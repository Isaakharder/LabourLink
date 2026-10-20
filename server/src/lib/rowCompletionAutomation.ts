// Automatic row completion: the moment an employee genuinely leaves a
// greenhouse row (switches to a different row, a different work activity,
// or ends their shift — see mobileTime.ts's openEntry() and its
// /time-entries/end-day hook), this creates (or extends) a row_completions
// record for the row they just left — no admin confirmation required. This
// sits ALONGSIDE the existing manual admin workflow (rowCompletions.ts),
// which still works exactly as before for anything this automation didn't
// already resolve.
//
// Re-entry handling ("was this row really finished?"): the moment the same
// or a different employee re-enters a row that already has an ACTIVE
// completion, within the same ~7-day row-work cycle
// (rowCompletionCandidates.ts's CYCLE_GAP_DAYS), markRowReopenedIfApplicable
// (called from openEntry()'s own insert step) flips that completion to
// 'reopened' — a status the report attribution query's `status = 'active'`
// filter does not match, so the row immediately stops counting as completed
// for the entire window the worker is back on it, exactly as if it had
// never been finished. The NEXT time that row is genuinely left again,
// completeRowVisitIfApplicable (below) finds it (its own lookup matches
// both 'active' and 'reopened'), gathers its segments plus every
// newly-unlinked matching segment in the same cycle, writes ONE new
// 'active' completion covering all of them, and marks the old one
// 'superseded' (never deleted — see migration 055). The physical row is
// counted exactly once per cycle either way.
//
// A visit in a NEW cycle (>7 calendar days after the active completion's
// own most recent segment) is left alone entirely — that completion stays
// exactly as it is, and a fresh completion is created for the new visit.
import { PoolClient } from "pg";
import { APP_TIMEZONE, calendarDateInAppTimezone, inclusiveDayCount } from "./timezone";

const CYCLE_GAP_DAYS = 7;

export interface ClosedRowVisit {
  activityId: string;
  greenhouseRowId: string;
  densityType: "plants" | "stems";
  densityCountPerRow: number;
  // The instant this employee's segment on this row was closed — used only
  // to anchor which row-work cycle this exit belongs to (APP_TIMEZONE
  // calendar date), never written to any row directly.
  endedAt: Date;
}

interface UnlinkedSegment {
  id: string;
  date: string;
  densityCountPerRow: number;
}

export interface OpenedRowVisit {
  activityId: string;
  greenhouseRowId: string;
  densityType: "plants" | "stems";
  // The instant this new segment was opened — used only to anchor which
  // row-work cycle it belongs to (APP_TIMEZONE calendar date), same as
  // ClosedRowVisit.endedAt above.
  startedAt: Date;
}

// Called from openEntry()'s own insert step, inside the SAME transaction,
// the moment a new work segment on a row is created — including the very
// first segment ever worked on it (a cheap no-op then: no 'active'
// completion exists yet to reopen). Flips an existing 'active' completion
// for this exact row+activity+density to 'reopened' if this new segment
// falls within the same ~7-day cycle as that completion's own latest
// segment — see the file-level comment above for why this must happen at
// ENTRY time rather than being deferred to the next exit like the combine
// step below.
export async function markRowReopenedIfApplicable(client: PoolClient, visit: OpenedRowVisit): Promise<void> {
  const anchorDate = calendarDateInAppTimezone(visit.startedAt, APP_TIMEZONE);

  // Locked for the same reason completeRowVisitIfApplicable locks its own
  // active-completion lookup: a concurrent exit on the same row (combining
  // and superseding this very completion) must not race with this reopen
  // flip. Whichever transaction gets here first wins; the other simply
  // observes the already-updated status once it proceeds.
  const { rows: activeRows } = await client.query(
    `select id from row_completions
     where greenhouse_row_id = $1 and activity_id = $2 and density_type = $3 and status = 'active'
     for update`,
    [visit.greenhouseRowId, visit.activityId, visit.densityType]
  );
  const active = activeRows[0] as { id: string } | undefined;
  if (!active) return;

  const { rows: latestRows } = await client.query(
    `select max(te.started_at) as latest_segment_started_at
     from row_completion_segments rcs
     join time_entries te on te.id = rcs.time_entry_id
     where rcs.row_completion_id = $1`,
    [active.id]
  );
  const latestSegmentStartedAt = latestRows[0]?.latest_segment_started_at;
  // No linked segments at all is not expected in practice (a completion is
  // never created without at least one), but guards against reopening on
  // no evidence rather than throwing.
  if (!latestSegmentStartedAt) return;
  const activeDate = calendarDateInAppTimezone(latestSegmentStartedAt, APP_TIMEZONE);
  // Beyond CYCLE_GAP_DAYS: this is a genuinely new, separate cycle for the
  // same physical row — the old completion stays exactly as it is (settled,
  // 'active'), and this new visit gets its own fresh completion once it is
  // eventually left, same as completeRowVisitIfApplicable's own cycle check.
  if (inclusiveDayCount(activeDate, anchorDate) > CYCLE_GAP_DAYS) return;

  await client.query(`update row_completions set status = 'reopened' where id = $1`, [active.id]);
}

// Called with the SAME client/transaction the caller used to close the
// employee's row — so a failure here rolls back the close too, and this
// can never observe (or create) a state where the row_entries close
// committed but the completion bookkeeping didn't, or vice versa.
export async function completeRowVisitIfApplicable(client: PoolClient, visit: ClosedRowVisit): Promise<void> {
  const anchorDate = calendarDateInAppTimezone(visit.endedAt, APP_TIMEZONE);

  // Every not-yet-linked, finished, non-deleted work segment anywhere for
  // this exact row+activity+density — across every employee, per the "it
  // must work when another employee continues the row" requirement. The
  // just-closed segment is always included here too (its own close already
  // committed within this same transaction before this function is
  // called), so it never needs special-casing alongside the rest.
  const { rows: unlinkedRows } = await client.query(
    `select te.id, te.started_at, te.density_count_per_row
     from time_entries te
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.greenhouse_row_id = $1 and te.activity_id = $2 and te.density_type = $3
       and te.entry_type = 'work' and te.deleted_at is null and te.ended_at is not null
       and rcs.time_entry_id is null
     order by te.started_at`,
    [visit.greenhouseRowId, visit.activityId, visit.densityType]
  );
  const unlinked: UnlinkedSegment[] = unlinkedRows.map((r) => ({
    id: r.id,
    date: calendarDateInAppTimezone(r.started_at, APP_TIMEZONE),
    densityCountPerRow: Number(r.density_count_per_row),
  }));

  // Same-cycle grouping as rowCompletionCandidates.ts's assignCycleIndexes —
  // candidates within CYCLE_GAP_DAYS of the PRECEDING one (chronologically)
  // stay one cycle. Only the LAST cycle (the one the just-closed visit's own
  // segment belongs to, since it was just inserted and is therefore always
  // chronologically last) is combined here; an older, separate cycle's
  // leftover unlinked segments are left alone.
  let lastCycleStart = 0;
  for (let i = 1; i < unlinked.length; i++) {
    if (inclusiveDayCount(unlinked[i - 1].date, unlinked[i].date) > CYCLE_GAP_DAYS) {
      lastCycleStart = i;
    }
  }
  const sameCycleSegments = unlinked.slice(lastCycleStart);

  // Reject any segment whose OWN frozen density count disagrees with this
  // visit's — a config change mid-cycle means those segments genuinely
  // aren't the same measurement and must not be silently blended into one
  // completion's quantity. Left unlinked; a later, consistent exit (or the
  // existing manual admin review) can still resolve them.
  const consistentSegmentIds = sameCycleSegments
    .filter((s) => s.densityCountPerRow === visit.densityCountPerRow)
    .map((s) => s.id);
  if (consistentSegmentIds.length === 0) return;

  // Is there already an ACTIVE (or REOPENED — see markRowReopenedIfApplicable
  // above) completion for this exact row+activity+type? Both are treated
  // identically here: whichever one exists is this row's current, not-yet-
  // finalized completion, and gets combined/superseded exactly the same way.
  // Locked so a concurrent exit on the same row (a genuine race between two
  // employees, or a retried event) can't both try to supersede it at once.
  // Postgres rejects FOR UPDATE combined with GROUP BY, so the lock (a
  // plain, unaggregated lookup) and the "latest linked segment" aggregate
  // are necessarily two separate queries — the row is already locked by
  // the time the second one runs, so no race is introduced between them.
  const { rows: activeRows } = await client.query(
    `select id from row_completions
     where greenhouse_row_id = $1 and activity_id = $2 and density_type = $3 and status in ('active', 'reopened')
     for update`,
    [visit.greenhouseRowId, visit.activityId, visit.densityType]
  );
  const active = activeRows[0] as { id: string } | undefined;

  let priorSegmentIds: string[] = [];
  let priorCompletionId: string | null = null;
  if (active) {
    const { rows: latestRows } = await client.query(
      `select max(te.started_at) as latest_segment_started_at
       from row_completion_segments rcs
       join time_entries te on te.id = rcs.time_entry_id
       where rcs.row_completion_id = $1`,
      [active.id]
    );
    // The completion's OWN latest linked segment's date — not
    // completed_at, which for a MANUALLY confirmed completion (admin
    // Review modal, possibly days or weeks after the work itself) can be
    // far later than when the work actually happened, and would otherwise
    // make an unrelated, long-settled completion look like the same cycle
    // as a re-entry that happens to arrive soon after the admin got around
    // to confirming it.
    const activeDate = calendarDateInAppTimezone(latestRows[0].latest_segment_started_at, APP_TIMEZONE);
    // Same cycle as this exit — genuine re-entry evidence; combine. A gap
    // beyond CYCLE_GAP_DAYS means the active completion is an unrelated,
    // already-settled earlier cycle — left untouched.
    if (inclusiveDayCount(activeDate, anchorDate) <= CYCLE_GAP_DAYS) {
      const { rows: segRows } = await client.query(`select time_entry_id from row_completion_segments where row_completion_id = $1`, [
        active.id,
      ]);
      priorSegmentIds = segRows.map((r) => r.time_entry_id as string);
      priorCompletionId = active.id;
    }
  }

  const finalSegmentIds = [...new Set([...priorSegmentIds, ...consistentSegmentIds])];
  if (finalSegmentIds.length === 0) return;

  const { rows: created } = await client.query(
    `insert into row_completions (greenhouse_row_id, activity_id, density_type, quantity_per_row, status, source)
     values ($1, $2, $3, $4, 'active', 'automatic')
     returning id`,
    [visit.greenhouseRowId, visit.activityId, visit.densityType, visit.densityCountPerRow]
  );
  const newCompletionId = created[0].id;

  if (priorCompletionId) {
    // Relink the prior completion's own segments onto the new one (never a
    // delete+reinsert — time_entry_id's PRIMARY KEY on this table already
    // guarantees a segment is claimed by at most one completion at a time,
    // so a plain UPDATE of the FK is all moving it requires) and mark the
    // old record superseded — permanent audit trail, never deleted.
    await client.query(`update row_completion_segments set row_completion_id = $1 where row_completion_id = $2`, [
      newCompletionId,
      priorCompletionId,
    ]);
    await client.query(`update row_completions set status = 'superseded', superseded_by_completion_id = $1 where id = $2`, [
      newCompletionId,
      priorCompletionId,
    ]);
    // Only the genuinely NEW segments (not already linked to the prior
    // completion) still need inserting.
    const newOnly = consistentSegmentIds.filter((id) => !priorSegmentIds.includes(id));
    if (newOnly.length > 0) {
      await client.query(`insert into row_completion_segments (time_entry_id, row_completion_id) select unnest($1::uuid[]), $2`, [
        newOnly,
        newCompletionId,
      ]);
    }
  } else {
    await client.query(`insert into row_completion_segments (time_entry_id, row_completion_id) select unnest($1::uuid[]), $2`, [
      consistentSegmentIds,
      newCompletionId,
    ]);
  }
}
