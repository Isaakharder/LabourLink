// Finds every not-yet-completed work run touching a given carrier, across
// every employee — the carrier-scoped mirror of getUnresolvedRunsForRow
// (rowCompletionCandidates.ts). Reuses groupIntoActivityRuns exactly as-is:
// it already breaks run contiguity on a carrier_id change (RunSegment.carrier_id),
// so a break-reconciliation split visit still collapses into one run here
// with no changes needed to that shared logic.
import { pool } from "../db";
import { groupIntoActivityRuns, RunSegment } from "./activityRuns";
import { calendarDateInAppTimezone } from "./timezone";

export interface CarrierCandidateRun {
  runId: string;
  segmentIds: string[];
  employeeId: string;
  employeeName: string;
  activityId: string;
  activityName: string;
  carrierId: string;
  carrierName: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
}

export async function getUnresolvedRunsForCarrier(carrierId: string): Promise<CarrierCandidateRun[]> {
  const { rows } = await pool.query(
    `select te.id, te.entry_type, te.activity_id, te.started_at, te.ended_at,
            te.greenhouse_row_id, te.carrier_id, te.density_type, te.density_count_per_row,
            te.employee_id, e.first_name, e.last_name, a.name as activity_name,
            c.name as carrier_name
     from time_entries te
     join employees e on e.id = te.employee_id
     left join activities a on a.id = te.activity_id
     join carriers c on c.id = te.carrier_id
     left join carrier_completion_segments ccs on ccs.time_entry_id = te.id
     where te.entry_type = 'work' and te.deleted_at is null
       and te.carrier_id = $1
       and ccs.time_entry_id is null
     order by te.employee_id, te.started_at asc`,
    [carrierId]
  );

  const byEmployee = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byEmployee.get(r.employee_id) ?? [];
    list.push(r);
    byEmployee.set(r.employee_id, list);
  }

  const candidates: CarrierCandidateRun[] = [];
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
      // Unlike rowCompletionCandidates.ts, this query is NOT scoped to one
      // calendar day at a time — it fetches every unresolved segment for
      // this carrier+employee across all time in one go — so a midnight-
      // rollover continuation is already in the same `segments` array as
      // its predecessor and merges into one run via groupIntoActivityRuns'
      // existing exact-boundary contiguity check with no extra handling
      // needed. This field only matters to a per-day-scoped caller.
      rollover_of_entry_id: null,
    }));
    const { runs } = groupIntoActivityRuns(segments);
    const activityNameById = new Map(empRows.map((r) => [r.activity_id, r.activity_name]));
    const carrierName = empRows[0].carrier_name;
    const employeeName = `${empRows[0].first_name} ${empRows[0].last_name}`;

    for (const run of runs) {
      candidates.push({
        runId: run.id,
        segmentIds: run.segmentIds,
        employeeId,
        employeeName,
        activityId: run.activityId,
        activityName: activityNameById.get(run.activityId) ?? "Unknown activity",
        carrierId,
        carrierName,
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

// Every carrier with at least one segment not yet linked to a
// carrier_completions record, scoped to the given (picking-card-type)
// activity ids — the discovery query the Dashboard's "pending bins" admin
// panel uses to know which carriers are even worth opening a review for
// (getUnresolvedRunsForCarrier itself needs a carrierId already in hand).
export interface PendingCarrier {
  carrierId: string;
  carrierName: string;
  pendingSegmentCount: number;
}

export async function getCarriersWithPendingWork(activityIds: string[]): Promise<PendingCarrier[]> {
  if (activityIds.length === 0) return [];

  const { rows } = await pool.query(
    `select te.carrier_id, c.name as carrier_name, count(*) as pending_segment_count
     from time_entries te
     join carriers c on c.id = te.carrier_id
     left join carrier_completion_segments ccs on ccs.time_entry_id = te.id
     where te.entry_type = 'work' and te.deleted_at is null
       and te.carrier_id is not null
       and te.activity_id = any($1::uuid[])
       and ccs.time_entry_id is null
     group by te.carrier_id, c.name
     order by c.name`,
    [activityIds]
  );
  return rows.map((r) => ({
    carrierId: r.carrier_id,
    carrierName: r.carrier_name,
    pendingSegmentCount: Number(r.pending_segment_count),
  }));
}
