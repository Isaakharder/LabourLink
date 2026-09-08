// Midnight rollover: keeps a shift that genuinely spans local midnight
// reading as one continuous shift instead of getting silently kicked to
// idle by the daily-cutoff safety net (dailyCutoff.ts, which now only fires
// as a much-wider-threshold outer fallback — see its own header comment).
//
// At each local midnight an employee's still-open time_entries row is
// closed at the exact boundary and an equivalent row is immediately opened
// for the new day, copying activity/row/carrier/density/device verbatim —
// never re-resolved, same "this is the same physical visit continuing"
// convention break/end's resume logic and breakReconciliation.ts's "after"
// segment already use. Modeled directly on breakReconciliation.ts: a
// per-employee, idempotent function called both at request time
// (mobileTime.ts's serializeStatus, inputs.ts's GET /daily) and from a
// scheduled sweep (runMidnightRolloverSweep, cli/midnightRolloverRun.ts) —
// the exact same function either way, so there is only ever one code path
// that can create a rollover row.
import crypto from "crypto";
import { Pool, PoolClient } from "pg";
import { pool } from "../db";
import { lockEmployeeForManualEntry } from "./manualTimeEntries";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "./timezone";
import { getOrgSettings } from "./longOpenShiftAlerts";
import { RUNAWAY_SHIFT_AUTO_CUTOFF_REASON, computeSafetyCutoffBoundary, findGenuineAnchor } from "./runawayShiftAutoCutoff";

export const MIDNIGHT_ROLLOVER_REASON = "midnight_rollover";

// Exported for midnightRollover.test.ts — pure timestamp math, no DB needed
// (same convention as dailyCutoff.ts's computeCutoffAt). The shared
// boundary timestamp used verbatim as both the closing entry's ended_at
// and the continuation's started_at: the next local midnight after the
// entry's own local start date, via the same DST-aware convergence-loop
// conversion getDayBoundsUtc already uses everywhere else in this codebase.
export function computeRolloverBoundary(startedAtLocalDate: string): Date {
  return getDayBoundsUtc(startedAtLocalDate).end;
}

interface OpenEntryRow {
  id: string;
  entry_type: "work" | "break";
  activity_id: string | null;
  device_id: string | null;
  started_at: string;
  greenhouse_row_id: string | null;
  carrier_id: string | null;
  density_type: "plants" | "stems" | null;
  density_count_per_row: number | null;
  break_profile_item_id: string | null;
  scheduled_break_date: string | null;
  is_paid: boolean | null;
  // Needed only for the runaway-shift safety-cutoff check below (see
  // findGenuineAnchor) — every other field above is copied forward into
  // each rollover continuation; these three are read-only context for the
  // CURRENT open row, never copied.
  source: string;
  created_by_employee_id: string | null;
  created_at: string;
}

// Deterministic per (employee, boundary, entry type) — the task's "use
// deterministic idempotency" requirement, and a real DB-level backstop: two
// concurrent attempts to roll the SAME employee across the SAME boundary
// (e.g. a bug that let the advisory lock below be bypassed) collide on
// time_entries' existing unique idempotency_key index and one becomes a
// true no-op, exactly like openEntry()'s own `on conflict (idempotency_key)
// do nothing` already relies on for real taps. Not a security-sensitive
// value (never exposed to a client) — sha256 truncated to 32 hex chars,
// reformatted into UUID grouping, is sufficient; no need for a real UUIDv5
// namespace implementation.
function deterministicRolloverIdempotencyKey(employeeId: string, boundaryIso: string, entryType: string): string {
  const hex = crypto
    .createHash("sha256")
    .update(`midnight_rollover:${employeeId}:${boundaryIso}:${entryType}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function getOpenEntryForUpdate(client: PoolClient, employeeId: string): Promise<OpenEntryRow | null> {
  const { rows } = await client.query(
    `select id, entry_type, activity_id, device_id, started_at, greenhouse_row_id, carrier_id,
            density_type, density_count_per_row, break_profile_item_id,
            to_char(scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date, is_paid,
            source, created_by_employee_id, created_at
     from time_entries
     where employee_id = $1 and ended_at is null and deleted_at is null
     for update`,
    [employeeId]
  );
  return rows[0] ?? null;
}

// Same shape as getOpenEntryForUpdate but no lock/transaction — used for the
// cheap up-front check (is a safety cutoff or a rollover hop even plausibly
// due?) that decides whether reconcileMidnightRollover needs to take the
// advisory lock at all. Never trusted for a real mutation decision on its
// own — every actual write re-fetches FOR UPDATE and re-validates first.
async function getOpenEntryUnlocked(db: Pool, employeeId: string): Promise<OpenEntryRow | null> {
  const { rows } = await db.query(
    `select id, entry_type, activity_id, device_id, started_at, greenhouse_row_id, carrier_id,
            density_type, density_count_per_row, break_profile_item_id,
            to_char(scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date, is_paid,
            source, created_by_employee_id, created_at
     from time_entries
     where employee_id = $1 and ended_at is null and deleted_at is null`,
    [employeeId]
  );
  return rows[0] ?? null;
}

async function computeCutoffBoundaryFor(
  db: Pool | PoolClient,
  employeeId: string,
  open: OpenEntryRow
): Promise<{ anchorAt: Date; cutoffBoundary: Date }> {
  const { autoSafetyCutoffThresholdHours } = await getOrgSettings();
  const { anchorAt } = await findGenuineAnchor(db, employeeId, {
    id: open.id,
    entryType: open.entry_type,
    source: open.source,
    createdByEmployeeId: open.created_by_employee_id,
    startedAt: new Date(open.started_at),
    endedAt: null,
    createdAt: new Date(open.created_at),
  });
  return { anchorAt, cutoffBoundary: computeSafetyCutoffBoundary(anchorAt, autoSafetyCutoffThresholdHours) };
}

// Closes the given open entry at the safety-cutoff boundary and records the
// audit trail — never creates a replacement/continuation row (unlike an
// ordinary rollover hop): this is a genuine stop, not a boundary hop. Caller
// already holds the per-employee advisory lock and has re-validated `open`
// is still the current open row under FOR UPDATE.
async function applySafetyCutoff(
  client: PoolClient,
  employeeId: string,
  open: OpenEntryRow,
  cutoffBoundary: Date,
  anchorAt: Date
): Promise<void> {
  // time_entries has a hard DB constraint (chk_time_entries_ended_after_started,
  // 040_fix_break_end_ordering.sql) that ended_at must be STRICTLY after
  // started_at — a zero-length row is treated as unrecoverable garbage in
  // this codebase, not a valid edge case. A threshold lowered after the
  // chain already started, or (the common real-world shape: a chain that's
  // been running so long its own current segment's started_at is already
  // past the computed boundary — see runawayShiftAutoCutoff.ts's header)
  // both need a floor of started_at + 1ms, never started_at itself. This is
  // a deliberate sentinel-short duration, not a real measurement — exactly
  // why the row is simultaneously marked safety_cutoff_at/genuine_anchor_at
  // and surfaced in the needs-review queue for a human to replace with the
  // real end time via Dashboard End Work.
  const closeAt = new Date(Math.max(cutoffBoundary.getTime(), new Date(open.started_at).getTime() + 1));
  await client.query(
    `update time_entries set ended_at = $2, safety_cutoff_at = $2, genuine_anchor_at = $3 where id = $1`,
    [open.id, closeAt, anchorAt]
  );
  await client.query(
    `insert into time_entry_corrections
       (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
     values ($1, $2, null, 'ended_at', 'null', $3, $4)`,
    [open.id, employeeId, closeAt.toISOString(), RUNAWAY_SHIFT_AUTO_CUTOFF_REASON]
  );
}

// Caps how many boundaries a single call will walk — several genuinely
// missed days reconstruct correctly in one call (well under this), but an
// entry that's somehow gone unreconciled for months/years (a real incident:
// confirmed against an orphaned QA fixture left open since 2019 by an
// unrelated crashed test) must never turn one request or sweep tick into a
// multi-thousand-row, multi-thousand-round-trip transaction — that starves
// the connection pool for every other concurrent request and risks a
// statement timeout that aborts the whole batch, undoing even the hops that
// did succeed. Deliberately smaller than dailyCutoff's own
// DAILY_CUTOFF_STALE_DAYS (3): if an entry is EVER still this far behind,
// something upstream is badly broken and dailyCutoff's outer fallback
// should hard-close it rather than have rollover keep making bounded,
// partial, forever-incomplete progress against it. For the ordinary case
// (a device reconnecting after a normal offline stretch), this limit is
// never reached — hitting it always means the outer fallback is about to
// take over anyway. A capped call leaves the entry open at whatever
// boundary it reached; the NEXT call (request-time or scheduled) simply
// continues from there, exactly like any other partial/resumable progress
// in this function.
const MAX_ROLLOVER_HOPS_PER_CALL = 30;

// Rolls forward every local midnight boundary this employee's open entry is
// currently behind on, up to MAX_ROLLOVER_HOPS_PER_CALL — one iteration per
// missed midnight, so several missed days reconstruct correctly in one
// call, not just the most recent one. Cheap no-op (no lock taken) when
// there's nothing to do, which is the overwhelming majority of calls: this
// runs on every mobile request and Inputs load, exactly like
// breakReconciliation.reconcileEmployeeBreaks.
// Reported back to the scheduled sweep (runMidnightRolloverSweep) purely
// for its own cron-run summary log — no caller depends on this for
// correctness, since every actual decision is already final by the time
// this returns. "no_action" covers both "there was nothing open" and "an
// ordinary open shift with nothing due yet," which the sweep's own log
// doesn't need to further distinguish.
export type ReconcileOutcome = "no_action" | "rolled_over" | "cut_off";

export async function reconcileMidnightRollover(employeeId: string): Promise<ReconcileOutcome> {
  // Unlocked pre-check first — real correctness comes from the lock+recheck
  // below, this just avoids opening a transaction/taking the advisory lock
  // for the common case (the large majority of calls): nothing open, or
  // what's open neither needs a midnight hop today NOR has already crossed
  // the runaway-shift safety-cutoff boundary.
  //
  // The safety-cutoff half of this check can't be skipped just because the
  // open row "belongs to today" the way the old rollover-only check could —
  // that's exactly the bug this mechanism exists to fix: a chain that
  // rolled over last night has a `started_at` from today even when the
  // TRUE chain has been running, genuinely untouched, for days (see
  // runawayShiftAutoCutoff.ts). So every call with something open pays for
  // one chain walk + two cheap indexed aggregate queries (findGenuineAnchor)
  // to answer "is this actually stale," even when nothing else needs to
  // happen — there is no cheaper test that stays correct.
  const peeked = await getOpenEntryUnlocked(pool, employeeId);
  if (!peeked) return "no_action";
  const todayLocal = calendarDateInAppTimezone(new Date());
  const hopDue = calendarDateInAppTimezone(new Date(peeked.started_at)) < todayLocal;
  const { cutoffBoundary: peekedCutoffBoundary } = await computeCutoffBoundaryFor(pool, employeeId, peeked);
  const cutoffDue = peekedCutoffBoundary.getTime() <= Date.now();
  if (!hopDue && !cutoffDue) return "no_action";

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Same "existing employee advisory lock" every other manual/system
    // time_entries mutation in this codebase serializes through
    // (manualTimeEntries.ts) — a concurrent scheduled sweep and a
    // request-time call for the same employee block on each other here;
    // whichever commits first leaves nothing for the other to do.
    await lockEmployeeForManualEntry(client, employeeId);

    const open = await getOpenEntryForUpdate(client, employeeId);
    if (!open) {
      // Closed by whoever we were blocked behind (End Work, a concurrent
      // reconcile, this same safety cutoff already applied) — nothing left
      // to do.
      await client.query("commit");
      return "no_action";
    }

    // Re-derived under the lock, not trusted from the unlocked pre-check
    // above — state may have changed while this call waited for the lock.
    const { anchorAt, cutoffBoundary } = await computeCutoffBoundaryFor(client, employeeId, open);

    if (cutoffBoundary.getTime() <= Date.now()) {
      // The chain has gone longer than the configured threshold since its
      // last genuine action anywhere in it — stop here. No further
      // continuation is created (unlike an ordinary hop below): ending the
      // chain, not extending it, is the whole point of this branch.
      await applySafetyCutoff(client, employeeId, open, cutoffBoundary, anchorAt);
      await client.query("commit");
      return "cut_off";
    }

    // Not yet past the safety threshold — proceed with the ordinary
    // midnight-rollover hop loop exactly as before. Every hop boundary
    // created below is, by construction, no later than "now," and
    // cutoffBoundary is already known to be later than "now" at this point
    // — so cutoffBoundary is guaranteed later than every boundary this loop
    // could possibly create; there is nothing left to re-check per hop.
    let hopOpen: OpenEntryRow | null = open;
    let hopsExecuted = 0;
    // Recomputed on every iteration (not captured once) — a sweep that
    // straddles local midnight itself, or a call that's been queued behind
    // the lock for a while, must still classify every boundary correctly.
    for (let hops = 0; hops < MAX_ROLLOVER_HOPS_PER_CALL; hops++) {
      const open = hopOpen;
      if (!open) break;
      const currentTodayLocal = calendarDateInAppTimezone(new Date());
      const startedLocalDate = calendarDateInAppTimezone(new Date(open.started_at));
      if (startedLocalDate >= currentTodayLocal) break;

      // The shared boundary timestamp — used verbatim as both the closed
      // entry's ended_at and the continuation's started_at, so there is no
      // gap or overlap. Never rounded: roundWorkStart/roundWorkEnd/
      // roundBreak are for real taps only (see mobileTime.ts), and are
      // never called anywhere in this file.
      const boundary = computeRolloverBoundary(startedLocalDate);
      const idempotencyKey = deterministicRolloverIdempotencyKey(employeeId, boundary.toISOString(), open.entry_type);

      await client.query(`update time_entries set ended_at = $2 where id = $1`, [open.id, boundary]);
      await client.query(
        `insert into time_entry_corrections
           (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, null, 'ended_at', 'null', $3, $4)`,
        [open.id, employeeId, boundary.toISOString(), MIDNIGHT_ROLLOVER_REASON]
      );

      const inserted = await client.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at,
            break_profile_item_id, scheduled_break_date, source, is_paid,
            greenhouse_row_id, carrier_id, density_type, density_count_per_row, rollover_of_entry_id)
         values ($1, $2, $3, $4, $5, $6, null, $7, $8, 'midnight_rollover', $9, $10, $11, $12, $13, $14)
         on conflict (idempotency_key) do nothing
         returning id, entry_type, activity_id, device_id, started_at, greenhouse_row_id, carrier_id,
                   density_type, density_count_per_row, break_profile_item_id,
                   to_char(scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date, is_paid,
                   source, created_by_employee_id, created_at`,
        [
          employeeId,
          open.device_id,
          open.entry_type,
          open.activity_id,
          idempotencyKey,
          boundary,
          open.break_profile_item_id,
          open.scheduled_break_date,
          open.is_paid,
          open.greenhouse_row_id,
          open.carrier_id,
          open.density_type,
          open.density_count_per_row,
          open.id,
        ]
      );

      let next = inserted.rows[0] as OpenEntryRow | undefined;
      if (!next) {
        // Lost a race against an already-applied rollover for this exact
        // boundary (the advisory lock should make this unreachable in
        // practice — defense in depth only) — read back whatever is
        // actually open now and continue from there.
        next = (await getOpenEntryForUpdate(client, employeeId)) ?? undefined;
        if (!next) break;
      }
      hopOpen = next;
      hopsExecuted++;
    }

    await client.query("commit");
    return hopsExecuted > 0 ? "rolled_over" : "no_action";
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface RolloverSweepResult {
  // Every employee with a currently open entry — not just the ones that
  // turned out to need action; see this function's own comment on why the
  // candidate set can't be narrowed further upfront.
  candidateEmployees: number;
  // Ordinary midnight-boundary hop(s) applied — a shift genuinely spanning
  // midnight, continuing normally.
  rolledOver: number;
  // The runaway-shift safety cutoff fired instead of continuing the chain —
  // this employee now needs admin review (see runawayChainRecovery.ts).
  cutOff: number;
  // Nothing was due — an ordinary open shift with no midnight boundary to
  // cross yet and not past the safety-cutoff threshold.
  skipped: number;
  failures: number;
}

// Scheduled-job entry point (cli/midnightRolloverRun.ts) — reconciles every
// employee with a currently open entry through the exact same function
// request-time callers use. One employee's failure never aborts the sweep
// for the rest.
//
// Deliberately every open entry, not just ones behind on a midnight
// boundary (started_at < today) — an entry whose started_at IS today can
// still belong to a chain that's genuinely been running, untouched, for
// days (a prior night's rollover hop refreshes started_at without moving
// the true chain forward at all), and only reconcileMidnightRollover's own
// safety-cutoff check can tell the difference. Narrowing this candidate set
// back to "started before today" would silently exempt exactly the
// runaway chains this whole mechanism exists to catch from ever being swept
// by cron at all, leaving them dependent on someone happening to load that
// employee's Inputs/mobile view. reconcileMidnightRollover's own unlocked
// pre-check keeps the ordinary (non-stale, no hop due) case just as cheap
// as before.
export async function runMidnightRolloverSweep(): Promise<RolloverSweepResult> {
  const { rows } = await pool.query<{ employee_id: string }>(
    `select distinct employee_id from time_entries where ended_at is null and deleted_at is null`
  );

  let rolledOver = 0;
  let cutOff = 0;
  let skipped = 0;
  let failures = 0;
  for (const row of rows) {
    try {
      const outcome = await reconcileMidnightRollover(row.employee_id);
      if (outcome === "rolled_over") rolledOver++;
      else if (outcome === "cut_off") cutOff++;
      else skipped++;
    } catch (err) {
      failures++;
      console.error(
        `[midnight-rollover] failed to reconcile employeeId=${row.employee_id}:`,
        err instanceof Error ? err.message : "unknown error"
      );
    }
  }

  return { candidateEmployees: rows.length, rolledOver, cutOff, skipped, failures };
}
