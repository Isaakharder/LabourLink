import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice } from "../middleware/device";
import { reconcileEmployeeBreaks } from "../lib/breakReconciliation";
import { calendarDateInAppTimezone, parseTimeParts, zonedWallTimeToUtc } from "../lib/timezone";

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

    // Frozen at the moment this work entry is opened — resolved from the
    // row's *current* density assignment of the activity's configured
    // density_source, never re-read afterward (see
    // 025_activity_density_speed.sql: editing a density later must not
    // change an already-recorded run's calculated speed on Inputs). Breaks
    // never reach here (entryType !== "work" short-circuits), matching the
    // chk_time_entries_density_only_on_work constraint for free.
    let densityType: "plants" | "stems" | null = null;
    let densityCountPerRow: number | null = null;
    if (entryType === "work" && activityId && overrides.greenhouseRowId) {
      const densityRes = await client.query(
        `select pd.type as density_type, pd.count_per_row as density_count_per_row
         from activities a
         left join plant_density_rows pdr
           on pdr.greenhouse_row_id = $2 and pdr.density_type = a.density_source
         left join plant_densities pd on pd.id = pdr.density_id
         where a.id = $1`,
        [activityId, overrides.greenhouseRowId]
      );
      const d = densityRes.rows[0];
      if (d && d.density_type) {
        densityType = d.density_type;
        densityCountPerRow = Number(d.density_count_per_row);
      }
    }

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

async function serializeStatus(employeeId: string, employeeFirstName: string, employeeLastName: string) {
  // Server-side reconciliation for scheduled breaks the employee worked
  // straight through — runs on every status fetch and every mutating
  // action (they all call this function), so it never depends on a
  // background worker. Idempotent: see breakReconciliation.ts.
  await reconcileEmployeeBreaks(employeeId, calendarDateInAppTimezone(new Date()));

  const open = await getOpenEntry(employeeId);

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
        row: { id: string; label: string } | null;
        carrier: { id: string; name: string } | null;
      }
    | null = null;
  if (open?.entry_type === "work" && open.activity_id) {
    const { rows } = await pool.query("select id, name from activities where id = $1", [
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
            gr.row_number, gp.name as row_phase_name,
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
    row: r.row_number != null ? { label: `${r.row_phase_name} · Row ${r.row_number}` } : null,
    carrier: r.carrier_id ? { label: r.carrier_name as string } : null,
    // Closed by the daily-cutoff safety net rather than a real End Work
    // tap — surfaced so the mobile app can optionally label it, matching
    // the same indicator Inputs shows.
    autoClosed: r.auto_closed_at !== null,
  }));

  return {
    employee: { id: employeeId, firstName: employeeFirstName, lastName: employeeLastName },
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
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

router.get(
  "/activities",
  asyncHandler(async (req, res) => {
    const d = req.device!;

    // Resolve every active group the employee currently has an active
    // assignment to — an assignment pointing at an inactive group can't
    // actually happen (activityGroups.ts closes the row on deactivation),
    // but the join filter is kept anyway as defense-in-depth, matching how
    // requireDevice double-checks is_active even after already gating on
    // assignment closure elsewhere.
    const groupRows = await pool.query(
      `select ag.id, ag.name
       from employee_activity_group_assignments eaga
       join activity_groups ag on ag.id = eaga.activity_group_id and ag.is_active = true
       where eaga.employee_id = $1 and eaga.unassigned_at is null
       order by ag.name`,
      [d.employeeId]
    );
    const groups = groupRows.rows;
    if (groups.length === 0) {
      // No active group — never fall back to "all activities."
      return res.json({ activities: [], activityGroups: [] });
    }

    // Deduplicated (an activity belonging to more than one of the
    // employee's groups is returned once) via an inner "distinct
    // activity_id" set, joined to activities and then to each activity's
    // own ordered question list via LATERAL — the same shape
    // server/src/routes/activities.ts uses, and for the same reason: a
    // plain LEFT JOIN to activity_questions (now zero-to-many per activity)
    // would fan out and require reintroducing the exact "distinct" problem
    // this dedup step already exists to solve.
    const { rows } = await pool.query(
      `select a.id, a.name, a.normal_speed, a.speed_unit, a.sort_order,
              coalesce(q.questions, '[]'::json) as questions
       from (
         select distinct aga.activity_id
         from activity_group_activities aga
         where aga.activity_group_id = any($1::uuid[])
       ) x
       join activities a on a.id = x.activity_id and a.is_active = true
       left join lateral (
         select json_agg(json_build_object(
                  'id', aq.id, 'questionType', aq.question_type,
                  'label', aq.label, 'isRequired', aq.is_required
                ) order by aq.sort_order) as questions
         from activity_questions aq
         where aq.activity_id = a.id and aq.is_active = true
       ) q on true
       order by a.sort_order, a.name`,
      [groups.map((g) => g.id)]
    );
    res.json({
      // pg returns numeric columns as strings — cast explicitly, same as
      // server/src/routes/activities.ts does for the desktop admin list.
      activities: rows.map((r) => ({
        id: r.id,
        name: r.name,
        normalSpeed: r.normal_speed !== null ? Number(r.normal_speed) : null,
        speedUnit: r.speed_unit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        questions: (r.questions as any[]).map((q) => ({
          id: q.id,
          questionType: q.questionType as "greenhouse_row" | "carrier",
          label: q.label as string,
          isRequired: q.isRequired as boolean,
        })),
      })),
      activityGroups: groups.map((g) => ({ id: g.id, name: g.name })),
    });
  })
);

router.post(
  "/time-entries/work",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { activityId, idempotencyKey, answers } = req.body as {
      activityId?: string;
      idempotencyKey?: string;
      answers?: { questionId?: string; greenhouseRowId?: string; carrierId?: string }[];
    };
    if (!activityId || !UUID_RE.test(activityId) || !isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "activityId and a valid idempotencyKey are required" });
    }
    // activityId is client-supplied — confirm it's a real, active activity
    // AND a member of the employee's currently active group before opening
    // an entry against it. Picker restriction is a UI convenience only; this
    // is the actual enforcement, since a client-supplied id is never trusted.
    const activityCheck = await pool.query(
      `select a.id
       from activities a
       join activity_group_activities aga on aga.activity_id = a.id
       join employee_activity_group_assignments eaga
         on eaga.activity_group_id = aga.activity_group_id
        and eaga.employee_id = $2
        and eaga.unassigned_at is null
       join activity_groups ag on ag.id = aga.activity_group_id and ag.is_active = true
       where a.id = $1 and a.is_active = true`,
      [activityId, d.employeeId]
    );
    if (!activityCheck.rows[0]) {
      return res.status(400).json({ error: "activityId is not available to this employee" });
    }

    // Server-authoritative question list: the client's job is only to
    // supply an answer per questionId, never to assert what type a
    // question is or whether it's required — both come from the DB here,
    // ordered the same way the mobile question flow asked them.
    const questionsRes = await pool.query(
      `select id, question_type, is_required from activity_questions
       where activity_id = $1 and is_active = true
       order by sort_order`,
      [activityId]
    );
    const questions = questionsRes.rows as { id: string; question_type: "greenhouse_row" | "carrier"; is_required: boolean }[];

    const answersArray = Array.isArray(answers) ? answers : [];
    const validQuestionIds = new Set(questions.map((q) => q.id));
    for (const a of answersArray) {
      if (!a || typeof a.questionId !== "string" || !validQuestionIds.has(a.questionId)) {
        return res.status(400).json({ error: "One or more answers do not match a configured question for this activity" });
      }
    }
    const answersByQuestionId = new Map(answersArray.map((a) => [a.questionId as string, a]));

    let validatedRowId: string | null = null;
    let validatedCarrierId: string | null = null;

    for (const q of questions) {
      const answer = answersByQuestionId.get(q.id);

      if (q.question_type === "greenhouse_row") {
        const rowId = answer?.greenhouseRowId;
        if (!rowId) {
          if (q.is_required) return res.status(400).json({ error: "greenhouseRowId is required for this activity" });
          continue;
        }
        if (typeof rowId !== "string" || !UUID_RE.test(rowId)) {
          return res.status(400).json({ error: "Invalid or inactive greenhouseRowId" });
        }
        const rowCheck = await pool.query(
          `select gr.id
           from greenhouse_rows gr
           join greenhouse_phases gp on gp.id = gr.phase_id and gp.is_active = true
           where gr.id = $1 and gr.deleted_at is null`,
          [rowId]
        );
        if (!rowCheck.rows[0]) return res.status(400).json({ error: "Invalid or inactive greenhouseRowId" });
        validatedRowId = rowId;
      } else if (q.question_type === "carrier") {
        const carrierId = answer?.carrierId;
        if (!carrierId) {
          if (q.is_required) return res.status(400).json({ error: "carrierId is required for this activity" });
          continue;
        }
        if (typeof carrierId !== "string" || !UUID_RE.test(carrierId)) {
          return res.status(400).json({ error: "Invalid or inactive carrierId" });
        }
        const carrierCheck = await pool.query(`select id from carriers where id = $1 and is_active = true`, [carrierId]);
        if (!carrierCheck.rows[0]) return res.status(400).json({ error: "Invalid or inactive carrierId" });
        validatedCarrierId = carrierId;
      }
    }

    await openEntry(d.employeeId, d.id, "work", activityId, idempotencyKey, {
      greenhouseRowId: validatedRowId,
      carrierId: validatedCarrierId,
    });
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
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

    await openEntry(
      d.employeeId,
      d.id,
      "break",
      null,
      idempotencyKey,
      match
        ? {
            startedAt: match.scheduledStart,
            actualStartedAt: now,
            breakProfileItemId: match.item.id,
            scheduledBreakDate: todayLocal,
            source: "manual",
            isPaid: match.item.is_paid,
          }
        : {}
    );
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
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

    // Only round the end if the currently open break was itself matched to
    // a fixed item at start time (never retroactively match on end alone).
    const open = await getOpenEntry(d.employeeId);
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
        }
      }
    }

    await openEntry(d.employeeId, d.id, "work", resumeActivityId, idempotencyKey, overrides);
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

router.post(
  "/time-entries/end-day",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    await pool.query(
      `update time_entries set ended_at = now() where employee_id = $1 and ended_at is null and deleted_at is null`,
      [d.employeeId]
    );
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

// Row options for the mobile row picker — device authenticated only (no
// role check, matching GET /activities), active phases/rows only. A plain
// list/grid on the phone, not a second map: reuses the same greenhouse_*
// tables the desktop editor and live view do.
router.get(
  "/greenhouse-rows",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select gl.id as land_id, gl.name as land_name, gp.id as phase_id, gp.name as phase_name,
              gp.sort_order, gr.id as row_id, gr.row_number
       from greenhouse_rows gr
       join greenhouse_phases gp on gp.id = gr.phase_id and gp.is_active = true
       join greenhouse_lands gl on gl.id = gp.land_id and gl.is_active = true
       where gr.deleted_at is null
       order by gl.name, gp.sort_order, gp.name, gr.row_number`
    );

    const lands = new Map<string, { id: string; name: string; phases: Map<string, { id: string; name: string; rows: { id: string; rowNumber: number }[] }> }>();
    for (const r of rows) {
      let land = lands.get(r.land_id);
      if (!land) {
        land = { id: r.land_id, name: r.land_name, phases: new Map() };
        lands.set(r.land_id, land);
      }
      let phase = land.phases.get(r.phase_id);
      if (!phase) {
        phase = { id: r.phase_id, name: r.phase_name, rows: [] };
        land.phases.set(r.phase_id, phase);
      }
      phase.rows.push({ id: r.row_id, rowNumber: r.row_number });
    }

    res.json({
      lands: Array.from(lands.values()).map((l) => ({
        id: l.id,
        name: l.name,
        phases: Array.from(l.phases.values()),
      })),
    });
  })
);

// Carrier options for the mobile carrier picker — same device-only auth and
// active-only scope as /greenhouse-rows above.
router.get(
  "/carriers",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`select id, name from carriers where is_active = true order by name`);
    res.json({ carriers: rows.map((r) => ({ id: r.id, name: r.name })) });
  })
);

export default router;
