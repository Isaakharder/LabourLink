// Shared overlap-detection for administrator-created manual entries (Add
// work start / Add break / Add activity — server/src/routes/inputs.ts).
// Every creation path funnels through the same check so "does this new
// entry conflict with something that already exists" is answered exactly
// once, not three slightly-different ways.
import { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface ConflictingEntry {
  id: string;
  entryType: "work" | "break";
  startedAt: Date;
  endedAt: Date | null;
}

// The first existing (non-deleted) entry for this employee whose range
// intersects [start, end) — end === null means "open-ended, extends
// forward indefinitely," used both for a newly-created open entry (nothing
// may exist at or after its start) and for matching an existing entry
// that's itself still open (its own range is unbounded forward). Touching
// exactly at a boundary is NOT a conflict — start equal to an existing
// entry's end, or end equal to an existing entry's start, is the ordinary
// "back to back" case every correction route elsewhere in this app already
// treats as valid, not overlapping. excludeId lets a correction path (not
// currently used by the create-only callers below, but kept for symmetry
// with the rest of this file's conventions) check against everything
// except the row being corrected.
export async function findOverlappingEntry(
  db: Queryable,
  employeeId: string,
  start: Date,
  end: Date | null,
  excludeId?: string
): Promise<ConflictingEntry | null> {
  const { rows } = await db.query(
    `select id, entry_type, started_at, ended_at from time_entries
     where employee_id = $1 and deleted_at is null
       and ($4::uuid is null or id <> $4)
       and started_at < coalesce($3::timestamptz, 'infinity'::timestamptz)
       and (ended_at is null or ended_at > $2::timestamptz)
     order by started_at asc
     limit 1`,
    [employeeId, start, end, excludeId ?? null]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    entryType: row.entry_type,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
  };
}

// "8:00 AM to 9:15 AM" / "8:00 AM (still in progress)" — plain English for
// a conflict error message; not locale/timezone-aware formatting (that
// happens client-side for display elsewhere), just enough to let an
// administrator recognize which existing entry they collided with without
// a second lookup.
export function describeConflict(conflict: ConflictingEntry): string {
  const kind = conflict.entryType === "work" ? "activity" : "break";
  if (!conflict.endedAt) return `an in-progress ${kind} that started at ${conflict.startedAt.toISOString()}`;
  return `an existing ${kind} from ${conflict.startedAt.toISOString()} to ${conflict.endedAt.toISOString()}`;
}

// Serializes manual-entry creation per employee — there's no existing row
// to lock (the whole point is that one doesn't exist yet), so two
// near-simultaneous submissions for the same employee (a double-click, or
// two admins acting at once) could otherwise both pass the overlap check
// before either has inserted. An advisory lock scoped to the employee id
// closes that race without needing a range-exclusion constraint or a
// client-supplied idempotency key — held only for the duration of the
// transaction (`_xact_lock`), released automatically on commit/rollback.
export async function lockEmployeeForManualEntry(client: PoolClient, employeeId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1::text))", [employeeId]);
}
