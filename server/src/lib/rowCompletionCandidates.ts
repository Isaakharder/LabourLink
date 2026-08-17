// Finds every not-yet-completed work run touching a given greenhouse row +
// density type, across every employee — the shared logic behind both the
// "is this row ambiguous" check on every Inputs load (server/src/routes/
// inputs.ts) and the admin review modal's candidate list (server/src/routes/
// rowCompletions.ts). Reuses groupIntoActivityRuns per-employee-day (see
// below for why "per day", not just "per employee") so a break-split visit
// (two time_entries rows, one real visit) is correctly collapsed into one
// run, never miscounted as two separate visits to the row.
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

export async function getUnresolvedRunsForRow(
  greenhouseRowId: string,
  densityType: "plants" | "stems"
): Promise<CandidateRun[]> {
  // Step 1: which employee+day pairs even have an unresolved work segment
  // touching this row+type — small, targeted (a physical row is visited by
  // a handful of employees on a handful of days, never thousands), same
  // "bounded, not per-employee-day-of-the-whole-app" reasoning the caller in
  // inputs.ts already documents for its own per-pair loop.
  const { rows: touchRows } = await pool.query(
    `select te.employee_id, te.started_at
     from time_entries te
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.entry_type = 'work' and te.deleted_at is null
       and te.greenhouse_row_id = $1 and te.density_type = $2
       and rcs.time_entry_id is null`,
    [greenhouseRowId, densityType]
  );
  if (touchRows.length === 0) return [];

  const daysByEmployee = new Map<string, Set<string>>();
  for (const r of touchRows) {
    const date = calendarDateInAppTimezone(r.started_at);
    const set = daysByEmployee.get(r.employee_id) ?? new Set<string>();
    set.add(date);
    daysByEmployee.set(r.employee_id, set);
  }

  const rowInfoRes = await pool.query(
    `select gr.row_number, gp.name as phase_name from greenhouse_rows gr
     join greenhouse_phases gp on gp.id = gr.phase_id where gr.id = $1`,
    [greenhouseRowId]
  );
  const rowInfo = rowInfoRes.rows[0];
  const rowLabel = rowInfo ? `${rowInfo.phase_name} · Row ${rowInfo.row_number}` : "Unknown row";

  const employeeIds = [...daysByEmployee.keys()];
  const empRes = await pool.query(`select id, first_name, last_name from employees where id = any($1::uuid[])`, [employeeIds]);
  const employeeNameById = new Map(empRes.rows.map((r) => [r.id, `${r.first_name} ${r.last_name}`]));

  const candidates: CandidateRun[] = [];
  for (const [employeeId, dates] of daysByEmployee) {
    for (const date of dates) {
      // Step 2: fetch the employee's WHOLE day — work AND break, the exact
      // same shape GET /daily's own run computation uses (see inputs.ts) —
      // never just the work segments touching this one row. A row-scoped,
      // work-only fetch (the previous approach here) can never see the
      // break entry that bridges a break-split visit back into one run,
      // since a break always has greenhouse_row_id = null and so can never
      // match a `greenhouse_row_id = $1` filter — feeding groupIntoActivityRuns
      // an incomplete segment list made it miscount "worked this row, took
      // a break, resumed the same row" as two spuriously ambiguous runs
      // instead of the one real visit it actually was.
      const { start, end } = getDayBoundsUtc(date);
      const { rows: dayRows } = await pool.query(
        `select te.id, te.entry_type, te.activity_id, te.started_at, te.ended_at,
                te.greenhouse_row_id, te.carrier_id, te.density_type, te.density_count_per_row,
                a.name as activity_name,
                (rcs.time_entry_id is not null) as is_resolved
         from time_entries te
         left join activities a on a.id = te.activity_id
         left join row_completion_segments rcs on rcs.time_entry_id = te.id
         where te.employee_id = $1 and te.deleted_at is null
           and te.started_at >= $2 and te.started_at < $3
         order by te.started_at asc`,
        [employeeId, start, end]
      );

      const resolvedSegmentIds = new Set(dayRows.filter((r) => r.is_resolved).map((r) => r.id));
      const activityNameById = new Map(dayRows.map((r) => [r.activity_id, r.activity_name]));
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

      for (const run of runs) {
        const root = visitRoot(run);
        if (run.id !== root.id) continue; // non-root chain members are folded into their root above, never an independent candidate
        if (root.greenhouseRowId !== greenhouseRowId) continue;
        if (root.densityType !== densityType) continue;
        const combinedSegmentIds = chainSegmentIdsByRootId.get(root.id)!;
        // A completion is always confirmed for a run's FULL segment set —
        // the review modal only ever lets an admin select whole candidate
        // runs (see RowCompletionReviewModal.tsx), never a partial one — so
        // a run here is always either entirely resolved or entirely not.
        // Excluding on ANY segment already being resolved is the
        // conservative, correct rule either way. Checked across the WHOLE
        // combined chain, not just the root's own segments.
        if (combinedSegmentIds.some((id) => resolvedSegmentIds.has(id))) continue;

        candidates.push({
          runId: root.id,
          segmentIds: combinedSegmentIds,
          employeeId,
          employeeName: employeeNameById.get(employeeId) ?? "Unknown employee",
          activityId: root.activityId,
          activityName: activityNameById.get(root.activityId) ?? "Unknown activity",
          greenhouseRowId,
          rowLabel,
          date: calendarDateInAppTimezone(root.startedAt),
          startedAt: root.startedAt.toISOString(),
          endedAt: (chainEndedAtByRootId.get(root.id) ?? root.endedAt)?.toISOString() ?? null,
          durationSeconds: Math.round(chainDurationByRootId.get(root.id)!),
        });
      }
    }
  }

  candidates.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return candidates;
}
