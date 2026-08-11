import { BreakDto, ManualEntryMeta } from "../../lib/inputsTypes";
import { formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

export interface EditingBreakField {
  id: string;
  field: "start" | "end";
}

// "Manually added" badge shared by the work-start row and every break row
// below — one tooltip format (who/when/why) for every manually-created
// entry on this card, matching the existing Auto-added/Auto-closed/Rounded
// badge conventions already used here.
function ManualBadge({ meta }: { meta: ManualEntryMeta }) {
  return (
    <span
      className="inputs-manual-badge"
      title={`Manually added by ${meta.createdByName}. Reason: ${meta.creationReason}`}
    >
      Manually added
    </span>
  );
}

interface WorkdayDetailsCardProps {
  workStartTime: string | null;
  // Present only when work-start rounding was active for this entry (see
  // inputsTypes.ts) — used only to decide whether to show the "Rounded"
  // badge/tooltip, never rendered as the primary time itself.
  workStartOriginalTime: string | null;
  workStartManualEntry: ManualEntryMeta | null;
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
  // Work start time editing is a single click-to-edit cell (no separate
  // "select, then click again to edit" step like the break rows below) —
  // there's no delete action or other row state that a select step would
  // otherwise be gating, so the row and its time cell both open the editor
  // directly. Only ever editable when workStartTime is non-null: an empty
  // day (no work entry to correct) renders "—" and stays non-interactive.
  editingWorkStart: boolean;
  editWorkStartTimeValue: string;
  onStartEditWorkStart: () => void;
  onEditWorkStartTimeChange: (value: string) => void;
  onSaveEditWorkStart: () => void;
  onCancelEditWorkStart: () => void;
  // Opens AddWorkStartModal/AddBreakModal — both omitted entirely (rather
  // than passed disabled) when the signed-in employee can't edit this day,
  // same convention as ActivityLogsCard's onAddActivity.
  onAddWorkStart?: () => void;
  onAddBreak?: () => void;
}

export function WorkdayDetailsCard({
  workStartTime,
  workStartOriginalTime,
  workStartManualEntry,
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
  editingWorkStart,
  editWorkStartTimeValue,
  onStartEditWorkStart,
  onEditWorkStartTimeChange,
  onSaveEditWorkStart,
  onCancelEditWorkStart,
  onAddWorkStart,
  onAddBreak,
}: WorkdayDetailsCardProps) {
  function handleWorkStartClick() {
    if (workStartTime && !editingWorkStart) onStartEditWorkStart();
  }
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
      <div className="inputs-section-header">
        <h3>Workday details</h3>
        <div className="inputs-section-header-actions">
          {onAddWorkStart && (
            <button
              type="button"
              className="inputs-section-header-button"
              disabled={Boolean(workStartTime)}
              title={
                workStartTime
                  ? "A work start already exists for this day — edit the existing start time instead."
                  : undefined
              }
              onClick={onAddWorkStart}
            >
              Add work start
            </button>
          )}
          {onAddBreak && (
            <button type="button" className="inputs-section-header-button" onClick={onAddBreak}>
              Add break
            </button>
          )}
        </div>
      </div>
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
          <tr
            className={`inputs-break-row${!workStartTime ? " inputs-break-row-disabled" : ""}${
              editingWorkStart ? " inputs-break-row-selected" : ""
            }`}
            onClick={handleWorkStartClick}
          >
            <td>Work start time</td>
            <td
              className={`inputs-time-cell${workStartTime ? " inputs-time-cell-editable" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                handleWorkStartClick();
              }}
            >
              {editingWorkStart ? (
                <div className="inputs-time-editor" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="time"
                    step={1}
                    value={editWorkStartTimeValue}
                    onChange={(e) => onEditWorkStartTimeChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSaveEditWorkStart();
                      if (e.key === "Escape") onCancelEditWorkStart();
                    }}
                    autoFocus
                  />
                  <button type="button" onClick={onSaveEditWorkStart}>
                    Save
                  </button>
                  <button type="button" onClick={onCancelEditWorkStart}>
                    Cancel
                  </button>
                </div>
              ) : workStartTime ? (
                <>
                  {formatTimeInAppTimezone(workStartTime)}
                  {workStartOriginalTime && workStartOriginalTime !== workStartTime && (
                    <span
                      className="inputs-rounded-badge"
                      title={`Actual tap time: ${formatTimeInAppTimezone(workStartOriginalTime)} — adjusted by this employee's break profile's work-start rounding setting.`}
                    >
                      Rounded
                    </span>
                  )}
                  {workStartManualEntry && <ManualBadge meta={workStartManualEntry} />}
                </>
              ) : (
                "—"
              )}
            </td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td></td>
          </tr>
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
                  {b.manualEntry && <ManualBadge meta={b.manualEntry} />}
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
                    <>
                      {formatTimeInAppTimezone(b.endedAt)}
                      {b.autoClosed && <span className="inputs-autoclosed-badge">Auto-closed</span>}
                    </>
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
