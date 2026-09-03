import { buildEmploymentTimelineRows } from "../../lib/employmentTimeline";
import { EmploymentTimelineEmployee } from "../../lib/employmentPeriodTypes";

interface EmploymentTimelineTableProps {
  employees: EmploymentTimelineEmployee[];
}

// Accessible table view carrying the same information as the graph — one
// row per employment period, reading from the same buildEmploymentTimelineRows
// builder the CSV/PDF export uses, so the table and export can never
// disagree.
export function EmploymentTimelineTable({ employees }: EmploymentTimelineTableProps) {
  const rows = buildEmploymentTimelineRows(employees);

  if (rows.length === 0) {
    return <p className="placeholder-page">No employment periods match the current filters.</p>;
  }

  return (
    <table className="employment-timeline-table">
      <caption className="sr-only">Employment periods</caption>
      <thead>
        <tr>
          <th scope="col">Employee</th>
          <th scope="col">Nationality</th>
          <th scope="col">Work Group</th>
          <th scope="col">Employment Type</th>
          <th scope="col">Start</th>
          <th scope="col">Expected Finish</th>
          <th scope="col">Actual Finish</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            <td>{row.employeeName}</td>
            <td>{row.nationality}</td>
            <td>{row.workGroup}</td>
            <td>{row.employmentType}</td>
            <td>{row.startDate}</td>
            <td>{row.expectedFinishDate || "—"}</td>
            <td>{row.actualFinishDate || "—"}</td>
            <td>{row.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
