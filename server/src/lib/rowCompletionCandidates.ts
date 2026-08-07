// Finds every not-yet-completed work run touching a given greenhouse row +
// density type, across every employee — the shared logic behind both the
// "is this row ambiguous" check on every Inputs load (server/src/routes/
// inputs.ts) and the admin review modal's candidate list (server/src/routes/
// rowCompletions.ts). Reuses groupIntoActivityRuns per-employee (grouped by
// employee_id first) so a break-reconciliation split (two time_entries rows,
// one real visit) is correctly collapsed into one run, never miscounted as
// two separate visits to the row.
import { pool } from "../db";
import { groupIntoActivityRuns, RunSegment } from "./activityRuns";
import { calendarDateInAppTimezone } from "./timezone";

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
  const { rows } = await pool.query(
    `select te.id, te.entry_type, te.activity_id, te.started_at, te.ended_at,
            te.greenhouse_row_id, te.carrier_id, te.density_type, te.density_count_per_row,
            te.employee_id, e.first_name, e.last_name, a.name as activity_name,
            gr.row_number, gp.name as phase_name
     from time_entries te
     join employees e on e.id = te.employee_id
     left join activities a on a.id = te.activity_id
     join greenhouse_rows gr on gr.id = te.greenhouse_row_id
     join greenhouse_phases gp on gp.id = gr.phase_id
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.entry_type = 'work' and te.deleted_at is null
       and te.greenhouse_row_id = $1 and te.density_type = $2
       and rcs.time_entry_id is null
     order by te.employee_id, te.started_at asc`,
    [greenhouseRowId, densityType]
  );

  const byEmployee = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byEmployee.get(r.employee_id) ?? [];
    list.push(r);
    byEmployee.set(r.employee_id, list);
  }

  const candidates: CandidateRun[] = [];
  for (const [employeeId, empRows] of byEmployee) {
    const segments: RunSegment[] = empRows.map((r) => ({
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
    const activityNameById = new Map(empRows.map((r) => [r.activity_id, r.activity_name]));
    const rowLabel = `${empRows[0].phase_name} · Row ${empRows[0].row_number}`;
    const employeeName = `${empRows[0].first_name} ${empRows[0].last_name}`;

    for (const run of runs) {
      candidates.push({
        runId: run.id,
        segmentIds: run.segmentIds,
        employeeId,
        employeeName,
        activityId: run.activityId,
        activityName: activityNameById.get(run.activityId) ?? "Unknown activity",
        greenhouseRowId,
        rowLabel,
        date: calendarDateInAppTimezone(run.startedAt),
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt ? run.endedAt.toISOString() : null,
        durationSeconds: Math.round(run.durationSeconds),
      });
    }
  }

  candidates.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return candidates;
}
