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

export const PAYROLL_METRIC_LABELS: Record<PayrollMetric, string> = {
  employee: "Employee",
  date: "Date",
  workStart: "Work start",
  workEnd: "Work end",
  paidTime: "Paid time",
  workTime: "Regular/work time",
  breakTime: "Break time",
  unpaidTime: "Unpaid time",
  totalHours: "Total hours",
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

// Payroll's pivot cells intentionally keep decimal-hours formatting
// (secondsToDecimalHours) — its existing, pre-pivot convention — rather
// than Activity pivot's H:MM; each report type keeps its own established
// number format, only the row grain (one row per employee) changed here.
export function payrollPivotCellValue(metric: PayrollMetric, source: PayrollPivotCellSource): string {
  switch (metric) {
    case "workTime":
      return secondsToDecimalHours(source.workSeconds);
    case "breakTime":
      return secondsToDecimalHours(source.breakSeconds);
    case "unpaidTime":
      return secondsToDecimalHours(source.unpaidBreakSeconds);
    case "paidTime":
      return secondsToDecimalHours(source.paidSeconds);
    case "totalHours":
      return secondsToDecimalHours(source.totalSeconds);
    default:
      return "—";
  }
}

// "H:MM:SS" -> "H.HH" decimal hours, better suited to a report/export column
// than the H:MM:SS clock format Inputs uses for a single day's live log.
export function secondsToDecimalHours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
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
