// Shared overlap-detection for administrator-created manual entries (Add
// work start / Add break / Add activity — server/src/routes/inputs.ts).
// Every creation path funnels through the same check so "does this new
// entry conflict with something that already exists" is answered exactly
// once, not three slightly-different ways. Add Activity additionally uses
// planActivityInsertion below, which can resolve a boundary-only overlap by
// trimming the existing entry instead of rejecting outright — see its own
// comment.
import { Pool, PoolClient } from "pg";
import { formatTimeInAppTimezone } from "./timezone";

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
// a conflict error message; formatted in the organization's own local time
// (formatTimeInAppTimezone), same as every timestamp already shown
// elsewhere on the Inputs page — an administrator reading this message is
// always looking at one specific local day, so a raw UTC/ISO instant (e.g.
// "2026-08-14T10:45:00.000Z") would be actively misleading, not just
// unpolished.
export function describeConflict(conflict: ConflictingEntry): string {
  const kind = conflict.entryType === "work" ? "activity" : "break";
  if (!conflict.endedAt) return `an in-progress ${kind} that started at ${formatTimeInAppTimezone(conflict.startedAt)}`;
  return `an existing ${kind} from ${formatTimeInAppTimezone(conflict.startedAt)} to ${formatTimeInAppTimezone(conflict.endedAt)}`;
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

export interface ActivityTrim {
  id: string;
  field: "started_at" | "ended_at";
  oldValue: Date;
  newValue: Date;
}

export type ActivityInsertionPlan = { ok: true; trims: ActivityTrim[] } | { ok: false; error: string };

// Used only by POST /activities (Add Activity) for a BOUNDED new entry
// [start, end) — not by /work-start or /breaks, which keep their simpler
// reject-only behavior, and not for an open-ended (in-progress) new
// activity, which also keeps the plain findOverlappingEntry reject above.
//
// An admin's manual activity is authoritative for the time range they
// typed — inserting it should never be blocked just because it happens to
// land at the START or END of an existing entry (the common case: a
// forgotten-clock-in correction backdates the day's first activity, and
// the admin then needs to insert what the employee actually did before
// that entry's original start). So instead of rejecting on ANY overlap,
// every existing entry touching [start, end) is classified:
//
//   - a BREAK fully inside [start, end) is left alone, not a conflict at
//     all — an activity naturally has breaks inside it, and a break is
//     always a separate row, never a sub-range of a work entry's own span
//     (see activityRuns.ts), so nothing about it needs to change.
//   - a WORK entry whose boundary falls inside [start, end) but that
//     still extends past the new range on the OTHER side gets trimmed at
//     that one boundary (existing.ended_at = start, or
//     existing.started_at = end) — by construction always a strictly
//     positive remaining duration, since the untouched side is
//     guaranteed to still be on the far side of the trimmed boundary.
//   - anything that would require SPLITTING an existing entry (it starts
//     before AND extends past the new range — the new range sits
//     entirely inside it) or would require silently DELETING one (it's
//     entirely inside the new range) blocks the whole insertion instead —
//     this endpoint only ever trims one boundary, it never splits or
//     removes an entry, so production data (row/carrier/density,
//     row_completion_segments — all keyed by the entry's own untouched
//     id) is never at risk.
//   - any other break overlap (not fully inside the new range) also
//     blocks, unchanged from the previous behavior.
//
// If ANY entry resolves to a block, the whole request is rejected and
// NOTHING is trimmed — the caller applies trims only after this returns
// `ok: true` for every entry, so a mixed "one trimmable, one blocked"
// range never partially commits.
//
// Caller must run this inside a transaction and must already hold (or
// immediately take) `for update` locks on every returned trim's row —
// this function itself takes those locks (`order by started_at asc`,
// matching the chronological lock order every other multi-row-locking
// route in this file uses, so it can never deadlock against
// PATCH /breaks/:id or PATCH /work-start).
export async function planActivityInsertion(
  client: PoolClient,
  employeeId: string,
  start: Date,
  end: Date
): Promise<ActivityInsertionPlan> {
  const { rows } = await client.query(
    `select id, entry_type, started_at, ended_at from time_entries
     where employee_id = $1 and deleted_at is null
       and started_at < $3::timestamptz
       and (ended_at is null or ended_at > $2::timestamptz)
     order by started_at asc
     for update`,
    [employeeId, start, end]
  );

  const trims: ActivityTrim[] = [];
  for (const row of rows) {
    const rowStart = new Date(row.started_at);
    const rowEnd = row.ended_at ? new Date(row.ended_at) : null;
    const conflict: ConflictingEntry = { id: row.id, entryType: row.entry_type, startedAt: rowStart, endedAt: rowEnd };

    if (row.entry_type === "break") {
      const fullyInside = rowStart.getTime() >= start.getTime() && rowEnd !== null && rowEnd.getTime() <= end.getTime();
      if (fullyInside) continue;
      return { ok: false, error: `This time range conflicts with ${describeConflict(conflict)}. Resolve the existing entry first.` };
    }

    const startsBeforeNew = rowStart.getTime() < start.getTime();
    const endsAtOrBeforeNewEnd = rowEnd !== null && rowEnd.getTime() <= end.getTime();

    if (startsBeforeNew && !endsAtOrBeforeNewEnd) {
      // The existing activity starts before the new range and continues
      // (or stays open) past it — the new range sits entirely inside it.
      // Resolving this would require splitting the existing entry into a
      // before/after pair, which this endpoint doesn't do.
      return {
        ok: false,
        error: `This time range conflicts with ${describeConflict(
          conflict
        )} — it sits entirely inside that entry, which would need to be split into two, and that isn't supported here. Correct or delete the existing entry first.`,
      };
    }
    if (!startsBeforeNew && endsAtOrBeforeNewEnd) {
      // The existing activity starts at/after the new range's start and
      // ends at/before its end — the new range completely covers it.
      // Never silently deleted; the admin has to resolve it explicitly.
      return {
        ok: false,
        error: `This time range conflicts with ${describeConflict(
          conflict
        )} — it completely covers that entry. Delete or move that entry first; it won't be removed automatically.`,
      };
    }
    if (startsBeforeNew && endsAtOrBeforeNewEnd) {
      // New range overlaps the END of the existing activity.
      trims.push({ id: row.id, field: "ended_at", oldValue: rowEnd!, newValue: start });
    } else {
      // !startsBeforeNew && !endsAtOrBeforeNewEnd: new range overlaps the
      // BEGINNING of the existing activity — the reported bug's case.
      trims.push({ id: row.id, field: "started_at", oldValue: rowStart, newValue: end });
    }
  }

  return { ok: true, trims };
}
