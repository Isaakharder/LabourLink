// Shapes an ActivityReportData into a rows(employees) x columns(dates)
// grid for one selected metric — the single source of truth the on-screen
// pivot table, CSV export, and PDF export all build from, so the three can
// never show different numbers for the same report/metric/range.
import { enumerateDates } from "./timezone";
import {
  ActivityMetric,
  ActivityReportData,
  DateRange,
  PayrollMetric,
  PayrollReportData,
  payrollPivotCellValue,
  pivotCellValue,
} from "./reportTypes";

export interface PivotEmployeeRow {
  employeeId: string;
  employeeName: string;
  cells: string[]; // one per date in PivotGrid.dates, "—" when the employee has no row that date
  grandTotal: string;
}

export interface PivotGrid {
  dates: string[];
  employees: PivotEmployeeRow[];
  columnTotals: string[]; // one per date, across all employees
  grandTotal: string; // bottom-right corner
}

export function buildActivityPivotGrid(data: ActivityReportData, dateRange: DateRange, metric: ActivityMetric): PivotGrid {
  const dates = enumerateDates(dateRange.start, dateRange.end);
  const speedUnit = data.activity.speedUnit;

  const rowByKey = new Map(data.rows.map((r) => [`${r.employeeId}:${r.date}`, r]));

  const employees: PivotEmployeeRow[] = [...data.employeeTotals]
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName))
    .map((et) => ({
      employeeId: et.employeeId,
      employeeName: et.employeeName,
      cells: dates.map((d) => {
        const row = rowByKey.get(`${et.employeeId}:${d}`);
        return row ? pivotCellValue(metric, row, speedUnit) : "—";
      }),
      grandTotal: pivotCellValue(metric, et, speedUnit),
    }));

  const dateTotalByDate = new Map(data.dateTotals.map((dt) => [dt.date, dt]));
  const columnTotals = dates.map((d) => {
    const dt = dateTotalByDate.get(d);
    return dt ? pivotCellValue(metric, dt, speedUnit) : "—";
  });

  const grandTotal = pivotCellValue(metric, data.totals, speedUnit);

  return { dates, employees, columnTotals, grandTotal };
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
