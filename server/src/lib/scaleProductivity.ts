// Kilograms/hour for Jobs whose productivity metric is "Kilograms/hour (from
// LabourLink Scale)" (077_activity_productivity_metric.sql), with shared bins
// allocated between their pickers (078_scale_productivity_allocations.sql).
//
// PRODUCTIVITY REPORTING ONLY. Read-only apart from the administrator's
// allocation decisions (scaleProductivityAllocations.ts): nothing here
// changes a weighing, an official scale credit, a picking cycle, a time
// entry or pay.
//
//   kg/hour = sum(kilograms allocated to the employee from counted bins)
//           / sum(the employee's own picking hours matched to those bins)
//
// A bin is a candidate when it has been weighed and carries a live employee
// credit (scale_employee_credits: status credited, credits live, which
// excludes trial, voided, duplicate, pending, needs-review and expired
// weighings) and closed a picking cycle. A bin still filling or awaiting
// weighing contributes neither kilograms nor minutes.
//
// The bin's LOAD is everything put into it since its previous boundary: the
// bin's previous weighing (any status: the bin was on the scale), an
// administrator's "closed without weighing" (bin emptied), or the start of
// picking-cycle tracking. Every employee with this Job's work time with the
// bin inside the load contributes their own matched minutes: their
// non-deleted time entries with the bin, clipped to the load, minus their own
// breaks, overlapping entries counted once. That covers the whole history of
// the load (every picking cycle, superseded or not, same-employee rescans,
// multiple handovers, and minutes recorded before the phone scan), and is
// independent of who holds the official credit.
//
// The bin's net kilograms are allocated in proportion to those minutes
// (integer grams, largest remainder: the shares always add up to the net
// weight exactly). Each employee's share and their own minutes enter their
// kg/hour together.
//
// LIMITATION: LabourLink records no event when a bin is emptied without
// being weighed, and no weight at a handover, so the records alone can't
// prove that two employees' picking went into one physical load. A bin is
// allocated automatically only when that is the plain reading of the
// records: one employee, or picking that continues from one employee to the
// next with no pause longer than HANDOVER_MAX_GAP_MS on the same day. Every
// other bin waits for an administrator (Scale Weighings -> Review
// allocation) and counts for nobody until then:
//   handover_gap        a pause of more than 15 minutes at a handover
//   overnight_handover  another employee continued the bin on a later day
//   other_job           some of the bin's time is under another Job
//   overlapping_time    an employee's counted time for this bin overlaps
//                       their counted time for another bin (a minute is
//                       never counted twice, whatever was decided)
//   late_conflict       another employee's phone claimed the bin after the
//                       weighing (scale_weighing_flags late_conflict)
//   inputs_changed      a reviewed bin whose records changed since (a time
//                       entry corrected, a delayed upload): decisions are
//                       never silently re-applied to different records
// Never counted: no_cycle (no picking cycle linked), no_matched_time (no
// picking time with the bin), excluded_by_admin.
//
// Reporting rule across days: a bin is reported on the local date it was
// WEIGHED, with all of its kilograms and all of its matched picking time
// (even minutes from an earlier day). Nothing is split across days, so
// every bin appears exactly once and totals over any set of days are exact.
//
// Reporting starts on SCALE_PRODUCTIVITY_START_DATE.
import { Pool, PoolClient } from "pg";
import { pool } from "../db";
import { calendarDateInAppTimezone, getRangeBoundsUtc } from "./timezone";
import {
  AllocationDecision,
  BreakInput,
  EmployeeScaleProductivity,
  EntryInput,
  evaluateLoad,
  LoadInput,
  LoadOutcome,
  reviewOverlappingLoads,
  SCALE_PRODUCTIVITY_START_DATE,
  summarizeByEmployee,
} from "./scaleProductivityRules";
export * from "./scaleProductivityRules";

type Db = Pool | PoolClient;

export interface ScaleProductivityResult {
  // The dates actually reported (from is never before the start date);
  // null when the whole requested range is before it.
  dateStart: string | null;
  dateEnd: string | null;
  byEmployee: Map<string, EmployeeScaleProductivity>;
  // The same figures split by the local date each bin was weighed (only
  // dates with at least one bin). Used by Reports' daily cells.
  byDateEmployee: Map<string, Map<string, EmployeeScaleProductivity>>;
  // Bins (per employee) picked with this Job's time that are still being
  // filled or awaiting weighing: they count once weighed and credited.
  openBinsByEmployee: Map<string, number>;
}

const ms = (t: Date | string) => new Date(t).getTime();
export const dayOfMs = (t: number) => calendarDateInAppTimezone(new Date(t));

const LOADS_SQL = (where: string) => `
  select w.id, w.carrier_id, w.employee_id, w.net_g, w.weighed_at,
         exists (select 1 from bin_cycles c where c.weighing_id = w.id and c.status = 'closed') as has_cycle,
         (select count(*)::int from scale_weighing_flags f
           where f.weighing_id = w.id and f.kind = 'late_conflict' and f.employee_id <> w.employee_id) as late_conflicts,
         greatest(
           (select max(pw.weighed_at) from scale_weighings pw where pw.carrier_id = w.carrier_id and pw.weighed_at < w.weighed_at),
           (select max(c.closed_at) from bin_cycles c
             where c.carrier_id = w.carrier_id and c.status = 'closed_unweighed' and c.closed_at < w.weighed_at),
           (select max(t.started_at) from bin_cycle_tracking t where t.started_at <= w.weighed_at)
         ) as load_start
  from scale_employee_credits w
  where not w.is_duplicate and ${where}`;

function toLoad(r: any): LoadInput {
  const weighedAt = ms(r.weighed_at);
  return {
    weighingId: r.id,
    carrierId: r.carrier_id,
    creditedEmployeeId: r.employee_id,
    netGrams: Number(r.net_g),
    weighedAt,
    loadStart: r.load_start ? Math.min(ms(r.load_start), weighedAt) : weighedAt,
    hasCycle: r.has_cycle === true,
    lateConflicts: Number(r.late_conflicts),
    scannerIds: [],
  };
}

// Evaluates the credited bins weighed in [start, end) for one Job. Bins
// whose loads can overlap them in time (weighed shortly before or after) are
// evaluated too, only so that the overlapping-time check gives the same
// answer whatever range is asked for.
export async function evaluateLoads(jobId: string, range: { start: Date; end: Date } | { weighingIds: string[] }, db: Db = pool): Promise<LoadOutcome[]> {
  const { rows: targetRows } =
    "weighingIds" in range
      ? await db.query(LOADS_SQL(`w.id = any($1::uuid[])`), [range.weighingIds])
      : await db.query(LOADS_SQL(`w.weighed_at >= $1 and w.weighed_at < $2`), [range.start, range.end]);
  const targets = targetRows.map(toLoad);
  if (!targets.length) return [];
  const spanFrom = Math.min(...targets.map((l) => l.loadStart));
  const spanTo = Math.max(...targets.map((l) => l.weighedAt));
  const targetIds = new Set(targets.map((l) => l.weighingId));
  const { rows: nearRows } = await db.query(
    `select * from (${LOADS_SQL(`w.weighed_at > $1::timestamptz and w.weighed_at < $3::timestamptz + interval '7 days'`)}) x
     where x.load_start < $2::timestamptz and not (x.id = any($4::uuid[]))`,
    [new Date(spanFrom), new Date(spanTo), new Date(spanTo), [...targetIds]]
  );
  const loads = [...targets, ...nearRows.map(toLoad).filter((l) => l.weighedAt > spanFrom && l.loadStart < spanTo)];

  const args = [loads.map((l) => l.weighingId), loads.map((l) => l.carrierId), loads.map((l) => new Date(l.loadStart)), loads.map((l) => new Date(l.weighedAt))];
  // One after another: `db` may be a single transaction client.
  const scanRes = await db.query(
    `select distinct x.weighing_id, s.employee_id
     from unnest($1::uuid[], $2::uuid[], $3::timestamptz[], $4::timestamptz[]) as x(weighing_id, carrier_id, from_at, to_at)
     join bin_scans s on s.carrier_id = x.carrier_id and s.occurred_at > x.from_at and s.occurred_at <= x.to_at`,
    args
  );
  const entryRes = await db.query(
    `select distinct te.id, te.employee_id, te.carrier_id, te.activity_id, te.started_at, te.ended_at
     from unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) as x(carrier_id, from_at, to_at)
     join time_entries te
       on te.carrier_id = x.carrier_id and te.entry_type = 'work' and te.deleted_at is null
      and te.started_at < x.to_at and coalesce(te.ended_at, 'infinity'::timestamptz) > x.from_at`,
    [args[1], args[2], args[3]]
  );
  const decisionRes = await db.query(
    `select a.weighing_id, a.action, a.method, a.inputs_fingerprint,
            coalesce(json_agg(json_build_object('employeeId', s.employee_id, 'included', s.included, 'allocatedGrams', s.allocated_g))
                     filter (where s.employee_id is not null), '[]'::json) as shares
     from scale_productivity_allocations a
     left join scale_productivity_allocation_shares s on s.weighing_id = a.weighing_id
     where a.weighing_id = any($1::uuid[]) and a.activity_id = $2
     group by a.weighing_id, a.action, a.method, a.inputs_fingerprint`,
    [args[0], jobId]
  );
  for (const r of scanRes.rows) loads.find((l) => l.weighingId === r.weighing_id)?.scannerIds.push(r.employee_id);
  const entries: EntryInput[] = entryRes.rows.map((r) => ({
    employeeId: r.employee_id,
    carrierId: r.carrier_id,
    activityId: r.activity_id,
    startedAt: ms(r.started_at),
    endedAt: r.ended_at ? ms(r.ended_at) : null,
  }));
  const people = [...new Set([...entries.map((e) => e.employeeId), ...scanRes.rows.map((r) => r.employee_id as string)])];
  const { rows: breakRows } = people.length
    ? await db.query(
        `select te.employee_id, te.started_at, te.ended_at from time_entries te
         where te.entry_type = 'break' and te.deleted_at is null and te.employee_id = any($1::uuid[])
           and te.started_at < $3 and coalesce(te.ended_at, 'infinity'::timestamptz) > $2`,
        [people, new Date(Math.min(...loads.map((l) => l.loadStart))), new Date(Math.max(...loads.map((l) => l.weighedAt)))]
      )
    : { rows: [] as any[] };
  const breaks: BreakInput[] = breakRows.map((r) => ({ employeeId: r.employee_id, startedAt: ms(r.started_at), endedAt: r.ended_at ? ms(r.ended_at) : null }));
  const decisions = new Map<string, AllocationDecision>(
    decisionRes.rows.map((r) => [r.weighing_id, { action: r.action, method: r.method, fingerprint: r.inputs_fingerprint, shares: r.shares }])
  );

  const outcomes = reviewOverlappingLoads(loads.map((l) => evaluateLoad(l, jobId, entries, breaks, decisions.get(l.weighingId) ?? null, dayOfMs)));
  return outcomes.filter((o) => targetIds.has(o.load.weighingId));
}

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
  const empty: ScaleProductivityResult = { dateStart: null, dateEnd: null, byEmployee: new Map(), byDateEmployee: new Map(), openBinsByEmployee: new Map() };
  if (dateEnd < from) return empty;
  const { start, end } = getRangeBoundsUtc(from, dateEnd);
  const employeeIds = opts.employeeIds ?? null;

  let outcomes = await evaluateLoads(jobId, { start: new Date(start), end: new Date(end) }, db);

  // Bins with no time at all can't be placed under a Job; they're shown for
  // this Job only to employees who worked it in the range.
  const { rows: jobWorkers } = await db.query(
    `select distinct employee_id from time_entries
     where activity_id = $1 and entry_type = 'work' and deleted_at is null and started_at >= $2 and started_at < $3`,
    [jobId, start, end]
  );
  const worksJob = new Set(jobWorkers.map((r) => r.employee_id as string));
  outcomes = outcomes.filter((o) => {
    if (o.kind !== "excluded") return true;
    if (o.reason === "no_cycle" || o.reason === "no_matched_time") return worksJob.has(o.load.creditedEmployeeId);
    return true;
  });

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

  const keep = (m: Map<string, EmployeeScaleProductivity>) => (employeeIds ? new Map([...m].filter(([id]) => employeeIds.includes(id))) : m);
  // Per local day of weighing: the same outcomes, summarized one day at a
  // time. Every bin is reported on exactly one day, so the days add up to
  // the range (kilograms and matched time; kg/hour is their ratio).
  const byDay = new Map<string, LoadOutcome[]>();
  for (const o of outcomes) {
    const day = dayOfMs(o.load.weighedAt);
    byDay.set(day, [...(byDay.get(day) ?? []), o]);
  }
  return {
    dateStart: from,
    dateEnd,
    byEmployee: keep(summarizeByEmployee(outcomes)),
    byDateEmployee: new Map([...byDay].map(([day, list]) => [day, keep(summarizeByEmployee(list))])),
    openBinsByEmployee: new Map(open.map((r) => [r.employee_id as string, Number(r.n)])),
  };
}
