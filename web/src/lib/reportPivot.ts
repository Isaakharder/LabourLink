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
  // Independent of whichever metric currently drives cells/grandTotal (the
  // "Show:" dropdown selection) — this employee's Paid time across the
  // whole selected range, using the report's own existing Paid time
  // formula (pivotCellValue's "paidTime" case: workSeconds +
  // paidBreakSeconds, summed from the underlying per-day seconds on
  // ActivityEmployeeTotal, never derived by re-adding already-rounded
  // display strings). Only ever set by buildActivityPivotGrid when the
  // caller passes includePaidTimeTotal — undefined otherwise (including
  // always on a Payroll grid), which is exactly when every consumer
  // (ReportPivotTable, ReportPreviewModal, CSV/PDF export) knows to hide
  // the column entirely rather than render an empty one.
  totalPaidTime?: string;
}

export interface PivotGrid {
  dates: string[];
  employees: PivotEmployeeRow[];
  columnTotals: string[]; // one per date, across all employees
  grandTotal: string; // bottom-right corner
  // Bottom-row combined Paid time across every DISPLAYED employee (a
  // total, not a per-employee average) — see PivotEmployeeRow.totalPaidTime.
  totalPaidTimeGrandTotal?: string;
}

export function buildActivityPivotGrid(
  data: ActivityReportData,
  dateRange: DateRange,
  metric: ActivityMetric,
  // Set from the report's own checked metrics list (metrics.includes
  // ("paidTime")) by the caller — see ReportViewPage.tsx. Deliberately a
  // separate flag from `metric` itself: the Total Paid Time column must
  // stay visible regardless of which metric the "Show:" dropdown currently
  // has selected, and must hide only when Paid time is unchecked, not
  // whenever some other metric happens to be shown.
  includePaidTimeTotal: boolean = false
): PivotGrid {
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
      // et (ActivityEmployeeTotal) is already the server's own per-employee
      // sum of the underlying seconds across the whole range (see
      // reportQueries.ts's employeeSeconds accumulation) — formatted once
      // here, never built from this grid's own already-rounded daily cells.
      totalPaidTime: includePaidTimeTotal ? pivotCellValue("paidTime", et, speedUnit) : undefined,
    }));

  const dateTotalByDate = new Map(data.dateTotals.map((dt) => [dt.date, dt]));
  const columnTotals = dates.map((d) => {
    const dt = dateTotalByDate.get(d);
    return dt ? pivotCellValue(metric, dt, speedUnit) : "—";
  });

  const grandTotal = pivotCellValue(metric, data.totals, speedUnit);
  const totalPaidTimeGrandTotal = includePaidTimeTotal ? pivotCellValue("paidTime", data.totals, speedUnit) : undefined;

  return { dates, employees, columnTotals, grandTotal, totalPaidTimeGrandTotal };
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
