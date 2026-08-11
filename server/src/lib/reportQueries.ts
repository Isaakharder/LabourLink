// Set-based data generation for the desktop Reports page (saved_reports,
// 029_saved_reports.sql). Every query here is bounded by the caller's date
// range and grouped in SQL — never one query per employee or per day — and
// the only place speed is *divided* is aggregateDensitySpeed (densitySpeed.ts),
// the same ratio-of-sums function Inputs (server/src/routes/inputs.ts) uses.
// This file only extends *selection* (which segments' quantity/duration
// count) from Inputs' single-day grain to a date range; it never introduces
// a second speed formula.
import { pool } from "../db";
import { APP_TIMEZONE, calendarDateInAppTimezone, getRangeBoundsUtc } from "./timezone";
import { aggregateDensitySpeed } from "./densitySpeed";
import { getUnresolvedRunsForRow } from "./rowCompletionCandidates";

export interface ActivityReportRow {
  employeeId: string;
  employeeName: string;
  date: string; // YYYY-MM-DD
  startedAt: string;
  endedAt: string;
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  rowsTouched: number;
  // Whole-range figures (not per-day) — see the file header. Attached
  // identically to every day-row for this employee, the same convention
  // Inputs already uses for a completion's speed ("shown on every run
  // belonging to it, on every day it touches").
  quantityWorked: number | null;
  rowsCompleted: number;
  averageSpeed: number | null;
}

// Per-employee (pivot table's right-hand Grand Total column) and per-date
// (bottom Grand Total row, across every employee) range totals — same shape
// of figures as `totals` below, just broken out along one axis at a time
// instead of collapsed to a single overall figure.
export interface ActivityEmployeeTotal {
  employeeId: string;
  employeeName: string;
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  rowsTouched: number;
  quantityWorked: number | null;
  rowsCompleted: number;
  averageSpeed: number | null;
}

export interface ActivityDateTotal {
  date: string;
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  rowsTouched: number;
  quantityWorked: number | null;
  rowsCompleted: number;
  averageSpeed: number | null;
}

export interface ActivityReportData {
  activity: { id: string; name: string; normalSpeedPerHour: number | null; speedUnit: string | null };
  rows: ActivityReportRow[];
  employeeTotals: ActivityEmployeeTotal[];
  dateTotals: ActivityDateTotal[];
  totals: {
    workSeconds: number;
    breakSeconds: number;
    paidBreakSeconds: number;
    unpaidBreakSeconds: number;
    quantityWorked: number | null;
    rowsCompleted: number;
    rowsTouched: number;
    averageSpeed: number | null;
  };
}

function toSeconds(v: unknown): number {
  return Math.round(Number(v ?? 0));
}

// Per-employee whole-range density contributions for one activity, following
// exactly the same two selection rules server/src/routes/inputs.ts already
// applies per day — extended here to a date range:
//
//  1. A confirmed row_completion counts its frozen quantity_per_row exactly
//     once, attributed to a single employee, only when *every* segment
//     linked to it belongs to that one employee, that one activity, and
//     falls inside the selected range. A completion is never split across
//     employees/activities — the current data model has no per-segment
//     quantity to divide, so a mixed completion is excluded entirely rather
//     than guessing an allocation (same "exclude when not cleanly
//     attributable" caution Inputs already applies to ambiguous runs).
//  2. A not-yet-completed row is auto-counted only when it's the *only*
//     candidate anywhere for that row+density type (checked via the same
//     getUnresolvedRunsForRow Inputs uses) — reused directly rather than
//     reimplemented, so this can never drift from Inputs' own resolution.
export interface DensityTotals {
  quantity: number;
  durationSeconds: number;
  completions: number;
}

export interface DensityAttribution {
  // Whole-range totals per employee — every qualifying contribution,
  // whether or not it could be pinned to one calendar day. This is what the
  // report's totals/footer uses for its ratio-of-sums speed: total quantity
  // / total productive hours across the *entire* selected range, never an
  // average of the daily speeds below.
  byEmployee: Map<string, DensityTotals>;
  // Subset of the above that CAN be safely pinned to one calendar day (in
  // APP_TIMEZONE) — keyed `${employeeId}:${date}`. A contribution whose
  // segments span more than one calendar day is deliberately left out of
  // this map (there's only one quantity_per_row for the whole thing; it
  // can't be split by day without guessing an allocation) even though it's
  // still included in byEmployee above.
  byEmployeeDay: Map<string, DensityTotals>;
}

// Exported so callers outside this file's own range-report shape (e.g. the
// mobile employee Stats page, server/src/routes/mobileStats.ts) can reuse
// this exact selection/attribution logic for a narrower slice — never
// reimplement it. See the file header: this is the only place quantity is
// attributed to an employee; aggregateDensitySpeed (densitySpeed.ts) is the
// only place a speed is ever divided.
export async function getActivityDensityAttribution(
  activityId: string,
  rangeStart: Date,
  rangeEnd: Date
): Promise<DensityAttribution> {
  const byEmployee = new Map<string, DensityTotals>();
  const byEmployeeDay = new Map<string, DensityTotals>();

  const addTo = (map: Map<string, DensityTotals>, key: string, quantity: number, durationSeconds: number, completions: number) => {
    const cur = map.get(key) ?? { quantity: 0, durationSeconds: 0, completions: 0 };
    cur.quantity += quantity;
    cur.durationSeconds += durationSeconds;
    cur.completions += completions;
    map.set(key, cur);
  };

  // Rule 1: confirmed completions. Aggregated over the completion's FULL
  // segment set (not filtered to this activity/range yet) so the
  // single-employee/single-activity/in-range checks below see the whole
  // picture — filtering the CTE itself would silently hide a completion
  // that also has segments outside this activity or range, corrupting the
  // "is this cleanly attributable" check.
  const { rows: completionRows } = await pool.query(
    `with segs as (
       select rc.id as completion_id, rc.quantity_per_row, te.employee_id, te.activity_id,
              te.started_at, te.ended_at
       from row_completions rc
       join row_completion_segments rcs on rcs.row_completion_id = rc.id
       join time_entries te on te.id = rcs.time_entry_id
       where te.deleted_at is null
     )
     select completion_id,
            max(quantity_per_row) as quantity_per_row,
            count(distinct employee_id) as employee_count,
            count(distinct activity_id) as activity_count,
            -- uuid has no built-in max()/min() aggregate — text is a stand-in
            -- sort just to pick one consistent value; only ever trusted below
            -- when employee_count/activity_count = 1, where every row's
            -- value is identical anyway.
            max(employee_id::text)::uuid as sole_employee_id,
            max(activity_id::text)::uuid as sole_activity_id,
            bool_and(started_at >= $2 and started_at < $3) as all_in_range,
            -- Same "only trust it when there's exactly one" pattern as
            -- sole_employee_id/sole_activity_id above, applied to which
            -- calendar day (APP_TIMEZONE) every segment falls on.
            count(distinct to_char((started_at at time zone $4)::date, 'YYYY-MM-DD')) as distinct_days,
            max(to_char((started_at at time zone $4)::date, 'YYYY-MM-DD')) as sole_day,
            sum(extract(epoch from (ended_at - started_at))) as total_duration_seconds
     from segs
     group by completion_id
     having bool_or(activity_id = $1) or count(distinct activity_id) > 1`,
    [activityId, rangeStart, rangeEnd, APP_TIMEZONE]
  );
  for (const c of completionRows) {
    if (Number(c.employee_count) !== 1) continue;
    if (Number(c.activity_count) !== 1) continue;
    if (c.sole_activity_id !== activityId) continue;
    if (!c.all_in_range) continue;
    const quantity = Number(c.quantity_per_row);
    const durationSeconds = Number(c.total_duration_seconds);
    addTo(byEmployee, c.sole_employee_id, quantity, durationSeconds, 1);
    if (Number(c.distinct_days) === 1) {
      addTo(byEmployeeDay, `${c.sole_employee_id}:${c.sole_day}`, quantity, durationSeconds, 1);
    }
    // else: this completion's segments span more than one calendar day —
    // it still counts toward byEmployee's range total above, but is left
    // out of every day-row it touches (see DensityAttribution's comment).
  }

  // Rule 2: unresolved (not-yet-completed) runs. Bounded by distinct rows
  // touched in this activity+range, not by employee/day — a greenhouse has
  // dozens to low hundreds of rows, never thousands of employee-days.
  const { rows: candidateRowsRes } = await pool.query(
    `select distinct te.greenhouse_row_id, te.density_type
     from time_entries te
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.activity_id = $1 and te.entry_type = 'work' and te.deleted_at is null
       and te.density_type is not null and te.greenhouse_row_id is not null
       and te.started_at >= $2 and te.started_at < $3
       and rcs.time_entry_id is null`,
    [activityId, rangeStart, rangeEnd]
  );
  for (const pair of candidateRowsRes) {
    const candidates = await getUnresolvedRunsForRow(pair.greenhouse_row_id, pair.density_type);
    if (candidates.length !== 1) continue; // ambiguous (2+) — excluded, same as Inputs
    const only = candidates[0];
    if (only.activityId !== activityId) continue;
    // Attribute only the portion of this run's own recorded segments that
    // fall inside the range — a run can't be split by quantity (there's
    // only one quantity_per_row for the whole row visit), so this follows
    // the same all-in-range rule as completions above rather than
    // guessing a partial share.
    const startedAt = new Date(only.startedAt);
    const endedAt = only.endedAt ? new Date(only.endedAt) : null;
    if (!endedAt || startedAt < rangeStart || endedAt > rangeEnd) continue;
    // Reuses the frozen density_count_per_row already resolved onto this
    // run's segments — refetched here (not carried on CandidateRun) since
    // getUnresolvedRunsForRow doesn't expose it; the query pattern mirrors
    // Inputs' own densityContributionsByActivity lookup.
    const { rows: densityRows } = await pool.query(
      `select density_count_per_row from time_entries where id = any($1::uuid[]) and density_count_per_row is not null limit 1`,
      [only.segmentIds]
    );
    const quantityPerRow = densityRows[0]?.density_count_per_row;
    if (quantityPerRow == null) continue;
    const quantity = Number(quantityPerRow);
    addTo(byEmployee, only.employeeId, quantity, only.durationSeconds, 0);
    // A run crossing midnight (started one calendar day, ended the next)
    // has the same "can't split one quantity across days" problem as a
    // multi-day completion above — counted in the range total, left out of
    // any single day-row.
    const startDay = calendarDateInAppTimezone(startedAt);
    const endDay = calendarDateInAppTimezone(endedAt);
    if (startDay === endDay) {
      addTo(byEmployeeDay, `${only.employeeId}:${startDay}`, quantity, only.durationSeconds, 0);
    }
  }

  return { byEmployee, byEmployeeDay };
}

export async function getActivityReportData(
  activityId: string,
  startDate: string,
  endDate: string
): Promise<ActivityReportData | null> {
  const activityRes = await pool.query(
    `select id, name, normal_speed, speed_unit from activities where id = $1`,
    [activityId]
  );
  const activity = activityRes.rows[0];
  if (!activity) return null;

  const { start, end } = getRangeBoundsUtc(startDate, endDate);

  const workRes = await pool.query(
    `select te.employee_id, e.first_name, e.last_name,
            -- to_char, not a bare ::date — node-postgres parses a plain SQL
            -- date result as a JS Date object (local-timezone rendered on
            -- String()/toString()), not the "YYYY-MM-DD" text this app
            -- treats calendar dates as everywhere else (see mobileTime.ts's
            -- identical to_char(...,'YYYY-MM-DD') use for
            -- scheduled_break_date).
            to_char((te.started_at at time zone $4)::date, 'YYYY-MM-DD') as work_date,
            sum(extract(epoch from (te.ended_at - te.started_at))) as work_seconds,
            min(te.started_at) as started_at,
            max(te.ended_at) as ended_at,
            count(distinct te.greenhouse_row_id) filter (where te.greenhouse_row_id is not null) as rows_touched
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.activity_id = $1 and te.entry_type = 'work' and te.deleted_at is null
       and te.ended_at is not null and te.started_at >= $2 and te.started_at < $3
     group by te.employee_id, e.first_name, e.last_name, work_date
     order by work_date, e.first_name, e.last_name`,
    [activityId, start, end, APP_TIMEZONE]
  );

  const employeeIds = [...new Set(workRes.rows.map((r) => r.employee_id as string))];

  // Whole-shift break totals for the same employee/day pairs — breaks carry
  // no activity_id (see time_entries schema), so "break time" on an Activity
  // Report is necessarily each employee's whole-day break time, not a
  // portion attributed to this one activity. This is the only safely
  // available reading of that column, not an invented split.
  const breakRes = employeeIds.length
    ? await pool.query(
        `select te.employee_id,
                to_char((te.started_at at time zone $4)::date, 'YYYY-MM-DD') as work_date,
                sum(extract(epoch from (te.ended_at - te.started_at))) as break_seconds,
                sum(extract(epoch from (te.ended_at - te.started_at))) filter (where te.is_paid) as paid_break_seconds,
                sum(extract(epoch from (te.ended_at - te.started_at))) filter (where not coalesce(te.is_paid, false)) as unpaid_break_seconds
         from time_entries te
         where te.entry_type = 'break' and te.deleted_at is null and te.ended_at is not null
           and te.employee_id = any($1::uuid[]) and te.started_at >= $2 and te.started_at < $3
         group by te.employee_id, work_date`,
        [employeeIds, start, end, APP_TIMEZONE]
      )
    : { rows: [] as { employee_id: string; work_date: string; break_seconds: string; paid_break_seconds: string; unpaid_break_seconds: string }[] };
  const breakByKey = new Map<string, { breakSeconds: number; paidBreakSeconds: number; unpaidBreakSeconds: number }>();
  for (const b of breakRes.rows) {
    breakByKey.set(`${b.employee_id}:${b.work_date}`, {
      breakSeconds: toSeconds(b.break_seconds),
      paidBreakSeconds: toSeconds(b.paid_break_seconds),
      unpaidBreakSeconds: toSeconds(b.unpaid_break_seconds),
    });
  }

  const attribution = await getActivityDensityAttribution(activityId, start, end);

  const rows: ActivityReportRow[] = workRes.rows.map((r) => {
    const dateStr = String(r.work_date);
    const breakInfo = breakByKey.get(`${r.employee_id}:${dateStr}`) ?? {
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
    };
    // That day's own safely-attributable quantity/speed only — never the
    // employee's whole-range figure. A day with real density work that
    // happened to be part of a multi-day-spanning completion/run correctly
    // shows blank here (see getActivityDensityAttribution) even though it
    // still contributes to the range totals below.
    const daily = attribution.byEmployeeDay.get(`${r.employee_id}:${dateStr}`) ?? null;
    const dailySpeed = daily
      ? aggregateDensitySpeed([{ quantityPerRow: daily.quantity, durationSeconds: daily.durationSeconds }])
      : null;
    return {
      employeeId: r.employee_id,
      employeeName: `${r.first_name} ${r.last_name}`,
      date: dateStr,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      workSeconds: toSeconds(r.work_seconds),
      breakSeconds: breakInfo.breakSeconds,
      paidBreakSeconds: breakInfo.paidBreakSeconds,
      unpaidBreakSeconds: breakInfo.unpaidBreakSeconds,
      rowsTouched: Number(r.rows_touched),
      quantityWorked: daily ? daily.quantity : null,
      rowsCompleted: daily ? daily.completions : 0,
      averageSpeed: dailySpeed,
    };
  });

  const totalWorkSeconds = rows.reduce((s, r) => s + r.workSeconds, 0);
  const totalBreakSeconds = rows.reduce((s, r) => s + r.breakSeconds, 0);
  const totalPaidBreakSeconds = rows.reduce((s, r) => s + r.paidBreakSeconds, 0);
  const totalUnpaidBreakSeconds = rows.reduce((s, r) => s + r.unpaidBreakSeconds, 0);
  const distinctRowsTouched = new Set<string>();
  // rowsTouched above is per employee-day (distinct rows that day) — the
  // range-wide distinct count needs its own query rather than summing the
  // per-day figures, which would double-count a row visited on more than
  // one day.
  const rangeRowsRes = await pool.query(
    `select count(distinct greenhouse_row_id) as n
     from time_entries
     where activity_id = $1 and entry_type = 'work' and deleted_at is null
       and greenhouse_row_id is not null and started_at >= $2 and started_at < $3`,
    [activityId, start, end]
  );
  const totalRowsTouched = Number(rangeRowsRes.rows[0]?.n ?? 0);
  void distinctRowsTouched;

  // Range-level totals — ratio-of-sums over EVERY qualifying contribution
  // for the whole selected range (attribution.byEmployee), never an average
  // of the per-day speeds shown on the rows above. This is also where a
  // multi-day-spanning completion/run actually counts, even though it
  // couldn't be pinned to any single day-row.
  let totalQuantity = 0;
  let totalDuration = 0;
  let totalCompletions = 0;
  let anyQuantity = false;
  for (const c of attribution.byEmployee.values()) {
    totalQuantity += c.quantity;
    totalDuration += c.durationSeconds;
    totalCompletions += c.completions;
    anyQuantity = true;
  }
  const overallSpeed = anyQuantity
    ? aggregateDensitySpeed([{ quantityPerRow: totalQuantity, durationSeconds: totalDuration }])
    : null;

  // Pivot table Grand Total column (per employee) and Grand Total row (per
  // date, across employees) — grouped from `rows`/`attribution`, already
  // fully fetched above; no new per-employee/per-day queries. Time metrics
  // sum directly (durations are always additive); quantity/speed reuse
  // attribution's per-employee bucket (already the correct whole-range
  // ratio-of-sums input) and a per-date re-aggregation of the same
  // day-attributable contributions — never a sum/average of the displayed
  // daily speeds.
  const employeeIdToName = new Map(rows.map((r) => [r.employeeId, r.employeeName]));
  const employeeSeconds = new Map<
    string,
    { workSeconds: number; breakSeconds: number; paidBreakSeconds: number; unpaidBreakSeconds: number }
  >();
  const dateSeconds = new Map<
    string,
    { workSeconds: number; breakSeconds: number; paidBreakSeconds: number; unpaidBreakSeconds: number }
  >();
  for (const r of rows) {
    const e = employeeSeconds.get(r.employeeId) ?? { workSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 };
    e.workSeconds += r.workSeconds;
    e.breakSeconds += r.breakSeconds;
    e.paidBreakSeconds += r.paidBreakSeconds;
    e.unpaidBreakSeconds += r.unpaidBreakSeconds;
    employeeSeconds.set(r.employeeId, e);

    const d = dateSeconds.get(r.date) ?? { workSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 };
    d.workSeconds += r.workSeconds;
    d.breakSeconds += r.breakSeconds;
    d.paidBreakSeconds += r.paidBreakSeconds;
    d.unpaidBreakSeconds += r.unpaidBreakSeconds;
    dateSeconds.set(r.date, d);
  }

  // rowsTouched (distinct greenhouse_row_id) can't be derived by summing the
  // per-employee-day figures already in `rows` — the same row visited on two
  // different days (or, for the date axis, by two different employees)
  // would double count. Each axis gets its own distinct-count query, same
  // reasoning as totalRowsTouched above.
  const employeeRowsTouchedRes = await pool.query(
    `select employee_id, count(distinct greenhouse_row_id) as n
     from time_entries
     where activity_id = $1 and entry_type = 'work' and deleted_at is null
       and greenhouse_row_id is not null and started_at >= $2 and started_at < $3
     group by employee_id`,
    [activityId, start, end]
  );
  const employeeRowsTouched = new Map(employeeRowsTouchedRes.rows.map((r) => [r.employee_id as string, Number(r.n)]));

  const dateRowsTouchedRes = await pool.query(
    `select to_char((started_at at time zone $4)::date, 'YYYY-MM-DD') as work_date, count(distinct greenhouse_row_id) as n
     from time_entries
     where activity_id = $1 and entry_type = 'work' and deleted_at is null
       and greenhouse_row_id is not null and started_at >= $2 and started_at < $3
     group by work_date`,
    [activityId, start, end, APP_TIMEZONE]
  );
  const dateRowsTouched = new Map(dateRowsTouchedRes.rows.map((r) => [String(r.work_date), Number(r.n)]));

  // Re-aggregates attribution.byEmployeeDay (keyed "employeeId:date") across
  // employees sharing the same date — the exact same day-attributable
  // contributions the per-day rows already use, just summed the other way.
  const byDateDensity = new Map<string, DensityTotals>();
  for (const [key, totals] of attribution.byEmployeeDay) {
    const date = key.slice(key.indexOf(":") + 1);
    const cur = byDateDensity.get(date) ?? { quantity: 0, durationSeconds: 0, completions: 0 };
    cur.quantity += totals.quantity;
    cur.durationSeconds += totals.durationSeconds;
    cur.completions += totals.completions;
    byDateDensity.set(date, cur);
  }

  const employeeTotals: ActivityEmployeeTotal[] = [...employeeSeconds.entries()].map(([employeeId, secs]) => {
    const density = attribution.byEmployee.get(employeeId) ?? null;
    return {
      employeeId,
      employeeName: employeeIdToName.get(employeeId) ?? "",
      ...secs,
      rowsTouched: employeeRowsTouched.get(employeeId) ?? 0,
      quantityWorked: density ? density.quantity : null,
      rowsCompleted: density ? density.completions : 0,
      averageSpeed: density
        ? aggregateDensitySpeed([{ quantityPerRow: density.quantity, durationSeconds: density.durationSeconds }])
        : null,
    };
  });

  const dateTotals: ActivityDateTotal[] = [...dateSeconds.entries()]
    .map(([date, secs]) => {
      const density = byDateDensity.get(date) ?? null;
      return {
        date,
        ...secs,
        rowsTouched: dateRowsTouched.get(date) ?? 0,
        quantityWorked: density ? density.quantity : null,
        rowsCompleted: density ? density.completions : 0,
        averageSpeed: density
          ? aggregateDensitySpeed([{ quantityPerRow: density.quantity, durationSeconds: density.durationSeconds }])
          : null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    activity: {
      id: activity.id,
      name: activity.name,
      normalSpeedPerHour: activity.normal_speed != null ? Number(activity.normal_speed) : null,
      speedUnit: activity.speed_unit,
    },
    rows,
    employeeTotals,
    dateTotals,
    totals: {
      workSeconds: totalWorkSeconds,
      breakSeconds: totalBreakSeconds,
      paidBreakSeconds: totalPaidBreakSeconds,
      unpaidBreakSeconds: totalUnpaidBreakSeconds,
      quantityWorked: anyQuantity ? totalQuantity : null,
      rowsCompleted: totalCompletions,
      rowsTouched: totalRowsTouched,
      averageSpeed: overallSpeed,
    },
  };
}

export interface PayrollReportRow {
  employeeId: string;
  employeeName: string;
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  paidSeconds: number; // work + paid breaks
  totalSeconds: number; // work + all breaks
}

export interface PayrollActivityBreakdownRow {
  employeeId: string;
  activityId: string;
  activityName: string;
  workSeconds: number;
}

export interface PayrollWeeklyTotalRow {
  weekStart: string;
  weekEnd: string;
  workSeconds: number;
  breakSeconds: number;
  paidSeconds: number;
}

// Pivot table's Employee Total column (per employee, whole range) and DAY
// TOTAL row (per date, across employees) — plain sums, no ratio-of-sums
// subtlety like Activity's speed (payroll has no per-quantity metric).
export interface PayrollEmployeeTotal {
  employeeId: string;
  employeeName: string;
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  paidSeconds: number;
  totalSeconds: number;
}

export interface PayrollDateTotal {
  date: string;
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  paidSeconds: number;
  totalSeconds: number;
}

export interface PayrollReportData {
  rows: PayrollReportRow[];
  employeeTotals: PayrollEmployeeTotal[];
  dateTotals: PayrollDateTotal[];
  daysWorkedByEmployee: { employeeId: string; employeeName: string; daysWorked: number }[];
  activityBreakdown: PayrollActivityBreakdownRow[];
  weeklyTotals: PayrollWeeklyTotalRow[];
  totals: {
    workSeconds: number;
    breakSeconds: number;
    paidBreakSeconds: number;
    unpaidBreakSeconds: number;
    paidSeconds: number;
    totalSeconds: number;
  };
}

// Paid/unpaid break split and "paid time = work + paid breaks" both reuse
// exactly the is_paid convention server/src/routes/inputs.ts already
// establishes (totalPaidBreakSeconds/totalUnpaidBreakSeconds) — no new
// pay-time rule is introduced here, only summed across a range instead of
// one day.
export async function getPayrollReportData(startDate: string, endDate: string): Promise<PayrollReportData> {
  const { start, end } = getRangeBoundsUtc(startDate, endDate);

  const { rows: dayRows } = await pool.query(
    `select te.employee_id, e.first_name, e.last_name,
            to_char((te.started_at at time zone $3)::date, 'YYYY-MM-DD') as work_date,
            sum(extract(epoch from (te.ended_at - te.started_at))) filter (where te.entry_type = 'work') as work_seconds,
            sum(extract(epoch from (te.ended_at - te.started_at))) filter (where te.entry_type = 'break') as break_seconds,
            sum(extract(epoch from (te.ended_at - te.started_at))) filter (where te.entry_type = 'break' and te.is_paid) as paid_break_seconds,
            sum(extract(epoch from (te.ended_at - te.started_at))) filter (where te.entry_type = 'break' and not coalesce(te.is_paid, false)) as unpaid_break_seconds,
            min(te.started_at) filter (where te.entry_type = 'work') as started_at,
            max(te.ended_at) filter (where te.entry_type = 'work') as ended_at
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.deleted_at is null and te.ended_at is not null
       and te.started_at >= $1 and te.started_at < $2
     group by te.employee_id, e.first_name, e.last_name, work_date
     order by work_date, e.first_name, e.last_name`,
    [start, end, APP_TIMEZONE]
  );

  const rows: PayrollReportRow[] = dayRows.map((r) => {
    const workSeconds = toSeconds(r.work_seconds);
    const breakSeconds = toSeconds(r.break_seconds);
    const paidBreakSeconds = toSeconds(r.paid_break_seconds);
    const unpaidBreakSeconds = toSeconds(r.unpaid_break_seconds);
    return {
      employeeId: r.employee_id,
      employeeName: `${r.first_name} ${r.last_name}`,
      date: String(r.work_date),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      workSeconds,
      breakSeconds,
      paidBreakSeconds,
      unpaidBreakSeconds,
      paidSeconds: workSeconds + paidBreakSeconds,
      totalSeconds: workSeconds + breakSeconds,
    };
  });

  const { rows: daysWorkedRows } = await pool.query(
    `select te.employee_id, e.first_name, e.last_name,
            count(distinct (te.started_at at time zone $3)::date) as days_worked
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.entry_type = 'work' and te.deleted_at is null and te.ended_at is not null
       and te.started_at >= $1 and te.started_at < $2
     group by te.employee_id, e.first_name, e.last_name`,
    [start, end, APP_TIMEZONE]
  );
  const daysWorkedByEmployee = daysWorkedRows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: `${r.first_name} ${r.last_name}`,
    daysWorked: Number(r.days_worked),
  }));

  const { rows: activityRows } = await pool.query(
    `select te.employee_id, te.activity_id, a.name as activity_name,
            sum(extract(epoch from (te.ended_at - te.started_at))) as work_seconds
     from time_entries te
     join activities a on a.id = te.activity_id
     where te.entry_type = 'work' and te.deleted_at is null and te.ended_at is not null
       and te.started_at >= $1 and te.started_at < $2
     group by te.employee_id, te.activity_id, a.name
     order by a.name`,
    [start, end]
  );
  const activityBreakdown: PayrollActivityBreakdownRow[] = activityRows.map((r) => ({
    employeeId: r.employee_id,
    activityId: r.activity_id,
    activityName: r.activity_name,
    workSeconds: toSeconds(r.work_seconds),
  }));

  // Aggregate (all employees combined) totals per calendar week — a
  // per-employee-per-week breakdown was judged out of scope for this pass;
  // see the implementation report.
  const { rows: weeklyRows } = await pool.query(
    `select to_char(date_trunc('week', (te.started_at at time zone $3))::date, 'YYYY-MM-DD') as week_start,
            sum(extract(epoch from (te.ended_at - te.started_at))) filter (where te.entry_type = 'work') as work_seconds,
            sum(extract(epoch from (te.ended_at - te.started_at))) filter (where te.entry_type = 'break') as break_seconds,
            sum(extract(epoch from (te.ended_at - te.started_at)))
              filter (where te.entry_type = 'work' or (te.entry_type = 'break' and te.is_paid)) as paid_seconds
     from time_entries te
     where te.deleted_at is null and te.ended_at is not null
       and te.started_at >= $1 and te.started_at < $2
     group by week_start
     order by week_start`,
    [start, end, APP_TIMEZONE]
  );
  const weeklyTotals: PayrollWeeklyTotalRow[] = weeklyRows.map((r) => {
    const weekStart = new Date(r.week_start as string);
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
    return {
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd: weekEnd.toISOString().slice(0, 10),
      workSeconds: toSeconds(r.work_seconds),
      breakSeconds: toSeconds(r.break_seconds),
      paidSeconds: toSeconds(r.paid_seconds),
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      workSeconds: acc.workSeconds + r.workSeconds,
      breakSeconds: acc.breakSeconds + r.breakSeconds,
      paidBreakSeconds: acc.paidBreakSeconds + r.paidBreakSeconds,
      unpaidBreakSeconds: acc.unpaidBreakSeconds + r.unpaidBreakSeconds,
      paidSeconds: acc.paidSeconds + r.paidSeconds,
      totalSeconds: acc.totalSeconds + r.totalSeconds,
    }),
    { workSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 0, totalSeconds: 0 }
  );

  // Employee Total column / DAY TOTAL row for the pivot view — grouped from
  // `rows` (already fetched above; every employee's multiple time_entries
  // for a day are already collapsed into that one employee-day row by the
  // SQL group-by, so this is purely a re-aggregation across days or across
  // employees, never a new per-employee/per-day query).
  const employeeIdToName = new Map(rows.map((r) => [r.employeeId, r.employeeName]));
  const zeroSecs = () => ({ workSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 0, totalSeconds: 0 });
  const employeeSecs = new Map<string, ReturnType<typeof zeroSecs>>();
  const dateSecs = new Map<string, ReturnType<typeof zeroSecs>>();
  for (const r of rows) {
    const e = employeeSecs.get(r.employeeId) ?? zeroSecs();
    e.workSeconds += r.workSeconds;
    e.breakSeconds += r.breakSeconds;
    e.paidBreakSeconds += r.paidBreakSeconds;
    e.unpaidBreakSeconds += r.unpaidBreakSeconds;
    e.paidSeconds += r.paidSeconds;
    e.totalSeconds += r.totalSeconds;
    employeeSecs.set(r.employeeId, e);

    const d = dateSecs.get(r.date) ?? zeroSecs();
    d.workSeconds += r.workSeconds;
    d.breakSeconds += r.breakSeconds;
    d.paidBreakSeconds += r.paidBreakSeconds;
    d.unpaidBreakSeconds += r.unpaidBreakSeconds;
    d.paidSeconds += r.paidSeconds;
    d.totalSeconds += r.totalSeconds;
    dateSecs.set(r.date, d);
  }
  const employeeTotals: PayrollEmployeeTotal[] = [...employeeSecs.entries()].map(([employeeId, secs]) => ({
    employeeId,
    employeeName: employeeIdToName.get(employeeId) ?? "",
    ...secs,
  }));
  const dateTotals: PayrollDateTotal[] = [...dateSecs.entries()]
    .map(([date, secs]) => ({ date, ...secs }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { rows, employeeTotals, dateTotals, daysWorkedByEmployee, activityBreakdown, weeklyTotals, totals };
}
