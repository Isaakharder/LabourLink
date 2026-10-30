import { buildEmploymentTimelineRows, EMPLOYMENT_TIMELINE_COLUMNS, employmentTimelineRowCells, VACATION_LEGEND_TEXT } from "../../lib/employmentTimeline";
import { EmploymentTimelineEmployee } from "../../lib/employmentPeriodTypes";

interface EmploymentTimelineTableProps {
  employees: EmploymentTimelineEmployee[];
}

// Accessible table view carrying the same information as the graph — one
// numbered row per displayed employee, from the same
// buildEmploymentTimelineRows builder the CSV/PDF/Print export uses, so the
// table, exports and graph numbering can never disagree.
export function EmploymentTimelineTable({ employees }: EmploymentTimelineTableProps) {
  const rows = buildEmploymentTimelineRows(employees);

  if (rows.length === 0) {
    return <p className="placeholder-page">No employees match the current filters.</p>;
  }

  return (
    <>
      <p className="employment-timeline-print-legend">{VACATION_LEGEND_TEXT}</p>
      <table className="employment-timeline-table">
        <caption className="sr-only">Employment timeline</caption>
        <thead>
          <tr>
            {EMPLOYMENT_TIMELINE_COLUMNS.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.number}>
              {employmentTimelineRowCells(row).map((cell, i) => (
                <td key={i}>{cell || "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
