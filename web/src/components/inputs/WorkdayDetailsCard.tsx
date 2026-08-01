import { BreakDto } from "../../lib/inputsTypes";
import { formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

interface WorkdayDetailsCardProps {
  workStartTime: string | null;
  breaks: BreakDto[];
}

// Break rows show a single Duration column, not Paid/Unpaid — time_entries
// has no paid/unpaid or break-type classification of any kind (confirmed
// during planning: no such column exists anywhere in this app's schema).
// Reporting that limitation here rather than guessing at a split.
export function WorkdayDetailsCard({ workStartTime, breaks }: WorkdayDetailsCardProps) {
  return (
    <div className="inputs-workday-card">
      <h3>Workday details</h3>
      <p className="inputs-workday-note">
        Paid/unpaid break classification isn't tracked yet — showing total break duration only.
      </p>
      <table className="employees-table">
        <thead>
          <tr>
            <th>Activity</th>
            <th>Start Time</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {workStartTime && (
            <tr>
              <td>Work start time</td>
              <td>{formatTimeInAppTimezone(workStartTime)}</td>
              <td>—</td>
            </tr>
          )}
          {breaks.map((b) => (
            <tr key={b.id}>
              <td>Break</td>
              <td>{formatTimeInAppTimezone(b.startedAt)}</td>
              <td>{b.endedAt ? formatDurationHMS(b.durationSeconds) : "In progress"}</td>
            </tr>
          ))}
          {!workStartTime && breaks.length === 0 && (
            <tr>
              <td colSpan={3} className="placeholder-page">
                No work start time or breaks recorded for this day.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
