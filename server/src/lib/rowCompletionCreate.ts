// Creates ONE confirmed row completion from a set of time entries — the
// validation and insert behind POST /api/row-completions (the individual
// Row Completion Review "Combine" action), factored out so the bulk speed
// review (POST /api/row-completions/bulk-review) applies exactly the same
// rules instead of a second copy that could drift.
//
// Runs inside the CALLER's transaction (never begins/commits itself), so a
// caller that creates several completions together (bulk "Keep separate")
// gets all-or-nothing for the whole set. Throws RowCompletionError for every
// expected refusal — the caller rolls back and reports `message` with
// `status`. Never touches time_entries: a completion only LINKS existing
// entries (row_completion_segments), so the original activity logs, rows,
// timestamps and frozen quantities are preserved untouched.
import { PoolClient } from "pg";
import { CandidateRun, getUnresolvedRunsForRow } from "./rowCompletionCandidates";
import { getRowReviewWindowDays } from "./rowReviewWindow";

export class RowCompletionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface CreatedRowCompletion {
  id: string;
  greenhouseRowId: string;
  activityId: string;
  densityType: "plants" | "stems";
  quantityPerRow: number;
  completedAt: string;
  segmentCount: number;
}

// opts (bulk review only): the Row review window and this row+activity+
// density's unresolved visits, already loaded once for the whole batch from
// the same committed state this function would otherwise re-read per call
// (getUnresolvedRunsForRow is several round trips over the row's history —
// ~1.3s per completion in production). The validation below is identical
// either way.
export async function createRowCompletion(
  client: PoolClient,
  timeEntryIds: string[],
  confirmedByEmployeeId: string,
  opts: { windowDays?: number; candidates?: CandidateRun[] } = {}
): Promise<CreatedRowCompletion> {
  const { rows } = await client.query(
    `select te.id, te.entry_type, te.deleted_at, te.ended_at, te.greenhouse_row_id, te.activity_id,
            te.density_type, te.density_count_per_row, rcs.time_entry_id as already_completed
     from time_entries te
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.id = any($1::uuid[])`,
    [timeEntryIds]
  );
  if (rows.length !== timeEntryIds.length) {
    throw new RowCompletionError(400, "One or more time entries were not found");
  }
  for (const r of rows) {
    if (r.entry_type !== "work" || r.deleted_at !== null) {
      throw new RowCompletionError(400, "Only active work entries can be combined");
    }
    if (r.ended_at === null) {
      throw new RowCompletionError(400, "An in-progress entry cannot be combined into a completed row");
    }
    if (!r.density_type || !r.density_count_per_row) {
      throw new RowCompletionError(400, "One or more entries have no resolvable row density");
    }
    if (r.already_completed) {
      throw new RowCompletionError(409, "One or more entries already belong to a completed row");
    }
  }
  const first = rows[0];
  const consistent = rows.every(
    (r) =>
      r.greenhouse_row_id === first.greenhouse_row_id &&
      r.activity_id === first.activity_id &&
      r.density_type === first.density_type &&
      Number(r.density_count_per_row) === Number(first.density_count_per_row)
  );
  if (!consistent) {
    throw new RowCompletionError(400, "Selected entries do not all refer to the same row, activity, and density");
  }

  // Row-work cycles (rowCompletionCandidates.ts's assignCycleIndexes, cut
  // at the Row review window setting): the same row+activity+density is no
  // longer one lifetime ambiguity group — a visit from months ago and one
  // from this week are unrelated passes over the row, so combining across
  // that gap must be refused the same way combining across two different
  // activities already is above. Reads via the shared pool (not `client`): it sees the
  // committed not-yet-completed state the review was built from, never
  // a sibling completion this same transaction inserted moments ago.
  const windowDays = opts.windowDays ?? (await getRowReviewWindowDays());
  const candidates =
    opts.candidates ??
    (await getUnresolvedRunsForRow(first.greenhouse_row_id, first.activity_id, first.density_type as "plants" | "stems", {
      windowDays,
    }));
  const candidateBySegmentId = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    for (const segId of c.segmentIds) candidateBySegmentId.set(segId, c);
  }
  const cycleIndexesUsed = new Set(timeEntryIds.map((id) => candidateBySegmentId.get(id)?.cycleIndex));
  if (cycleIndexesUsed.has(undefined)) {
    // An entry that's no longer a pending visit: most likely an overlapping
    // review resolved it between this transaction's first check and now.
    const { rows: nowCompleted } = await client.query(
      `select 1 from row_completion_segments where time_entry_id = any($1::uuid[]) limit 1`,
      [timeEntryIds]
    );
    if (nowCompleted.length > 0) {
      throw new RowCompletionError(409, "These visits were just resolved by another review — nothing was changed");
    }
  }
  if (cycleIndexesUsed.size > 1 || cycleIndexesUsed.has(undefined)) {
    throw new RowCompletionError(
      400,
      `Selected entries span more than one row-work cycle (${windowDays} or more calendar days apart) and cannot be combined together`
    );
  }
  // A visit is completed whole or not at all. Its segments (break
  // splits, carrier changes) are one physical pass over the row;
  // completing part of it would leave the rest as a second "visit" and
  // count the row's stems twice.
  const selected = new Set(timeEntryIds);
  const touchedVisits = new Set(timeEntryIds.map((id) => candidateBySegmentId.get(id)!));
  if ([...touchedVisits].some((c) => c.segmentIds.some((segId) => !selected.has(segId)))) {
    throw new RowCompletionError(400, "Selected entries include only part of a visit — select every segment of each visit");
  }

  const { rows: created } = await client.query(
    `insert into row_completions (greenhouse_row_id, activity_id, density_type, quantity_per_row, confirmed_by_employee_id)
     values ($1, $2, $3, $4, $5)
     returning id, greenhouse_row_id, activity_id, density_type, quantity_per_row, completed_at`,
    [first.greenhouse_row_id, first.activity_id, first.density_type, first.density_count_per_row, confirmedByEmployeeId]
  );
  const completion = created[0];

  // row_completion_segments' primary key is time_entry_id: an entry can
  // belong to one completion only. Two overlapping submissions for the same
  // visits can both pass the already_completed check above; the second
  // then blocks here until the first commits and fails on that key — a
  // clean refusal (its whole transaction rolls back), never a duplicate.
  try {
    await client.query(
      `insert into row_completion_segments (time_entry_id, row_completion_id)
       select unnest($1::uuid[]), $2`,
      [timeEntryIds, completion.id]
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new RowCompletionError(409, "These visits were just resolved by another review — nothing was changed");
    }
    throw err;
  }

  return {
    id: completion.id,
    greenhouseRowId: completion.greenhouse_row_id,
    activityId: completion.activity_id,
    densityType: completion.density_type,
    quantityPerRow: Number(completion.quantity_per_row),
    completedAt: completion.completed_at,
    segmentCount: timeEntryIds.length,
  };
}
