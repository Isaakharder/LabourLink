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
  "activityHours",
  "averageSpeed",
  // Whole-shift, every activity combined for that employee/day — only ever
  // valid as a WEEKLY TOTAL column (see WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS
  // below), never as the daily metric shown under Monday-Sunday (a per-day
  // whole-shift figure next to per-day activity-scoped figures would read as
  // if it were this activity's own number). Deliberately a different key
  // from "paidTime" above (workSeconds + paidBreakSeconds, scoped to just
  // this activity) — the two can genuinely disagree on a multi-activity day.
  "employeePaidTime",
  "date",
  // The simplified Job Report choices — see REPORT_METRIC_CHOICES below.
  // ("rows" above is one of them.)
  "totalHours",
  "paidHours",
  "stemsPerHour",
  "kgPerHour",
  "plantsPerHour",
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
  activity: "Job",
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
  // Renamed from "Total hours" — this is the selected activity's own exact
  // work-entry time only (excludes breaks and every other activity, see
  // reportQueries.ts's ActivityReportRow.workSeconds), never the employee's
  // full-week/whole-shift hours. "Total Hours" invited exactly that
  // confusion.
  activityHours: "Job hours",
  averageSpeed: "Average speed",
  employeePaidTime: "Employee Paid Time",
  date: "Date",
  totalHours: "Total Hours",
  paidHours: "Paid Hours",
  stemsPerHour: "Stems/Hr",
  kgPerHour: "Kg/Hr",
  plantsPerHour: "Plants/Hr",
};

// The only six choices the Job Report offers, for the daily cells and for
// the summary columns alike (chosen independently):
//   rows          distinct rows worked
//   totalHours    this Job's own work time (H:MM)
//   paidHours     the employee's whole-day paid time, every Job combined,
//                 exactly as Payroll calculates it (H:MM)
//   stemsPerHour  row-count speed of a stems Job: stems / this Job's hours
//   plantsPerHour the same for a plants Job
//   kgPerHour     LabourLink Scale kg/hour, the Dashboard/TV calculation
// Every rate is a ratio of sums (quantity added up, hours added up), never
// an average of daily or employee rates.
export const REPORT_METRIC_CHOICES = ["rows", "totalHours", "paidHours", "stemsPerHour", "kgPerHour", "plantsPerHour"] as const;
export type ReportMetricChoice = (typeof REPORT_METRIC_CHOICES)[number];

export const REPORT_METRIC_HINTS: Record<ReportMetricChoice, string> = {
  rows: "Rows worked",
  totalHours: "This Job's work time",
  paidHours: "Whole-day paid time, all Jobs (as Payroll)",
  stemsPerHour: "Stems from completed rows per hour of this Job",
  kgPerHour: "Weighed-bin kilograms per matched picking hour (same as the Dashboard and TV)",
  plantsPerHour: "Plants from completed rows per hour of this Job",
};

export interface ReportJobInfo {
  productivityMetric?: "density" | "scale_kg";
  // "stems" and/or "plants": the Job's row counts.
  quantityUnits?: string[];
}

// null when the choice applies to this Job, otherwise why it doesn't.
export function reportMetricUnavailableReason(choice: ReportMetricChoice, job: ReportJobInfo | null): string | null {
  if (!job) return null;
  const units = job.quantityUnits;
  if (choice === "kgPerHour") return job.productivityMetric === "scale_kg" ? null : "Only for Jobs measured with LabourLink Scale";
  if (choice === "stemsPerHour" || choice === "plantsPerHour") {
    const unit = choice === "stemsPerHour" ? "stems" : "plants";
    if (units === undefined) return null; // not known yet
    if (units.length > 1) return "This Job's rows mix stems and plants";
    return units.includes(unit) ? null : `This Job has no ${unit} count per row`;
  }
  return null;
}

// Reports saved before the six choices used other keys. They are read, not
// rewritten: the saved report changes only when someone saves it again.
//   workTime / activityHours  -> totalHours (both were this Job's work time)
//   employeePaidTime          -> paidHours (the same whole-day figure)
//   paidTime                  -> paidHours (was this Job's time plus paid
//                                breaks; no saved report used it)
//   averageSpeed              -> stemsPerHour or plantsPerHour
//   breakTime, rowsCompleted, quantityWorked -> dropped
export function normalizeReportMetric(key: string, job: ReportJobInfo | null): ReportMetricChoice | null {
  if ((REPORT_METRIC_CHOICES as readonly string[]).includes(key)) return key as ReportMetricChoice;
  switch (key) {
    case "workTime":
    case "activityHours":
      return "totalHours";
    case "employeePaidTime":
    case "paidTime":
      return "paidHours";
    case "averageSpeed":
      return (job?.quantityUnits ?? []).length === 1 && job!.quantityUnits![0] === "plants" ? "plantsPerHour" : "stemsPerHour";
    default:
      return null;
  }
}

export function normalizeReportMetrics(keys: string[], job: ReportJobInfo | null): ReportMetricChoice[] {
  const out: ReportMetricChoice[] = [];
  for (const k of keys) {
    const c = normalizeReportMetric(k, job);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

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
  activityBreakdown: "Job breakdown",
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

export type EmployeeSelectionMode = "all" | "selected";

export interface SavedReportDetail {
  id: string;
  name: string;
  reportType: ReportType;
  activity: { id: string; name: string } | null;
  // Payroll reports keep the flat `metrics` checkbox list unchanged.
  // Activity reports use the two-field model instead: `dailyMetric` (single,
  // shown under Monday-Sunday) and `weeklyTotals` (one or more activity-
  // scoped/whole-shift summary columns) — see reportPivot.ts's
  // buildActivityPivotGrid. Both optional so an Activity report saved
  // before this redesign still loads (ReportViewPage/reportPivot.ts apply
  // sensible defaults when absent).
  configuration: { metrics?: string[]; dailyMetric?: string; weeklyTotals?: string[]; lastDateRange?: DateRange };
  // Persisted server-side on the report itself — see
  // server/migrations/046_saved_reports_employee_selection.sql. "all" is
  // dynamic (includes newly eligible employees automatically); "selected"
  // is the exact, explicit employeeIds list, never auto-extended.
  employeeSelectionMode: EmployeeSelectionMode;
  employeeIds: string[];
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
  // The employee's whole shift for this one day — every activity combined,
  // not just this one. See reportQueries.ts's identically-named field.
  // Surfaced as "Employee Paid Time", always kept separate from this
  // activity's own metrics.
  employeePaidSeconds: number;
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

// Kg/Hr figures from LabourLink Scale (server lib/reportScaleProductivity.ts).
export interface ReportKgFigures {
  netGrams: number;
  matchedSeconds: number;
  bins: number;
  kgPerHour: number | null;
}

export interface ReportScaleProductivity {
  reportingFrom: string | null;
  byEmployeeDay: (ReportKgFigures & { employeeId: string; date: string })[];
  byEmployee: (ReportKgFigures & { employeeId: string; employeeName: string; openBins: number })[];
  byDate: (ReportKgFigures & { date: string })[];
  totals: ReportKgFigures;
}

export interface ActivityReportData {
  activity: { id: string; name: string; normalSpeedPerHour: number | null; speedUnit: string | null } & ReportJobInfo;
  // Present only for Jobs measured with LabourLink Scale.
  scaleProductivity?: ReportScaleProductivity | null;
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
    employeePaidSeconds: number;
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
  "activityHours",
  "rows",
  "rowsCompleted",
  "quantityWorked",
  "averageSpeed",
];

// The "Daily metric" selector's own candidate list — literally the same set
// as PIVOT_ELIGIBLE_ACTIVITY_METRICS above (one metric shown under each
// Monday-Sunday date column), kept as its own named export so the "daily"
// and "weekly" concepts read as distinct choices in the UI/persistence code
// even though today they happen to share one list.
export const DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS: ActivityMetric[] = PIVOT_ELIGIBLE_ACTIVITY_METRICS;

// The "Weekly totals" multi-select's candidate list — every daily-eligible
// metric (each becomes that metric's own whole-range total, e.g. "Weekly
// Activity Hours" is Activity Hours summed across the selected range for
// that one employee) PLUS employeePaidTime, which only ever appears here,
// never as a daily metric (see ACTIVITY_METRICS' own comment on why).
export const WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS: ActivityMetric[] = [...PIVOT_ELIGIBLE_ACTIVITY_METRICS, "employeePaidTime"];

// Column-header labels for the Weekly totals area specifically — distinct
// from ACTIVITY_METRIC_LABELS because the SAME metric reads differently as
// a whole-range summary column than as a per-day pivot cell header ("Weekly
// Activity Hours" here vs. "Activity hours" for the daily selector). Every
// activity-scoped entry is prefixed "Weekly ..."; employeePaidTime
// deliberately is NOT — the missing prefix is what keeps it "clearly
// identified as a whole-shift metric" (never confusable with the
// activity-scoped columns sitting right next to it).
export const WEEKLY_TOTAL_METRIC_LABELS: Record<ActivityMetric, string> = {
  ...ACTIVITY_METRIC_LABELS,
  workTime: "Weekly Productive/Work Time",
  breakTime: "Weekly Break Time",
  paidTime: "Weekly Paid Time",
  activityHours: "Weekly Job Hours",
  rows: "Weekly Rows",
  rowsCompleted: "Weekly Rows Completed",
  quantityWorked: "Weekly Quantity Worked",
  averageSpeed: "Weekly Average Speed",
  employeePaidTime: "Employee Paid Time",
  totalHours: "Total Hours",
  paidHours: "Paid Hours",
  stemsPerHour: "Stems/Hr",
  kgPerHour: "Kg/Hr",
  plantsPerHour: "Plants/Hr",
};

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
  // Whole-day paid time (every Job, as Payroll) — "Paid Hours".
  employeePaidSeconds?: number;
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
    case "activityHours":
      // Exactly this activity's own accumulated work-entry time — never
      // + breakSeconds (breaks aren't this activity's time at all) and
      // never rounded beyond secondsToHoursMinutes' own display-only
      // nearest-minute formatting.
      return secondsToHoursMinutes(source.workSeconds);
    case "rows":
      return String(source.rowsTouched);
    case "rowsCompleted":
      return String(source.rowsCompleted);
    case "quantityWorked":
      return source.quantityWorked == null ? "—" : String(source.quantityWorked);
    case "averageSpeed":
      return source.averageSpeed == null ? "—" : formatSpeedValue(source.averageSpeed, speedUnit);
    case "totalHours":
      return secondsToHoursMinutes(source.workSeconds);
    case "paidHours":
      return source.employeePaidSeconds == null ? "—" : secondsToHoursMinutes(source.employeePaidSeconds);
    case "stemsPerHour":
    case "plantsPerHour":
      // The unit is in the column header (Stems/Hr, Plants/Hr).
      return source.averageSpeed == null ? "—" : source.averageSpeed.toFixed(1);
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

// Display-only compaction of a speed unit already spelled out into a
// formatted pivot cell string (e.g. "12.3 stems/hour") — this never touches
// the underlying number or the stored activities.speed_unit value, only how
// the cell text is shown on screen/print/PDF. Only the two units this app
// actually derives from activities.density_source ("stems"/"plants" ->
// "stems/hour"/"plants/hour", see ActivityFormModal.tsx) have a defined
// abbreviation; any other (free-text) speed_unit is returned unchanged —
// there's nothing to abbreviate it to, and abbreviating an unknown unit
// would just be confusing. CSV export deliberately does NOT call this (see
// reportExport.ts's exportPivotCsv) so its exported unit stays fully
// spelled out and unambiguous outside the app's own visual context.
const SPEED_UNIT_ABBREVIATIONS: [full: string, short: string][] = [
  ["stems/hour", "st/hr"],
  ["plants/hour", "pl/hr"],
];

export function abbreviateSpeedCellText(text: string): string {
  let result = text;
  for (const [full, short] of SPEED_UNIT_ABBREVIATIONS) {
    result = result.replace(full, short);
  }
  return result;
}

// The exact explanatory note to show above the pivot table (screen, print,
// and PDF) when the selected metric is Average Speed and the activity's
// speed unit is one of the two abbreviated forms above — null for any other
// unit, including a free-text speed_unit with no defined abbreviation, so
// the note is never shown for a unit that wasn't actually shortened.
export function speedUnitAbbreviationNote(speedUnit: string | null): string | null {
  if (speedUnit === "stems/hour") return "Speed shown as st/hr (stems per hour).";
  if (speedUnit === "plants/hour") return "pl/hr means plants per hour.";
  return null;
}
