import { Avatar } from "../employees/Avatar";
import { ActivityTimer } from "../mobile/ActivityTimer";
import { ActivityRunDto } from "../../lib/inputsTypes";
import { formatDateLong, formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

interface ActivityLogsCardEmployee {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
}

interface ActivityLogsCardProps {
  employee: ActivityLogsCardEmployee;
  date: string;
  runs: ActivityRunDto[];
  totals: { workedSeconds: number; breakSeconds: number };
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  editingRunId: string | null;
  editTimeValue: string;
  onStartEdit: (run: ActivityRunDto) => void;
  onEditTimeChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDeleteRun: (run: ActivityRunDto) => void;
}

export function ActivityLogsCard({
  employee,
  date,
  runs,
  totals,
  selectedRunId,
  onSelectRun,
  editingRunId,
  editTimeValue,
  onStartEdit,
  onEditTimeChange,
  onSaveEdit,
  onCancelEdit,
  onDeleteRun,
}: ActivityLogsCardProps) {
  function handleEndTimeCellClick(run: ActivityRunDto) {
    if (run.id === selectedRunId && run.canEdit && editingRunId !== run.id) {
      onStartEdit(run);
    } else {
      onSelectRun(run.id);
    }
  }

  return (
    <>
      <div className="inputs-logs-header">
        <Avatar photoUrl={employee.photoUrl} firstName={employee.firstName} lastName={employee.lastName} size="large" />
        <div className="inputs-logs-header-text">
          <h2>
            {employee.firstName} {employee.lastName}
          </h2>
          <p>{formatDateLong(date)}</p>
        </div>
        <div className="inputs-logs-totals">
          <div className="stat-tile">
            <span className="stat-value">{formatDurationHMS(totals.workedSeconds)}</span>
            <span className="stat-label">Worked</span>
          </div>
          <div className="stat-tile">
            <span className="stat-value">{formatDurationHMS(totals.breakSeconds)}</span>
            <span className="stat-label">Break</span>
          </div>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="placeholder-page inputs-workspace-placeholder">No activity logs for this date.</p>
      ) : (
        <div className="inputs-logs-table-scroll">
          <table className="employees-table inputs-logs-table">
            <colgroup>
              <col className="inputs-col-activity" />
              <col className="inputs-col-row" />
              <col className="inputs-col-carrier" />
              <col className="inputs-col-speed" />
              <col className="inputs-col-duration" />
              <col className="inputs-col-endtime" />
              <col className="inputs-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>Activity</th>
                <th>Row</th>
                <th>Carrier</th>
                <th>Normal Speed</th>
                <th className="inputs-th-duration">Duration</th>
                <th className="inputs-th-endtime">End Time</th>
                <th className="inputs-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className={`inputs-log-row${run.id === selectedRunId ? " inputs-log-row-selected" : ""}`}
                  onClick={() => onSelectRun(run.id)}
                >
                  <td className="inputs-log-activity">{run.activityName}</td>
                  <td className="inputs-log-row-cell">{run.row?.label ?? "—"}</td>
                  <td className="inputs-log-carrier-cell">{run.carrier?.name ?? "—"}</td>
                  <td className="inputs-log-speed">
                    {run.normalSpeedPerHour ? (
                      <span title="Configured normal speed for this activity — not measured actual output">
                        {run.normalSpeedPerHour.value.toFixed(1)}
                        {run.normalSpeedPerHour.unit ? ` ${run.normalSpeedPerHour.unit}` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="inputs-log-duration">
                    {run.isOpen ? (
                      <>
                        <ActivityTimer
                          startedAt={run.currentSegmentStartedAt}
                          offsetSeconds={run.durationSeconds}
                          className="inputs-log-duration-live"
                        />{" "}
                        <span className="status-pill status-active">In progress</span>
                      </>
                    ) : (
                      formatDurationHMS(run.durationSeconds)
                    )}
                  </td>
                  <td
                    className={`inputs-log-endtime${run.canEdit ? " inputs-log-endtime-editable" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEndTimeCellClick(run);
                    }}
                  >
                    {editingRunId === run.id ? (
                      <div className="inputs-endtime-editor" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="time"
                          step={1}
                          value={editTimeValue}
                          onChange={(e) => onEditTimeChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onSaveEdit();
                            if (e.key === "Escape") onCancelEdit();
                          }}
                          autoFocus
                        />
                        <button type="button" onClick={onSaveEdit}>
                          Save
                        </button>
                        <button type="button" onClick={onCancelEdit}>
                          Cancel
                        </button>
                      </div>
                    ) : run.isOpen ? (
                      "In progress"
                    ) : run.endedAt ? (
                      <>
                        {formatTimeInAppTimezone(run.endedAt)}
                        {run.autoClosed && <span className="inputs-autoclosed-badge">Auto-closed</span>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="inputs-row-actions">
                    {run.id === selectedRunId && run.canEdit && (
                      <button
                        type="button"
                        className="inputs-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteRun(run);
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
