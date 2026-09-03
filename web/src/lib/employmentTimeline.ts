// Pure grid-building + filter-composition logic for the Employment Timeline
// graph/table — kept independent of any component so it's directly
// testable and so the graph, table, and export all read the exact same
// filtered/positioned data (guarantees parity by construction).
import { addCalendarDays, addCalendarMonths, enumerateDates, endOfMonth, startOfMonth, startOfWeekMonday } from "./timezone";
import { EmploymentPeriod, EmploymentTimelineEmployee, EmploymentTimelineFilterState, STATUS_LABELS } from "./employmentPeriodTypes";

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

function displayStatus(period: EmploymentPeriod): string {
  // Priority order matches the graph's own bar-state precedence
  // (barStateLabel in EmploymentTimelineGraph.tsx) so the table/export and
  // the graph never disagree about a period's headline status, even though
  // computePeriodStatuses can return more than one tag at once.
  if (period.statuses.includes("overdue")) return STATUS_LABELS.overdue;
  if (period.statuses.includes("completed")) return STATUS_LABELS.completed;
  if (period.statuses.includes("finishingSoon")) return STATUS_LABELS.finishingSoon;
  if (period.statuses.includes("startingSoon")) return STATUS_LABELS.startingSoon;
  if (period.statuses.includes("future")) return STATUS_LABELS.future;
  return STATUS_LABELS.current;
}

// One row per employment period (not per employee) — the single builder the
// table view and CSV/PDF export both call, so they can never disagree about
// row content or order (parity by construction, not by re-implementing the
// same mapping twice).
export function buildEmploymentTimelineRows(employees: EmploymentTimelineEmployee[]): EmploymentTimelineRow[] {
  const rows: EmploymentTimelineRow[] = [];
  for (const emp of employees) {
    const name = `${emp.firstName} ${emp.lastName}`;
    for (const period of emp.periods) {
      rows.push({
        employeeName: name,
        nationality: emp.nationality ?? "Unspecified",
        workGroup: period.workGroup ?? "Unspecified",
        employmentType: period.employmentType ?? "Unspecified",
        startDate: period.startDate,
        expectedFinishDate: period.expectedFinishDate ?? "",
        actualFinishDate: period.actualFinishDate ?? "",
        status: displayStatus(period),
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

// -- timeline columns (Month/Quarter/Year views) ------------------------

export type TimelineViewType = "month" | "quarter" | "year";

export interface TimelineColumn {
  key: string;
  label: string;
  startDate: string; // inclusive
  endDate: string; // inclusive
}

function startOfQuarter(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(quarterStartMonth).padStart(2, "0")}-01`;
}

function formatDayLabel(dateStr: string): string {
  const [, , d] = dateStr.split("-");
  return String(Number(d));
}

function formatWeekLabel(startDate: string): string {
  const [, m, d] = startDate.split("-");
  return `${MONTH_ABBR[Number(m) - 1]} ${Number(d)}`;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonthLabel(dateStr: string): string {
  const [, m] = dateStr.split("-");
  return MONTH_ABBR[Number(m) - 1];
}

// The visible columns for a given view anchored on `anchorDate` — Month:
// one column per day of that month. Quarter: one column per week (13
// weeks, Monday-start) of the quarter containing anchorDate. Year: one
// column per month of that year.
export function getTimelineColumns(view: TimelineViewType, anchorDate: string): TimelineColumn[] {
  if (view === "month") {
    const start = startOfMonth(anchorDate);
    const end = endOfMonth(anchorDate);
    return enumerateDates(start, end).map((d) => ({ key: d, label: formatDayLabel(d), startDate: d, endDate: d }));
  }
  if (view === "quarter") {
    const quarterStart = startOfQuarter(anchorDate);
    const columns: TimelineColumn[] = [];
    let cursor = startOfWeekMonday(quarterStart);
    for (let i = 0; i < 13; i++) {
      const weekEnd = addCalendarDays(cursor, 6);
      columns.push({ key: cursor, label: formatWeekLabel(cursor), startDate: cursor, endDate: weekEnd });
      cursor = addCalendarDays(cursor, 7);
    }
    return columns;
  }
  // year
  const yearStart = `${anchorDate.slice(0, 4)}-01-01`;
  const columns: TimelineColumn[] = [];
  let cursor = yearStart;
  for (let i = 0; i < 12; i++) {
    columns.push({ key: cursor, label: formatMonthLabel(cursor), startDate: startOfMonth(cursor), endDate: endOfMonth(cursor) });
    cursor = addCalendarMonths(cursor, 1);
  }
  return columns;
}

// Shifts the anchor date by one view-unit in `direction` (+1/-1) — Prev/Next
// navigation.
export function shiftAnchor(view: TimelineViewType, anchorDate: string, direction: 1 | -1): string {
  if (view === "month") return addCalendarMonths(anchorDate, direction);
  if (view === "quarter") return addCalendarMonths(anchorDate, direction * 3);
  return addCalendarMonths(anchorDate, direction * 12);
}

// -- bar positioning ------------------------------------------------------

export interface BarPosition {
  startColIndex: number; // inclusive index into the columns array
  endColIndex: number; // inclusive index into the columns array
  clippedStart: boolean; // the period actually started before the first visible column
  clippedEnd: boolean; // the period's true end (if any) extends past the last visible column, or it has no finish at all
}

// Returns null when the period doesn't intersect the visible columns at
// all. `columns` must be non-empty and sorted ascending (as returned by
// getTimelineColumns).
export function computeBarPosition(
  period: Pick<EmploymentPeriod, "startDate" | "expectedFinishDate" | "actualFinishDate">,
  columns: TimelineColumn[]
): BarPosition | null {
  if (columns.length === 0) return null;
  const firstCol = columns[0];
  const lastCol = columns[columns.length - 1];
  const effectiveEnd = period.actualFinishDate ?? period.expectedFinishDate ?? null; // null = open-ended

  if (effectiveEnd !== null && effectiveEnd < firstCol.startDate) return null; // entirely before the visible range
  if (period.startDate > lastCol.endDate) return null; // entirely after the visible range

  const clippedStart = period.startDate < firstCol.startDate;
  let startColIndex = clippedStart ? 0 : columns.findIndex((c) => period.startDate <= c.endDate);
  if (startColIndex === -1) startColIndex = 0;

  const clippedEnd = effectiveEnd === null || effectiveEnd > lastCol.endDate;
  let endColIndex: number;
  if (clippedEnd) {
    endColIndex = columns.length - 1;
  } else {
    endColIndex = columns.findIndex((c) => (effectiveEnd as string) <= c.endDate);
    if (endColIndex === -1) endColIndex = columns.length - 1;
  }

  return { startColIndex, endColIndex, clippedStart, clippedEnd };
}
