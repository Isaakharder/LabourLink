// Kilograms/hour for Jobs whose productivity metric is "Kilograms/hour (from
// LabourLink Scale)" (077_activity_productivity_metric.sql).
//
// Matched weighed-bin productivity. Read-only: nothing here decides a
// weighing, a credit, a picking cycle, a time entry or pay.
//
//   kg/hour = sum(net kg of the eligible bins)
//           / sum(picking hours matched to those same bins)
//
// A bin enters the figure only when it has been weighed and carries a live
// employee credit (scale_employee_credits: status credited, credits live,
// which already excludes trial, voided, duplicate, pending, needs-review and
// expired weighings). Its kilograms and its matched picking time enter
// together; a bin still filling, awaiting weighing or pending contributes
// neither.
//
// A bin's matched picking time, from the existing attribution (074/075):
// * the picking cycle this weighing closed (bin_cycles.weighing_id, which
//   follows an administrator's "credit this cycle instead"), from the
//   cycle's first scan (opened_at) to the weighing; when the credited
//   employee's own entry with this bin was already running at that scan,
//   from that entry's start (never before the bin's previous weighing);
// * the credited employee's own work time entries with this bin in that
//   window, as they are now (after Inputs corrections), not deleted;
// * minus that employee's breaks; overlapping entries counted once.
//
// A bin is EXCLUDED (counted and shown, never in the figure) when its
// kilograms can't be fully attributed to that time:
//   several_employees      another employee scanned this bin in the cycle, or
//                          has time with it in the window
//   superseded_review_open an earlier cycle of this bin by someone else was
//                          superseded and is still awaiting review
//   late_conflict          another employee's phone claimed the bin after the
//                          credit (scale_weighing_flags late_conflict)
//   credit_mismatch        the credited employee isn't the cycle's employee
//   other_job              some of the bin's time is under another Job
//   no_matched_time        no picking time matches the bin (never divided by
//                          zero, never given a made-up duration)
//   overlapping_time       the employee's time for this bin overlaps their
//                          time for another bin (a minute is never counted
//                          for two bins)
//   no_cycle               credited, but no picking cycle is linked
//
// Reporting rule across days: a bin is reported on the local date it was
// WEIGHED, with all of its kilograms and all of its matched picking time
// (even minutes from an earlier day). Nothing is split or estimated, so
// every bin appears exactly once and totals over any set of days are exact.
//
// Reporting starts on SCALE_PRODUCTIVITY_START_DATE: bins weighed earlier
// (trials, the activation day) are never included.
import { Pool, PoolClient } from "pg";
import { pool } from "../db";
import { calendarDateInAppTimezone, getRangeBoundsUtc } from "./timezone";
import {
  BinInput,
  BreakInput,
  EmployeeScaleProductivity,
  EntryInput,
  evaluateBin,
  excludeOverlappingBins,
  SCALE_PRODUCTIVITY_START_DATE,
  summarizeByEmployee,
} from "./scaleProductivityRules";
export * from "./scaleProductivityRules";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
type Db = Pool | PoolClient;

export interface ScaleProductivityResult {
  // The dates actually reported (from is never before the start date);
  // null when the whole requested range is before it.
  dateStart: string | null;
  dateEnd: string | null;
  byEmployee: Map<string, EmployeeScaleProductivity>;
  // Bins (per employee) picked with this Job's time that are still being
  // filled or awaiting weighing: they count once weighed and credited.
  openBinsByEmployee: Map<string, number>;
}

const ms = (t: Date | string) => new Date(t).getTime();

// Inclusive local dates. `employeeIds` limits the result (null = everyone).
export async function getScaleProductivity(
  jobId: string,
  dateStart: string,
  dateEnd: string,
  opts: { employeeIds?: string[] | null; db?: Db; now?: Date } = {}
): Promise<ScaleProductivityResult> {
  const db = opts.db ?? pool;
  const now = opts.now ?? new Date();
  const from = dateStart < SCALE_PRODUCTIVITY_START_DATE ? SCALE_PRODUCTIVITY_START_DATE : dateStart;
  const empty: ScaleProductivityResult = { dateStart: null, dateEnd: null, byEmployee: new Map(), openBinsByEmployee: new Map() };
  if (dateEnd < from) return empty;
  const { start, end } = getRangeBoundsUtc(from, dateEnd);
  const employeeIds = opts.employeeIds ?? null;

  const { rows: credits } = await db.query(
    `select w.id, w.carrier_id, w.employee_id, w.net_g, w.weighed_at,
            c.employee_id as cycle_employee_id, c.opened_at as cycle_opened_at,
            (select count(distinct s.employee_id)::int from bin_scans s
              where s.cycle_id = c.id and s.employee_id <> w.employee_id) as other_scan_employees,
            (select count(*)::int from bin_cycles sc
              where sc.superseded_by_cycle_id = c.id and sc.status = 'superseded' and sc.review_status = 'open') as open_superseded,
            (select count(*)::int from scale_weighing_flags f
              where f.weighing_id = w.id and f.kind = 'late_conflict' and f.employee_id <> w.employee_id) as late_conflicts,
            greatest(
              (select max(pw.weighed_at) from scale_weighings pw where pw.carrier_id = w.carrier_id and pw.weighed_at < c.opened_at),
              (select max(pc.closed_at) from bin_cycles pc where pc.carrier_id = c.carrier_id and pc.id <> c.id and pc.closed_at <= c.opened_at)
            ) as previous_boundary_at
     from scale_employee_credits w
     left join bin_cycles c on c.weighing_id = w.id and c.status = 'closed'
     where not w.is_duplicate and w.weighed_at >= $1 and w.weighed_at < $2
       and ($3::uuid[] is null or w.employee_id = any($3::uuid[]))`,
    [start, end, employeeIds]
  );

  const bins: BinInput[] = credits.map((r) => ({
    weighingId: r.id,
    carrierId: r.carrier_id,
    employeeId: r.employee_id,
    netGrams: Number(r.net_g),
    weighedAt: ms(r.weighed_at),
    weighDate: calendarDateInAppTimezone(new Date(r.weighed_at)),
    cycle: r.cycle_opened_at
      ? {
          employeeId: r.cycle_employee_id,
          openedAt: ms(r.cycle_opened_at),
          otherScanEmployees: Number(r.other_scan_employees),
          openSupersededReviews: Number(r.open_superseded),
          previousBoundaryAt: r.previous_boundary_at ? ms(r.previous_boundary_at) : null,
        }
      : null,
    lateConflicts: Number(r.late_conflicts),
  }));

  const windowed = bins.filter((b) => b.cycle);
  let entries: EntryInput[] = [];
  let breaks: BreakInput[] = [];
  if (windowed.length) {
    const [entryRes, breakRes] = await Promise.all([
      db.query(
        `select distinct te.id, te.employee_id, te.carrier_id, te.activity_id, te.started_at, te.ended_at
         from unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) as x(carrier_id, from_at, to_at)
         join time_entries te
           on te.carrier_id = x.carrier_id and te.entry_type = 'work' and te.deleted_at is null
          and te.started_at < x.to_at and coalesce(te.ended_at, 'infinity'::timestamptz) > x.from_at`,
        [windowed.map((b) => b.carrierId), windowed.map((b) => new Date(b.cycle!.openedAt)), windowed.map((b) => new Date(b.weighedAt))]
      ),
      db.query(
        `select te.employee_id, te.started_at, te.ended_at
         from time_entries te
         where te.entry_type = 'break' and te.deleted_at is null and te.employee_id = any($1::uuid[])
           and te.started_at < $3 and coalesce(te.ended_at, 'infinity'::timestamptz) > $2`,
        [
          [...new Set(windowed.map((b) => b.employeeId))],
          // 12 h earlier: breaks inside an entry that started before its scan.
          new Date(Math.min(...windowed.map((b) => b.cycle!.openedAt)) - 12 * 3_600_000),
          new Date(Math.max(...windowed.map((b) => b.weighedAt))),
        ]
      ),
    ]);
    entries = entryRes.rows.map((r) => ({
      employeeId: r.employee_id,
      carrierId: r.carrier_id,
      activityId: r.activity_id,
      startedAt: ms(r.started_at),
      endedAt: r.ended_at ? ms(r.ended_at) : null,
    }));
    breaks = breakRes.rows.map((r) => ({ employeeId: r.employee_id, startedAt: ms(r.started_at), endedAt: r.ended_at ? ms(r.ended_at) : null }));
  }

  // Bins with no time at all can't be placed under a Job; they're shown for
  // this Job only to employees who worked it in the range.
  const { rows: jobWorkers } = await db.query(
    `select distinct employee_id from time_entries
     where activity_id = $1 and entry_type = 'work' and deleted_at is null and started_at >= $2 and started_at < $3`,
    [jobId, start, end]
  );
  const worksJob = new Set(jobWorkers.map((r) => r.employee_id as string));

  let outcomes = bins.map((b) => evaluateBin(b, jobId, entries, breaks));
  outcomes = outcomes.filter((o) => {
    if (o.kind !== "excluded") return true;
    if (o.reason === "no_cycle" || o.reason === "no_matched_time") return worksJob.has(o.bin.employeeId);
    return true;
  });
  outcomes = excludeOverlappingBins(outcomes);

  // Bins still open (filling / awaiting weighing / needs review) whose
  // employee has this Job's time with them: they count once weighed.
  const { rows: open } = await db.query(
    `select c.employee_id, count(distinct c.id)::int as n
     from bin_cycles c
     where c.status in ('filling', 'awaiting_weighing', 'needs_review')
       and ($2::uuid[] is null or c.employee_id = any($2::uuid[]))
       and exists (select 1 from time_entries te
                   where te.employee_id = c.employee_id and te.carrier_id = c.carrier_id and te.activity_id = $1
                     and te.entry_type = 'work' and te.deleted_at is null
                     and coalesce(te.ended_at, $3::timestamptz) > c.opened_at)
     group by c.employee_id`,
    [jobId, employeeIds, now]
  );

  return {
    dateStart: from,
    dateEnd,
    byEmployee: summarizeByEmployee(outcomes),
    openBinsByEmployee: new Map(open.map((r) => [r.employee_id as string, Number(r.n)])),
  };
}

