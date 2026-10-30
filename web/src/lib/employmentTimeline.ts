// Pure range/positioning + filter-composition logic for the Employment
// Timeline graph/table — kept independent of any component so it's
// directly testable and so the graph, table, and export all read the exact
// same filtered/positioned data (parity by construction).
//
// Every bar's dates and end/label are decided server-side
// (employmentTimelineView.ts) from the employee record — this file only
// filters, numbers and positions them.
//
// Positioning model: the visible range [start, end] is a run of whole
// calendar days, each one an equal slot; a date's position is the LEFT edge
// of its day. A bar covers its start day through its last day inclusive, so
// it ends at the left edge of the day after — exactly on the next month's
// gridline when it ends on a month's last day. All arithmetic is on
// YYYY-MM-DD strings in UTC-arithmetic space (calendar days, never a real
// timezone conversion), so DST changes can't move anything by an hour.
import {
  DATE_FIELD_LABELS,
  EmploymentTimelineEmployee,
  EmploymentTimelineFilterState,
  STATUS_LABELS,
  TIMELINE_BAR_LABEL_TEXT,
} from "./employmentPeriodTypes";

// -- table/export rows -----------------------------------------------------

export const EMPLOYMENT_TIMELINE_COLUMNS = [
  "#",
  "Employee",
  "Nationality",
  "Employee Group",
  "Employment Type",
  "Work Group",
  DATE_FIELD_LABELS.startDate,
  DATE_FIELD_LABELS.workPermitExpiryDate,
  DATE_FIELD_LABELS.endDifferentDate,
  "Timeline ends",
  "Status",
] as const;

export interface EmploymentTimelineRow {
  number: number;
  employeeName: string;
  nationality: string;
  employeeGroup: string;
  employmentType: string;
  workGroup: string;
  startDate: string;
  workPermitExpiryDate: string;
  endDifferentDate: string;
  timelineEnds: string;
  status: string;
}

// Where the bar ends, in words — same priority as the bar itself.
export function describeTimelineEnd(emp: EmploymentTimelineEmployee): string {
  if (!emp.hasUsableDates) return "";
  if (emp.timelineEndDate === null) return "Ongoing";
  const source = emp.timelineEndSource === "endDifferentDate" ? DATE_FIELD_LABELS.endDifferentDate : DATE_FIELD_LABELS.workPermitExpiryDate;
  return `${emp.timelineEndDate} (${source})`;
}

// One row per displayed employee, numbered 1.. in displayed order — the
// single builder the table view, CSV, PDF and Print all use, so they can
// never disagree with each other or with the graph's numbering.
export function buildEmploymentTimelineRows(employees: EmploymentTimelineEmployee[]): EmploymentTimelineRow[] {
  return employees.map((emp, i) => ({
    number: i + 1,
    employeeName: `${emp.firstName} ${emp.lastName}`,
    nationality: emp.nationality ?? "Unspecified",
    employeeGroup: emp.employeeGroup?.name ?? "Ungrouped",
    employmentType: emp.employmentType ?? "Unspecified",
    workGroup: emp.workGroup ?? "Unspecified",
    startDate: emp.employmentStartDate ?? "",
    workPermitExpiryDate: emp.workPermitExpiryDate ?? "",
    endDifferentDate: emp.endDifferentDate ?? "",
    timelineEnds: describeTimelineEnd(emp),
    status: !emp.hasUsableDates ? "No Employment Start Date recorded" : emp.timelineLabel ? TIMELINE_BAR_LABEL_TEXT[emp.timelineLabel] : "",
  }));
}

export function employmentTimelineRowCells(row: EmploymentTimelineRow): string[] {
  return [
    String(row.number),
    row.employeeName,
    row.nationality,
    row.employeeGroup,
    row.employmentType,
    row.workGroup,
    row.startDate,
    row.workPermitExpiryDate,
    row.endDifferentDate,
    row.timelineEnds,
    row.status,
  ];
}

export function statusSummary(emp: EmploymentTimelineEmployee): string {
  return emp.statuses.map((s) => STATUS_LABELS[s]).join(", ");
}

// -- filter composition ------------------------------------------------

// AND across categories, OR within a category. Keeps the server's order
// (first name, last name), which is the order the numbering follows.
export function filterEmploymentTimelineEmployees(
  employees: EmploymentTimelineEmployee[],
  filters: EmploymentTimelineFilterState
): EmploymentTimelineEmployee[] {
  const inList = (list: string[], value: string) => list.length === 0 || list.includes(value);
  return employees.filter(
    (emp) =>
      inList(filters.employeeIds, emp.id) &&
      inList(filters.nationalities, emp.nationality ?? "Unspecified") &&
      inList(filters.employeeGroupIds, emp.employeeGroup?.id ?? "Ungrouped") &&
      inList(filters.workGroups, emp.workGroup ?? "Unspecified") &&
      inList(filters.employmentTypes, emp.employmentType ?? "Unspecified") &&
      (filters.statuses.length === 0 || emp.statuses.some((s) => filters.statuses.includes(s)))
  );
}

// -- date math -------------------------------------------------------------

// Calendar-day difference (to - from), positive when `to` is later.
export function daysBetweenDateStrs(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export interface TimelineRange {
  start: string; // inclusive YYYY-MM-DD
  end: string; // inclusive YYYY-MM-DD
}

// Number of day slots shown: start..end inclusive.
export function rangeDayCount(range: TimelineRange): number {
  return Math.max(1, daysBetweenDateStrs(range.start, range.end) + 1);
}

// Left edge of `dateStr`'s day, as a percentage of the visible range,
// clamped to [0, 100] (a date outside the range sits on the edge).
export function percentInRange(dateStr: string, range: TimelineRange): number {
  const offset = daysBetweenDateStrs(range.start, dateStr);
  return Math.min(100, Math.max(0, (offset / rangeDayCount(range)) * 100));
}

// The default "Full timeline" range: from the earliest Employment Start
// Date among the displayed employees (or the saved "Timeline starts"
// setting, when set) to the latest bar end, never earlier than today — so
// ongoing bars and the Today marker always fit. Null when nothing is
// datable. Recomputed from the already-filtered list.
export function computeFittedRange(
  employees: EmploymentTimelineEmployee[],
  today: string,
  displayStartOverride?: string | null
): TimelineRange | null {
  let earliest: string | null = null;
  let end: string = today;
  for (const emp of employees) {
    if (!emp.hasUsableDates || !emp.employmentStartDate) continue;
    if (earliest === null || emp.employmentStartDate < earliest) earliest = emp.employmentStartDate;
    if (emp.timelineEndDate && emp.timelineEndDate > end) end = emp.timelineEndDate;
  }
  if (earliest === null) return null;
  const start = displayStartOverride ?? earliest;
  return { start, end: end < start ? start : end };
}

export interface BarPosition {
  leftPercent: number;
  widthPercent: number;
  // The real start is before the visible range (drawn from the edge with a
  // continuation notch; the tooltip still shows the real date).
  clippedStart: boolean;
  // False when the whole bar falls outside the visible range (e.g. a custom
  // From after it ended): nothing is drawn, the row and its number stay.
  inRange: boolean;
}

// A tiny minimum width keeps a one-day bar visible at far zoom.
const MIN_BAR_WIDTH_PERCENT = 0.4;

// Start day's left edge to the left edge of the day after the last day.
// Ongoing bars (no end date) run to the right edge of the visible range.
export function computeBarPosition(emp: EmploymentTimelineEmployee, range: TimelineRange): BarPosition | null {
  if (!emp.hasUsableDates || !emp.employmentStartDate) return null;
  const left = percentInRange(emp.employmentStartDate, range);
  const right = emp.timelineEndDate === null ? 100 : percentInRange(addDaysStr(emp.timelineEndDate, 1), range);
  const inRange = emp.employmentStartDate <= range.end && (emp.timelineEndDate === null || emp.timelineEndDate >= range.start);
  return { leftPercent: left, widthPercent: Math.max(right - left, MIN_BAR_WIDTH_PERCENT), clippedStart: emp.employmentStartDate < range.start, inRange };
}

// -- zoom --------------------------------------------------------------

// Close enough to inspect individual days.
export const MAX_PX_PER_DAY = 60;
// Absolute floor against pathological inputs (a zero-width container).
export const MIN_PX_PER_DAY_FLOOR = 0.02;

// The exact "farthest zoom-out" density: the whole range fits the date
// track's measured width with nothing to scroll. "Full timeline" resets to
// this, recomputed fresh after resizes, filter changes and range changes.
export function computeFitAllPxPerDay(rangeDays: number, containerWidthPx: number): number {
  if (rangeDays <= 0 || containerWidthPx <= 0) return MAX_PX_PER_DAY;
  return Math.max(MIN_PX_PER_DAY_FLOOR, containerWidthPx / rangeDays);
}

// -- date scale (header) ------------------------------------------------

export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Narrowest space a label needs before the next one starts ("Sep" plus
// padding, "2026" plus padding).
export const MIN_MONTH_LABEL_PX = 34;
export const MIN_YEAR_LABEL_PX = 40;
const MONTH_LABEL_STEPS = [1, 2, 3, 6, 12];
const YEAR_LABEL_STEPS = [1, 2, 5, 10, 25];
// Close-zoom third row: Monday-start weeks once a week is this wide, day
// numbers once a day fits one ("31" plus padding) — reachable below
// MAX_PX_PER_DAY.
const MIN_WEEK_MARK_PX = 64;
export const MIN_DAY_MARK_PX = 24;

export interface TimelineScaleSegment {
  key: string; // YYYY-MM-DD of the boundary (or the range start for a leading partial segment)
  label: string;
  leftPercent: number;
  widthPercent: number;
  // A whole month/year starts here (a gridline is drawn); false for the
  // leading partial segment that begins mid-month/mid-year at the range start.
  isBoundary: boolean;
  showLabel: boolean;
}

// The year to pin at the left edge of the visible area when a scrolled
// (zoomed-in) view would otherwise show no year at all: the year of the
// first visible day, unless that year's own label is still in view or the
// next year's label is about to reach the pinned spot. `scrollLeftPx` is the
// date track's horizontal scroll offset.
export function pinnedYearLabel(range: TimelineRange, pxPerDay: number, scrollLeftPx: number): string | null {
  if (scrollLeftPx <= 0 || pxPerDay <= 0) return null;
  const firstVisible = addDaysStr(range.start, Math.floor(scrollLeftPx / pxPerDay));
  if (firstVisible > range.end) return null;
  const year = Number(firstVisible.slice(0, 4));
  const ownStartPx = Math.max(0, daysBetweenDateStrs(range.start, `${year}-01-01`)) * pxPerDay;
  if (ownStartPx >= scrollLeftPx) return null; // its own label is in view
  const nextStartPx = daysBetweenDateStrs(range.start, `${year + 1}-01-01`) * pxPerDay;
  if (nextStartPx - scrollLeftPx < MIN_YEAR_LABEL_PX) return null;
  return String(year);
}

export interface TimelineMinorMark {
  key: string;
  label: string;
  leftPercent: number;
}

export interface TimelineScale {
  years: TimelineScaleSegment[];
  months: TimelineScaleSegment[];
  // Every n-th month is labeled (1 = every month); labels are thinned, the
  // monthly gridlines never are.
  monthLabelStep: number;
  minor: { granularity: "week" | "day"; marks: TimelineMinorMark[] } | null;
}

function pickStep(widthPx: number, minPx: number, steps: number[]): number | null {
  for (const s of steps) if (widthPx * s >= minPx) return s;
  return null;
}

function segments(boundaries: string[], range: TimelineRange, label: (key: string) => string): TimelineScaleSegment[] {
  const out: TimelineScaleSegment[] = [];
  const next = (i: number) => (i + 1 < boundaries.length ? percentInRange(boundaries[i + 1], range) : 100);
  if (boundaries.length === 0 || boundaries[0] > range.start) {
    const firstEdge = boundaries.length ? percentInRange(boundaries[0], range) : 100;
    out.push({ key: range.start, label: label(range.start), leftPercent: 0, widthPercent: firstEdge, isBoundary: false, showLabel: true });
  }
  boundaries.forEach((b, i) => {
    const left = percentInRange(b, range);
    out.push({ key: b, label: label(b), leftPercent: left, widthPercent: next(i) - left, isBoundary: true, showLabel: true });
  });
  return out;
}

// Year row, month row and (at close zoom) a week/day row for `range` at
// `pxPerDay`. Gridlines sit on every month start; labels are thinned so
// they never overlap: months to every 2nd/3rd/6th/12th month (January is
// always one of them, so each year's first label stays put), years to every
// 2nd/5th/... year at extreme ranges. A partial month/year at the range
// start is labeled only when there's room before the next label.
export function buildTimelineScale(range: TimelineRange, pxPerDay: number): TimelineScale {
  const totalPx = rangeDayCount(range) * pxPerDay;

  const monthStarts: string[] = [];
  const yearStarts: string[] = [];
  let [y, m] = range.start.split("-").map(Number);
  if (range.start.slice(8) !== "01") {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}-01`;
    if (key > range.end) break;
    monthStarts.push(key);
    if (m === 1) yearStarts.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  const months = segments(monthStarts, range, (k) => MONTH_ABBR[Number(k.slice(5, 7)) - 1]);
  const monthLabelStep = pickStep(pxPerDay * 30.44, MIN_MONTH_LABEL_PX, MONTH_LABEL_STEPS);
  for (const seg of months) {
    const monthIndex = Number(seg.key.slice(5, 7)) - 1;
    const segPx = (seg.widthPercent / 100) * totalPx;
    if (monthLabelStep === null) seg.showLabel = false;
    else if (!seg.isBoundary) seg.showLabel = segPx >= MIN_MONTH_LABEL_PX && monthLabelStep === 1;
    else seg.showLabel = monthIndex % monthLabelStep === 0;
  }

  const years = segments(yearStarts, range, (k) => k.slice(0, 4));
  const yearStep = pickStep(pxPerDay * 365.25, MIN_YEAR_LABEL_PX, YEAR_LABEL_STEPS) ?? YEAR_LABEL_STEPS[YEAR_LABEL_STEPS.length - 1];
  for (const seg of years) {
    const segPx = (seg.widthPercent / 100) * totalPx;
    if (!seg.isBoundary) seg.showLabel = segPx >= MIN_YEAR_LABEL_PX;
    else seg.showLabel = Number(seg.key.slice(0, 4)) % yearStep === 0;
  }

  let minor: TimelineScale["minor"] = null;
  if (pxPerDay >= MIN_DAY_MARK_PX) {
    minor = { granularity: "day", marks: [] };
    for (let c = range.start; c <= range.end; c = addDaysStr(c, 1)) {
      minor.marks.push({ key: c, label: String(Number(c.slice(8))), leftPercent: percentInRange(c, range) });
    }
  } else if (pxPerDay * 7 >= MIN_WEEK_MARK_PX) {
    minor = { granularity: "week", marks: [] };
    const dow = new Date(`${range.start}T00:00:00Z`).getUTCDay();
    for (let c = addDaysStr(range.start, (8 - dow) % 7); c <= range.end; c = addDaysStr(c, 7)) {
      minor.marks.push({ key: c, label: `${MONTH_ABBR[Number(c.slice(5, 7)) - 1]} ${Number(c.slice(8))}`, leftPercent: percentInRange(c, range) });
    }
  }

  return { years, months, monthLabelStep: monthLabelStep ?? 0, minor };
}
