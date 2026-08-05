import { BreakDto } from "../../lib/inputsTypes";
import { formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

export interface EditingBreakField {
  id: string;
  field: "start" | "end";
}

interface WorkdayDetailsCardProps {
  workStartTime: string | null;
  breaks: BreakDto[];
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  selectedBreakId: string | null;
  onSelectBreak: (id: string) => void;
  editingBreak: EditingBreakField | null;
  editBreakTimeValue: string;
  onStartEditBreak: (brk: BreakDto, field: "start" | "end") => void;
  onEditBreakTimeChange: (value: string) => void;
  onSaveEditBreak: () => void;
  onCancelEditBreak: () => void;
  onDeleteBreak: (brk: BreakDto) => void;
}

export function WorkdayDetailsCard({
  workStartTime,
  breaks,
  paidBreakSeconds,
  unpaidBreakSeconds,
  selectedBreakId,
  onSelectBreak,
  editingBreak,
  editBreakTimeValue,
  onStartEditBreak,
  onEditBreakTimeChange,
  onSaveEditBreak,
  onCancelEditBreak,
  onDeleteBreak,
}: WorkdayDetailsCardProps) {
  function handleTimeCellClick(brk: BreakDto, field: "start" | "end", isSelected: boolean) {
    const alreadyEditingThisCell = editingBreak?.id === brk.id && editingBreak.field === field;
    if (isSelected && brk.canEdit && !alreadyEditingThisCell && (field === "start" || brk.endedAt)) {
      onStartEditBreak(brk, field);
    } else {
      onSelectBreak(brk.id);
    }
  }

  return (
    <div className="inputs-workday-section">
      <h3>Workday details</h3>
      <table className="employees-table inputs-workday-table">
        <thead>
          <tr>
            <th>Activity</th>
            <th>Start Time</th>
            <th>End Time</th>
            <th>Paid Time</th>
            <th>Unpaid Time</th>
            <th className="inputs-th-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {workStartTime && (
            <tr className="inputs-workday-readonly-row">
              <td>Work start time</td>
              <td>{formatTimeInAppTimezone(workStartTime)}</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td></td>
            </tr>
          )}
          {breaks.map((b) => {
            const durationDisplay = b.endedAt ? formatDurationHMS(b.durationSeconds) : "In progress";
            const isSelected = b.id === selectedBreakId;
            const editingStart = editingBreak?.id === b.id && editingBreak.field === "start";
            const editingEnd = editingBreak?.id === b.id && editingBreak.field === "end";

            return (
              <tr
                key={b.id}
                className={`inputs-break-row${isSelected ? " inputs-break-row-selected" : ""}`}
                onClick={() => onSelectBreak(b.id)}
              >
                <td>
                  {b.name ?? "Break"}
                  {b.source === "auto" && <span className="inputs-break-source-badge">Auto-added</span>}
                </td>
                <td
                  className={`inputs-time-cell${b.canEdit ? " inputs-time-cell-editable" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTimeCellClick(b, "start", isSelected);
                  }}
                >
                  {editingStart ? (
                    <div className="inputs-time-editor" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="time"
                        step={1}
                        value={editBreakTimeValue}
                        onChange={(e) => onEditBreakTimeChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onSaveEditBreak();
                          if (e.key === "Escape") onCancelEditBreak();
                        }}
                        autoFocus
                      />
                      <button type="button" onClick={onSaveEditBreak}>
                        Save
                      </button>
                      <button type="button" onClick={onCancelEditBreak}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    formatTimeInAppTimezone(b.startedAt)
                  )}
                </td>
                <td
                  className={`inputs-time-cell${b.canEdit && b.endedAt ? " inputs-time-cell-editable" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (b.endedAt) handleTimeCellClick(b, "end", isSelected);
                    else onSelectBreak(b.id);
                  }}
                >
                  {editingEnd ? (
                    <div className="inputs-time-editor" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="time"
                        step={1}
                        value={editBreakTimeValue}
                        onChange={(e) => onEditBreakTimeChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onSaveEditBreak();
                          if (e.key === "Escape") onCancelEditBreak();
                        }}
                        autoFocus
                      />
                      <button type="button" onClick={onSaveEditBreak}>
                        Save
                      </button>
                      <button type="button" onClick={onCancelEditBreak}>
                        Cancel
                      </button>
                    </div>
                  ) : b.endedAt ? (
                    formatTimeInAppTimezone(b.endedAt)
                  ) : (
                    "In progress"
                  )}
                </td>
                <td>{b.isPaid ? durationDisplay : "—"}</td>
                <td>{!b.isPaid ? durationDisplay : "—"}</td>
                <td className="inputs-row-actions">
                  {isSelected && b.canEdit && (
                    <button
                      type="button"
                      className="inputs-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteBreak(b);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!workStartTime && breaks.length === 0 && (
            <tr>
              <td colSpan={6} className="placeholder-page">
                No work start time or breaks recorded for this day.
              </td>
            </tr>
          )}
        </tbody>
        {breaks.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={3}>Total break time</td>
              <td>{formatDurationHMS(paidBreakSeconds)}</td>
              <td>{formatDurationHMS(unpaidBreakSeconds)}</td>
              <td></td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
