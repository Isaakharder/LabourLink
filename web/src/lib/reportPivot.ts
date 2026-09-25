// Shapes an ActivityReportData into a rows(employees) x columns(dates)
// grid for one selected metric — the single source of truth the on-screen
// pivot table, CSV export, and PDF export all build from, so the three can
// never show different numbers for the same report/metric/range.
import { enumerateDates } from "./timezone";
import {
  ActivityEmployeeTotal,
  ActivityDateTotal,
  ActivityMetric,
  ActivityReportData,
  DateRange,
  PayrollMetric,
  PayrollReportData,
  WEEKLY_TOTAL_METRIC_LABELS,
  payrollPivotCellValue,
  pivotCellValue,
  secondsToHoursMinutes,
} from "./reportTypes";

// One saved "weekly total" column — key drives both the value lookup
// (weeklyValue below) and what gets persisted in the report's
// configuration.weeklyTotals; label is WEEKLY_TOTAL_METRIC_LABELS[key],
// carried on the column itself so every consumer (screen/CSV/PDF) renders
// the identical header text without re-deriving it.
export interface PivotWeeklyTotalColumn {
  key: ActivityMetric;
  label: string;
}

export interface PivotEmployeeRow {
  employeeId: string;
  employeeName: string;
  cells: string[]; // one per date in PivotGrid.dates, "—" when the employee has no row that date
  // Payroll only — the single "Employee Total" column for whichever metric
  // the "Show:" dropdown/checkbox editor currently has selected. Activity
  // reports use weeklyTotals instead (see below); the two are mutually
  // exclusive, discriminated by PivotGrid.weeklyTotalColumns's presence.
  grandTotal?: string;
  // Activity only — one formatted value per PivotGrid.weeklyTotalColumns,
  // same order/length. Replaces the old single Employee Total/Employee
  // Paid Time columns with the report's own saved, independently-chosen
  // list of weekly totals (each activity-scoped except "employeePaidTime",
  // which is deliberately whole-shift — see weeklyValue below).
  weeklyTotals?: string[];
}

export interface PivotGrid {
  dates: string[];
  employees: PivotEmployeeRow[];
  columnTotals: string[]; // one per date, across all employees
  grandTotal?: string; // bottom-right corner — Payroll only, see PivotEmployeeRow.grandTotal
  // Activity only — parallel to PivotEmployeeRow.weeklyTotals; presence of
  // this field (vs undefined) is what every consumer (ReportPivotTable,
  // reportExport.ts) branches on to pick Activity's N-column layout over
  // Payroll's single Employee Total column.
  weeklyTotalColumns?: PivotWeeklyTotalColumn[];
  // Bottom-row combined value per weeklyTotalColumns, across every
  // DISPLAYED employee (a total, not a per-employee average).
  weeklyTotalColumnTotals?: string[];
}

// employeePaidTime is whole-shift (every activity combined) and lives on
// ActivityEmployeeTotal/ActivityDateTotal/ActivityReportData.totals as
// employeePaidSeconds — a different field from the activity-scoped
// metrics pivotCellValue already knows how to format. Every other
// weekly-total key is exactly one of the report's own activity-scoped
// ActivityMetrics, so it can go straight through pivotCellValue like the
// daily metric does.
function weeklyValue(
  key: ActivityMetric,
  source: ActivityEmployeeTotal | ActivityDateTotal | ActivityReportData["totals"],
  speedUnit: string | null
): string {
  if (key === "employeePaidTime") {
    return secondsToHoursMinutes(source.employeePaidSeconds);
  }
  return pivotCellValue(key, source, speedUnit);
}

export function buildActivityPivotGrid(
  data: ActivityReportData,
  dateRange: DateRange,
  dailyMetric: ActivityMetric,
  weeklyTotals: ActivityMetric[]
): PivotGrid {
  const dates = enumerateDates(dateRange.start, dateRange.end);
  const speedUnit = data.activity.speedUnit;

  const rowByKey = new Map(data.rows.map((r) => [`${r.employeeId}:${r.date}`, r]));
  const weeklyTotalColumns: PivotWeeklyTotalColumn[] = weeklyTotals.map((key) => ({
    key,
    label: WEEKLY_TOTAL_METRIC_LABELS[key],
  }));

  const employees: PivotEmployeeRow[] = [...data.employeeTotals]
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName))
    .map((et) => ({
      employeeId: et.employeeId,
      employeeName: et.employeeName,
      cells: dates.map((d) => {
        const row = rowByKey.get(`${et.employeeId}:${d}`);
        return row ? pivotCellValue(dailyMetric, row, speedUnit) : "—";
      }),
      // et (ActivityEmployeeTotal) is already the server's own per-employee
      // sum of the underlying seconds across the whole range (see
      // reportQueries.ts's employeeSeconds accumulation) — formatted once
      // here, never built from this grid's own already-rounded daily cells.
      weeklyTotals: weeklyTotals.map((key) => weeklyValue(key, et, speedUnit)),
    }));

  const dateTotalByDate = new Map(data.dateTotals.map((dt) => [dt.date, dt]));
  const columnTotals = dates.map((d) => {
    const dt = dateTotalByDate.get(d);
    return dt ? pivotCellValue(dailyMetric, dt, speedUnit) : "—";
  });

  const weeklyTotalColumnTotals = weeklyTotals.map((key) => weeklyValue(key, data.totals, speedUnit));

  return { dates, employees, columnTotals, weeklyTotalColumns, weeklyTotalColumnTotals };
}

// Same PivotGrid shape as buildActivityPivotGrid, built from
// PayrollReportData's per-employee-day rows/employeeTotals/dateTotals
// instead — plain additive sums throughout, no ratio-of-sums metric exists
// on the payroll side.
export function buildPayrollPivotGrid(data: PayrollReportData, dateRange: DateRange, metric: PayrollMetric): PivotGrid {
  const dates = enumerateDates(dateRange.start, dateRange.end);
  const rowByKey = new Map(data.rows.map((r) => [`${r.employeeId}:${r.date}`, r]));

  const employees: PivotEmployeeRow[] = [...data.employeeTotals]
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName))
    .map((et) => ({
      employeeId: et.employeeId,
      employeeName: et.employeeName,
      cells: dates.map((d) => {
        const row = rowByKey.get(`${et.employeeId}:${d}`);
        return row ? payrollPivotCellValue(metric, row) : "—";
      }),
      grandTotal: payrollPivotCellValue(metric, et),
    }));

  const dateTotalByDate = new Map(data.dateTotals.map((dt) => [dt.date, dt]));
  const columnTotals = dates.map((d) => {
    const dt = dateTotalByDate.get(d);
    return dt ? payrollPivotCellValue(metric, dt) : "—";
  });

  const grandTotal = payrollPivotCellValue(metric, data.totals);

  return { dates, employees, columnTotals, grandTotal };
}

// "Aug 3" — short column header date label (Reports pivot only; unrelated
// to Inputs' own date formatting).
export function formatPivotDateHeader(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

// "Mon" — weekday sub-label under the date header.
export function formatPivotWeekday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(Date.UTC(y, m - 1, d)));
}
