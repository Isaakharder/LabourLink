// Finds every not-yet-completed work run touching a given greenhouse row +
// activity + density type, across every employee — the shared logic behind
// both the "is this row ambiguous" check on every Inputs load (server/src/
// routes/inputs.ts) and the admin review modal's candidate list (server/src/
// routes/rowCompletions.ts). Reuses groupIntoActivityRuns per-employee-day
// (see below for why "per day", not just "per employee") so a break-split
// visit (two time_entries rows, one real visit) is correctly collapsed into
// one run, never miscounted as two separate visits to the row.
//
// Scoped by activity_id as well as row+density — NOT just the physical row
// and frozen density type. An ActivityRun (activityRuns.ts) is always
// single-activity by construction (an activity change starts a new run), so
// this is a safe, always-available third key. Without it, two completely
// independent activities that happen to share a row and density type (e.g.
// Picking Peppers and Winding & Pruning both freezing 'stems' on the same
// physical row) would be lumped into one ambiguity group: one activity's
// work could show up in the other's review modal, and confirming one could
// make the other's genuinely-separate, otherwise-unambiguous visit vanish
// from auto-counting (see 045_row_completion_activity_id.sql).
import { pool } from "../db";
import { groupIntoActivityRuns, RunSegment } from "./activityRuns";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "./timezone";

export interface CandidateRun {
  runId: string;
  segmentIds: string[];
  employeeId: string;
  employeeName: string;
  activityId: string;
  activityName: string;
  greenhouseRowId: string;
  rowLabel: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
}

export interface RowActivityDensityKey {
  greenhouseRowId: string;
  activityId: string;
  densityType: "plants" | "stems";
}

function pairKey(k: RowActivityDensityKey): string {
  return `${k.greenhouseRowId}:${k.activityId}:${k.densityType}`;
}

interface DayFetchRow {
  id: string;
  entry_type: "work" | "break";
  activity_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  greenhouse_row_id: string | null;
  carrier_id: string | null;
  density_type: "plants" | "stems" | null;
  density_count_per_row: number | null;
  is_resolved: boolean;
  rollover_of_entry_id: string | null;
}

// Batched form: computes candidates for MANY row+activity+density pairs in
// one pass. This is what getUnresolvedRunsForRow (below) is now a thin
// single-pair wrapper around.
//
// The single-pair version this replaced had a real N+1: called once per
// unresolved pair (inputs.ts's ambiguity check, reportQueries.ts's Reports/
// Stats/Dashboard attribution), and EVERY call independently re-ran its own
// "fetch this employee's whole day" query — even when several pairs shared
// the exact same employee+day (the common case: one busy employee's one
// busy day touching a dozen-plus rows). Measured against a real production
// day (60 entries, 14 unresolved row+activity+density pairs, all the same
// employee/day), that was 14 redundant whole-day fetches (plus 14 redundant
// row-label and employee-name lookups) where exactly 1 of each would do —
// GET /api/inputs/daily took ~5.6s, almost entirely spent on those
// redundant round trips (EXPLAIN ANALYZE confirmed each query itself runs
// in ~1ms; the cost is round-trip count, not query plan).
//
// Fixed here by computing every pair in one shot: one combined query finds
// every unresolved touch across every pair at once (a row-value IN list,
// not one query per pair), row-label/employee-name/activity-name lookups
// are each batched across every distinct row/employee/activity involved,
// and each distinct employee+day is fetched — and its runs computed — at
// most ONCE no matter how many requested pairs touch it, then every pair's
// candidates are filtered from that shared, already-computed run list.
export async function getUnresolvedRunsForRows(pairs: RowActivityDensityKey[]): Promise<Map<string, CandidateRun[]>> {
  const result = new Map<string, CandidateRun[]>();
  if (pairs.length === 0) return result;

  // Dedupe defensively — callers may already dedupe (inputs.ts's own
  // unresolvedPairs is a Map), but this must never do 2x the work if one
  // doesn't.
  const byKey = new Map<string, RowActivityDensityKey>();
  for (const p of pairs) byKey.set(pairKey(p), p);
  const dedupedPairs = [...byKey.values()];
  for (const p of dedupedPairs) result.set(pairKey(p), []);

  // Step 1: every unresolved work segment touching ANY of the requested
  // pairs, in a single round trip — the row-value form of "= ANY" lets
  // Postgres match all three columns together per candidate row, the same
  // way a single-pair query would, just for every pair at once.
  const { rows: touchRows } = await pool.query(
    `select te.employee_id, te.started_at
     from time_entries te
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.entry_type = 'work' and te.deleted_at is null
       and rcs.time_entry_id is null
       and (te.greenhouse_row_id, te.activity_id, te.density_type)
         in (select * from unnest($1::uuid[], $2::uuid[], $3::text[]))`,
    [dedupedPairs.map((p) => p.greenhouseRowId), dedupedPairs.map((p) => p.activityId), dedupedPairs.map((p) => p.densityType)]
  );
  if (touchRows.length === 0) return result; // every pair already seeded to [] above

  const daysByEmployee = new Map<string, Set<string>>();
  for (const r of touchRows) {
    const date = calendarDateInAppTimezone(r.started_at);
    const set = daysByEmployee.get(r.employee_id) ?? new Set<string>();
    set.add(date);
    daysByEmployee.set(r.employee_id, set);
  }

  // Step 2: row-label / employee-name / activity-name lookups, each batched
  // across every distinct id involved — once each, never once per pair.
  const distinctRowIds = [...new Set(dedupedPairs.map((p) => p.greenhouseRowId))];
  const rowInfoRes = await pool.query(
    `select gr.id, gr.row_number, gp.name as phase_name from greenhouse_rows gr
     join greenhouse_phases gp on gp.id = gr.phase_id where gr.id = any($1::uuid[])`,
    [distinctRowIds]
  );
  const rowLabelById = new Map(rowInfoRes.rows.map((r) => [r.id, `${r.phase_name} · Row ${r.row_number}`]));

  const employeeIds = [...daysByEmployee.keys()];
  const empRes = await pool.query(`select id, first_name, last_name from employees where id = any($1::uuid[])`, [employeeIds]);
  const employeeNameById = new Map(empRes.rows.map((r) => [r.id, `${r.first_name} ${r.last_name}`]));

  // Only ever looked up for a run whose root already matches one of the
  // requested pairs (see the final filter below), so the requested pairs'
  // own activity ids are the complete set this needs — never one query per
  // employee-day like the old per-day `left join activities` did.
  const distinctActivityIds = [...new Set(dedupedPairs.map((p) => p.activityId))];
  const activityRes = await pool.query(`select id, name from activities where id = any($1::uuid[])`, [distinctActivityIds]);
  const activityNameById = new Map(activityRes.rows.map((r) => [r.id, r.name]));

  // Step 3: fetch each distinct employee+day EXACTLY ONCE, concurrently — a
  // Map of in-flight promises keyed by employee+day is the dedup: a second
  // request for the same day while the first is still in flight reuses the
  // same promise instead of firing a second query.
  const dayFetches = new Map<string, Promise<DayFetchRow[]>>();
  function fetchDay(employeeId: string, date: string): Promise<DayFetchRow[]> {
    const dayKey = `${employeeId}:${date}`;
    let p = dayFetches.get(dayKey);
    if (!p) {
      // Step 3's own query — the exact same shape GET /daily's own run
      // computation uses (work AND break, never just the work segments
      // touching one row): a row-scoped, work-only fetch can never see the
      // break entry that bridges a break-split visit back into one run,
      // since a break always has greenhouse_row_id = null. No `activities`
      // join here (unlike the old per-day query) — activity names are
      // already batched once in Step 2 above, from the requested pairs'
      // own activity ids.
      p = (async () => {
        const { start, end } = getDayBoundsUtc(date);
        const { rows } = await pool.query(
          `select te.id, te.entry_type, te.activity_id, te.started_at, te.ended_at,
                  te.greenhouse_row_id, te.carrier_id, te.density_type, te.density_count_per_row,
                  te.rollover_of_entry_id,
                  (rcs.time_entry_id is not null) as is_resolved
           from time_entries te
           left join row_completion_segments rcs on rcs.time_entry_id = te.id
           where te.employee_id = $1 and te.deleted_at is null
             and te.started_at >= $2 and te.started_at < $3
           order by te.started_at asc`,
          [employeeId, start, end]
        );
        return rows;
      })();
      dayFetches.set(dayKey, p);
    }
    return p;
  }
  for (const [employeeId, dates] of daysByEmployee) {
    for (const date of dates) fetchDay(employeeId, date); // kicks off concurrently; Map above dedupes
  }
  await Promise.all(dayFetches.values());

  // Step 4: for each employee+day, compute its runs ONCE, then hand every
  // resulting root to whichever requested pair(s) it actually matches — the
  // exact same per-run filtering the single-pair version did, just run once
  // per employee-day instead of once per (pair, employee-day).
  //
  // Days are processed in chronological order per employee (not Set
  // insertion order) so that when a LATER day's root turns out to be a
  // midnight-rollover continuation (rolloverContinuationFromEntryId set —
  // see activityRuns.ts), the EARLIER day's own candidate for the same
  // chain has always already been computed and is ready to be found and
  // extended via rolloverTerminalToCandidate below, rather than pushed as a
  // second, independent (and falsely ambiguous) candidate. This is what
  // keeps one continuous visit spanning any number of local midnights as
  // exactly one candidate.
  const rolloverTerminalToCandidate = new Map<string, CandidateRun>();
  for (const [employeeId, dateSet] of daysByEmployee) {
    const dates = [...dateSet].sort();
    for (const date of dates) {
      const dayRows = await fetchDay(employeeId, date); // already resolved — Step 3 awaited every entry above

      const resolvedSegmentIds = new Set(dayRows.filter((r) => r.is_resolved).map((r) => r.id));
      const segments: RunSegment[] = dayRows.map((r) => ({
        id: r.id,
        entry_type: r.entry_type,
        activity_id: r.activity_id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        greenhouse_row_id: r.greenhouse_row_id,
        carrier_id: r.carrier_id,
        density_type: r.density_type,
        density_count_per_row: r.density_count_per_row,
        rollover_of_entry_id: r.rollover_of_entry_id,
      }));
      const { runs } = groupIntoActivityRuns(segments);
      const runById = new Map(runs.map((r) => [r.id, r]));

      // A run linked via splitByDensityChangeFromRunId (activityRuns.ts) is
      // the SAME physical visit as its immediately preceding run, just
      // frozen under a different density_type — never an independent
      // candidate under its own (spurious) type. Walk back to the visit's
      // true origin so the whole chain is attributed once, as a single
      // candidate under the ORIGINAL frozen type — this is what keeps a
      // mid-visit density_source change from awarding one physical row's
      // completion to two different density types (see inputs.ts's own
      // identical visitRoot helper, which needs the same resolution for its
      // per-run speed display — kept as two small local copies rather than
      // a shared export because each needs a different "when do we stop
      // walking" rule: this one only cares about resolvedSegmentIds, which
      // isn't available at all when inputs.ts resolves its own roots).
      function visitRoot(run: (typeof runs)[number]): (typeof runs)[number] {
        let cur = run;
        const seen = new Set<string>();
        while (cur.splitByDensityChangeFromRunId && !seen.has(cur.id)) {
          seen.add(cur.id);
          const prior = runById.get(cur.splitByDensityChangeFromRunId);
          if (!prior) break;
          cur = prior;
        }
        return cur;
      }

      const chainDurationByRootId = new Map<string, number>();
      const chainSegmentIdsByRootId = new Map<string, string[]>();
      const chainEndedAtByRootId = new Map<string, Date | null>();
      for (const run of runs) {
        const root = visitRoot(run);
        chainDurationByRootId.set(root.id, (chainDurationByRootId.get(root.id) ?? 0) + run.durationSeconds);
        chainSegmentIdsByRootId.set(root.id, [...(chainSegmentIdsByRootId.get(root.id) ?? []), ...run.segmentIds]);
        const priorEnd = chainEndedAtByRootId.get(root.id);
        if (!chainEndedAtByRootId.has(root.id) || (run.endedAt && (!priorEnd || run.endedAt > priorEnd))) {
          chainEndedAtByRootId.set(root.id, run.endedAt);
        }
      }

      // Tracks, for THIS day only, which already-pushed-or-merged
      // CandidateRun object each qualifying root produced — looked up again
      // just below the loop to register this day's own chronologically-last
      // run as a new rollover terminal, so a LATER day's continuation (if
      // this shift is still open going into tomorrow) can find and extend
      // the same object instead of creating a duplicate.
      const candidateByRootId = new Map<string, CandidateRun>();

      for (const run of runs) {
        const root = visitRoot(run);
        if (run.id !== root.id) continue; // non-root chain members are folded into their root above, never an independent candidate
        if (!root.greenhouseRowId) continue;
        const key = `${root.greenhouseRowId}:${root.activityId}:${root.densityType}`;
        if (!result.has(key)) continue; // this root isn't one of the requested pairs — irrelevant here
        const combinedSegmentIds = chainSegmentIdsByRootId.get(root.id)!;
        // A completion is always confirmed for a run's FULL segment set —
        // the review modal only ever lets an admin select whole candidate
        // runs (see RowCompletionReviewModal.tsx), never a partial one — so
        // a run here is always either entirely resolved or entirely not.
        // Excluding on ANY segment already being resolved is the
        // conservative, correct rule either way. Checked across the WHOLE
        // combined chain, not just the root's own segments.
        if (combinedSegmentIds.some((id) => resolvedSegmentIds.has(id))) continue;

        const thisDayEndedAt = (chainEndedAtByRootId.get(root.id) ?? root.endedAt) ?? null;
        const thisDayDuration = Math.round(chainDurationByRootId.get(root.id)!);

        // This day's chain BEGINS with a midnight-rollover continuation of
        // an earlier day's chain — merge into that earlier day's own
        // candidate (already pushed, since days are processed chronologically
        // above) instead of creating a second, falsely-independent one for
        // the same physical visit. This is the fix for the false "Needs
        // review" ambiguity a visit spanning local midnight would otherwise
        // trigger (two separate unresolved candidates for the same
        // row+activity+density).
        const rolloverFromId = root.rolloverContinuationFromEntryId;
        const priorCandidate = rolloverFromId ? rolloverTerminalToCandidate.get(rolloverFromId) : undefined;
        if (priorCandidate && rolloverFromId) {
          priorCandidate.segmentIds = [...priorCandidate.segmentIds, ...combinedSegmentIds];
          priorCandidate.durationSeconds += thisDayDuration;
          priorCandidate.endedAt = thisDayEndedAt ? thisDayEndedAt.toISOString() : null;
          rolloverTerminalToCandidate.delete(rolloverFromId);
          candidateByRootId.set(root.id, priorCandidate);
          continue;
        }

        const candidate: CandidateRun = {
          runId: root.id,
          segmentIds: combinedSegmentIds,
          employeeId,
          employeeName: employeeNameById.get(employeeId) ?? "Unknown employee",
          activityId: root.activityId,
          activityName: activityNameById.get(root.activityId) ?? "Unknown activity",
          greenhouseRowId: root.greenhouseRowId,
          rowLabel: rowLabelById.get(root.greenhouseRowId) ?? "Unknown row",
          date: calendarDateInAppTimezone(root.startedAt),
          startedAt: root.startedAt.toISOString(),
          endedAt: thisDayEndedAt?.toISOString() ?? null,
          durationSeconds: thisDayDuration,
        };
        result.get(key)!.push(candidate);
        candidateByRootId.set(root.id, candidate);
      }

      // Register this day's own chronologically-last run's terminal segment
      // id, if it produced a tracked candidate, so a future day in this
      // same batch (this shift still open, rolling into tomorrow) can find
      // and extend it. `runs` is built in started_at order (callers always
      // fetch `order by te.started_at asc`), so the last element is always
      // the day's most recent run.
      const lastRun = runs[runs.length - 1];
      if (lastRun) {
        const lastRunRoot = visitRoot(lastRun);
        const candidate = candidateByRootId.get(lastRunRoot.id);
        if (candidate) rolloverTerminalToCandidate.set(lastRun.id, candidate);
      }
    }
  }

  for (const list of result.values()) {
    list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  return result;
}

// Thin single-pair wrapper, kept for callers that only ever need one pair
// at a time (rowCompletions.ts's GET /candidates — exactly the one modal an
// admin has open) — see getUnresolvedRunsForRows above for the batched form
// and the N+1 it replaced.
export async function getUnresolvedRunsForRow(
  greenhouseRowId: string,
  activityId: string,
  densityType: "plants" | "stems"
): Promise<CandidateRun[]> {
  const key: RowActivityDensityKey = { greenhouseRowId, activityId, densityType };
  const map = await getUnresolvedRunsForRows([key]);
  return map.get(pairKey(key)) ?? [];
}

// The total duration (seconds) of every entry BEFORE `entryId` in its
// midnight-rollover chain — i.e. every earlier day's contribution to a
// visit that's continuing into the day `entryId` itself belongs to. Used
// by inputs.ts's own per-day speed calculation: once getUnresolvedRunsForRows
// (above) has correctly determined a rollover-spanning visit is NOT
// ambiguous, the calculated speed shown for it must still divide the row's
// full frozen quantity by the visit's FULL duration, not just today's
// partial slice — this is what supplies the rest. A simple bounded
// backward walk (rollover chains are, by construction, a single exact-
// boundary link per day, so this is at most one hop per calendar day the
// visit has spanned); capped well above any realistic chain length purely
// as a defensive bound against a data anomaly, never expected to bind.
const MAX_ROLLOVER_CHAIN_WALK = 60;

interface RolloverChainHopRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  rollover_of_entry_id: string | null;
}

async function fetchRolloverChainHop(id: string): Promise<RolloverChainHopRow | undefined> {
  const result = await pool.query<RolloverChainHopRow>(
    `select id, started_at, ended_at, rollover_of_entry_id from time_entries where id = $1`,
    [id]
  );
  return result.rows[0];
}

export async function getRolloverPriorDurationSeconds(entryId: string): Promise<number> {
  let totalSeconds = 0;
  let cursorId: string | null = entryId;
  let hops = 0;
  while (cursorId && hops < MAX_ROLLOVER_CHAIN_WALK) {
    hops++;
    const row = await fetchRolloverChainHop(cursorId);
    if (!row || !row.ended_at) break;
    totalSeconds += (row.ended_at.getTime() - new Date(row.started_at).getTime()) / 1000;
    cursorId = row.rollover_of_entry_id;
  }
  return Math.round(totalSeconds);
}
