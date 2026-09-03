import { PivotGrid, formatPivotDateHeader, formatPivotWeekday } from "../../lib/reportPivot";
import { abbreviateSpeedCellText } from "../../lib/reportTypes";

interface ReportPivotTableProps {
  grid: PivotGrid;
}

// Spreadsheet-style matrix shared by both report types: exactly one row per
// employee (employeeId is the row key — see PivotGrid/reportQueries.ts,
// never one row per time_entries/run), one column per calendar day in the
// selected range, an Employee Total column on the right (per employee,
// ratio-of-sums for any speed metric — see reportQueries.ts), and a DAY
// TOTAL row on the bottom (per date, across employees). Both the employee
// column and the Employee Total column stay pinned (sticky) while the date
// columns scroll horizontally — a long date range stays usable by
// scrolling instead of shrinking every cell to illegibility.
//
// Every cell is passed through abbreviateSpeedCellText — a harmless no-op
// for any non-speed metric's text, since only an Average Speed cell can
// ever contain "stems/hour"/"plants/hour" as a literal substring. This is
// display-only: PivotGrid itself (and therefore CSV export, which reads
// grid values directly rather than through this component) keeps the full
// spelled-out unit — see reportTypes.ts's abbreviateSpeedCellText comment.
//
// The trailing "Total Paid Time" column is entirely driven by whether
// grid.totalPaidTimeGrandTotal is set (buildActivityPivotGrid only sets it
// when the report's Paid time metric is checked — see ReportViewPage.tsx)
// — a single source of truth so this table, the Print/PDF preview (which
// reuses this same component), and CSV/PDF export can never disagree about
// whether the column should appear. It stays visible no matter which
// metric the "Show:" dropdown has selected, since its own value never
// comes from `metric`.
export function ReportPivotTable({ grid }: ReportPivotTableProps) {
  const showPaidTimeTotal = grid.totalPaidTimeGrandTotal !== undefined;
  // Both total columns are pinned (sticky) to the right edge — when both
  // are present, Employee Total needs to shift left by Total Paid Time's
  // own width so the two don't render on top of each other; see the
  // matching CSS in index.css.
  const employeeTotalHeaderClass = `report-pivot-grand-col${showPaidTimeTotal ? " report-pivot-grand-col-with-paidtime" : ""}`;
  const employeeTotalCellClass = `report-pivot-grand-col report-pivot-grand-cell${
    showPaidTimeTotal ? " report-pivot-grand-col-with-paidtime" : ""
  }`;
  return (
    <div className="report-pivot-wrap">
      <table className="report-pivot-table">
        <thead>
          <tr>
            <th className="report-pivot-employee-col">Employee</th>
            {grid.dates.map((d) => (
              <th key={d} className="report-pivot-date-col">
                <span className="report-pivot-date-top">{formatPivotWeekday(d)}</span>
                <span className="report-pivot-date-bottom">{formatPivotDateHeader(d)}</span>
              </th>
            ))}
            <th className={employeeTotalHeaderClass}>Employee Total</th>
            {showPaidTimeTotal && <th className="report-pivot-grand-col report-pivot-paidtime-col">Total Paid Time</th>}
          </tr>
        </thead>
        <tbody>
          {grid.employees.map((row) => (
            <tr key={row.employeeId}>
              <td className="report-pivot-employee-col">{row.employeeName}</td>
              {row.cells.map((cell, i) => (
                <td key={grid.dates[i]} className="report-pivot-cell">
                  {abbreviateSpeedCellText(cell)}
                </td>
              ))}
              <td className={employeeTotalCellClass}>{abbreviateSpeedCellText(row.grandTotal)}</td>
              {showPaidTimeTotal && (
                <td className="report-pivot-grand-col report-pivot-grand-cell report-pivot-paidtime-col">
                  {row.totalPaidTime ?? "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="report-totals-row">
            <td className="report-pivot-employee-col">DAY TOTAL</td>
            {grid.columnTotals.map((total, i) => (
              <td key={grid.dates[i]} className="report-pivot-cell">
                {abbreviateSpeedCellText(total)}
              </td>
            ))}
            <td className={employeeTotalCellClass}>{abbreviateSpeedCellText(grid.grandTotal)}</td>
            {showPaidTimeTotal && (
              <td className="report-pivot-grand-col report-pivot-grand-cell report-pivot-paidtime-col">
                {grid.totalPaidTimeGrandTotal}
              </td>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
