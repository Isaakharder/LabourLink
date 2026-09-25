import { PivotGrid, formatPivotDateHeader, formatPivotWeekday } from "../../lib/reportPivot";
import { abbreviateSpeedCellText } from "../../lib/reportTypes";

interface ReportPivotTableProps {
  grid: PivotGrid;
}

// Spreadsheet-style matrix shared by both report types: exactly one row per
// employee (employeeId is the row key — see PivotGrid/reportQueries.ts,
// never one row per time_entries/run) and one column per calendar day in
// the selected range, plus a DAY TOTAL row on the bottom (per date, across
// employees). The employee column always stays pinned (sticky) while the
// date columns scroll horizontally.
//
// The trailing column(s) differ by report type — discriminated by
// grid.weeklyTotalColumns's presence, never by reportType directly, so this
// component (also reused for Print/PDF preview) stays a pure PivotGrid
// consumer:
//   - Payroll: a single sticky "Employee Total" column (grid.grandTotal /
//     row.grandTotal) for whichever metric the checkbox editor/"Show:"
//     dropdown currently has selected.
//   - Activity: N columns, one per the report's own saved
//     configuration.weeklyTotals (grid.weeklyTotalColumns / row.
//     weeklyTotals) — e.g. "Weekly Activity Hours" alongside "Employee
//     Paid Time" (deliberately un-prefixed — the one whole-shift column
//     among otherwise activity-scoped ones). These are NOT sticky (a
//     variable-width N-column area doesn't generalize the way a single
//     fixed column does), so they simply scroll off with the date columns.
//
// Every cell is passed through abbreviateSpeedCellText — a harmless no-op
// for any non-speed metric's text, since only an Average Speed cell can
// ever contain "stems/hour"/"plants/hour" as a literal substring. This is
// display-only: PivotGrid itself (and therefore CSV export, which reads
// grid values directly rather than through this component) keeps the full
// spelled-out unit — see reportTypes.ts's abbreviateSpeedCellText comment.
export function ReportPivotTable({ grid }: ReportPivotTableProps) {
  const weeklyColumns = grid.weeklyTotalColumns;
  const isActivity = weeklyColumns !== undefined;

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
            {isActivity
              ? weeklyColumns.map((col) => (
                  <th key={col.key} className="report-pivot-weekly-col">
                    {col.label}
                  </th>
                ))
              : (
                  <th className="report-pivot-grand-col">Employee Total</th>
                )}
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
              {isActivity
                ? weeklyColumns.map((col, i) => (
                    <td key={col.key} className="report-pivot-weekly-col">
                      {row.weeklyTotals?.[i] ?? "—"}
                    </td>
                  ))
                : (
                    <td className="report-pivot-grand-col report-pivot-grand-cell">
                      {abbreviateSpeedCellText(row.grandTotal ?? "—")}
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
            {isActivity
              ? weeklyColumns.map((col, i) => (
                  <td key={col.key} className="report-pivot-weekly-col">
                    {grid.weeklyTotalColumnTotals?.[i] ?? "—"}
                  </td>
                ))
              : (
                  <td className="report-pivot-grand-col report-pivot-grand-cell">
                    {abbreviateSpeedCellText(grid.grandTotal ?? "—")}
                  </td>
                )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
