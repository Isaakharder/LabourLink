// Set-based data generation for the desktop Reports page (saved_reports,
// 029_saved_reports.sql). Every query here is bounded by the caller's date
// range and grouped in SQL — never one query per employee or per day — and
// the only place speed is *divided* is aggregateDensitySpeed (densitySpeed.ts),
// the same ratio-of-sums function Inputs (server/src/routes/inputs.ts) uses.
// This file only extends *selection* (which segments' quantity/duration
// count) from Inputs' single-day grain to a date range; it never introduces
// a second speed formula.
import { pool } from "../db";
import { addDaysToDateStr, APP_TIMEZONE, calendarDateInAppTimezone, getDayBoundsUtc, getRangeBoundsUtc } from "./timezone";
import { aggregateDensitySpeed } from "./densitySpeed";
import { computeWorkdayTotals, groupByEmployeeDay, WorkdayBoundaryEntry } from "./workdayTotals";
import { CandidateRun, getUnresolvedRunsForRows } from "./rowCompletionCandidates";

export interface ActivityReportRow {
  employeeId: string;
  employeeName: string;
  date: string; // YYYY-MM-DD
  startedAt: string;
  endedAt: string;
  // This activity's own exact, unrounded work-entry time only — excludes
  // breaks and every other activity (see the SQL below: `activity_id = $1`,
  // entry_type = 'work'). This IS "Activity Hours" (reportTypes.ts's
  // ACTIVITY_METRIC_LABELS.activityHours) — an employee with 3:12 of this
  // activity and 6:00 of other work shows exactly 3:12 here, never 9:12 and
  // never rounded to a shift-boundary interval (work-start/work-finish
  // rounding, workStartRounding.ts, only ever touches the overall shift's
  // clock-in/clock-out, never an individual activity segment).
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
  // quantityWorked / this row's own workSeconds (Activity Hours) — see
  // aggregateDensitySpeed's call site below for why the denominator is
  // workSeconds, not attribution's own (possibly narrower) durationSeconds.
  averageSpeed: number | null;
  // The employee's WHOLE SHIFT paid time for this one calendar day — every
  // activity combined, computed the exact same way Payroll/Inputs already
  // do (computeWorkdayTotals's span-based workedSeconds, which already
  // folds in paid breaks — see getPayrollReportData's identical
  // `paidSeconds: workSeconds` comment). Deliberately NOT
  // `workSeconds + paidBreakSeconds` scoped to this one activity — that
  // undercounts on any day the employee also worked a different activity.
  // Surfaced as "Employee Paid Time" (reportTypes.ts), always kept visually
  // and semantically separate from this activity's own metrics.
  employeePaidSeconds: number;
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
  employeePaidSeconds: number;
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
  employeePaidSeconds: number;
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
    employeePaidSeconds: number;
  };
}

function toSeconds(v: unknown): number {
  return Math.round(Number(v ?? 0));
}

// The Monday that starts dateStr's ISO calendar week, as a YYYY-MM-DD
// string — plain calendar-date arithmetic (dateStr is already an
// APP_TIMEZONE calendar date, same "no timezone conversion needed"
// reasoning as addDaysToDateStr), matching Postgres's own
// date_trunc('week', ...) definition (week starts Monday) that this
// replaces.
function isoWeekStartDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return addDaysToDateStr(dateStr, -daysSinceMonday);
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
//     candidate in its own row-work CYCLE (rowCompletionCandidates.ts's
//     CYCLE_GAP_DAYS) for that row+activity+density type — checked via the
//     same getUnresolvedRunsForRows Inputs uses, and ambiguity decided the
//     exact same PER-CYCLE way inputs.ts's ambiguousCycleKeys does (see
//     computeAmbiguousCycleKeys below). Checking raw candidate COUNT with no
//     cycle scoping — the bug this replaced — wrongly treated a genuinely
//     unrelated, unfinished visit from months ago as making THIS week's
//     otherwise-clean, unambiguous visit "ambiguous" too, silently dropping
//     its entire quantity from every report/dashboard/stats consumer of
//     this function. A different activity sharing this row+density type is
//     never itself a candidate here, and never suppresses this one either.
//
// A contribution whose segments span more than one APP_TIMEZONE calendar
// day (a row worked across two real work sessions, or a shift closed and
// reopened at midnight rollover) is never dropped from the per-day view and
// never double-counted: its one frozen quantity is allocated across the
// days it touches in proportion to each day's own share of the
// contribution's total productive duration (splitDurationByCalendarDay
// below) — which, by construction, gives every day the SAME resulting
// speed as the contribution's own overall speed, matching what Inputs
// itself shows on every day/run belonging to one completion/visit.
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
  // Every qualifying contribution's quantity, allocated to the calendar
  // day(s) (APP_TIMEZONE) it was actually earned on — keyed
  // `${employeeId}:${date}`. A contribution touching only one day lands
  // here whole; one spanning several days is split proportionally by
  // duration (see the file-level comment above) rather than omitted.
  byEmployeeDay: Map<string, DensityTotals>;
}

interface ReportEmployeeFilter {
  employeeIds?: string[];
}

function filterToUuidArray(employeeIds?: string[]): string[] | null {
  if (!employeeIds || employeeIds.length === 0) return null;
  const deduped = [...new Set(employeeIds)];
  return deduped.length ? deduped : null;
}

// A segment's [startedAt, endedAt) sliced against APP_TIMEZONE calendar-day
// boundaries — the shared building block for "how much of this
// completion/run's duration falls on each date it touches". Loops rather
// than assuming a segment never itself straddles a calendar day (normal
// midnight-rollover processing closes/reopens an entry exactly at the
// boundary, so a raw segment straddling midnight shouldn't happen in
// practice, but this stays correct even if one ever does, e.g. a
// hand-edited manual entry). Multiple segments' shares for the same date
// accumulate naturally since the caller sums this map across every segment
// in a contribution.
function splitDurationByCalendarDay(segments: { startedAt: Date; endedAt: Date }[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const seg of segments) {
    let cursor = seg.startedAt;
    while (cursor < seg.endedAt) {
      const date = calendarDateInAppTimezone(cursor);
      const { end: dayEnd } = getDayBoundsUtc(date);
      const sliceEnd = dayEnd < seg.endedAt ? dayEnd : seg.endedAt;
      const seconds = (sliceEnd.getTime() - cursor.getTime()) / 1000;
      byDate.set(date, (byDate.get(date) ?? 0) + seconds);
      cursor = sliceEnd;
    }
  }
  return byDate;
}

// Exactly inputs.ts's own ambiguousCycleKeys logic (see its comment there) —
// factored out here so the Report/Dashboard/Stats attribution below and the
// read-only production audit (getActivityDensityAudit) can never drift from
// each other, or from what Inputs itself decides. A "row-work cycle" is
// candidates within CYCLE_GAP_DAYS of each other (rowCompletionCandidates.ts);
// a key ("pairKey:cycleIndex") is ambiguous when 2+ candidates share it.
function computeAmbiguousCycleKeys(candidatesByKey: Map<string, CandidateRun[]>): Set<string> {
  const ambiguousCycleKeys = new Set<string>();
  for (const [key, list] of candidatesByKey) {
    const countByCycle = new Map<number, number>();
    for (const candidate of list) {
      countByCycle.set(candidate.cycleIndex, (countByCycle.get(candidate.cycleIndex) ?? 0) + 1);
    }
    for (const [cycleIndex, count] of countByCycle) {
      if (count > 1) ambiguousCycleKeys.add(`${key}:${cycleIndex}`);
    }
  }
  return ambiguousCycleKeys;
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
  rangeEnd: Date,
  filter: ReportEmployeeFilter = {}
): Promise<DensityAttribution> {
  const employeeIds = filterToUuidArray(filter.employeeIds);
  const byEmployee = new Map<string, DensityTotals>();
  const byEmployeeDay = new Map<string, DensityTotals>();

  const addTo = (map: Map<string, DensityTotals>, key: string, quantity: number, durationSeconds: number, completions: number) => {
    const cur = map.get(key) ?? { quantity: 0, durationSeconds: 0, completions: 0 };
    cur.quantity += quantity;
    cur.durationSeconds += durationSeconds;
    cur.completions += completions;
    map.set(key, cur);
  };

  // Distributes one contribution's frozen quantity across the calendar
  // day(s) it touches, proportional to each day's own share of duration —
  // see the file-level comment above. The "completions" count (a whole-row
  // metric, not something meaningful to split fractionally) is attributed
  // in full to whichever day carries the largest share of the duration;
  // ties keep the earliest date, both purely deterministic tie-breaks with
  // no effect on quantity/speed.
  function attributeByDay(employeeId: string, quantity: number, segments: { startedAt: Date; endedAt: Date }[], completions: number) {
    const perDay = splitDurationByCalendarDay(segments);
    if (perDay.size <= 1) {
      const [date] = [...perDay.keys()];
      const durationSeconds = perDay.get(date) ?? 0;
      if (date) addTo(byEmployeeDay, `${employeeId}:${date}`, quantity, durationSeconds, completions);
      return;
    }
    const totalDuration = [...perDay.values()].reduce((s, d) => s + d, 0);
    let bestDate = "";
    let bestDuration = -1;
    for (const [date, duration] of perDay) {
      addTo(byEmployeeDay, `${employeeId}:${date}`, Math.round(quantity * (duration / totalDuration)), duration, 0);
      if (duration > bestDuration) {
        bestDuration = duration;
        bestDate = date;
      }
    }
    if (completions > 0 && bestDate) addTo(byEmployeeDay, `${employeeId}:${bestDate}`, 0, 0, completions);
  }

  // Rule 1: confirmed completions. Fetches every linked segment (not
  // filtered to this activity/range yet) so the single-employee/
  // single-activity/in-range checks below see the whole picture — filtering
  // earlier would silently hide a completion that also has segments outside
  // this activity or range, corrupting the "is this cleanly attributable"
  // check. The candidate_ids CTE keeps this scoped to completions that
  // could plausibly matter to this activity (same "having" shape as
  // before), then the full per-segment detail is fetched separately so a
  // multi-day completion's duration can be split by day below, not just
  // aggregated.
  const { rows: candidateIdRows } = await pool.query(
    `select rc.id as completion_id
     from row_completions rc
     join row_completion_segments rcs on rcs.row_completion_id = rc.id
     join time_entries te on te.id = rcs.time_entry_id
     where te.deleted_at is null
       and ($2::uuid[] is null or te.employee_id = any($2::uuid[]))
     group by rc.id
     having bool_or(te.activity_id = $1) or count(distinct te.activity_id) > 1`,
    [activityId, employeeIds]
  );
  const completionIds: string[] = candidateIdRows.map((r) => r.completion_id);
  const completionSegRows = completionIds.length
    ? (
        await pool.query(
          `select rc.id as completion_id, rc.quantity_per_row, te.employee_id, te.activity_id, te.started_at, te.ended_at
           from row_completions rc
           join row_completion_segments rcs on rcs.row_completion_id = rc.id
           join time_entries te on te.id = rcs.time_entry_id
           where rc.id = any($1::uuid[])
           order by rc.id, te.started_at`,
          [completionIds]
        )
      ).rows
    : [];

  interface CompletionSeg {
    employeeId: string;
    activityId: string;
    startedAt: Date;
    endedAt: Date;
  }
  const completionSegsById = new Map<string, { quantityPerRow: number; segs: CompletionSeg[] }>();
  for (const r of completionSegRows) {
    const g = completionSegsById.get(r.completion_id) ?? { quantityPerRow: Number(r.quantity_per_row), segs: [] };
    g.segs.push({ employeeId: r.employee_id, activityId: r.activity_id, startedAt: r.started_at, endedAt: r.ended_at });
    completionSegsById.set(r.completion_id, g);
  }

  for (const { quantityPerRow, segs } of completionSegsById.values()) {
    const employeeIdsInGroup = new Set(segs.map((s) => s.employeeId));
    const activityIdsInGroup = new Set(segs.map((s) => s.activityId));
    if (employeeIdsInGroup.size !== 1) continue;
    if (activityIdsInGroup.size !== 1) continue;
    const [soleActivityId] = activityIdsInGroup;
    if (soleActivityId !== activityId) continue;
    const [soleEmployeeId] = employeeIdsInGroup;
    const allInRange = segs.every((s) => s.startedAt >= rangeStart && s.startedAt < rangeEnd);
    if (!allInRange) continue;

    const totalDurationSeconds = segs.reduce((sum, s) => sum + (s.endedAt.getTime() - s.startedAt.getTime()) / 1000, 0);
    addTo(byEmployee, soleEmployeeId, quantityPerRow, totalDurationSeconds, 1);
    attributeByDay(soleEmployeeId, quantityPerRow, segs, 1);
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
       and ($4::uuid[] is null or te.employee_id = any($4::uuid[]))
       and rcs.time_entry_id is null`,
     [activityId, rangeStart, rangeEnd, employeeIds]
  );
  // Resolved as ONE batched call, not one-per-candidate-row (even
  // concurrently) — a previous fix here moved from a sequential per-row
  // loop to Promise.all (confirmed: ~17s for a single busy activity with
  // dozens of candidate rows, down to something tolerable), but each
  // concurrent call still independently re-fetched any employee-day shared
  // by more than one candidate row — the common case for one busy employee
  // touching many rows in a day. getUnresolvedRunsForRows (see its own
  // comment) fetches each distinct employee-day at most once no matter how
  // many candidate rows here share it, cutting the query count (not just
  // wall-clock time) down to roughly the number of distinct employee-days
  // involved, not the number of candidate rows. Same "byte-identical
  // totals, just far faster" guarantee — the underlying per-run selection
  // logic is unchanged, only how many times it's computed from scratch.
  const candidatesByKey = await getUnresolvedRunsForRows(
    candidateRowsRes.map((pair) => ({ greenhouseRowId: pair.greenhouse_row_id, activityId, densityType: pair.density_type }))
  );
  const ambiguousCycleKeys = computeAmbiguousCycleKeys(candidatesByKey);

  interface AcceptedRun {
    only: CandidateRun;
    startedAt: Date;
    endedAt: Date;
  }
  const accepted: AcceptedRun[] = [];
  for (const pair of candidateRowsRes) {
    const key = `${pair.greenhouse_row_id}:${activityId}:${pair.density_type}`;
    const candidates = candidatesByKey.get(key) ?? [];
    for (const candidate of candidates) {
      // Ambiguous WITHIN ITS OWN ROW-WORK CYCLE, never across the row's
      // whole lifetime — see computeAmbiguousCycleKeys/this function's own
      // header comment for the bug this fixes.
      if (ambiguousCycleKeys.has(`${key}:${candidate.cycleIndex}`)) continue;
      // Belt-and-suspenders: getUnresolvedRunsForRows is itself called with
      // activityId (see above), so this can never actually be false — kept
      // as a cheap invariant check rather than trusted-but-unverified.
      if (candidate.activityId !== activityId) continue;
      const startedAt = new Date(candidate.startedAt);
      const endedAt = candidate.endedAt ? new Date(candidate.endedAt) : null;
      // In progress (no ended_at yet) — Activity Hours still count
      // elsewhere, but there is no finished visit to attribute a quantity
      // to; never invented.
      if (!endedAt) continue;
      // Attribute only a run whose own recorded segments fall entirely
      // inside the requested RANGE — a run that starts before or ends after
      // the report's own date window can't be cleanly resolved against a
      // range boundary. This is distinct from spanning multiple calendar
      // DAYS *within* the range, which is now split proportionally below
      // rather than excluded.
      if (startedAt < rangeStart || endedAt > rangeEnd) continue;
      accepted.push({ only: candidate, startedAt, endedAt });
    }
  }

  // Reuses the frozen density_count_per_row already resolved onto each
  // run's segments — refetched here (not carried on CandidateRun) since
  // getUnresolvedRunsForRows doesn't expose it; the query pattern mirrors
  // Inputs' own densityContributionsByActivity lookup. Also concurrent —
  // only as many of these fire as there are ACCEPTED (unambiguous,
  // in-range) candidates, typically far fewer than candidateRowsRes.
  //
  // Reads only segmentIds[0] — the chain's OWN root's first segment (see
  // getUnresolvedRunsForRows: chainSegmentIdsByRootId always accumulates the
  // root run's own segments first) — never `= any(segmentIds) limit 1`
  // across the WHOLE chain. A density-type-split visit's chain can contain
  // segments with two DIFFERENT frozen density_count_per_row values (the
  // original type's, and whatever a later config change froze on the
  // continuation) — `limit 1` with no ORDER BY picks whichever one Postgres
  // happens to visit first (index/physical order, unrelated to which is the
  // chain's actual originally-frozen quantity), silently misattributing the
  // wrong number some of the time. segmentIds[0] is deterministic and is
  // always the value that belongs to `only`'s own densityType.
  //
  // Every segment's own started_at/ended_at is fetched too (not just
  // segmentIds[0]'s) so a run spanning more than one calendar day (a
  // midnight-rollover-continued shift) can have its single frozen quantity
  // split by day proportional to duration, the same as a multi-day
  // completion above, rather than omitted from every day it touches.
  const [densityResults, segmentDetailResults] = await Promise.all([
    Promise.all(accepted.map(({ only }) => pool.query(`select density_count_per_row from time_entries where id = $1`, [only.segmentIds[0]]))),
    Promise.all(
      accepted.map(({ only }) => pool.query(`select started_at, ended_at from time_entries where id = any($1::uuid[])`, [only.segmentIds]))
    ),
  ]);

  accepted.forEach(({ only }, i) => {
    const quantityPerRow = densityResults[i].rows[0]?.density_count_per_row;
    if (quantityPerRow == null) return;
    const quantity = Number(quantityPerRow);
    const segs = segmentDetailResults[i].rows.map((r) => ({ startedAt: r.started_at as Date, endedAt: r.ended_at as Date }));
    addTo(byEmployee, only.employeeId, quantity, only.durationSeconds, 0);
    attributeByDay(only.employeeId, quantity, segs, 0);
  });

  return { byEmployee, byEmployeeDay };
}

// One raw work segment's own resolution detail — the read-only production
// audit behind the "why doesn't this quantity show up in the report"
// question. Deliberately re-derives its verdict from the SAME underlying
// data/rules getActivityDensityAttribution uses (row_completion_segments,
// getUnresolvedRunsForRows, computeAmbiguousCycleKeys, the same
// employee/activity purity and in-range checks) rather than a separate,
// potentially-drifting calculation — this is a diagnostic VIEW of that
// exact logic, not a second implementation of it.
export type DensityAuditGrouping =
  | { kind: "completed"; completionId: string; groupQuantityPerRow: number; groupDurationSeconds: number; groupSegmentCount: number }
  | { kind: "unresolved"; cycleIndex: number; candidatesInCycle: number; ambiguous: boolean; groupDurationSeconds: number; groupSegmentCount: number }
  | { kind: "in-progress" }
  | { kind: "not-density-eligible" };

export interface DensityAuditSegment {
  segmentId: string;
  employeeId: string;
  employeeName: string;
  rowLabel: string;
  // This segment's OWN calendar date (APP_TIMEZONE) — not necessarily the
  // same date its completion/run's quantity is ultimately anchored to when
  // that group spans more than one day (see groupDurationSeconds/
  // attributedQuantity, which are this segment's own proportional share).
  date: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  densityType: "plants" | "stems" | null;
  densityCountPerRow: number | null;
  completionGrouping: DensityAuditGrouping;
  // This segment's own share of its group's quantity, proportional to
  // duration (one decimal place — a diagnostic view, not the report's own
  // integer-rounded internal figure) — null whenever includedInReport is
  // false.
  attributedQuantity: number | null;
  includedInReport: boolean;
  exclusionReason: string | null;
}

// Scoped to ONE employee (an audit is a targeted "why" investigation, never
// a bulk export) across a caller-supplied date range — the same [start,
// end) an Activity Report for this activity would use, so "included in
// report" here means exactly what it would mean in that report.
export async function getActivityDensityAudit(
  activityId: string,
  employeeId: string,
  startDate: string,
  endDate: string
): Promise<DensityAuditSegment[]> {
  const { start, end } = getRangeBoundsUtc(startDate, endDate);

  const { rows: segRows } = await pool.query(
    `select te.id, te.employee_id, e.first_name, e.last_name, te.started_at, te.ended_at,
            te.greenhouse_row_id, te.density_type, te.density_count_per_row,
            gp.name as phase_name, gr.row_number,
            rcs.row_completion_id
     from time_entries te
     join employees e on e.id = te.employee_id
     left join greenhouse_rows gr on gr.id = te.greenhouse_row_id
     left join greenhouse_phases gp on gp.id = gr.phase_id
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.employee_id = $1 and te.activity_id = $2 and te.entry_type = 'work' and te.deleted_at is null
       and te.started_at >= $3 and te.started_at < $4
     order by te.started_at`,
    [employeeId, activityId, start, end]
  );

  // Completed segments: batch-fetch each distinct completion's FULL segment
  // set (every employee/activity/day it actually touches, not just this
  // employee's own slice) so the same employee/activity-purity and
  // in-range checks Rule 1 applies can be reproduced exactly here.
  const completionIds = [...new Set(segRows.filter((r) => r.row_completion_id).map((r) => r.row_completion_id as string))];
  interface CompletionSeg {
    employeeId: string;
    activityId: string;
    startedAt: Date;
    endedAt: Date;
  }
  const completionGroups = new Map<string, { quantityPerRow: number; segs: CompletionSeg[] }>();
  if (completionIds.length) {
    const { rows: groupRows } = await pool.query(
      `select rc.id as completion_id, rc.quantity_per_row, te.employee_id, te.activity_id, te.started_at, te.ended_at
       from row_completions rc
       join row_completion_segments rcs on rcs.row_completion_id = rc.id
       join time_entries te on te.id = rcs.time_entry_id
       where rc.id = any($1::uuid[])`,
      [completionIds]
    );
    for (const r of groupRows) {
      const g = completionGroups.get(r.completion_id) ?? { quantityPerRow: Number(r.quantity_per_row), segs: [] };
      g.segs.push({ employeeId: r.employee_id, activityId: r.activity_id, startedAt: r.started_at, endedAt: r.ended_at });
      completionGroups.set(r.completion_id, g);
    }
  }

  // Unresolved segments: batch by (row, densityType) pair, reusing the same
  // getUnresolvedRunsForRows + computeAmbiguousCycleKeys the real report
  // uses. Scoped to finished (ended_at not null) segments only — an
  // in-progress one is reported separately below, never sent through
  // candidate resolution.
  const unresolvedSegs = segRows.filter((r) => !r.row_completion_id && r.greenhouse_row_id && r.density_type && r.ended_at);
  const candidatesByKey = await getUnresolvedRunsForRows(
    unresolvedSegs.map((r) => ({ greenhouseRowId: r.greenhouse_row_id, activityId, densityType: r.density_type }))
  );
  const ambiguousCycleKeys = computeAmbiguousCycleKeys(candidatesByKey);
  const candidateBySegmentId = new Map<string, CandidateRun>();
  for (const list of candidatesByKey.values()) {
    for (const candidate of list) {
      for (const segId of candidate.segmentIds) candidateBySegmentId.set(segId, candidate);
    }
  }
  // Cached across segments sharing the same candidate root — avoids
  // re-querying the same run's frozen density value once per one of its own
  // multiple segments.
  const densityByFirstSegmentId = new Map<string, number | null>();
  async function frozenDensityFor(candidate: CandidateRun): Promise<number | null> {
    const firstId = candidate.segmentIds[0];
    if (densityByFirstSegmentId.has(firstId)) return densityByFirstSegmentId.get(firstId)!;
    const res = await pool.query(`select density_count_per_row from time_entries where id = $1`, [firstId]);
    const value = res.rows[0]?.density_count_per_row != null ? Number(res.rows[0].density_count_per_row) : null;
    densityByFirstSegmentId.set(firstId, value);
    return value;
  }

  const rows: DensityAuditSegment[] = [];
  for (const r of segRows) {
    const durationSeconds = r.ended_at ? Math.round((r.ended_at.getTime() - r.started_at.getTime()) / 1000) : 0;
    const base = {
      segmentId: r.id as string,
      employeeId: r.employee_id as string,
      employeeName: `${r.first_name} ${r.last_name}`,
      rowLabel: r.phase_name ? `${r.phase_name} · Row ${r.row_number}` : "—",
      date: calendarDateInAppTimezone(r.started_at),
      startedAt: (r.started_at as Date).toISOString(),
      endedAt: r.ended_at ? (r.ended_at as Date).toISOString() : null,
      durationSeconds,
      densityType: r.density_type as "plants" | "stems" | null,
      densityCountPerRow: r.density_count_per_row != null ? Number(r.density_count_per_row) : null,
    };

    if (!r.greenhouse_row_id || !r.density_type) {
      rows.push({
        ...base,
        completionGrouping: { kind: "not-density-eligible" },
        attributedQuantity: null,
        includedInReport: false,
        exclusionReason: "Not linked to a density-tracked greenhouse row",
      });
      continue;
    }
    if (!r.ended_at) {
      rows.push({
        ...base,
        completionGrouping: { kind: "in-progress" },
        attributedQuantity: null,
        includedInReport: false,
        exclusionReason: "Still in progress — no end time yet, so Activity Hours (once finished) but never an invented quantity",
      });
      continue;
    }

    if (r.row_completion_id) {
      const group = completionGroups.get(r.row_completion_id)!;
      const employeeIdsInGroup = new Set(group.segs.map((s) => s.employeeId));
      const activityIdsInGroup = new Set(group.segs.map((s) => s.activityId));
      const groupDurationSeconds = group.segs.reduce((s, seg) => s + (seg.endedAt.getTime() - seg.startedAt.getTime()) / 1000, 0);
      let reason: string | null = null;
      if (employeeIdsInGroup.size !== 1) {
        reason = "This completion's segments span more than one employee — not cleanly attributable";
      } else if (activityIdsInGroup.size !== 1 || [...activityIdsInGroup][0] !== activityId) {
        reason = "This completion's segments span more than one activity — not cleanly attributable";
      } else if (!group.segs.every((s) => s.startedAt >= start && s.startedAt < end)) {
        reason = "One or more of this completion's segments fall outside the audited date range";
      }
      const included = reason === null;
      const attributedQuantity = included && groupDurationSeconds > 0 ? group.quantityPerRow * (durationSeconds / groupDurationSeconds) : null;
      rows.push({
        ...base,
        completionGrouping: {
          kind: "completed",
          completionId: r.row_completion_id,
          groupQuantityPerRow: group.quantityPerRow,
          groupDurationSeconds,
          groupSegmentCount: group.segs.length,
        },
        attributedQuantity: attributedQuantity != null ? Math.round(attributedQuantity * 10) / 10 : null,
        includedInReport: included,
        exclusionReason: reason,
      });
      continue;
    }

    // Unresolved.
    const key = `${r.greenhouse_row_id}:${activityId}:${r.density_type}`;
    const candidate = candidateBySegmentId.get(r.id);
    if (!candidate) {
      // Should not happen (every unresolved segment sent into
      // getUnresolvedRunsForRows resolves to some candidate) — surfaced
      // rather than silently guessed at, in case of a genuine data anomaly.
      rows.push({
        ...base,
        completionGrouping: { kind: "not-density-eligible" },
        attributedQuantity: null,
        includedInReport: false,
        exclusionReason: "Could not resolve a candidate run for this segment",
      });
      continue;
    }
    const candidatesInCycle = (candidatesByKey.get(key) ?? []).filter((c) => c.cycleIndex === candidate.cycleIndex).length;
    const ambiguous = ambiguousCycleKeys.has(`${key}:${candidate.cycleIndex}`);
    if (ambiguous) {
      rows.push({
        ...base,
        completionGrouping: {
          kind: "unresolved",
          cycleIndex: candidate.cycleIndex,
          candidatesInCycle,
          ambiguous: true,
          groupDurationSeconds: candidate.durationSeconds,
          groupSegmentCount: candidate.segmentIds.length,
        },
        attributedQuantity: null,
        includedInReport: false,
        exclusionReason: `Ambiguous — ${candidatesInCycle} unresolved candidates for this row in the same ~7-day work cycle (needs admin review via Row Completion Review)`,
      });
      continue;
    }
    const quantityPerRow = await frozenDensityFor(candidate);
    const candidateStartedAt = new Date(candidate.startedAt);
    const candidateEndedAt = candidate.endedAt ? new Date(candidate.endedAt) : null;
    const inRange = !!candidateEndedAt && candidateStartedAt >= start && candidateEndedAt < end;
    let reason: string | null = null;
    if (quantityPerRow == null) reason = "No resolvable density value for this run";
    else if (!inRange) reason = "This run extends outside the audited date range";
    const included = reason === null;
    const attributedQuantity =
      included && quantityPerRow != null && candidate.durationSeconds > 0 ? quantityPerRow * (durationSeconds / candidate.durationSeconds) : null;
    rows.push({
      ...base,
      completionGrouping: {
        kind: "unresolved",
        cycleIndex: candidate.cycleIndex,
        candidatesInCycle,
        ambiguous: false,
        groupDurationSeconds: candidate.durationSeconds,
        groupSegmentCount: candidate.segmentIds.length,
      },
      attributedQuantity: attributedQuantity != null ? Math.round(attributedQuantity * 10) / 10 : null,
      includedInReport: included,
      exclusionReason: reason,
    });
  }

  return rows;
}

export async function getActivityReportData(
  activityId: string,
  startDate: string,
  endDate: string,
  filter: ReportEmployeeFilter = {}
): Promise<ActivityReportData | null> {
  const activityRes = await pool.query(
    `select id, name, normal_speed, speed_unit from activities where id = $1`,
    [activityId]
  );
  const activity = activityRes.rows[0];
  if (!activity) return null;

  const { start, end } = getRangeBoundsUtc(startDate, endDate);
  const employeeIds = filterToUuidArray(filter.employeeIds);

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
       and ($5::uuid[] is null or te.employee_id = any($5::uuid[]))
     group by te.employee_id, e.first_name, e.last_name, work_date
     order by work_date, e.first_name, e.last_name`,
    [activityId, start, end, APP_TIMEZONE, employeeIds]
  );

  const workEmployeeIds = [...new Set(workRes.rows.map((r) => r.employee_id as string))];

  // Whole-shift break totals for the same employee/day pairs — breaks carry
  // no activity_id (see time_entries schema), so "break time" on an Activity
  // Report is necessarily each employee's whole-day break time, not a
  // portion attributed to this one activity. This is the only safely
  // available reading of that column, not an invented split.
  const breakRes = workEmployeeIds.length
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
        [workEmployeeIds, start, end, APP_TIMEZONE]
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

  // Employee Paid Time — the employee's WHOLE SHIFT for each day they
  // touched this activity, every activity combined, never scoped to just
  // this one. Deliberately a completely separate query from workRes above
  // (not activity-scoped at all) and computed via computeWorkdayTotals —
  // the same span-based formula Payroll/Inputs already use — rather than
  // "this activity's workSeconds + the day's paidBreakSeconds", which
  // undercounts on any day the employee also worked a different activity.
  const wholeShiftRes = workEmployeeIds.length
    ? await pool.query(
        `select te.employee_id, te.entry_type, te.started_at, te.ended_at, te.is_paid
         from time_entries te
         where te.deleted_at is null and te.ended_at is not null
           and te.employee_id = any($1::uuid[]) and te.started_at >= $2 and te.started_at < $3
         order by te.employee_id, te.started_at`,
        [workEmployeeIds, start, end]
      )
    : { rows: [] as { employee_id: string; entry_type: "work" | "break"; started_at: Date; ended_at: Date; is_paid: boolean | null }[] };
  interface WholeShiftEntry extends WorkdayBoundaryEntry {
    employeeId: string;
  }
  const wholeShiftEntries: WholeShiftEntry[] = wholeShiftRes.rows.map((r) => ({
    employeeId: r.employee_id,
    entryType: r.entry_type,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    isPaid: r.is_paid,
  }));
  const employeePaidByKey = new Map<string, number>();
  for (const [key, entries] of groupByEmployeeDay(wholeShiftEntries)) {
    employeePaidByKey.set(key, toSeconds(computeWorkdayTotals(entries).workedSeconds));
  }

  const attribution = await getActivityDensityAttribution(activityId, start, end, { employeeIds: employeeIds ?? undefined });

  const rows: ActivityReportRow[] = workRes.rows.map((r) => {
    const dateStr = String(r.work_date);
    const breakInfo = breakByKey.get(`${r.employee_id}:${dateStr}`) ?? {
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
    };
    const rowWorkSeconds = toSeconds(r.work_seconds);
    // That day's own safely-attributable quantity only — never the
    // employee's whole-range figure. A day with real density work that
    // happened to be part of a multi-day-spanning completion/run correctly
    // shows blank here (see getActivityDensityAttribution) even though it
    // still contributes to the range totals below. Speed's denominator is
    // this row's own Activity Hours (rowWorkSeconds) — the activity's full
    // exact productive time that day — not attribution's own durationSeconds,
    // which only covers segments that happened to yield a resolvable
    // quantity and can be narrower (e.g. non-row-based work, or an
    // unresolved/ambiguous row) than the day's real Activity Hours.
    const daily = attribution.byEmployeeDay.get(`${r.employee_id}:${dateStr}`) ?? null;
    const dailySpeed = daily ? aggregateDensitySpeed([{ quantityPerRow: daily.quantity, durationSeconds: rowWorkSeconds }]) : null;
    return {
      employeeId: r.employee_id,
      employeeName: `${r.first_name} ${r.last_name}`,
      date: dateStr,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      workSeconds: rowWorkSeconds,
      breakSeconds: breakInfo.breakSeconds,
      paidBreakSeconds: breakInfo.paidBreakSeconds,
      unpaidBreakSeconds: breakInfo.unpaidBreakSeconds,
      rowsTouched: Number(r.rows_touched),
      quantityWorked: daily ? daily.quantity : null,
      rowsCompleted: daily ? daily.completions : 0,
      averageSpeed: dailySpeed,
      employeePaidSeconds: employeePaidByKey.get(`${r.employee_id}:${dateStr}`) ?? 0,
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
       and greenhouse_row_id is not null and started_at >= $2 and started_at < $3
       and ($4::uuid[] is null or employee_id = any($4::uuid[]))`,
    [activityId, start, end, employeeIds]
  );
  const totalRowsTouched = Number(rangeRowsRes.rows[0]?.n ?? 0);
  void distinctRowsTouched;

  // Range-level totals — ratio-of-sums over EVERY qualifying contribution
  // for the whole selected range (attribution.byEmployee), never an average
  // of the per-day speeds shown on the rows above. This is also where a
  // multi-day-spanning completion/run actually counts, even though it
  // couldn't be pinned to any single day-row. The denominator is the
  // range's total Activity Hours (totalWorkSeconds, already summed above),
  // not attribution's own duration — see the per-row comment above for why.
  let totalQuantity = 0;
  let totalCompletions = 0;
  let anyQuantity = false;
  for (const c of attribution.byEmployee.values()) {
    totalQuantity += c.quantity;
    totalCompletions += c.completions;
    anyQuantity = true;
  }
  const overallSpeed = anyQuantity
    ? aggregateDensitySpeed([{ quantityPerRow: totalQuantity, durationSeconds: totalWorkSeconds }])
    : null;
  const totalEmployeePaidSeconds = rows.reduce((s, r) => s + r.employeePaidSeconds, 0);

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
    { workSeconds: number; breakSeconds: number; paidBreakSeconds: number; unpaidBreakSeconds: number; employeePaidSeconds: number }
  >();
  const dateSeconds = new Map<
    string,
    { workSeconds: number; breakSeconds: number; paidBreakSeconds: number; unpaidBreakSeconds: number; employeePaidSeconds: number }
  >();
  for (const r of rows) {
    const e = employeeSeconds.get(r.employeeId) ?? {
      workSeconds: 0,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      employeePaidSeconds: 0,
    };
    e.workSeconds += r.workSeconds;
    e.breakSeconds += r.breakSeconds;
    e.paidBreakSeconds += r.paidBreakSeconds;
    e.unpaidBreakSeconds += r.unpaidBreakSeconds;
    e.employeePaidSeconds += r.employeePaidSeconds;
    employeeSeconds.set(r.employeeId, e);

    const d = dateSeconds.get(r.date) ?? {
      workSeconds: 0,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      employeePaidSeconds: 0,
    };
    d.workSeconds += r.workSeconds;
    d.breakSeconds += r.breakSeconds;
    d.paidBreakSeconds += r.paidBreakSeconds;
    d.unpaidBreakSeconds += r.unpaidBreakSeconds;
    d.employeePaidSeconds += r.employeePaidSeconds;
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
       and ($4::uuid[] is null or employee_id = any($4::uuid[]))
     group by employee_id`,
    [activityId, start, end, employeeIds]
  );
  const employeeRowsTouched = new Map(employeeRowsTouchedRes.rows.map((r) => [r.employee_id as string, Number(r.n)]));

  const dateRowsTouchedRes = await pool.query(
    `select to_char((started_at at time zone $4)::date, 'YYYY-MM-DD') as work_date, count(distinct greenhouse_row_id) as n
     from time_entries
     where activity_id = $1 and entry_type = 'work' and deleted_at is null
       and greenhouse_row_id is not null and started_at >= $2 and started_at < $3
       and ($5::uuid[] is null or employee_id = any($5::uuid[]))
     group by work_date`,
    [activityId, start, end, APP_TIMEZONE, employeeIds]
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
      // Denominator is this employee's own Activity Hours (secs.workSeconds)
      // for the whole range, not density's own durationSeconds — see the
      // per-row comment above.
      averageSpeed: density ? aggregateDensitySpeed([{ quantityPerRow: density.quantity, durationSeconds: secs.workSeconds }]) : null,
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
        averageSpeed: density ? aggregateDensitySpeed([{ quantityPerRow: density.quantity, durationSeconds: secs.workSeconds }]) : null,
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
      employeePaidSeconds: totalEmployeePaidSeconds,
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
export async function getPayrollReportData(
  startDate: string,
  endDate: string,
  filter: ReportEmployeeFilter = {}
): Promise<PayrollReportData> {
  const { start, end } = getRangeBoundsUtc(startDate, endDate);
  const employeeIds = filterToUuidArray(filter.employeeIds);

  // Raw entries, not a SQL sum — the authoritative whole-day Worked total
  // (workSeconds below) is span-based (corrected/rounded work-end minus
  // corrected/rounded work-start, minus the union of unpaid breaks — see
  // workdayTotals.ts), which a plain SQL sum/filter aggregate can't express
  // (interval union needs either range-type support this schema doesn't
  // use, or raw rows merged in application code). Same shared function GET
  // /api/inputs/daily uses, so Inputs and Payroll can never disagree on one
  // employee-day's total — the whole point of this fix (see
  // workdayTotals.ts's header for the reported bug this traces back to).
  const { rows: rawRows } = await pool.query(
    `select te.employee_id, e.first_name, e.last_name, te.entry_type, te.started_at, te.ended_at, te.is_paid
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.deleted_at is null and te.ended_at is not null
       and te.started_at >= $1 and te.started_at < $2
       and ($3::uuid[] is null or te.employee_id = any($3::uuid[]))
     order by te.employee_id, te.started_at`,
    [start, end, employeeIds]
  );

  interface RawEntry extends WorkdayBoundaryEntry {
    employeeId: string;
    employeeName: string;
  }
  const rawEntries: RawEntry[] = rawRows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: `${r.first_name} ${r.last_name}`,
    entryType: r.entry_type,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    isPaid: r.is_paid,
  }));

  const rows: PayrollReportRow[] = [...groupByEmployeeDay(rawEntries).entries()]
    .map(([key, entries]) => {
      const [employeeId, date] = [entries[0].employeeId, key.slice(key.indexOf(":") + 1)];
      const totals = computeWorkdayTotals(entries);
      const workSeconds = toSeconds(totals.workedSeconds);
      const breakSeconds = toSeconds(totals.breakSeconds);
      const paidBreakSeconds = toSeconds(totals.paidBreakSeconds);
      const unpaidBreakSeconds = toSeconds(totals.unpaidBreakSeconds);
      return {
        employeeId,
        employeeName: entries[0].employeeName,
        date,
        startedAt: totals.workStartTime ? totals.workStartTime.toISOString() : null,
        endedAt: totals.workEndTime ? totals.workEndTime.toISOString() : null,
        workSeconds,
        breakSeconds,
        paidBreakSeconds,
        unpaidBreakSeconds,
        // Paid breaks are already folded into workSeconds (the span-based
        // formula only ever subtracts UNPAID break time — see
        // workdayTotals.ts) — "paid time" is therefore identical to
        // "worked time" under the new model, not a separate add-on the way
        // it was when workSeconds excluded every break, paid or not.
        paidSeconds: workSeconds,
        // The full authoritative span, not work + naively-summed breaks
        // (which, pre-fix, silently excluded any untracked transition
        // gap) — equal to workSeconds + unpaidBreakSeconds by construction.
        totalSeconds: workSeconds + unpaidBreakSeconds,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));

  const { rows: daysWorkedRows } = await pool.query(
    `select te.employee_id, e.first_name, e.last_name,
            count(distinct (te.started_at at time zone $3)::date) as days_worked
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.entry_type = 'work' and te.deleted_at is null and te.ended_at is not null
       and te.started_at >= $1 and te.started_at < $2
       and ($4::uuid[] is null or te.employee_id = any($4::uuid[]))
     group by te.employee_id, e.first_name, e.last_name`,
    [start, end, APP_TIMEZONE, employeeIds]
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
       and ($3::uuid[] is null or te.employee_id = any($3::uuid[]))
     group by te.employee_id, te.activity_id, a.name
     order by a.name`,
    [start, end, employeeIds]
  );
  const activityBreakdown: PayrollActivityBreakdownRow[] = activityRows.map((r) => ({
    employeeId: r.employee_id,
    activityId: r.activity_id,
    activityName: r.activity_name,
    workSeconds: toSeconds(r.work_seconds),
  }));

  // Aggregate (all employees combined) totals per calendar week — a
  // per-employee-per-week breakdown was judged out of scope for this pass;
  // see the implementation report. Derived from `rows` (already computed
  // above via the shared workdayTotals.ts formula), not a separate raw-sum
  // SQL query — a week total must equal the sum of its own days' rows, the
  // same self-consistency reasoning this whole file's fix is about; a
  // second, differently-computed aggregate here would silently reintroduce
  // exactly the kind of disagreement this fix eliminates, just one level
  // up.
  const weekBuckets = new Map<string, { workSeconds: number; breakSeconds: number }>();
  for (const r of rows) {
    const weekStart = isoWeekStartDateStr(r.date);
    const bucket = weekBuckets.get(weekStart) ?? { workSeconds: 0, breakSeconds: 0 };
    bucket.workSeconds += r.workSeconds;
    // r.breakSeconds is already paid+unpaid combined (same meaning as
    // PayrollReportRow.breakSeconds) — kept that way here too so this
    // column means the same thing at every level of the report, daily or
    // weekly.
    bucket.breakSeconds += r.breakSeconds;
    weekBuckets.set(weekStart, bucket);
  }
  const weeklyTotals: PayrollWeeklyTotalRow[] = [...weekBuckets.entries()]
    .map(([weekStart, b]) => ({
      weekStart,
      weekEnd: addDaysToDateStr(weekStart, 6),
      workSeconds: b.workSeconds,
      breakSeconds: b.breakSeconds,
      // Paid break time is already folded into workSeconds under the new
      // model (see rows' own paidSeconds comment above) — "paid seconds"
      // is therefore identical to "worked seconds", not a separate add-on.
      paidSeconds: b.workSeconds,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

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
