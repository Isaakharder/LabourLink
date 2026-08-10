import { PivotGrid, formatPivotDateHeader, formatPivotWeekday } from "../../lib/reportPivot";

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
export function ReportPivotTable({ grid }: ReportPivotTableProps) {
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
            <th className="report-pivot-grand-col">Employee Total</th>
          </tr>
        </thead>
        <tbody>
          {grid.employees.map((row) => (
            <tr key={row.employeeId}>
              <td className="report-pivot-employee-col">{row.employeeName}</td>
              {row.cells.map((cell, i) => (
                <td key={grid.dates[i]} className="report-pivot-cell">
                  {cell}
                </td>
              ))}
              <td className="report-pivot-grand-col report-pivot-grand-cell">{row.grandTotal}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="report-totals-row">
            <td className="report-pivot-employee-col">DAY TOTAL</td>
            {grid.columnTotals.map((total, i) => (
              <td key={grid.dates[i]} className="report-pivot-cell">
                {total}
              </td>
            ))}
            <td className="report-pivot-grand-col report-pivot-grand-cell">{grid.grandTotal}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
