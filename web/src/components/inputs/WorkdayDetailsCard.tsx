import { BreakDto } from "../../lib/inputsTypes";
import { formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

interface WorkdayDetailsCardProps {
  workStartTime: string | null;
  breaks: BreakDto[];
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
}

export function WorkdayDetailsCard({
  workStartTime,
  breaks,
  paidBreakSeconds,
  unpaidBreakSeconds,
}: WorkdayDetailsCardProps) {
  return (
    <div className="inputs-workday-section">
      <h3>Workday details</h3>
      <table className="employees-table inputs-workday-table">
        <thead>
          <tr>
            <th>Activity</th>
            <th>Start Time</th>
            <th>Paid Time</th>
            <th>Unpaid Time</th>
          </tr>
        </thead>
        <tbody>
          {workStartTime && (
            <tr>
              <td>Work start time</td>
              <td>{formatTimeInAppTimezone(workStartTime)}</td>
              <td>—</td>
              <td>—</td>
            </tr>
          )}
          {breaks.map((b) => {
            const durationDisplay = b.endedAt ? formatDurationHMS(b.durationSeconds) : "In progress";
            return (
              <tr key={b.id}>
                <td>
                  {b.name ?? "Break"}
                  {b.source === "auto" && <span className="inputs-break-source-badge">Auto-added</span>}
                </td>
                <td>{formatTimeInAppTimezone(b.startedAt)}</td>
                <td>{b.isPaid ? durationDisplay : "—"}</td>
                <td>{!b.isPaid ? durationDisplay : "—"}</td>
              </tr>
            );
          })}
          {!workStartTime && breaks.length === 0 && (
            <tr>
              <td colSpan={4} className="placeholder-page">
                No work start time or breaks recorded for this day.
              </td>
            </tr>
          )}
        </tbody>
        {breaks.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={2}>Total break time</td>
              <td>{formatDurationHMS(paidBreakSeconds)}</td>
              <td>{formatDurationHMS(unpaidBreakSeconds)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
