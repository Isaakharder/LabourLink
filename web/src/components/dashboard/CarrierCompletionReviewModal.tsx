// Structural copy of RowCompletionReviewModal.tsx, adapted for carriers
// instead of greenhouse rows — see carrierCompletions.ts / carrierCompletionCandidates.ts
// for why this needs its own candidate/confirm endpoints rather than reusing
// the row-completion ones.
import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { formatDateLong, formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

interface CarrierCompletionCandidateRun {
  runId: string;
  segmentIds: string[];
  employeeName: string;
  activityName: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
}

interface CarrierCompletionReviewModalProps {
  carrierId: string;
  carrierName: string;
  onClose: () => void;
  onCombined: () => void;
}

export function CarrierCompletionReviewModal({
  carrierId,
  carrierName,
  onClose,
  onCombined,
}: CarrierCompletionReviewModalProps) {
  const [candidates, setCandidates] = useState<CarrierCompletionCandidateRun[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ candidates: CarrierCompletionCandidateRun[] }>(`/api/carrier-completions/candidates?carrierId=${carrierId}`)
      .then((res) => setCandidates(res.candidates))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load pending bin work"));
  }, [carrierId]);

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
      await api("/api/carrier-completions", { method: "POST", body: JSON.stringify({ timeEntryIds: segmentIds }) });
      onCombined();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not combine the selected work");
      setSubmitting(false);
    }
  }

  const totalDuration = candidates
    ? candidates.filter((c) => selected.has(c.runId)).reduce((sum, c) => sum + c.durationSeconds, 0)
    : 0;
  // An in-progress entry can't be confirmed (mirrors the server's own
  // validation) — disable it here too rather than only after a failed save.
  const selectedIncludesOpen = candidates?.some((c) => selected.has(c.runId) && c.endedAt === null) ?? false;

  return (
    <Modal
      title={`Review bin work — ${carrierName}`}
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
            disabled={selected.size === 0 || selectedIncludesOpen || submitting}
            onClick={handleCombine}
          >
            Combine as one completed bin
          </button>
        </>
      }
    >
      <p className="field-hint">
        This bin has work logged across more than one segment — select the segments that represent the same
        completed bin before its speed can be counted. Selecting just one segment on its own confirms it as a
        separate, deliberately-not-combined completion. An in-progress (not yet finished) entry can't be selected.
      </p>

      {error && <p className="error-text">{error}</p>}

      {!candidates ? (
        <p>Loading...</p>
      ) : candidates.length === 0 ? (
        <p className="placeholder-page">No pending work found for this bin.</p>
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
              <tr
                key={c.runId}
                onClick={() => (c.endedAt === null ? undefined : toggle(c.runId))}
                style={{ cursor: c.endedAt === null ? "not-allowed" : "pointer", opacity: c.endedAt === null ? 0.6 : 1 }}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(c.runId)}
                    disabled={c.endedAt === null}
                    onChange={() => toggle(c.runId)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td>{formatDateLong(c.date)}</td>
                <td>{formatTimeInAppTimezone(c.startedAt)}</td>
                <td>{c.endedAt ? formatTimeInAppTimezone(c.endedAt) : "In progress"}</td>
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
