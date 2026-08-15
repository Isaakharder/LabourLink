import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice } from "../middleware/device";
import { reconcileEmployeeBreaks } from "../lib/breakReconciliation";
import { calendarDateInAppTimezone, parseTimeParts, zonedWallTimeToUtc } from "../lib/timezone";
import {
  resolveOriginalEndedAt,
  resolveOriginalStartedAt,
  roundBreak,
  roundWorkEnd,
  roundWorkStart,
  RoundingDirection,
} from "../lib/workStartRounding";
import {
  loadCarrierOptions,
  loadEmployeeActivitiesWithQuestions,
  loadGreenhouseRowOptions,
  resolveDensitySnapshot,
  validateActivityAndAnswers,
} from "../lib/activitySelection";

const router = Router();
router.use(asyncHandler(requireDevice));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && UUID_RE.test(key);
}

interface OpenEntry {
  id: string;
  entry_type: "work" | "break";
  activity_id: string | null;
  started_at: string;
  greenhouse_row_id: string | null;
  carrier_id: string | null;
}

interface OpenEntryOverrides {
  // Rounds the recorded boundary: used for both the new row's started_at
  // AND (if this call closes a prior row) that row's ended_at — both must
  // get the same explicit value, not just the new row, or the chain's
  // exact-boundary contiguity check (accumulateChainSeconds /
  // groupIntoActivityRuns) breaks.
  startedAt?: Date;
  // Real tap timestamps, kept alongside the possibly-rounded started_at/
  // ended_at for audit purposes.
  actualStartedAt?: Date;
  actualEndedAt?: Date;
  breakProfileItemId?: string | null;
  scheduledBreakDate?: string | null;
  source?: "manual" | "auto";
  isPaid?: boolean | null;
  // Greenhouse row this work entry is attached to, if the activity's
  // configured question supplied/permits one. Never set for breaks (see the
  // chk_time_entries_row_only_on_work constraint, 015_time_entries_
  // greenhouse_row.sql).
  greenhouseRowId?: string | null;
  // Carrier this work entry is attached to, if the activity's configured
  // question supplied/permits one. Same "work only" shape as
  // greenhouseRowId (see chk_time_entries_carrier_only_on_work,
  // 019_carriers.sql).
  carrierId?: string | null;
}

async function getOpenEntry(employeeId: string): Promise<OpenEntry | null> {
  const { rows } = await pool.query(
    `select id, entry_type, activity_id, started_at, greenhouse_row_id, carrier_id
     from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
    [employeeId]
  );
  return rows[0] ?? null;
}

// Same as getOpenEntry, but excludes rows already carrying `idempotencyKey`
// — used only to decide whether a work-start request is a genuine idle ->
// work transition (see the work-start-rounding block in POST
// /time-entries/work). Without this exclusion, a *replay* of an already-
// succeeded work-start (same idempotencyKey, offline retry or a lost
// response) would see its own prior insert as "something's open" and
// wrongly conclude this wasn't a workday start. It doesn't affect what
// actually gets stored either way — openEntry()'s own idempotency_key
// unique index makes the insert a true no-op on any replay regardless of
// what overrides a replay computes — but getting `wasIdle` right keeps the
// rounding decision (and its debug-ability) honest on every call, not just
// the first.
async function getOpenEntryExcluding(employeeId: string, idempotencyKey: string): Promise<OpenEntry | null> {
  const { rows } = await pool.query(
    `select id, entry_type, activity_id, started_at, greenhouse_row_id, carrier_id
     from time_entries where employee_id = $1 and ended_at is null and deleted_at is null and idempotency_key <> $2`,
    [employeeId, idempotencyKey]
  );
  return rows[0] ?? null;
}

// Opens a new row and closes whatever else is open for this employee — used
// for both "start work" and "change activity" (closing the prior entry and
// opening the next is the same operation either way). The close step
// excludes rows already carrying this idempotency_key — the only row that
// could ever match is one a concurrent replay of this exact request already
// created, so excluding it is what stops a duplicate tap from closing the
// very row it was supposed to return. Closing must run before inserting:
// insert-first would briefly have two open rows for the same employee
// (the old one, still open, plus the new one), which the partial unique
// index on "one open row per employee" rejects outright.
async function openEntry(
  employeeId: string,
  deviceId: string,
  entryType: "work" | "break",
  activityId: string | null,
  idempotencyKey: string,
  overrides: OpenEntryOverrides = {}
): Promise<OpenEntry> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `update time_entries
       set ended_at = coalesce($3, now()),
           actual_ended_at = coalesce($4, actual_ended_at)
       where employee_id = $1 and ended_at is null and deleted_at is null and idempotency_key <> $2`,
      [employeeId, idempotencyKey, overrides.startedAt ?? null, overrides.actualEndedAt ?? null]
    );

    // Frozen at the moment this work entry is opened (see
    // resolveDensitySnapshot's own comment for why it's never re-read
    // afterward). Breaks never reach here (entryType !== "work"
    // short-circuits), matching the chk_time_entries_density_only_on_work
    // constraint for free.
    const { densityType, densityCountPerRow } =
      entryType === "work" && activityId
        ? await resolveDensitySnapshot(client, activityId, overrides.greenhouseRowId ?? null)
        : { densityType: null, densityCountPerRow: null };

    const insert = await client.query(
      `insert into time_entries
         (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at,
          actual_started_at, break_profile_item_id, scheduled_break_date, source, is_paid,
          greenhouse_row_id, carrier_id, density_type, density_count_per_row)
       values ($1, $2, $3, $4, $5, coalesce($6, now()), $7, $8, $9, coalesce($10, 'manual'), $11, $12, $13, $14, $15)
       on conflict (idempotency_key) do nothing
       returning id, entry_type, activity_id, started_at, greenhouse_row_id, carrier_id`,
      [
        employeeId,
        deviceId,
        entryType,
        activityId,
        idempotencyKey,
        overrides.startedAt ?? null,
        overrides.actualStartedAt ?? null,
        overrides.breakProfileItemId ?? null,
        overrides.scheduledBreakDate ?? null,
        overrides.source ?? null,
        overrides.isPaid ?? null,
        overrides.greenhouseRowId ?? null,
        overrides.carrierId ?? null,
        densityType,
        densityCountPerRow,
      ]
    );

    let row = insert.rows[0];
    if (!row) {
      const existing = await client.query(
        `select id, entry_type, activity_id, started_at, greenhouse_row_id, carrier_id
         from time_entries where idempotency_key = $1`,
        [idempotencyKey]
      );
      row = existing.rows[0];
    }

    await client.query("commit");
    return row;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if ((err as { code?: string }).code === "23505") {
      // Lost a race against a concurrent transition for the same employee
      // (e.g. a double-tap that fired two requests). Report whichever
      // transition actually won instead of erroring out.
      const current = await getOpenEntry(employeeId);
      if (current) return current;
    }
    throw err;
  } finally {
    client.release();
  }
}

interface ChainEntry {
  entry_type: "work" | "break";
  activity_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  greenhouse_row_id: string | null;
  carrier_id: string | null;
}

// Walks backward from `boundary` through the employee's recent entries,
// summing completed work-entry durations for `activityId`/`rowId`/
// `carrierId`, treating breaks as transparent (skipped, not counted) as
// long as the chain stays unbroken. A step only continues if the previous
// entry's ended_at exactly equals the timestamp being walked back from —
// openEntry() always closes the prior row and inserts the next one inside a
// single transaction, and Postgres resolves every now() call within one
// transaction to the same value, so two entries that are genuinely
// contiguous (no end-day/idle gap between them) always share a
// bit-identical timestamp there. A real gap (end-day, or a fresh start
// after being fully idle) naturally has no entry matching that exact
// boundary, which is what ends the chain. All entries here come from one
// query result compared only against each other in memory — never
// round-tripped back into a new SQL parameter — so the millisecond
// precision node-postgres applies when parsing timestamptz into a JS Date
// is applied identically on both sides and can't cause the kind of false
// mismatch a fresh round trip would.
//
// The row/carrier equality checks exist alongside the activity check
// because a row or carrier change (same activity, different location/
// carrier) already produces a fresh time_entries row the same way an
// activity change does (see openEntry() close+insert transaction) — a
// changed row or carrier is a new logical job segment, so the accumulated
// timer must reset there too, not just on activity change.
function accumulateChainSeconds(
  entries: ChainEntry[],
  activityId: string,
  rowId: string | null,
  carrierId: string | null,
  boundary: Date
): number {
  const byEndedAt = new Map<number, ChainEntry>();
  for (const e of entries) {
    if (e.ended_at) byEndedAt.set(e.ended_at.getTime(), e);
  }

  let totalSeconds = 0;
  let cursor = boundary.getTime();
  for (;;) {
    const prev = byEndedAt.get(cursor);
    if (!prev) break;
    if (prev.entry_type === "break") {
      cursor = prev.started_at.getTime();
      continue;
    }
    if (prev.activity_id !== activityId || prev.greenhouse_row_id !== rowId || prev.carrier_id !== carrierId) break;
    totalSeconds += (prev.ended_at!.getTime() - prev.started_at.getTime()) / 1000;
    cursor = prev.started_at.getTime();
  }
  return Math.round(totalSeconds);
}

// The employee's currently open work segment — activity, row/carrier, and
// elapsed seconds on the "effective active work segment" (chain-accumulated
// across break interruptions exactly like accumulatedWorkedSecondsBefore
// CurrentEntry above, break time never counted) — or null if not currently
// working (idle, on break, or a data lookup came back empty). Used by the
// same-row/minimum-duration switch checks in POST /time-entries/work below;
// pulled out as its own function rather than duplicating serializeStatus's
// inline version so the two can never drift on what "elapsed" means.
async function getCurrentWorkSegment(employeeId: string): Promise<{
  activityId: string;
  rowId: string | null;
  carrierId: string | null;
  elapsedSeconds: number;
  minimumDurationMinutes: number;
} | null> {
  const open = await getOpenEntry(employeeId);
  if (!open || open.entry_type !== "work" || !open.activity_id) return null;

  const { rows } = await pool.query("select minimum_duration_minutes from activities where id = $1", [open.activity_id]);
  const activity = rows[0];
  if (!activity) return null;

  const { rows: chainRows } = await pool.query<ChainEntry>(
    `select entry_type, activity_id, started_at, ended_at, greenhouse_row_id, carrier_id
     from time_entries
     where employee_id = $1 and started_at >= now() - interval '24 hours' and deleted_at is null`,
    [employeeId]
  );
  const accumulated = accumulateChainSeconds(
    chainRows,
    open.activity_id,
    open.greenhouse_row_id,
    open.carrier_id,
    new Date(open.started_at)
  );
  const elapsedSeconds = accumulated + (Date.now() - new Date(open.started_at).getTime()) / 1000;

  return {
    activityId: open.activity_id,
    rowId: open.greenhouse_row_id,
    carrierId: open.carrier_id,
    elapsedSeconds: Math.round(elapsedSeconds),
    minimumDurationMinutes: activity.minimum_duration_minutes,
  };
}

interface FixedItem {
  id: string;
  start_time: string;
  end_time: string;
  is_paid: boolean;
  fixed_start_window_minutes: number;
  fixed_end_window_minutes: number;
}

// Fixed-break items on the employee's currently active assigned profile —
// used to decide whether a manual Start/End Break tap should be rounded to
// the scheduled time. Inactive profile/employee naturally returns nothing.
async function loadActiveFixedItems(employeeId: string): Promise<FixedItem[]> {
  const { rows } = await pool.query(
    `select bpi.id, bpi.start_time, bpi.end_time, bpi.is_paid,
            bpi.fixed_start_window_minutes, bpi.fixed_end_window_minutes
     from employees e
     join break_profiles bp on bp.id = e.break_profile_id and bp.is_active = true
     join break_profile_items bpi
       on bpi.break_profile_id = bp.id and bpi.fixed_break = true and bpi.is_active = true
     where e.id = $1 and e.is_active = true`,
    [employeeId]
  );
  return rows;
}

interface WorkStartRoundingSettings {
  enabled: boolean;
  direction: RoundingDirection;
  intervalMinutes: number;
}

// The employee's currently assigned (active profile, active employee)
// work-start rounding configuration, read fresh on every call — there is no
// historical/versioned config to look up "as of" some earlier moment. This
// is deliberate (see resolveOriginalStartedAt's comment): whatever config
// is live at the moment the server actually processes a work-start request
// is the one that applies to it, including for a delayed offline sync.
// Returns null for "no active profile assigned" — the caller treats that
// the same as "rounding disabled."
async function loadWorkStartRoundingSettings(employeeId: string): Promise<WorkStartRoundingSettings | null> {
  const { rows } = await pool.query(
    `select bp.work_start_rounding_enabled, bp.work_start_rounding_direction,
            bp.work_start_rounding_interval_minutes
     from employees e
     join break_profiles bp on bp.id = e.break_profile_id and bp.is_active = true
     where e.id = $1 and e.is_active = true`,
    [employeeId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.work_start_rounding_enabled,
    direction: row.work_start_rounding_direction,
    intervalMinutes: row.work_start_rounding_interval_minutes,
  };
}

// Same shape and same "read fresh on every call, no historical/versioned
// lookup" reasoning as loadWorkStartRoundingSettings above, for the
// employee's work-END rounding configuration — an independent setting on
// the same break profile, never coupled to work-start rounding's own
// enabled/direction/interval (see 032_work_end_rounding.sql).
async function loadWorkEndRoundingSettings(employeeId: string): Promise<WorkStartRoundingSettings | null> {
  const { rows } = await pool.query(
    `select bp.work_end_rounding_enabled, bp.work_end_rounding_direction,
            bp.work_end_rounding_interval_minutes
     from employees e
     join break_profiles bp on bp.id = e.break_profile_id and bp.is_active = true
     where e.id = $1 and e.is_active = true`,
    [employeeId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.work_end_rounding_enabled,
    direction: row.work_end_rounding_direction,
    intervalMinutes: row.work_end_rounding_interval_minutes,
  };
}

// Same shape and same "read fresh on every call" reasoning as
// loadWorkStartRoundingSettings/loadWorkEndRoundingSettings above, for the
// employee's break-rounding configuration — a single independent setting
// (see 037_break_rounding.sql) applied to BOTH ends of a break, unlike
// work-start/work-end which are two separate settings for two separate
// routes.
async function loadBreakRoundingSettings(employeeId: string): Promise<WorkStartRoundingSettings | null> {
  const { rows } = await pool.query(
    `select bp.break_rounding_enabled, bp.break_rounding_direction,
            bp.break_rounding_interval_minutes
     from employees e
     join break_profiles bp on bp.id = e.break_profile_id and bp.is_active = true
     where e.id = $1 and e.is_active = true`,
    [employeeId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.break_rounding_enabled,
    direction: row.break_rounding_direction,
    intervalMinutes: row.break_rounding_interval_minutes,
  };
}

async function serializeStatus(
  employeeId: string,
  employeeFirstName: string,
  employeeLastName: string,
  employeePreferredLanguage: string | null,
  employeeSecurityRole: string
) {
  // TEMPORARY — End Work ~1min delay investigation. Elapsed-time-only, no
  // secrets. Remove once the slow hop is identified.
  const __t0 = Date.now();
  // Server-side reconciliation for scheduled breaks the employee worked
  // straight through — runs on every status fetch and every mutating
  // action (they all call this function), so it never depends on a
  // background worker. Idempotent: see breakReconciliation.ts.
  await reconcileEmployeeBreaks(employeeId, calendarDateInAppTimezone(new Date()));
  console.log(`[timing] serializeStatus reconcileEmployeeBreaks: ${Date.now() - __t0}ms`);

  const open = await getOpenEntry(employeeId);
  console.log(`[timing] serializeStatus getOpenEntry: ${Date.now() - __t0}ms`);

  // Bounded window used to walk the current job chain backward — work/break
  // segments are short-lived, so a day's worth of history is always enough;
  // this is a cheap indexed scan, not an unbounded per-employee history read.
  const { rows: chainRows } = await pool.query<ChainEntry>(
    `select entry_type, activity_id, started_at, ended_at, greenhouse_row_id, carrier_id
     from time_entries
     where employee_id = $1 and started_at >= now() - interval '24 hours' and deleted_at is null`,
    [employeeId]
  );

  let currentActivity:
    | {
        id: string;
        name: string;
        startedAt: string;
        accumulatedWorkedSecondsBeforeCurrentEntry: number;
        // The row/bin-switch same-row/minimum-duration warnings (see
        // checkSwitchWarning on the client, and the mirrored server-side
        // check in POST /time-entries/work) both need this — exposed here
        // so the client's fast pre-check never has to make a second request
        // just to learn the currently-running activity's own configured
        // minimum.
        minimumDurationMinutes: number;
        row: { id: string; label: string } | null;
        carrier: { id: string; name: string } | null;
      }
    | null = null;
  if (open?.entry_type === "work" && open.activity_id) {
    const { rows } = await pool.query("select id, name, minimum_duration_minutes from activities where id = $1", [
      open.activity_id,
    ]);
    const a = rows[0];
    if (a) {
      const accumulated = accumulateChainSeconds(
        chainRows,
        open.activity_id,
        open.greenhouse_row_id,
        open.carrier_id,
        new Date(open.started_at)
      );
      // Deliberately not filtered on the row/phase's active state — this
      // describes the employee's *current* location and must still resolve
      // if an admin deactivated it after the shift started (see plan A5-2).
      let row: { id: string; label: string } | null = null;
      if (open.greenhouse_row_id) {
        const { rows: rowRows } = await pool.query(
          `select gr.row_number, gp.name as phase_name
           from greenhouse_rows gr join greenhouse_phases gp on gp.id = gr.phase_id
           where gr.id = $1`,
          [open.greenhouse_row_id]
        );
        const r = rowRows[0];
        if (r) row = { id: open.greenhouse_row_id, label: `${r.phase_name} · Row ${r.row_number}` };
      }
      // Same "resolve even if deactivated since" convention as the row
      // lookup above.
      let carrier: { id: string; name: string } | null = null;
      if (open.carrier_id) {
        const { rows: carrierRows } = await pool.query(`select name from carriers where id = $1`, [open.carrier_id]);
        const c = carrierRows[0];
        if (c) carrier = { id: open.carrier_id, name: c.name };
      }
      currentActivity = {
        id: a.id,
        name: a.name,
        startedAt: open.started_at,
        accumulatedWorkedSecondsBeforeCurrentEntry: accumulated,
        minimumDurationMinutes: a.minimum_duration_minutes,
        row,
        carrier,
      };
    }
  }

  // The work entry that was closed to open this break, if any — found by
  // exact ended_at = this break's started_at match rather than "most
  // recently closed work entry": openEntry's transaction resolves both the
  // closing update's now() and the new row's default now() to the same
  // transaction timestamp, so this is a precise, race-free link (a "most
  // recent" query could instead reach across breaks/days and mislabel a
  // stale entry as "before this break"). The comparison is done via a
  // subquery on the break row's own id, not by passing its started_at
  // through JS — node-postgres returns timestamptz as a JS Date, which only
  // holds millisecond precision, while Postgres stores microseconds;
  // round-tripping now() (which is rarely exactly on a millisecond
  // boundary) through a Date and back would silently fail this equality
  // check. Comparing two values Postgres reads directly from its own
  // storage avoids that precision loss entirely.
  let previousActivity: { id: string; name: string; accumulatedWorkedSeconds: number } | null = null;
  if (open?.entry_type === "break") {
    const { rows } = await pool.query(
      `select te.activity_id as id, a.name, te.greenhouse_row_id, te.carrier_id
       from time_entries te
       join activities a on a.id = te.activity_id
       where te.employee_id = $1
         and te.entry_type = 'work'
         and te.deleted_at is null
         and te.ended_at = (select started_at from time_entries where id = $2)
       order by te.started_at desc
       limit 1`,
      [employeeId, open.id]
    );
    const row = rows[0];
    if (row) {
      // Walking back from the break's own start naturally picks up the
      // segment that just closed (its ended_at equals the break's
      // started_at) plus everything earlier in the same chain — this is
      // the running total "worked so far," not just the last segment.
      const accumulated = accumulateChainSeconds(
        chainRows,
        row.id,
        row.greenhouse_row_id,
        row.carrier_id,
        new Date(open.started_at)
      );
      previousActivity = { id: row.id, name: row.name, accumulatedWorkedSeconds: accumulated };
    }
  }

  // Most recent completed (not the open entry, not breaks) work entries for
  // today. is_active is deliberately not checked on the activity join —
  // activities are never hard-deleted, only deactivated, so history always
  // resolves; the name shown is whatever it's currently named (no
  // at-the-time snapshot exists). Same for the carrier left join.
  const { rows: recentRows } = await pool.query(
    `select te.id, te.activity_id, a.name, te.started_at, te.ended_at, te.auto_closed_at,
            extract(epoch from (te.ended_at - te.started_at))::int as duration_seconds,
            gr.id as row_id, gr.row_number, gp.name as row_phase_name,
            c.id as carrier_id, c.name as carrier_name
     from time_entries te
     join activities a on a.id = te.activity_id
     left join greenhouse_rows gr on gr.id = te.greenhouse_row_id
     left join greenhouse_phases gp on gp.id = gr.phase_id
     left join carriers c on c.id = te.carrier_id
     where te.employee_id = $1
       and te.entry_type = 'work'
       and te.ended_at is not null
       and te.deleted_at is null
       and te.started_at >= date_trunc('day', now())
     order by te.started_at desc
     limit 5`,
    [employeeId]
  );
  const recentJobs = recentRows.map((r) => ({
    id: r.id,
    activityId: r.activity_id,
    name: r.name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSeconds: r.duration_seconds,
    row: r.row_id ? { id: r.row_id as string, label: `${r.row_phase_name} · Row ${r.row_number}` } : null,
    carrier: r.carrier_id ? { id: r.carrier_id as string, label: r.carrier_name as string } : null,
    // Closed by the daily-cutoff safety net rather than a real End Work
    // tap — surfaced so the mobile app can optionally label it, matching
    // the same indicator Inputs shows.
    autoClosed: r.auto_closed_at !== null,
  }));

  console.log(`[timing] serializeStatus total: ${Date.now() - __t0}ms`);
  return {
    employee: {
      id: employeeId,
      firstName: employeeFirstName,
      lastName: employeeLastName,
      preferredLanguage: employeePreferredLanguage,
      // Display-only on the client (e.g. gating the mobile "Admin Mode"
      // section) — never treated as proof by any server route, which each
      // independently check req.device.employeeSecurityRole.
      securityRole: employeeSecurityRole,
    },
    status: open ? open.entry_type : "idle",
    currentActivity,
    since: open?.started_at ?? null,
    previousActivity,
    recentJobs,
  };
}

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName, d.employeePreferredLanguage, d.employeeSecurityRole));
  })
);

router.get(
  "/activities",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const result = await loadEmployeeActivitiesWithQuestions(pool, d.employeeId);
    res.json(result);
  })
);

router.post(
  "/time-entries/work",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { activityId, idempotencyKey, answers, clientStartedAt, confirmSwitch } = req.body as {
      activityId?: string;
      idempotencyKey?: string;
      answers?: { questionId?: string; greenhouseRowId?: string; carrierId?: string }[];
      // The phone's own clock reading of the moment this was tapped,
      // captured client-side before the request was even attempted — see
      // resolveOriginalStartedAt above. Only ever consulted below when this
      // turns out to be a genuine workday start; ignored entirely for an
      // activity change or a break/end resume, which always use server time
      // exactly as before.
      clientStartedAt?: string;
      // Set only after the employee has explicitly dismissed the same-row
      // or minimum-duration warning below (client-side dialog, see
      // lib/nfcSwitchWarning.ts) — bypasses BOTH checks for this one
      // request. Never trusted as "the client already checked, skip
      // re-checking": the checks below are the actual enforcement,
      // independent of what triggered this call (manual tap or NFC scan),
      // so a stale/offline/manipulated client can't silently skip them by
      // just never sending a warning it decided not to show.
      confirmSwitch?: boolean;
    };
    if (!activityId || !UUID_RE.test(activityId) || !isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "activityId and a valid idempotencyKey are required" });
    }

    // activityId is client-supplied — confirm it's a real, active activity
    // AND a member of the employee's currently active group, and every
    // configured question fully/validly answered, before opening an entry
    // against it. Picker restriction is a UI convenience only; this is the
    // actual enforcement, since a client-supplied id is never trusted. Same
    // validation the desktop admin manual-entry endpoints use (see
    // activitySelection.ts) — one set of rules, not two.
    const validation = await validateActivityAndAnswers(pool, activityId, d.employeeId, answers);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const { validatedRowId, validatedCarrierId } = validation;

    // Work-start rounding applies ONLY on a genuine idle -> work
    // transition — never to an activity change (something is already
    // open, entryType stays "work") and never to resuming work after a
    // break (that's POST /time-entries/break/end below, a separate route
    // that never reaches here at all). getOpenEntryExcluding rather than
    // plain getOpenEntry so a *replay* of this exact request (same
    // idempotencyKey) still correctly recognizes itself as "was idle" —
    // see that function's own comment for why this doesn't actually change
    // what ends up stored on a replay either way (openEntry's idempotency_key
    // uniqueness already makes the insert a true no-op), it just keeps the
    // rounding decision honest and debuggable on every call, not only the
    // first.
    const wasIdle = (await getOpenEntryExcluding(d.employeeId, idempotencyKey)) === null;

    // Interrupting an already-open work segment to start a different
    // activity/row/carrier — never on a genuine idle/break -> work start,
    // which has nothing to interrupt. Priority order (checked in this
    // order, only the first applicable one is ever returned — see the NFC
    // feature plan's "do not stack multiple confirmation dialogs for one
    // scan"): same-row-recently-completed, then minimum-duration. Both are
    // skippable in one request via confirmSwitch, set only after the
    // employee has actually seen and dismissed whichever dialog fired.
    if (!wasIdle && !confirmSwitch) {
      const current = await getCurrentWorkSegment(d.employeeId);
      const isRealSwitch =
        current !== null &&
        (current.activityId !== activityId || current.rowId !== validatedRowId || current.carrierId !== validatedCarrierId);

      if (isRealSwitch) {
        const { rows: mostRecentRows } = await pool.query(
          `select activity_id, greenhouse_row_id, carrier_id from time_entries
           where employee_id = $1 and entry_type = 'work' and ended_at is not null and deleted_at is null
           order by started_at desc limit 1`,
          [d.employeeId]
        );
        const mostRecent = mostRecentRows[0];
        if (
          mostRecent &&
          mostRecent.activity_id === activityId &&
          mostRecent.greenhouse_row_id === validatedRowId &&
          mostRecent.carrier_id === validatedCarrierId
        ) {
          return res.status(409).json({
            error: "You just finished this row/bin.",
            code: "SAME_ROW_RECENTLY_COMPLETED",
          });
        }

        const minimumSeconds = current!.minimumDurationMinutes * 60;
        if (current!.elapsedSeconds < minimumSeconds) {
          return res.status(409).json({
            error: "The minimum duration for this activity has not been reached.",
            code: "MINIMUM_DURATION_NOT_REACHED",
            elapsedSeconds: current!.elapsedSeconds,
            minimumMinutes: current!.minimumDurationMinutes,
          });
        }
      }
    }

    let overrides: OpenEntryOverrides = {
      greenhouseRowId: validatedRowId,
      carrierId: validatedCarrierId,
    };

    if (wasIdle) {
      const settings = await loadWorkStartRoundingSettings(d.employeeId);
      if (settings?.enabled) {
        const now = new Date();
        const original = resolveOriginalStartedAt(clientStartedAt, now);
        const rounded = roundWorkStart(original, settings.intervalMinutes, settings.direction);
        // actual_started_at (original tap) and started_at (rounded,
        // effective — what paid-time calculations, Inputs, and reports all
        // read) are both set here, once, at insert time. Whatever is
        // computed and stored now is permanent: a later change to this
        // profile's rounding settings only ever affects work starts
        // recorded after that change (loadWorkStartRoundingSettings reads
        // the *current* row on every call — there's no historical
        // config to retroactively apply, and nothing here ever updates an
        // already-stored started_at/actual_started_at).
        overrides = { ...overrides, startedAt: rounded, actualStartedAt: original };
      }
      // rounding disabled (or no active profile assigned): deliberately no
      // overrides.startedAt/actualStartedAt at all here — openEntry() falls
      // back to server now() for started_at exactly as it did before this
      // feature existed, and actual_started_at stays null on this row, same
      // as every work entry recorded before this feature shipped.
    }

    await openEntry(d.employeeId, d.id, "work", activityId, idempotencyKey, overrides);
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName, d.employeePreferredLanguage, d.employeeSecurityRole));
  })
);

router.post(
  "/time-entries/break/start",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { idempotencyKey } = req.body as { idempotencyKey?: string };
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "a valid idempotencyKey is required" });
    }

    // If the employee's assigned profile has a fixed-break item whose start
    // grace window contains this moment, round to the scheduled time and
    // tag the entry with that item — otherwise record the actual tap time
    // with no profile association. Nearest scheduled time wins on overlap
    // between two items' windows.
    //
    // `now` is always server-processing time, same as every other
    // timestamp in this file — for a request replayed from the offline
    // queue (offlineQueue.ts) after connectivity returns, that's when it's
    // replayed, not the original tap. A long-delayed replay can therefore
    // miss the window it should have matched, or (rarely) land inside a
    // different item's window. Accepted: the offline queue is already
    // documented as not meant to survive an extended fully-offline shift,
    // and every other timestamp here has the same server-time
    // characteristic — fixed-break rounding doesn't introduce a new class
    // of problem, it just makes an existing one slightly more visible.
    const now = new Date();
    const todayLocal = calendarDateInAppTimezone(now);
    const [y, mo, da] = todayLocal.split("-").map(Number);
    const fixedItems = await loadActiveFixedItems(d.employeeId);

    let match: { item: FixedItem; scheduledStart: Date } | null = null;
    for (const item of fixedItems) {
      const [sh, sm, ss] = parseTimeParts(item.start_time);
      const scheduledStart = zonedWallTimeToUtc(y, mo, da, sh, sm, ss);
      const windowMs = item.fixed_start_window_minutes * 60 * 1000;
      const distance = Math.abs(now.getTime() - scheduledStart.getTime());
      if (distance > windowMs) continue;
      if (!match || distance < Math.abs(now.getTime() - match.scheduledStart.getTime())) {
        match = { item, scheduledStart };
      }
    }

    let overrides: OpenEntryOverrides = {};
    if (match) {
      overrides = {
        startedAt: match.scheduledStart,
        actualStartedAt: now,
        breakProfileItemId: match.item.id,
        scheduledBreakDate: todayLocal,
        source: "manual",
        isPaid: match.item.is_paid,
      };
    } else {
      // No scheduled fixed-break item matched this tap — apply the
      // employee's own break-rounding setting instead, if enabled (see
      // 037_break_rounding.sql). Deliberately never layered on top of a
      // fixed-item match above: that's already an exact scheduled-time
      // snap, and rounding it further would just move it away from the
      // schedule it was just matched to.
      const settings = await loadBreakRoundingSettings(d.employeeId);
      if (settings?.enabled) {
        let rounded = roundBreak(now, settings.intervalMinutes, settings.direction);
        // Never let rounding push this break's start at or before the
        // work entry it's about to close — same short-workday guard (and
        // the same two-step fallback) as end-day's work-end rounding (see
        // loadWorkEndRoundingSettings's call site below). The first
        // fallback (the exact unrounded tap) is itself not guaranteed to
        // clear the floor: that entry's own started_at could itself be a
        // clockwise-work-start-rounded instant still in the future
        // relative to `now`, in which case a second, guaranteed-positive
        // fallback is needed.
        const currentlyOpen = await getOpenEntry(d.employeeId);
        if (currentlyOpen) {
          const floor = new Date(currentlyOpen.started_at).getTime();
          if (rounded.getTime() <= floor) rounded = now;
          if (rounded.getTime() <= floor) rounded = new Date(floor + 1000);
        }
        overrides = { startedAt: rounded, actualStartedAt: now };
      }
      // rounding disabled (or no active profile assigned): no overrides at
      // all — openEntry() falls back to server now() for started_at
      // exactly as it did before this feature existed, and
      // actual_started_at stays null on this row.
    }

    await openEntry(d.employeeId, d.id, "break", null, idempotencyKey, overrides);
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName, d.employeePreferredLanguage, d.employeeSecurityRole));
  })
);

router.post(
  "/time-entries/break/end",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { idempotencyKey } = req.body as { idempotencyKey?: string };
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "a valid idempotencyKey is required" });
    }

    // Resume whatever activity — and greenhouse row/carrier, if any — was
    // active before the break. Reattaching the same answers here, with no
    // client input at all, is what makes "resume the same activity, row,
    // and carrier automatically, no re-asking" work: the mobile app never
    // needs to send (or re-collect) an answer on break/end.
    const { rows } = await pool.query(
      `select activity_id, greenhouse_row_id, carrier_id from time_entries
       where employee_id = $1 and entry_type = 'work' and deleted_at is null
       order by started_at desc limit 1`,
      [d.employeeId]
    );
    const resumeActivityId = rows[0]?.activity_id ?? null;
    const resumeRowId = rows[0]?.greenhouse_row_id ?? null;
    const resumeCarrierId = rows[0]?.carrier_id ?? null;
    if (!resumeActivityId) {
      return res.status(409).json({ error: "No prior activity to resume" });
    }

    const now = new Date();
    const overrides: OpenEntryOverrides = {
      actualEndedAt: now,
      greenhouseRowId: resumeRowId,
      carrierId: resumeCarrierId,
    };

    // Only snap-to-schedule the end if the currently open break was itself
    // matched to a fixed item at start time (never retroactively match on
    // end alone).
    const open = await getOpenEntry(d.employeeId);
    let matchedFixedEnd = false;
    if (open?.entry_type === "break") {
      const { rows: itemRows } = await pool.query(
        `select bpi.end_time, bpi.fixed_end_window_minutes,
                to_char(te.scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date
         from time_entries te
         join break_profile_items bpi on bpi.id = te.break_profile_item_id
         where te.id = $1`,
        [open.id]
      );
      const row = itemRows[0];
      if (row) {
        const [y, mo, da] = (row.scheduled_break_date as string).split("-").map(Number);
        const [eh, em, es] = parseTimeParts(row.end_time);
        const scheduledEnd = zonedWallTimeToUtc(y, mo, da, eh, em, es);
        const windowMs = row.fixed_end_window_minutes * 60 * 1000;
        if (Math.abs(now.getTime() - scheduledEnd.getTime()) <= windowMs) {
          overrides.startedAt = scheduledEnd;
          matchedFixedEnd = true;
        }
      }
    }

    // No fixed-item end match — apply the employee's own break-rounding
    // setting instead, if enabled (see 037_break_rounding.sql). Always
    // explicitly resolved to a concrete value here (never left unset to
    // fall through to openEntry()'s own `coalesce($3, now())` default) so
    // this closing boundary and actualEndedAt above are built from the
    // exact same JS Date — otherwise a JS-vs-Postgres now() skew of a few
    // milliseconds could make an unrounded break look "Rounded" on the
    // Inputs page for no real reason.
    if (open?.entry_type === "break" && !matchedFixedEnd) {
      let effectiveEnd = now;
      const settings = await loadBreakRoundingSettings(d.employeeId);
      if (settings?.enabled) {
        effectiveEnd = roundBreak(now, settings.intervalMinutes, settings.direction);
      }
      // Never let the break's end land at or before its own start — same
      // short-workday guard (and the same two-step fallback) as end-day's
      // work-end rounding. Enforced unconditionally, not just when
      // break-end rounding is enabled: this break's own started_at can
      // itself be a clockwise-break-rounded instant still in the future
      // relative to `now` (break-start rounding, above), so even the exact
      // unrounded tap isn't guaranteed to clear it — the second fallback
      // guarantees a strictly positive duration regardless.
      const floor = new Date(open.started_at).getTime();
      if (effectiveEnd.getTime() <= floor) effectiveEnd = now;
      if (effectiveEnd.getTime() <= floor) effectiveEnd = new Date(floor + 1000);
      overrides.startedAt = effectiveEnd;
    }

    await openEntry(d.employeeId, d.id, "work", resumeActivityId, idempotencyKey, overrides);
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName, d.employeePreferredLanguage, d.employeeSecurityRole));
  })
);

router.post(
  "/time-entries/end-day",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { idempotencyKey, clientEndedAt } = req.body as {
      idempotencyKey?: string;
      // The phone's own clock reading of the moment "Finish Work" was
      // tapped, captured client-side before the request was even attempted
      // and preserved across a retry with the same idempotencyKey — see
      // resolveOriginalEndedAt's comment and WorkSessionContext.tsx's
      // confirmEndDay. Only ever consulted below when there's actually an
      // open entry to close and work-end rounding is enabled for this
      // employee; ignored entirely otherwise, same as clientStartedAt on
      // POST /time-entries/work.
      clientEndedAt?: string;
    };
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "a valid idempotencyKey is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      // Whatever is open for this employee right now — at most one row, per
      // the app's own one-open-entry invariant. A replay of this exact
      // request (same idempotencyKey, retried after a network hiccup, or a
      // duplicate tap) finds nothing here the second time: the first
      // successful call already closed it, so ended_at is no longer null
      // and this SELECT returns no row. That's the entire idempotency
      // guarantee for this route — no separate "have I seen this key
      // before" table needed, and it's what makes "replaying must not round
      // twice or create another entry" true for free.
      const openRes = await client.query(
        `select id, started_at from time_entries
         where employee_id = $1 and ended_at is null and deleted_at is null
         for update`,
        [d.employeeId]
      );
      const open = openRes.rows[0];

      if (open) {
        const now = new Date();
        const original = resolveOriginalEndedAt(clientEndedAt, now);
        const settings = await loadWorkEndRoundingSettings(d.employeeId);

        // ended_at is set to a real, non-null value in every case below —
        // including when rounding lands on a timestamp still in the
        // future (a clockwise round-forward past `now`). That alone is
        // what immediately closes the employee's active state: `status`
        // is derived purely from "is there a row with ended_at is null"
        // (getOpenEntry), never from comparing ended_at to the current
        // time, so a future-dated ended_at still reads as fully idle the
        // instant this commits — never "still active until the clock
        // catches up."
        let effectiveEnd = original;
        // actual_ended_at stays null unless rounding is actually enabled
        // for this employee — same "only set when enabled, regardless of
        // whether it happened to change anything" convention
        // actual_started_at uses for work-start rounding, so "rounding
        // was active for this entry" stays a simple non-null check.
        let actualEndedAt: Date | null = null;

        if (settings?.enabled) {
          let rounded = roundWorkEnd(original, settings.intervalMinutes, settings.direction);
          const startedAt = new Date(open.started_at);
          // Never let rounding push the effective end at or before this
          // entry's own start — a counter-clockwise round on a very short
          // workday could otherwise land before it even began. Falling
          // back to the unrounded tap time is the safe degradation (it's
          // still a real, employee-reported moment, just not rounded),
          // not a silently zero/negative-duration row.
          if (rounded.getTime() <= startedAt.getTime()) {
            rounded = original;
          }
          // Only reachable if even the unrounded tap time doesn't clear
          // the entry's own start — a pathological clock-skew edge case,
          // not a real rounding outcome (resolveOriginalEndedAt already
          // falls back to `now` for grossly invalid client timestamps,
          // and `now` can't itself be before a start already recorded in
          // the past). Guarantees a strictly positive duration is always
          // recorded rather than ever risking zero or negative.
          if (rounded.getTime() <= startedAt.getTime()) {
            rounded = new Date(startedAt.getTime() + 1000);
          }
          effectiveEnd = rounded;
          actualEndedAt = original;
        }

        await client.query(`update time_entries set ended_at = $2, actual_ended_at = $3 where id = $1`, [
          open.id,
          effectiveEnd,
          actualEndedAt,
        ]);
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName, d.employeePreferredLanguage, d.employeeSecurityRole));
  })
);

// Row options for the mobile row picker — device authenticated only (no
// role check, matching GET /activities), active phases/rows only. A plain
// list/grid on the phone, not a second map: reuses the same greenhouse_*
// tables the desktop editor and live view do.
router.get(
  "/greenhouse-rows",
  asyncHandler(async (_req, res) => {
    res.json({ lands: await loadGreenhouseRowOptions(pool) });
  })
);

// Carrier options for the mobile carrier picker — same device-only auth and
// active-only scope as /greenhouse-rows above.
router.get(
  "/carriers",
  asyncHandler(async (_req, res) => {
    res.json({ carriers: await loadCarrierOptions(pool) });
  })
);

export default router;
