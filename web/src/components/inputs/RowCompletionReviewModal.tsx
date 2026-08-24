import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { RowCompletionCandidateRun } from "../../lib/rowCompletionTypes";
import { formatDateLong, formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

interface RowCompletionReviewModalProps {
  greenhouseRowId: string;
  // Scopes candidates to this one activity, not just the row+density — a
  // different activity sharing this row and density type is never a
  // candidate here (see rowCompletionCandidates.ts / ActivityLogsCard.tsx's
  // openReview).
  activityId: string;
  activityName: string;
  densityType: "plants" | "stems";
  rowLabel: string;
  onClose: () => void;
  onCombined: () => void;
  // Called when this row genuinely has no pending work to review — the
  // "Needs review" badge that opened this modal was stale (already
  // resolved elsewhere, or the underlying data changed since the page
  // loaded). Distinct from onCombined (nothing was actually combined here),
  // but the caller typically reacts the same way: reload the day so the
  // now-correctly-computed badge disappears.
  onNoLongerPending: () => void;
}

export function RowCompletionReviewModal({
  greenhouseRowId,
  activityId,
  activityName,
  densityType,
  rowLabel,
  onClose,
  onCombined,
  onNoLongerPending,
}: RowCompletionReviewModalProps) {
  const [candidates, setCandidates] = useState<RowCompletionCandidateRun[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ candidates: RowCompletionCandidateRun[] }>(
      `/api/row-completions/candidates?greenhouseRowId=${greenhouseRowId}&activityId=${activityId}&densityType=${densityType}`
    )
      .then((res) => setCandidates(res.candidates))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load pending row work"));
  }, [greenhouseRowId, activityId, densityType]);

  function toggle(runId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  async function handleCombine() {
    if (!candidates || selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const segmentIds = candidates.filter((c) => selected.has(c.runId)).flatMap((c) => c.segmentIds);
      await api("/api/row-completions", { method: "POST", body: JSON.stringify({ timeEntryIds: segmentIds }) });
      onCombined();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not combine the selected work");
      setSubmitting(false);
    }
  }

  const totalDuration = candidates
    ? candidates.filter((c) => selected.has(c.runId)).reduce((sum, c) => sum + c.durationSeconds, 0)
    : 0;
  // Distinguishes "still loading" (candidates === null) from "loaded, and
  // there's genuinely nothing to review" (candidates.length === 0) — the
  // latter must never offer a Combine action at all (there's nothing to
  // select), only a way to acknowledge the stale badge and refresh.
  const isEmpty = candidates !== null && candidates.length === 0;

  function handleAcknowledgeStale() {
    onNoLongerPending();
    onClose();
  }

  return (
    <Modal
      title={`Review row work — ${rowLabel} · ${activityName}`}
      onClose={onClose}
      wide
      footer={
        isEmpty ? (
          <button type="button" className="employees-add-button" onClick={handleAcknowledgeStale}>
            Refresh
          </button>
        ) : (
          <>
            <span className="employees-count">
              {selected.size > 0 ? `${selected.size} selected · ${formatDurationHMS(totalDuration)} total` : ""}
            </span>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="employees-add-button"
              disabled={selected.size === 0 || submitting}
              onClick={handleCombine}
            >
              Combine as one completed row
            </button>
          </>
        )
      }
    >
      {!isEmpty && (
        <p className="field-hint">
          This physical row has work logged across more than one segment — select the segments that represent the
          same completed row before its density-based speed can be calculated. Selecting just one segment on its own
          confirms it as a separate, deliberately-not-combined completion.
        </p>
      )}

      {error && <p className="error-text">{error}</p>}

      {!candidates ? (
        <p>Loading...</p>
      ) : isEmpty ? (
        <p className="placeholder-page">
          This row has no pending work to review right now — the "Needs review" badge was stale. The work has likely
          already been resolved, or the underlying data changed since this page loaded. Click Refresh to reload this
          row and clear the badge.
        </p>
      ) : (
        <table className="employees-table">
          <thead>
            <tr>
              <th></th>
              <th>Date</th>
              <th>Start</th>
              <th>End</th>
              <th>Duration</th>
              <th>Employee</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.runId} onClick={() => toggle(c.runId)} style={{ cursor: "pointer" }}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(c.runId)}
                    onChange={() => toggle(c.runId)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td>{formatDateLong(c.date)}</td>
                <td>{formatTimeInAppTimezone(c.startedAt)}</td>
                <td>{c.endedAt ? formatTimeInAppTimezone(c.endedAt) : "—"}</td>
                <td>{formatDurationHMS(c.durationSeconds)}</td>
                <td>{c.employeeName}</td>
                <td>{c.activityName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
