import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { RowCompletionCandidateRun } from "../../lib/rowCompletionTypes";
import { formatDateLong, formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

interface RowCompletionReviewModalProps {
  greenhouseRowId: string;
  densityType: "plants" | "stems";
  rowLabel: string;
  onClose: () => void;
  onCombined: () => void;
}

export function RowCompletionReviewModal({
  greenhouseRowId,
  densityType,
  rowLabel,
  onClose,
  onCombined,
}: RowCompletionReviewModalProps) {
  const [candidates, setCandidates] = useState<RowCompletionCandidateRun[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ candidates: RowCompletionCandidateRun[] }>(
      `/api/row-completions/candidates?greenhouseRowId=${greenhouseRowId}&densityType=${densityType}`
    )
      .then((res) => setCandidates(res.candidates))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load pending row work"));
  }, [greenhouseRowId, densityType]);

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

  return (
    <Modal
      title={`Review row work — ${rowLabel}`}
      onClose={onClose}
      wide
      footer={
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
      }
    >
      <p className="field-hint">
        This physical row has work logged across more than one segment — select the segments that represent the same
        completed row before its density-based speed can be calculated. Selecting just one segment on its own confirms
        it as a separate, deliberately-not-combined completion.
      </p>

      {error && <p className="error-text">{error}</p>}

      {!candidates ? (
        <p>Loading...</p>
      ) : candidates.length === 0 ? (
        <p className="placeholder-page">No pending work found for this row.</p>
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
