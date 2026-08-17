// Shared types/metric catalogs for the desktop Reports page — mirrors
// server/src/routes/reports.ts's ACTIVITY_METRICS/PAYROLL_METRICS exactly;
// keep both lists in sync if either changes.

export type ReportType = "activity" | "payroll";

export const ACTIVITY_METRICS = [
  "employee",
  "activity",
  "speed",
  "speedUnit",
  "paidTime",
  "workTime",
  "breakTime",
  "rows",
  "rowsCompleted",
  "quantityWorked",
  "startTime",
  "endTime",
  "totalHours",
  "averageSpeed",
  "date",
] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

export const PAYROLL_METRICS = [
  "employee",
  "date",
  "workStart",
  "workEnd",
  "paidTime",
  "workTime",
  "breakTime",
  "unpaidTime",
  "totalHours",
  "daysWorked",
  "activityBreakdown",
  "weeklyTotals",
] as const;
export type PayrollMetric = (typeof PAYROLL_METRICS)[number];

export const ACTIVITY_METRIC_LABELS: Record<ActivityMetric, string> = {
  employee: "Employee",
  activity: "Activity",
  speed: "Speed",
  speedUnit: "Speed unit",
  paidTime: "Paid time",
  workTime: "Productive/work time",
  breakTime: "Break time",
  rows: "Rows",
  rowsCompleted: "Rows completed",
  quantityWorked: "Quantity worked",
  startTime: "Start time",
  endTime: "End time",
  totalHours: "Total hours",
  averageSpeed: "Average speed",
  date: "Date",
};

// The "(H:MM)" suffix on every duration metric is the "clear indication ...
// so users know this is a duration, not a clock time" requirement — applied
// here so it shows up everywhere this label is already used (the metrics
// editor, the pivot "Show:" selector, the Print/PDF preview's meta line, and
// the CSV/PDF filename/subtitle — see reportExport.ts) without a second
// place to keep in sync. daysWorked is a plain count, not a duration, so it
// keeps no suffix.
export const PAYROLL_METRIC_LABELS: Record<PayrollMetric, string> = {
  employee: "Employee",
  date: "Date",
  workStart: "Work start",
  workEnd: "Work end",
  paidTime: "Paid time (H:MM)",
  workTime: "Regular/work time (H:MM)",
  breakTime: "Break time (H:MM)",
  unpaidTime: "Unpaid time (H:MM)",
  totalHours: "Total hours (H:MM)",
  daysWorked: "Days worked",
  activityBreakdown: "Activity breakdown",
  weeklyTotals: "Weekly totals",
};

export interface SavedReportSummary {
  id: string;
  name: string;
  reportType: ReportType;
  activity: { id: string; name: string } | null;
  updatedAt: string;
}

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;
}

export interface SavedReportDetail {
  id: string;
  name: string;
  reportType: ReportType;
  activity: { id: string; name: string } | null;
  configuration: { metrics?: string[]; lastDateRange?: DateRange };
  createdAt: string;
  updatedAt: string;
}

export interface ActivityReportRow {
  employeeId: string;
  employeeName: string;
  date: string;
  startedAt: string;
  endedAt: string;
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  rowsTouched: number;
  quantityWorked: number | null;
  rowsCompleted: number;
  averageSpeed: number | null;
}

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
  // Pivot table's right-hand Grand Total column (per employee) and bottom
  // Grand Total row (per date, across employees) — see reportQueries.ts.
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

// Metrics that have a single, well-defined per-employee-per-day (or
// per-employee-range, or per-date-range) numeric value — i.e. ones that can
// meaningfully fill a pivot table cell. "employee"/"date"/"activity" are
// identity/label fields (row/column headers, not cell values); "speed" is
// the activity's static configured speed (constant, never varies by
// employee/day, so it can't usefully populate a matrix cell); "startTime"/
// "endTime" have no sensible Grand Total (summing or averaging a clock time
// is meaningless) so they're left out of the pivot metric selector — a
// report can still have them checked as metrics without breaking the pivot,
// they simply won't appear as pivot-selectable.
export const PIVOT_ELIGIBLE_ACTIVITY_METRICS: ActivityMetric[] = [
  "workTime",
  "breakTime",
  "paidTime",
  "totalHours",
  "rows",
  "rowsCompleted",
  "quantityWorked",
  "averageSpeed",
];

// Common shape every pivot cell's data source (a day-row, an employee Grand
// Total, or a date Grand Total) already satisfies — lets one function read
// a cell's value regardless of which axis it's summarizing.
export interface PivotCellSource {
  workSeconds: number;
  breakSeconds: number;
  paidBreakSeconds: number;
  rowsTouched: number;
  quantityWorked: number | null;
  rowsCompleted: number;
  averageSpeed: number | null;
}

// Single source of truth for "what does this metric look like in a pivot
// cell" — used identically by the on-screen table, CSV, and PDF so all
// three can never disagree about a value's formatting.
export function pivotCellValue(metric: ActivityMetric, source: PivotCellSource, speedUnit: string | null): string {
  switch (metric) {
    case "workTime":
      return secondsToHoursMinutes(source.workSeconds);
    case "breakTime":
      return secondsToHoursMinutes(source.breakSeconds);
    case "paidTime":
      return secondsToHoursMinutes(source.workSeconds + source.paidBreakSeconds);
    case "totalHours":
      return secondsToHoursMinutes(source.workSeconds + source.breakSeconds);
    case "rows":
      return String(source.rowsTouched);
    case "rowsCompleted":
      return String(source.rowsCompleted);
    case "quantityWorked":
      return source.quantityWorked == null ? "—" : String(source.quantityWorked);
    case "averageSpeed":
      return source.averageSpeed == null ? "—" : formatSpeedValue(source.averageSpeed, speedUnit);
    default:
      return "—";
  }
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
  paidSeconds: number;
  totalSeconds: number;
}

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
  // Pivot table's Employee Total column and DAY TOTAL row — see
  // reportQueries.ts. Plain sums (no ratio-of-sums metric exists in
  // payroll data).
  employeeTotals: PayrollEmployeeTotal[];
  dateTotals: PayrollDateTotal[];
  daysWorkedByEmployee: { employeeId: string; employeeName: string; daysWorked: number }[];
  activityBreakdown: { employeeId: string; activityId: string; activityName: string; workSeconds: number }[];
  weeklyTotals: { weekStart: string; weekEnd: string; workSeconds: number; breakSeconds: number; paidSeconds: number }[];
  totals: {
    workSeconds: number;
    breakSeconds: number;
    paidBreakSeconds: number;
    unpaidBreakSeconds: number;
    paidSeconds: number;
    totalSeconds: number;
  };
}

// Metrics that can fill a payroll pivot cell — "employee"/"date"/"workStart"/
// "workEnd" are identity/label fields or have no sensible Grand Total (a
// clock time can't be summed), and "daysWorked"/"activityBreakdown"/
// "weeklyTotals" remain separate sub-tables below the matrix (different
// grain — whole-range per employee, or per employee+activity — not a
// per-day cell value), same convention as Activity's non-pivot-eligible
// metrics.
export const PIVOT_ELIGIBLE_PAYROLL_METRICS: PayrollMetric[] = ["workTime", "breakTime", "paidTime", "unpaidTime", "totalHours"];

export interface PayrollPivotCellSource {
  workSeconds: number;
  breakSeconds: number;
  unpaidBreakSeconds: number;
  paidSeconds: number;
  totalSeconds: number;
}

// Payroll's pivot cells use H:MM (formatPayrollDuration) — decimal hours
// (the former "10.42" convention) reads as "10 hours 42 minutes" to anyone
// not fluent in decimal-hour notation, when the real duration is 10:25.
// Every source field here (workSeconds/paidSeconds/totalSeconds/...) is
// already the server's own exact-second sum (reportQueries.ts) — this
// formats that authoritative total directly, once, never by re-adding
// already-rounded per-day display strings (see reportPivot.ts: employee/day
// totals are independent fields on PayrollReportData, not derived from the
// grid's own formatted cells).
export function payrollPivotCellValue(metric: PayrollMetric, source: PayrollPivotCellSource): string {
  switch (metric) {
    case "workTime":
      return formatPayrollDuration(source.workSeconds);
    case "breakTime":
      return formatPayrollDuration(source.breakSeconds);
    case "unpaidTime":
      return formatPayrollDuration(source.unpaidBreakSeconds);
    case "paidTime":
      return formatPayrollDuration(source.paidSeconds);
    case "totalHours":
      return formatPayrollDuration(source.totalSeconds);
    default:
      return "—";
  }
}

// "H:MM" (hours not zero-padded so they can exceed 24 for a weekly total —
// e.g. "64:35" — minutes always zero-padded) — the Payroll Report's duration
// format. Rounds the exact underlying seconds to the nearest whole minute in
// ONE step (never pre-rounds smaller segments before totaling, which can
// accumulate error — see the file-level totals this is always called on).
// A positive duration under 30 seconds would round to "0:00", which reads
// as no time at all — shown as "<1m" instead so a real (if tiny) duration
// is never silently indistinguishable from a genuinely empty cell ("—",
// applied separately in reportPivot.ts for a day with no row at all).
export function formatPayrollDuration(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped > 0 && clamped < 30) return "<1m";
  const totalMinutes = Math.round(clamped / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// "H:MM" (hours not zero-padded, no seconds) — compact enough for a
// spreadsheet-style pivot cell, where secondsToDecimalHours's "8.50" or
// Inputs' "8:30:00" would be needlessly wide across many date columns.
export function secondsToHoursMinutes(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function formatSpeedValue(value: number, unit: string | null): string {
  return unit ? `${value.toFixed(1)} ${unit}` : value.toFixed(1);
}
