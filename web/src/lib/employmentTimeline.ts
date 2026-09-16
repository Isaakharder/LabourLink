// Pure range/positioning + filter-composition logic for the Employment
// Timeline graph/table — kept independent of any component so it's
// directly testable and so the graph, table, and export all read the exact
// same filtered/positioned data (guarantees parity by construction).
//
// The graph's default and primary view is "Fit all": one continuous
// date range spanning every included employee's employment, positioned by
// percentage rather than a fixed per-day/week/month grid (a grid can't
// reasonably span years of history). computeFittedRange/buildTimelineMonthMarks/
// computeBarPosition below are that range-based system. Every date-range
// rule (inclusion, effective end date, label) is already decided
// server-side per period (employmentTimelineView.ts on the server) — this
// file only aggregates/positions those already-agreed-upon fields, the
// same "server decides, client positions" split computePeriodStatuses
// (server) + the old computeBarPosition (client) already used.
import { EmploymentPeriod, EmploymentTimelineEmployee, EmploymentTimelineFilterState, TIMELINE_BAR_LABEL_TEXT } from "./employmentPeriodTypes";

// -- table/export row shape ----------------------------------------------

export interface EmploymentTimelineRow {
  employeeName: string;
  nationality: string;
  workGroup: string;
  employmentType: string;
  startDate: string;
  expectedFinishDate: string;
  actualFinishDate: string;
  status: string;
}

// One row per employment period (not per employee) — the single builder the
// table view and CSV/PDF export both call, so they can never disagree about
// row content or order (parity by construction, not by re-implementing the
// same mapping twice). An employee with no usable dates at all (see
// EmploymentTimelineEmployee.hasUsableDates) still gets exactly one row, so
// they're visibly flagged rather than silently missing from the table/export.
export function buildEmploymentTimelineRows(employees: EmploymentTimelineEmployee[]): EmploymentTimelineRow[] {
  const rows: EmploymentTimelineRow[] = [];
  for (const emp of employees) {
    const name = `${emp.firstName} ${emp.lastName}`;
    if (!emp.hasUsableDates) {
      rows.push({
        employeeName: name,
        nationality: emp.nationality ?? "Unspecified",
        workGroup: "—",
        employmentType: "—",
        startDate: "",
        expectedFinishDate: "",
        actualFinishDate: "",
        status: "No employment dates recorded",
      });
      continue;
    }
    for (const period of emp.periods) {
      rows.push({
        employeeName: name,
        nationality: emp.nationality ?? "Unspecified",
        workGroup: period.workGroup ?? "Unspecified",
        employmentType: period.employmentType ?? "Unspecified",
        startDate: period.startDate,
        expectedFinishDate: period.expectedFinishDate ?? "",
        actualFinishDate: period.actualFinishDate ?? "",
        status: TIMELINE_BAR_LABEL_TEXT[period.timelineLabel],
      });
    }
  }
  return rows;
}

// -- filter composition ------------------------------------------------

// AND across categories (employee, nationality, and "at least one period
// matches every active period-level filter"), OR within a category (any
// selected value in that category counts as a match). A period must
// satisfy Work Group AND Employment Type AND Status together to count for
// the employee-qualifies check — e.g. "Guatemalan + Greenhouse + Seasonal"
// requires one period that is both Greenhouse and Seasonal, on a
// Guatemalan employee, not any period being Greenhouse and any (possibly
// different) period being Seasonal.
//
// Row-visibility rule: once an employee qualifies, ALL of their periods are
// kept (not just the matching one) — employment history never shows
// misleading gaps just because an older period doesn't match the current
// filter.
export function filterEmploymentTimelineEmployees(
  employees: EmploymentTimelineEmployee[],
  filters: EmploymentTimelineFilterState
): EmploymentTimelineEmployee[] {
  const hasEmployeeFilter = filters.employeeIds.length > 0;
  const hasNationalityFilter = filters.nationalities.length > 0;
  const hasWorkGroupFilter = filters.workGroups.length > 0;
  const hasEmploymentTypeFilter = filters.employmentTypes.length > 0;
  const hasStatusFilter = filters.statuses.length > 0;
  const hasAnyPeriodFilter = hasWorkGroupFilter || hasEmploymentTypeFilter || hasStatusFilter;

  function periodMatches(p: EmploymentPeriod): boolean {
    if (hasWorkGroupFilter) {
      const matches = p.workGroup ? filters.workGroups.includes(p.workGroup) : filters.workGroups.includes("Unspecified");
      if (!matches) return false;
    }
    if (hasEmploymentTypeFilter) {
      const matches = p.employmentType ? filters.employmentTypes.includes(p.employmentType) : filters.employmentTypes.includes("Unspecified");
      if (!matches) return false;
    }
    if (hasStatusFilter) {
      if (!p.statuses.some((s) => filters.statuses.includes(s))) return false;
    }
    return true;
  }

  return employees.filter((emp) => {
    if (hasEmployeeFilter && !filters.employeeIds.includes(emp.id)) return false;
    if (hasNationalityFilter) {
      const matches = emp.nationality ? filters.nationalities.includes(emp.nationality) : filters.nationalities.includes("Unspecified");
      if (!matches) return false;
    }
    if (!hasAnyPeriodFilter) return true;
    return emp.periods.some(periodMatches);
  });
}

// -- date-range math -------------------------------------------------------

// Calendar-day difference (to - from), positive when `to` is later. Pure
// UTC-arithmetic-space subtraction — same "never a real timezone
// conversion" convention as every other calendar-date helper in this
// codebase (see timezone.ts's own header comment).
export function daysBetweenDateStrs(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / 86400000);
}

export interface TimelineRange {
  start: string; // inclusive YYYY-MM-DD
  end: string; // inclusive YYYY-MM-DD
}

// The default "Fit all" range: begins at the earliest start date of any
// included, dated employee/period and ends at the latest
// timelineEffectiveEndDate among them — which is already `today` for any
// "ongoing"/"expiredStillWorking" bar (see employmentTimelineView.ts) — so
// today is naturally included without special-casing it here beyond the
// final floor below. Returns null only when there is nothing datable to
// show at all (e.g. every visible employee is flagged hasUsableDates:false).
// Recompute this from whatever employee list is currently visible — it
// naturally "recalculates after filters" simply by being called with the
// already-filtered array, no separate filter-awareness needed here.
export function computeFittedRange(employees: EmploymentTimelineEmployee[], today: string): TimelineRange | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const emp of employees) {
    if (!emp.hasUsableDates) continue;
    for (const p of emp.periods) {
      if (start === null || p.startDate < start) start = p.startDate;
      if (end === null || p.timelineEffectiveEndDate > end) end = p.timelineEffectiveEndDate;
    }
  }
  if (start === null) return null;
  if (end === null || end < today) end = today;
  return { start, end };
}

// Clamps a date into [0, 100] percent of `range` — a date before range.start
// (a bar clipped by a custom From/To override, say) reads as 0%, one after
// range.end reads as 100%, matching the same "clip at the visible edge"
// behavior the old fixed-grid computeBarPosition had.
export function percentInRange(dateStr: string, range: TimelineRange): number {
  const totalDays = daysBetweenDateStrs(range.start, range.end);
  if (totalDays <= 0) return 0;
  const offset = daysBetweenDateStrs(range.start, dateStr);
  return Math.min(100, Math.max(0, (offset / totalDays) * 100));
}

export interface BarPosition {
  leftPercent: number;
  widthPercent: number;
}

// "Ongoing"/"expiredStillWorking" bars are drawn all the way to the range's
// own right edge (not literally clipped at their timelineEffectiveEndDate,
// which is always `today` — the range's right edge is always >= today by
// construction, so this reaches exactly "through today/the displayed right
// boundary" per spec). A tiny minimum width keeps a same-day bar visible
// rather than collapsing to nothing.
const MIN_BAR_WIDTH_PERCENT = 0.4;

export function computeBarPosition(period: EmploymentPeriod, range: TimelineRange): BarPosition {
  const extendsToEdge = period.timelineLabel === "ongoing" || period.timelineLabel === "expiredStillWorking";
  const endDate = extendsToEdge ? range.end : period.timelineEffectiveEndDate;
  const left = percentInRange(period.startDate, range);
  const right = extendsToEdge ? 100 : percentInRange(endDate, range);
  return { leftPercent: left, widthPercent: Math.max(right - left, MIN_BAR_WIDTH_PERCENT) };
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface TimelineMonthMark {
  key: string; // YYYY-MM-01
  label: string; // "Jan" normally, "Jan 2027" at a year boundary (incl. the very first mark)
  leftPercent: number;
}

// One mark per calendar month boundary crossed by `range`, positioned by
// percentage — sensible month/year headers for a range that can span from a
// few weeks to several years, without needing a discrete per-day grid
// column for every day in between.
export function buildTimelineMonthMarks(range: TimelineRange): TimelineMonthMark[] {
  const marks: TimelineMonthMark[] = [];
  const [startY, startM] = range.start.split("-").map(Number);
  const [endY, endM] = range.end.split("-").map(Number);
  let y = startY;
  let m = startM;
  let first = true;
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${String(m).padStart(2, "0")}-01`;
    const label = first || m === 1 ? `${MONTH_ABBR[m - 1]} ${y}` : MONTH_ABBR[m - 1];
    marks.push({ key, label, leftPercent: percentInRange(key, range) });
    first = false;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return marks;
}
