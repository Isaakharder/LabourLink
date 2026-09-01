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
import { PoolClient } from "pg";
import { pool } from "../db";
import { lockEmployeeForManualEntry } from "./manualTimeEntries";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "./timezone";

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
            to_char(scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date, is_paid
     from time_entries
     where employee_id = $1 and ended_at is null and deleted_at is null
     for update`,
    [employeeId]
  );
  return rows[0] ?? null;
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
export async function reconcileMidnightRollover(employeeId: string): Promise<void> {
  // Unlocked peek first — real correctness comes from the lock+recheck
  // below, this just avoids opening a transaction/taking the advisory lock
  // for the common case where nothing is open, or what's open already
  // belongs to today.
  const peek = await pool.query(
    `select started_at from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
    [employeeId]
  );
  if (!peek.rows[0]) return;
  const todayLocal = calendarDateInAppTimezone(new Date());
  if (calendarDateInAppTimezone(new Date(peek.rows[0].started_at)) >= todayLocal) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Same "existing employee advisory lock" every other manual/system
    // time_entries mutation in this codebase serializes through
    // (manualTimeEntries.ts) — a concurrent scheduled sweep and a
    // request-time call for the same employee block on each other here;
    // whichever commits first leaves nothing for the other to do.
    await lockEmployeeForManualEntry(client, employeeId);

    let open = await getOpenEntryForUpdate(client, employeeId);
    // Recomputed on every iteration (not captured once) — a sweep that
    // straddles local midnight itself, or a call that's been queued behind
    // the lock for a while, must still classify every boundary correctly.
    for (let hops = 0; hops < MAX_ROLLOVER_HOPS_PER_CALL; hops++) {
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
                   to_char(scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date, is_paid`,
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
      open = next;
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface RolloverSweepResult {
  candidateEmployees: number;
  succeeded: number;
  failures: number;
}

// Scheduled-job entry point (cli/midnightRolloverRun.ts) — finds every
// employee with an open entry that's behind on at least one boundary and
// reconciles each in turn through the exact same function request-time
// callers use. One employee's failure never aborts the sweep for the rest.
export async function runMidnightRolloverSweep(): Promise<RolloverSweepResult> {
  const todayLocal = calendarDateInAppTimezone(new Date());
  const { start: todayStartUtc } = getDayBoundsUtc(todayLocal);
  const { rows } = await pool.query<{ employee_id: string }>(
    `select distinct employee_id from time_entries
     where ended_at is null and deleted_at is null and started_at < $1`,
    [todayStartUtc]
  );

  let succeeded = 0;
  let failures = 0;
  for (const row of rows) {
    try {
      await reconcileMidnightRollover(row.employee_id);
      succeeded++;
    } catch (err) {
      failures++;
      console.error(
        `[midnight-rollover] failed to reconcile employeeId=${row.employee_id}:`,
        err instanceof Error ? err.message : "unknown error"
      );
    }
  }

  return { candidateEmployees: rows.length, succeeded, failures };
}
