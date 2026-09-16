// Pure range/positioning + filter-composition logic for the Employment
// Timeline graph/table — kept independent of any component so it's
// directly testable and so the graph, table, and export all read the exact
// same filtered/positioned data (guarantees parity by construction).
//
// The graph's default and primary view is "Fit all": one continuous
// date range spanning every included employee's employment, positioned by
// percentage rather than a fixed per-day/week/month grid (a grid can't
// reasonably span years of history). computeFittedRange/buildTimelineHeaderMarks/
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
// included, dated employee/period (or the saved "Timeline starts" org
// setting, when one is on file — see displayStartOverride) and ends at the
// latest timelineEffectiveEndDate among them — which is already `today` for
// any "ongoing"/"expiredStillWorking" bar (see employmentTimelineView.ts) —
// so today is naturally included without special-casing it here beyond the
// final floor below. The right edge is NEVER affected by
// displayStartOverride, per spec: "The right edge remains the latest
// applicable future end/expiry date or Today, whichever is later."
// Returns null only when there is nothing datable to show at all (e.g.
// every visible employee is flagged hasUsableDates:false). Recompute this
// from whatever employee list is currently visible — it naturally
// "recalculates after filters" simply by being called with the
// already-filtered array, no separate filter-awareness needed here.
export function computeFittedRange(
  employees: EmploymentTimelineEmployee[],
  today: string,
  displayStartOverride?: string | null
): TimelineRange | null {
  let trueEarliestStart: string | null = null;
  let end: string | null = null;
  for (const emp of employees) {
    if (!emp.hasUsableDates) continue;
    for (const p of emp.periods) {
      if (trueEarliestStart === null || p.startDate < trueEarliestStart) trueEarliestStart = p.startDate;
      if (end === null || p.timelineEffectiveEndDate > end) end = p.timelineEffectiveEndDate;
    }
  }
  if (trueEarliestStart === null) return null;
  if (end === null || end < today) end = today;
  return { start: displayStartOverride ?? trueEarliestStart, end };
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
  // True when the period's real startDate is earlier than the currently
  // displayed range's left edge — most commonly because it started before
  // the saved "Timeline starts" cutoff, but the same treatment applies
  // whenever a custom From override does the same thing. The bar is never
  // stretched or its true dates altered to compensate — it's simply drawn
  // from the display boundary, flagged so the caller can render a
  // continuation indicator, and the true startDate is still always
  // available on `period` itself for the tooltip.
  clippedStart: boolean;
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
  return { leftPercent: left, widthPercent: Math.max(right - left, MIN_BAR_WIDTH_PERCENT), clippedStart: period.startDate < range.start };
}

// -- zoom --------------------------------------------------------------

// Close enough to inspect individual days without the bars/labels becoming
// unusably fat — a day column this wide comfortably fits a short label.
export const MAX_PX_PER_DAY = 60;
// An absolute floor so pathological inputs (a zero-width container mid
// layout, say) can't produce a zero/negative or infinite density. The REAL
// zoomed-out floor in normal operation is whatever computeFitAllPxPerDay
// returns for the actual container width — that's almost always larger
// than this.
export const MIN_PX_PER_DAY_FLOOR = 0.02;

// The exact "farthest zoom-out" density: the whole range fits inside the
// container's own measured width, with nothing left over to scroll. "Full
// timeline" always resets to exactly this value, recomputed fresh (not
// cached) so it stays exact across a container resize, a filter change, or
// a saved-cutoff edit.
export function computeFitAllPxPerDay(rangeDays: number, containerWidthPx: number): number {
  if (rangeDays <= 0 || containerWidthPx <= 0) return MAX_PX_PER_DAY;
  return Math.max(MIN_PX_PER_DAY_FLOOR, containerWidthPx / rangeDays);
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Monday-start week (matches this codebase's existing startOfWeekMonday
// convention in timezone.ts) containing `dateStr`.
function startOfWeekMonday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const backToMonday = (dow + 6) % 7;
  return addDaysStr(dateStr, -backToMonday);
}

export interface TimelineHeaderMark {
  key: string; // the mark's own start date, YYYY-MM-DD
  label: string;
  leftPercent: number;
}

export type TimelineHeaderGranularity = "year" | "quarter" | "month" | "week" | "day";

// Headers get coarser as pxPerDay shrinks — picks the FINEST granularity
// whose marks are still spaced at least this far apart on screen, so
// labels never overlap however the range/zoom combine (a few weeks at
// closest zoom shows days; a decade at "Fit all" shows years).
const MIN_MARK_SPACING_PX = 64;

export function chooseHeaderGranularity(pxPerDay: number): TimelineHeaderGranularity {
  if (pxPerDay * 1 >= MIN_MARK_SPACING_PX) return "day";
  if (pxPerDay * 7 >= MIN_MARK_SPACING_PX) return "week";
  if (pxPerDay * 30 >= MIN_MARK_SPACING_PX) return "month";
  if (pxPerDay * 91 >= MIN_MARK_SPACING_PX) return "quarter";
  return "year";
}

function buildYearMarks(range: TimelineRange): TimelineHeaderMark[] {
  const marks: TimelineHeaderMark[] = [];
  const startY = Number(range.start.slice(0, 4));
  const endY = Number(range.end.slice(0, 4));
  for (let y = startY; y <= endY; y++) {
    const key = `${y}-01-01`;
    marks.push({ key, label: String(y), leftPercent: percentInRange(key, range) });
  }
  return marks;
}

function buildQuarterMarks(range: TimelineRange): TimelineHeaderMark[] {
  const marks: TimelineHeaderMark[] = [];
  const [startY, startM] = range.start.split("-").map(Number);
  const [endY, endM] = range.end.split("-").map(Number);
  let y = startY;
  let q = Math.floor((startM - 1) / 3); // 0-3
  const endQAbs = endY * 4 + Math.floor((endM - 1) / 3);
  let first = true;
  while (y * 4 + q <= endQAbs) {
    const month = q * 3 + 1;
    const key = `${y}-${String(month).padStart(2, "0")}-01`;
    const label = first || q === 0 ? `Q${q + 1} ${y}` : `Q${q + 1}`;
    marks.push({ key, label, leftPercent: percentInRange(key, range) });
    first = false;
    q += 1;
    if (q > 3) {
      q = 0;
      y += 1;
    }
  }
  return marks;
}

function buildMonthMarks(range: TimelineRange): TimelineHeaderMark[] {
  const marks: TimelineHeaderMark[] = [];
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

function buildWeekMarks(range: TimelineRange): TimelineHeaderMark[] {
  const marks: TimelineHeaderMark[] = [];
  let cursor = startOfWeekMonday(range.start);
  while (cursor <= range.end) {
    const [, m, d] = cursor.split("-").map(Number);
    marks.push({ key: cursor, label: `${MONTH_ABBR[m - 1]} ${d}`, leftPercent: percentInRange(cursor, range) });
    cursor = addDaysStr(cursor, 7);
  }
  return marks;
}

function buildDayMarks(range: TimelineRange): TimelineHeaderMark[] {
  const marks: TimelineHeaderMark[] = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    const [, m, d] = cursor.split("-").map(Number);
    marks.push({ key: cursor, label: `${MONTH_ABBR[m - 1]} ${d}`, leftPercent: percentInRange(cursor, range) });
    cursor = addDaysStr(cursor, 1);
  }
  return marks;
}

// Adaptive header marks — one mark per year/quarter/month/week/day boundary
// crossed by `range`, whichever granularity chooseHeaderGranularity picks
// for the current zoom density, positioned by percentage (not a discrete
// grid column) so the same function covers a two-week range and a
// multi-year one alike.
export function buildTimelineHeaderMarks(range: TimelineRange, pxPerDay: number): TimelineHeaderMark[] {
  switch (chooseHeaderGranularity(pxPerDay)) {
    case "year":
      return buildYearMarks(range);
    case "quarter":
      return buildQuarterMarks(range);
    case "month":
      return buildMonthMarks(range);
    case "week":
      return buildWeekMarks(range);
    case "day":
      return buildDayMarks(range);
  }
}
