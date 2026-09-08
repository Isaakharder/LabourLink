// Midnight cutoff: an employee's shift may never cross local midnight. The
// moment local midnight passes, whatever time_entries row is still open for
// that employee is closed EXACTLY at that boundary — never continued. If
// the employee is genuinely still working, they must explicitly press
// Start Work again and pick/resume an activity; nothing here ever creates a
// successor row.
//
// This replaces an earlier "midnight rollover" design (still visible in
// historical data: time_entries.source = 'midnight_rollover',
// rollover_of_entry_id — see migration 049) that closed-and-immediately-
// reopened an equivalent row so a genuine overnight shift read as one
// continuous visit. That design let a shift silently run for days with a
// dead/offline device and zero real activity (a real incident: 5 employees
// found stuck 57-105 hours, see the 2026-09 investigation). Rather than
// detecting and stopping such a chain after the fact, this design prevents
// it from ever forming: nothing is ever continued, so there is no chain to
// silently run away. A visit genuinely spanning local midnight now reads as
// two disconnected runs from here on — the accepted trade-off for never
// letting an abandoned shift run indefinitely.
//
// Per-employee, idempotent function called both at request time
// (mobileTime.ts's serializeStatus, inputs.ts's GET /daily) and from a
// scheduled sweep (runMidnightCutoffSweep, cli/midnightCutoffRun.ts) — the
// exact same function either way, so there is only ever one code path that
// can close an entry at a midnight boundary.
import { PoolClient } from "pg";
import { pool } from "../db";
import { lockEmployeeForManualEntry } from "./manualTimeEntries";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "./timezone";

export const MIDNIGHT_CUTOFF_REASON = "midnight_cutoff";

// Exported for midnightCutoff.test.ts — pure timestamp math, no DB needed
// (same convention as dailyCutoff.ts's computeCutoffAt). The next local
// midnight after the entry's own local start date — used verbatim as the
// entry's ended_at, so the close instant is always exact.
export function computeMidnightCutoffBoundary(startedAtLocalDate: string): Date {
  return getDayBoundsUtc(startedAtLocalDate).end;
}

interface OpenEntryRow {
  id: string;
  started_at: string;
}

async function getOpenEntryForUpdate(client: PoolClient, employeeId: string): Promise<OpenEntryRow | null> {
  const { rows } = await client.query(
    `select id, started_at from time_entries
     where employee_id = $1 and ended_at is null and deleted_at is null
     for update`,
    [employeeId]
  );
  return rows[0] ?? null;
}

// Same shape as getOpenEntryForUpdate but no lock/transaction — used for the
// cheap up-front check that decides whether reconcileMidnightCutoff needs to
// take the advisory lock at all. Never trusted for a real mutation decision
// on its own — the real write re-fetches FOR UPDATE and re-validates first.
async function getOpenEntryUnlocked(employeeId: string): Promise<OpenEntryRow | null> {
  const { rows } = await pool.query(
    `select id, started_at from time_entries
     where employee_id = $1 and ended_at is null and deleted_at is null`,
    [employeeId]
  );
  return rows[0] ?? null;
}

export type ReconcileOutcome = "no_action" | "cut_off";

// Closes this employee's open entry at the local midnight immediately
// following its OWN started_at, whenever that boundary has already passed —
// regardless of how late this call itself runs. A three-day-old entry
// (a delayed cron, a device that only just reconnected) closes at the
// FIRST midnight after its own start, not "now" and not a chain of hops:
// there is nothing to continue, so there is only ever one thing to do.
// Cheap no-op (no lock taken) when there's nothing to do, which is the
// overwhelming majority of calls: this runs on every mobile request and
// Inputs load, exactly like breakReconciliation.reconcileEmployeeBreaks.
export async function reconcileMidnightCutoff(employeeId: string): Promise<ReconcileOutcome> {
  const peeked = await getOpenEntryUnlocked(employeeId);
  if (!peeked) return "no_action";
  const todayLocal = calendarDateInAppTimezone(new Date());
  if (calendarDateInAppTimezone(new Date(peeked.started_at)) >= todayLocal) return "no_action";

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
      // reconcile) — nothing left to do.
      await client.query("commit");
      return "no_action";
    }

    // Re-derived under the lock, not trusted from the unlocked pre-check
    // above — state may have changed while this call waited for the lock.
    const currentTodayLocal = calendarDateInAppTimezone(new Date());
    const startedLocalDate = calendarDateInAppTimezone(new Date(open.started_at));
    if (startedLocalDate >= currentTodayLocal) {
      await client.query("commit");
      return "no_action";
    }

    const boundary = computeMidnightCutoffBoundary(startedLocalDate);
    await client.query(`update time_entries set ended_at = $2 where id = $1`, [open.id, boundary]);
    await client.query(
      `insert into time_entry_corrections
         (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
       values ($1, $2, null, 'ended_at', 'null', $3, $4)`,
      [open.id, employeeId, boundary.toISOString(), MIDNIGHT_CUTOFF_REASON]
    );
    // Deliberately no continuation row: no INSERT, no rollover_of_entry_id,
    // no idempotency key to generate — this is a stop, never a hop.

    await client.query("commit");
    return "cut_off";
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface MidnightCutoffSweepResult {
  candidateEmployees: number;
  cutOff: number;
  skipped: number;
  failures: number;
}

// Scheduled-job entry point (cli/midnightCutoffRun.ts) — reconciles every
// employee with a currently open entry through the exact same function
// request-time callers use. One employee's failure never aborts the sweep
// for the rest.
export async function runMidnightCutoffSweep(): Promise<MidnightCutoffSweepResult> {
  const { rows } = await pool.query<{ employee_id: string }>(
    `select distinct employee_id from time_entries where ended_at is null and deleted_at is null`
  );

  let cutOff = 0;
  let skipped = 0;
  let failures = 0;
  for (const row of rows) {
    try {
      const outcome = await reconcileMidnightCutoff(row.employee_id);
      if (outcome === "cut_off") cutOff++;
      else skipped++;
    } catch (err) {
      failures++;
      console.error(
        `[midnight-cutoff] failed to reconcile employeeId=${row.employee_id}:`,
        err instanceof Error ? err.message : "unknown error"
      );
    }
  }

  return { candidateEmployees: rows.length, cutOff, skipped, failures };
}
