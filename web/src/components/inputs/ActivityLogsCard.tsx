import { MouseEvent, useState } from "react";
import { Avatar } from "../employees/Avatar";
import { ActivityTimer } from "../mobile/ActivityTimer";
import { ActivityRunDto } from "../../lib/inputsTypes";
import { formatDateLong, formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";
import { RowCompletionReviewModal } from "./RowCompletionReviewModal";
import { InputsErrorBoundary } from "./InputsErrorBoundary";

// One row's worth of columns — 8 <th>s in the header above (Activity, Row,
// Carrier, Speed, Start Time, Duration, End Time, Actions). Kept as a plain
// constant (not derived) since the fallback row below needs the same span
// whether or not a real render ever gets far enough to count columns
// dynamically.
const ACTIVITY_LOG_COLUMN_COUNT = 8;

// Defensive against a non-finite/missing value reaching this — .toFixed
// throws a TypeError outright on null/undefined (not just a bad-looking
// result, an actual crash), same class of risk the Inputs blank-screen
// investigation flagged for every duration/total display here.
function formatSpeed(speed: { value: number; unit: string | null }): string {
  if (typeof speed.value !== "number" || !Number.isFinite(speed.value)) {
    console.error("[ActivityLogsCard] formatSpeed: non-finite speed value, showing a safe fallback instead", speed);
    return "—";
  }
  return speed.unit ? `${speed.value.toFixed(1)} ${speed.unit}` : speed.value.toFixed(1);
}

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
  // Both Start Time and End Time are editable now (the general Activity
  // Time Correction workflow — see InputsPage.tsx's handleSaveEdit),
  // entered together as one combined edit mode on the run regardless of
  // which cell was clicked, so an admin can change either or both boundaries
  // in a single correction.
  editingRunId: string | null;
  editStartTimeValue: string;
  editEndTimeValue: string;
  onStartEdit: (run: ActivityRunDto) => void;
  onEditStartTimeChange: (value: string) => void;
  onEditEndTimeChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDeleteRun: (run: ActivityRunDto) => void;
  // Called after the admin combines segments in the row-completion review
  // modal — the parent reloads the day so the newly-resolved speed shows up.
  onRowCompletionChanged: () => void;
  // True while a correction's preview or PATCH request is in flight
  // (InputsPage's actionInFlight) — disables Save/Cancel on the inline
  // editor so a double-click can't fire two overlapping requests.
  saving: boolean;
}

function ManualBadge({ meta }: { meta: NonNullable<ActivityRunDto["manualEntry"]> }) {
  return (
    <span
      className="inputs-manual-badge"
      title={`Manually added by ${meta.createdByName}. Reason: ${meta.creationReason}`}
    >
      Manually added
    </span>
  );
}

export function ActivityLogsCard({
  employee,
  date,
  runs,
  totals,
  selectedRunId,
  onSelectRun,
  editingRunId,
  editStartTimeValue,
  editEndTimeValue,
  onStartEdit,
  onEditStartTimeChange,
  onEditEndTimeChange,
  onSaveEdit,
  onCancelEdit,
  onDeleteRun,
  onRowCompletionChanged,
  saving,
}: ActivityLogsCardProps) {
  const [reviewTarget, setReviewTarget] = useState<{
    greenhouseRowId: string;
    activityId: string;
    activityName: string;
    densityType: "plants" | "stems";
    rowLabel: string;
  } | null>(null);

  // Shared by both the Start Time and End Time cells — either one clicked
  // while the row is already selected and editable enters ONE combined
  // edit mode covering both boundaries (see onStartEdit's own comment on
  // InputsPage.tsx), not two independent per-field editors.
  function handleTimeCellClick(run: ActivityRunDto) {
    // Blocked while a correction is already in flight for this card — a
    // Save click closes the editor immediately (before the request
    // resolves), so without this guard a quick second click on the same
    // cell could re-open editing on the still-stale pre-correction values
    // and race a second request against the first.
    if (saving) return;
    if (run.id === selectedRunId && run.canEdit && editingRunId !== run.id) {
      onStartEdit(run);
    } else {
      onSelectRun(run.id);
    }
  }

  function openReview(run: ActivityRunDto, e: MouseEvent) {
    e.stopPropagation();
    // run.densityType (this run's own frozen density type), never
    // run.activityDensitySource (the activity's current config) — the
    // "Needs review" badge itself was computed server-side from the frozen
    // value, so querying candidates with anything else can silently return
    // zero results for a row the badge just flagged (see inputsTypes.ts).
    // run.activityId is always included too — the badge's own ambiguity
    // check is scoped by row+activity+density (see rowCompletionCandidates.ts),
    // so a different activity sharing this row and density type must never
    // leak into this run's own review group.
    if (!run.row || !run.densityType) return;
    setReviewTarget({
      greenhouseRowId: run.row.id,
      activityId: run.activityId,
      activityName: run.activityName,
      densityType: run.densityType,
      rowLabel: run.row.label,
    });
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
              <col className="inputs-col-starttime" />
              <col className="inputs-col-duration" />
              <col className="inputs-col-endtime" />
              <col className="inputs-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>Activity</th>
                <th>Row</th>
                <th>Carrier</th>
                <th>Speed</th>
                <th className="inputs-th-starttime">Start Time</th>
                <th className="inputs-th-duration">Duration</th>
                <th className="inputs-th-endtime">End Time</th>
                <th className="inputs-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <InputsErrorBoundary
                  key={run.id}
                  resetKey={`${date}:${run.id}`}
                  label={`activity log row (run ${run.id})`}
                  renderFallback={(diagnosticId) => (
                    <tr className="inputs-log-row inputs-log-row-needs-review">
                      <td colSpan={ACTIVITY_LOG_COLUMN_COUNT}>
                        <span className="inputs-needs-review-badge">Needs review</span> This entry couldn't be
                        displayed due to a data issue. Reference: {diagnosticId} · Entry ID: {run.id}
                      </td>
                    </tr>
                  )}
                >
                <tr
                  className={`inputs-log-row${run.id === selectedRunId ? " inputs-log-row-selected" : ""}`}
                  onClick={() => onSelectRun(run.id)}
                >
                  <td className="inputs-log-activity">
                    {run.activityName}
                    {run.manualEntry && <ManualBadge meta={run.manualEntry} />}
                  </td>
                  <td className="inputs-log-row-cell">{run.row?.label ?? "—"}</td>
                  <td className="inputs-log-carrier-cell">{run.carrier?.name ?? "—"}</td>
                  <td className="inputs-log-speed">
                    {run.activityDensitySource ? (
                      run.isUnresolvedRowCompletion ? (
                        <button
                          type="button"
                          className="inputs-row-completion-warning"
                          title="This row has work logged in more than one segment — review and combine before it can count toward speed"
                          onClick={(e) => openReview(run, e)}
                        >
                          Needs review
                        </button>
                      ) : run.calculatedSpeedPerHour ? (
                        <span title="Calculated actual speed for this activity, based on row density and hours worked">
                          {formatSpeed(run.calculatedSpeedPerHour)}
                        </span>
                      ) : (
                        "—"
                      )
                    ) : run.normalSpeedPerHour ? (
                      <span title="Configured normal speed for this activity — not measured actual output">
                        {formatSpeed(run.normalSpeedPerHour)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td
                    className={`inputs-log-starttime${run.canEdit ? " inputs-log-starttime-editable" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTimeCellClick(run);
                    }}
                  >
                    {editingRunId === run.id ? (
                      <input
                        type="time"
                        step={1}
                        value={editStartTimeValue}
                        onChange={(e) => onEditStartTimeChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !saving) onSaveEdit();
                          if (e.key === "Escape") onCancelEdit();
                        }}
                        disabled={saving}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <>
                        {formatTimeInAppTimezone(run.startedAt)}
                        {run.startedAtOriginalTime && run.startedAtOriginalTime !== run.startedAt && (
                          <span
                            className="inputs-rounded-badge"
                            title={`Actual tap time: ${formatTimeInAppTimezone(
                              run.startedAtOriginalTime
                            )} — adjusted by this employee's break profile's work-start rounding setting.`}
                          >
                            Rounded
                          </span>
                        )}
                        {run.startedAtCorrectedFrom && (
                          <span
                            className="inputs-corrected-badge"
                            title={`Previously ${formatTimeInAppTimezone(
                              run.startedAtCorrectedFrom
                            )} — adjusted by an administrator or an automatic correction.`}
                          >
                            Corrected
                          </span>
                        )}
                      </>
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
                      handleTimeCellClick(run);
                    }}
                  >
                    {editingRunId === run.id ? (
                      <div className="inputs-endtime-editor" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="time"
                          step={1}
                          value={editEndTimeValue}
                          onChange={(e) => onEditEndTimeChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !saving) onSaveEdit();
                            if (e.key === "Escape") onCancelEdit();
                          }}
                          disabled={saving}
                          autoFocus
                        />
                        <button type="button" onClick={onSaveEdit} disabled={saving}>
                          {saving ? "Saving..." : "Save"}
                        </button>
                        <button type="button" onClick={onCancelEdit} disabled={saving}>
                          Cancel
                        </button>
                      </div>
                    ) : run.isOpen ? (
                      "In progress"
                    ) : run.endedAt ? (
                      <>
                        {formatTimeInAppTimezone(run.endedAt)}
                        {run.endedAtOriginalTime && run.endedAtOriginalTime !== run.endedAt && (
                          <span
                            className="inputs-rounded-badge"
                            title={`Actual tap time: ${formatTimeInAppTimezone(
                              run.endedAtOriginalTime
                            )} — adjusted by this employee's break profile's work-end rounding setting.`}
                          >
                            Rounded
                          </span>
                        )}
                        {run.endedAtCorrectedFrom && (
                          <span
                            className="inputs-corrected-badge"
                            title={`Previously ${formatTimeInAppTimezone(
                              run.endedAtCorrectedFrom
                            )} — adjusted by an administrator or an automatic correction.`}
                          >
                            Corrected
                          </span>
                        )}
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
                </InputsErrorBoundary>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewTarget && (
        <RowCompletionReviewModal
          greenhouseRowId={reviewTarget.greenhouseRowId}
          activityId={reviewTarget.activityId}
          activityName={reviewTarget.activityName}
          densityType={reviewTarget.densityType}
          rowLabel={reviewTarget.rowLabel}
          onClose={() => setReviewTarget(null)}
          onCombined={() => {
            setReviewTarget(null);
            onRowCompletionChanged();
          }}
          onNoLongerPending={() => {
            setReviewTarget(null);
            onRowCompletionChanged();
          }}
        />
      )}
    </>
  );
}
