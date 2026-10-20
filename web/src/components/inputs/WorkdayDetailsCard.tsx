import { BreakDto, ManualEntryMeta } from "../../lib/inputsTypes";
import { formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";
import { useCommitOnOutsidePointerDown } from "./useCommitOnOutsidePointerDown";

// Checkbox-selectable for deletion: the same rule the server enforces (a
// finished break, by someone allowed to edit Inputs). Only break rows are
// ever selectable — the Work start row has no delete action anywhere in the
// product, and the Total break time row is a summary, not an entry.
export function isBreakDeletable(brk: BreakDto): boolean {
  return brk.canEdit && brk.endedAt !== null;
}

export interface EditingBreakField {
  id: string;
  field: "start" | "end";
}

// "Manually added" badge shared by the work-start row and every break row
// below — one tooltip format (who/when/why) for every manually-created
// entry on this card, matching the existing Auto-added/Auto-closed
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
  // The effective (possibly rounded) time is all this table shows — there
  // is deliberately no "Rounded" badge; the original tap time stays in the
  // API data (DailyInputsResponse.workStartOriginalTime) and audit history.
  workStartTime: string | null;
  // Present only when the work-start entry's started_at was set by an
  // administrator/system correction.
  workStartCorrectedFrom: string | null;
  workStartManualEntry: ManualEntryMeta | null;
  breaks: BreakDto[];
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  selectedBreakId: string | null;
  // Every checked break (a plain row click selects just that row; the
  // checkboxes add/remove). Defaults to just selectedBreakId.
  selectedBreakIds?: ReadonlySet<string>;
  // additive = the row's checkbox (or Ctrl/Cmd+click): toggle it in/out.
  onSelectBreak: (id: string, additive?: boolean) => void;
  // Header checkbox: replaces the selection with exactly these breaks.
  onSetSelectedBreaks?: (ids: string[]) => void;
  // Opens the delete confirmation for every selected deletable break —
  // omitted entirely when the signed-in employee can't edit this day.
  onDeleteSelectedBreaks?: () => void;
  editingBreak: EditingBreakField | null;
  editBreakTimeValue: string;
  onStartEditBreak: (brk: BreakDto, field: "start" | "end") => void;
  onEditBreakTimeChange: (value: string) => void;
  onSaveEditBreak: () => void;
  onCancelEditBreak: () => void;
  // Work start time editing is a single click-to-edit cell (no separate
  // "select, then click again to edit" step like the break rows below) —
  // there's no delete action or other row state that a select step would
  // otherwise be gating, so the row and its time cell both open the editor
  // directly. Only ever editable when workStartTime is non-null: an empty
  // day (no work entry to correct) leaves the cell blank and non-interactive.
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
  workStartCorrectedFrom,
  workStartManualEntry,
  breaks,
  paidBreakSeconds,
  unpaidBreakSeconds,
  selectedBreakId,
  selectedBreakIds,
  onSelectBreak,
  onSetSelectedBreaks,
  onDeleteSelectedBreaks,
  editingBreak,
  editBreakTimeValue,
  onStartEditBreak,
  onEditBreakTimeChange,
  onSaveEditBreak,
  onCancelEditBreak,
  editingWorkStart,
  editWorkStartTimeValue,
  onStartEditWorkStart,
  onEditWorkStartTimeChange,
  onSaveEditWorkStart,
  onCancelEditWorkStart,
  onAddWorkStart,
  onAddBreak,
}: WorkdayDetailsCardProps) {
  const selected: ReadonlySet<string> = selectedBreakIds ?? new Set(selectedBreakId ? [selectedBreakId] : []);
  const deletableBreaks = breaks.filter(isBreakDeletable);
  const checkedDeletableCount = deletableBreaks.filter((b) => selected.has(b.id)).length;
  const allDeletableChecked = deletableBreaks.length > 0 && checkedDeletableCount === deletableBreaks.length;

  // Clicking anywhere outside an open time editor saves it, same as Enter.
  useCommitOnOutsidePointerDown(editingBreak !== null, "break", onSaveEditBreak);
  useCommitOnOutsidePointerDown(editingWorkStart, "work-start", onSaveEditWorkStart);

  function handleWorkStartClick() {
    if (workStartTime && !editingWorkStart) onStartEditWorkStart();
  }
  function handleTimeCellClick(brk: BreakDto, field: "start" | "end", isSelected: boolean) {
    const alreadyEditingThisCell = editingBreak?.id === brk.id && editingBreak.field === field;
    if (isSelected && selected.size <= 1 && brk.canEdit && !alreadyEditingThisCell && (field === "start" || brk.endedAt)) {
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
          {onDeleteSelectedBreaks && (
            <button
              type="button"
              className="inputs-section-header-button inputs-section-header-button-danger"
              disabled={checkedDeletableCount === 0}
              title={checkedDeletableCount === 0 ? "Select one or more breaks to delete" : undefined}
              onClick={onDeleteSelectedBreaks}
            >
              {checkedDeletableCount === 0 ? "Delete" : `Delete (${checkedDeletableCount})`}
            </button>
          )}
        </div>
      </div>
      <div className="inputs-workday-table-scroll">
        <table className="employees-table inputs-workday-table">
          <colgroup>
            <col className="inputs-col-select" />
            <col className="inputs-workday-col-name" />
            <col className="inputs-workday-col-time" />
            <col className="inputs-workday-col-time" />
            <col className="inputs-workday-col-duration" />
            <col className="inputs-workday-col-duration" />
          </colgroup>
          <thead>
            <tr>
              <th className="inputs-select-cell">
                {onSetSelectedBreaks && deletableBreaks.length > 0 && (
                  <input
                    type="checkbox"
                    className="inputs-select-checkbox"
                    aria-label="Select all deletable breaks"
                    checked={allDeletableChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = checkedDeletableCount > 0 && !allDeletableChecked;
                    }}
                    onChange={() => onSetSelectedBreaks(allDeletableChecked ? [] : deletableBreaks.map((b) => b.id))}
                  />
                )}
              </th>
              <th>Activity</th>
              <th>Start Time</th>
              <th>End Time</th>
              <th>Paid Time</th>
              <th>Unpaid Time</th>
            </tr>
          </thead>
          <tbody>
            <tr
              className={`inputs-break-row${!workStartTime ? " inputs-break-row-disabled" : ""}${
                editingWorkStart ? " inputs-break-row-selected" : ""
              }`}
              // The whole row: any click on it (re)opens the editor, so it
              // must not count as clicking elsewhere.
              data-time-editor={editingWorkStart ? "work-start" : undefined}
              onClick={handleWorkStartClick}
            >
              <td className="inputs-select-cell" />
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
                      className="inputs-time-input"
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
                  <span className="inputs-cell-stack">
                    <span className="inputs-cell-time">{formatTimeInAppTimezone(workStartTime)}</span>
                    {workStartManualEntry && <ManualBadge meta={workStartManualEntry} />}
                  </span>
                ) : null}
              </td>
              {/* No data → an empty cell (no "—" placeholder), here and below. */}
              <td />
              <td />
              <td />
            </tr>
            {breaks.map((b) => {
              const durationDisplay = b.endedAt ? formatDurationHMS(b.durationSeconds) : "In progress";
              const isSelected = selected.has(b.id);
              const editingStart = editingBreak?.id === b.id && editingBreak.field === "start";
              const editingEnd = editingBreak?.id === b.id && editingBreak.field === "end";

              return (
                <tr
                  key={b.id}
                  className={`inputs-break-row${isSelected ? " inputs-break-row-selected" : ""}`}
                  onClick={(e) => onSelectBreak(b.id, e.ctrlKey || e.metaKey)}
                >
                  <td className="inputs-select-cell" onClick={(e) => e.stopPropagation()}>
                    {onSetSelectedBreaks && isBreakDeletable(b) && (
                      <input
                        type="checkbox"
                        className="inputs-select-checkbox"
                        aria-label={`Select ${b.name ?? "Break"} at ${formatTimeInAppTimezone(b.startedAt)}`}
                        checked={selected.has(b.id)}
                        onChange={() => onSelectBreak(b.id, true)}
                      />
                    )}
                  </td>
                  <td className="inputs-workday-name">
                    <span className="inputs-activity-line">
                      <span className="inputs-cell-truncate" title={b.name ?? "Break"}>
                        {b.name ?? "Break"}
                      </span>
                      {b.source === "auto" && <span className="inputs-break-source-badge">Auto-added</span>}
                      {b.manualEntry && <ManualBadge meta={b.manualEntry} />}
                    </span>
                  </td>
                  <td
                    className={`inputs-time-cell${b.canEdit ? " inputs-time-cell-editable" : ""}`}
                    data-time-editor={editingStart ? "break" : undefined}
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
                          className="inputs-time-input"
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
                      <span className="inputs-cell-stack">
                        <span className="inputs-cell-time">{formatTimeInAppTimezone(b.startedAt)}</span>
                      </span>
                    )}
                  </td>
                  <td
                    className={`inputs-time-cell${b.canEdit && b.endedAt ? " inputs-time-cell-editable" : ""}`}
                    data-time-editor={editingEnd ? "break" : undefined}
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
                          className="inputs-time-input"
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
                      <span className="inputs-cell-stack">
                        <span className="inputs-cell-time">{formatTimeInAppTimezone(b.endedAt)}</span>
                        {b.autoClosed && <span className="inputs-autoclosed-badge">Auto-closed</span>}
                      </span>
                    ) : (
                      "In progress"
                    )}
                  </td>
                  <td className="inputs-workday-duration">{b.isPaid ? durationDisplay : null}</td>
                  <td className="inputs-workday-duration">{!b.isPaid ? durationDisplay : null}</td>
                </tr>
              );
            })}
          </tbody>
          {breaks.length > 0 && (
            <tfoot>
              <tr className="inputs-workday-total-row">
                <td colSpan={4}>Total break time</td>
                <td className="inputs-workday-duration">{formatDurationHMS(paidBreakSeconds)}</td>
                <td className="inputs-workday-duration">{formatDurationHMS(unpaidBreakSeconds)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
