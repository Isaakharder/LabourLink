import { pool } from "../db";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "./timezone";

// Safety net for a forgotten "End Work"/"End Day" action — entirely
// server-side, independent of any client (phone closed, charging
// overnight, no internet, nobody opens the Inputs page, no mobile request
// ever occurs again). Closes every open work/break entry whose LOCAL start
// date (in APP_TIMEZONE) is strictly before today's local date, backdating
// each to 23:59:59 local time on the day it actually started — never the
// day this job happens to run, and never a later day than the entry
// itself began. Never creates a new entry (no auto-resume): the employee
// simply shows idle and picks a job again.
export const CUTOFF_REASON = "Automatically closed at daily cutoff";

export interface CutoffCandidate {
  id: string;
  employeeId: string;
  employeeName: string;
  entryType: "work" | "break";
  startedAtIso: string;
  cutoffAtIso: string;
  durationSeconds: number;
}

export interface DailyCutoffResult {
  found: number;
  closed: number;
  skipped: number;
  failures: number;
  // Rows actually closed (or, in dryRun mode, rows that WOULD be closed —
  // computed via the exact same lock-and-recheck path, just rolled back
  // instead of committed, so a dry-run report can never drift from what a
  // real run would do).
  details: CutoffCandidate[];
}

// Exported for dailyCutoff.test.ts — pure timestamp math, no DB needed.
export function computeCutoffAt(startedAtLocalDate: string): Date {
  // "next local midnight" (getDayBoundsUtc's own end boundary) minus one
  // second — 23:59:59 local time on the day the entry started. Computed
  // from the timezone helpers' DST-aware conversion, never the server
  // machine's implicit timezone.
  return new Date(getDayBoundsUtc(startedAtLocalDate).end.getTime() - 1000);
}

// dryRun still locks and re-validates each candidate row (the only way the
// reported "would close" list can be guaranteed to match what a real run
// would actually do) but rolls back instead of committing, so nothing is
// ever persisted.
export async function runDailyCutoff(options: { dryRun?: boolean } = {}): Promise<DailyCutoffResult> {
  const dryRun = options.dryRun ?? false;

  // Unlocked, outside any transaction — just decides which rows are worth
  // attempting. Real correctness comes from the per-row lock+recheck
  // below, not from this list being perfectly fresh; two overlapping runs
  // (or a genuine employee action landing at the same instant) each work
  // from their own independently-taken snapshot of this list but can never
  // double-process the same row, since the lock+recheck step below only
  // ever proceeds if the row is *still* open at that moment.
  const { rows: candidates } = await pool.query<{
    id: string;
    employee_id: string;
    entry_type: "work" | "break";
    started_at: string;
    first_name: string;
    last_name: string;
  }>(
    `select te.id, te.employee_id, te.entry_type, te.started_at,
            e.first_name, e.last_name
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.ended_at is null and te.deleted_at is null
     order by te.started_at asc`
  );

  let closed = 0;
  let skipped = 0;
  let failures = 0;
  const details: CutoffCandidate[] = [];

  for (const candidate of candidates) {
    // Recomputed per-candidate (not captured once at function start) so a
    // long-running sweep that happens to straddle local midnight itself
    // still classifies every row correctly.
    const todayLocal = calendarDateInAppTimezone(new Date());
    const startedLocalDate = calendarDateInAppTimezone(new Date(candidate.started_at));
    if (startedLocalDate >= todayLocal) continue; // still within its own current local day

    const client = await pool.connect();
    try {
      await client.query("begin");

      const lockRes = await client.query(
        `select id, employee_id, entry_type, started_at, ended_at from time_entries
         where id = $1 and deleted_at is null for update`,
        [candidate.id]
      );
      const row = lockRes.rows[0];
      if (!row || row.ended_at !== null) {
        // Already closed — normally, or by a concurrent cutoff run — since
        // the candidate scan. Not a failure, just nothing left to do.
        await client.query(dryRun ? "rollback" : "commit");
        skipped++;
        continue;
      }

      // Re-derived from the freshly-locked row's own started_at, not the
      // (potentially stale) candidate snapshot — guarantees the cutoff
      // instant is always anchored to the entry's real recorded start.
      const rowStartedLocalDate = calendarDateInAppTimezone(new Date(row.started_at));
      const cutoffAt = computeCutoffAt(rowStartedLocalDate);

      if (!dryRun) {
        await client.query(`update time_entries set ended_at = $1, auto_closed_at = $1 where id = $2`, [
          cutoffAt,
          row.id,
        ]);
        await client.query(
          `insert into time_entry_corrections
             (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
           values ($1, $2, null, 'ended_at', $3, $4, $5)`,
          [row.id, row.employee_id, "null", cutoffAt.toISOString(), CUTOFF_REASON]
        );
      }

      await client.query(dryRun ? "rollback" : "commit");
      closed++;
      details.push({
        id: row.id,
        employeeId: row.employee_id,
        employeeName: `${candidate.first_name} ${candidate.last_name}`,
        entryType: row.entry_type,
        startedAtIso: new Date(row.started_at).toISOString(),
        cutoffAtIso: cutoffAt.toISOString(),
        durationSeconds: Math.round((cutoffAt.getTime() - new Date(row.started_at).getTime()) / 1000),
      });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      failures++;
      // Entry/employee ids only — never a device identifier or token.
      console.error(
        `[dailyCutoff] failed to close entry entryId=${candidate.id} employeeId=${candidate.employee_id}:`,
        err instanceof Error ? err.message : "unknown error"
      );
    } finally {
      client.release();
    }
  }

  return { found: candidates.length, closed, skipped, failures, details };
}
