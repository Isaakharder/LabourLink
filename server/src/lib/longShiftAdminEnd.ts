// The "End Work" action an Administrator/Manager takes directly from a
// Dashboard long-open-shift alert (longOpenShiftAlerts.ts) — closes the
// employee's currently open work or break entry at an admin-confirmed exact
// time, instead of leaving it to the employee to eventually tap Finish Work
// themselves (see the 2026-08-31/09-01 Marcelino Besa incident this exists
// to give admins a safe, auditable recovery path for).
//
// Every rule below traces to that incident:
//  - Reconcile midnight boundaries FIRST (its own call, own lock/txn — see
//    reconcileMidnightRollover) so the entry being closed is always the
//    CURRENT segment, never a stale pre-rollover one.
//  - Same employee advisory lock as every other time_entries mutation
//    (manualTimeEntries.ts's lockEmployeeForManualEntry) — held for this
//    function's own transaction, taken AFTER reconciliation's own lock has
//    already been released, never nested inside it.
//  - Never creates a replacement/open continuation entry — this is a
//    genuine end of the workday, not a boundary hop.
//  - No automatic rounding — an administrator-entered correction is exact,
//    by definition never the ordinary tap-rounding path.
//  - Idempotent: if the entry is already closed (a race with the employee's
//    own device, or a duplicate click) this returns the already-finished
//    state instead of erroring or writing a second correction.
import { PoolClient } from "pg";
import { pool } from "../db";
import { lockEmployeeForManualEntry } from "./manualTimeEntries";
import { reconcileMidnightRollover } from "./midnightRollover";
import { walkShiftStart } from "./longOpenShiftAlerts";

export const LONG_SHIFT_ADMIN_END_REASON = "long_shift_admin_end";

export class LongShiftAdminEndError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongShiftAdminEndError";
  }
}

export interface EndLongOpenShiftResult {
  status: "ended" | "already_finished";
  employeeId: string;
  timeEntryId: string;
  entryType: "work" | "break";
  startedAtIso: string;
  endedAtIso: string;
}

interface OpenEntryRow {
  id: string;
  entry_type: "work" | "break";
  started_at: string;
}

async function mostRecentlyClosedEntry(
  client: PoolClient,
  employeeId: string
): Promise<{ id: string; entry_type: "work" | "break"; started_at: string; ended_at: string } | null> {
  const { rows } = await client.query(
    `select id, entry_type, started_at, ended_at from time_entries
     where employee_id = $1 and deleted_at is null and ended_at is not null
     order by ended_at desc limit 1`,
    [employeeId]
  );
  return rows[0] ?? null;
}

// Used by mobileTime.ts's sync-event processing: an offline event that was
// genuinely queued on the device before an admin used End Work, but only
// syncs afterward, must never silently reopen the day — see this module's
// own header. An event whose own occurred_at_utc falls at-or-before the
// most recent long_shift_admin_end correction's confirmed end time is
// exactly that case; anything genuinely later (a real new shift starting
// after the admin's correction) is unaffected.
export async function findMostRecentAdminEndCorrection(employeeId: string): Promise<{ endedAtIso: string } | null> {
  const { rows } = await pool.query<{ new_value: string }>(
    `select new_value from time_entry_corrections
     where employee_id = $1 and reason = $2
     order by changed_at desc limit 1`,
    [employeeId, LONG_SHIFT_ADMIN_END_REASON]
  );
  return rows[0] ? { endedAtIso: rows[0].new_value } : null;
}

// endedAt: the administrator-confirmed exact clock-out instant (defaults to
// "now" client-side, but may be any past time the admin enters). adminId:
// the acting Administrator/Manager, for the audit correction's
// changed_by_employee_id — never null here, unlike the system-generated
// midnight_rollover/dailyCutoff corrections.
export async function endLongOpenShift(employeeId: string, endedAt: Date, adminId: string): Promise<EndLongOpenShiftResult> {
  // Own call, own lock/transaction, committed before this function ever
  // takes its own lock below — never nested inside it. Cheap no-op in the
  // overwhelming majority of calls (nothing to reconcile).
  await reconcileMidnightRollover(employeeId);

  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockEmployeeForManualEntry(client, employeeId);

    const { rows } = await client.query<OpenEntryRow>(
      `select id, entry_type, started_at from time_entries
       where employee_id = $1 and ended_at is null and deleted_at is null
       for update`,
      [employeeId]
    );
    const open = rows[0];

    if (!open) {
      // Already ended — by the employee's own device, another admin tab, or
      // this exact request retried. Idempotent: report the current state,
      // never a duplicate correction.
      await client.query("commit");
      const last = await mostRecentlyClosedEntry(client, employeeId);
      if (!last) {
        throw new LongShiftAdminEndError("No open or recent time entry found for this employee.");
      }
      return {
        status: "already_finished",
        employeeId,
        timeEntryId: last.id,
        entryType: last.entry_type,
        startedAtIso: new Date(last.started_at).toISOString(),
        endedAtIso: new Date(last.ended_at).toISOString(),
      };
    }

    const startedAt = new Date(open.started_at);
    const shiftStart = await walkShiftStart(client, employeeId, startedAt);

    if (endedAt.getTime() <= shiftStart.getTime()) {
      await client.query("rollback");
      throw new LongShiftAdminEndError(
        `End time must be after this shift's true start (${shiftStart.toISOString()}).`
      );
    }

    const { rows: overlapRows } = await client.query(
      `select id from time_entries
       where employee_id = $1 and id <> $2 and deleted_at is null
         and started_at < $3 and (ended_at is null or ended_at > $4)`,
      [employeeId, open.id, endedAt, startedAt]
    );
    if (overlapRows.length > 0) {
      await client.query("rollback");
      throw new LongShiftAdminEndError("End time overlaps another time entry for this employee.");
    }

    // No rounding — this is an exact administrator-entered correction, never
    // the ordinary tap-rounding path (roundWorkEnd/roundBreak are never
    // called here). actual_ended_at is cleared: it exists to preserve a
    // real tap time distinct from a rounded stored value, and there is no
    // such distinction for this path — ended_at IS the real value.
    await client.query(`update time_entries set ended_at = $2, actual_ended_at = null where id = $1`, [open.id, endedAt]);
    await client.query(
      `insert into time_entry_corrections
         (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
       values ($1, $2, $3, 'ended_at', 'null', $4, $5)`,
      [open.id, employeeId, adminId, endedAt.toISOString(), LONG_SHIFT_ADMIN_END_REASON]
    );

    await client.query("commit");
    return {
      status: "ended",
      employeeId,
      timeEntryId: open.id,
      entryType: open.entry_type,
      startedAtIso: startedAt.toISOString(),
      endedAtIso: endedAt.toISOString(),
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
