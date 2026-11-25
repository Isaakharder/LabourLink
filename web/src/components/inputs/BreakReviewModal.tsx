import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import {
  combineDateAndTimeToUtcIso,
  formatDateLong,
  formatDurationHMS,
  formatTimeInAppTimezone,
  toTimeInputValue,
} from "../../lib/timezone";

// A break that a cut-off closed (at midnight, or the end-of-day backstop)
// and nobody has reviewed yet — GET /api/inputs/break-reviews.
export interface BreakReviewCase {
  breakId: string;
  employeeId: string;
  employeeName: string;
  date: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  name: string | null;
  isPaid: boolean | null;
  overlappedWorkSeconds: number;
}

export function breakReviewSummary(c: Pick<BreakReviewCase, "startedAt" | "endedAt" | "durationSeconds">): string {
  return `${formatTimeInAppTimezone(c.startedAt)} – ${formatTimeInAppTimezone(c.endedAt)} (${formatDurationHMS(c.durationSeconds)})`;
}

// The outstanding cases, newest first. Choosing one opens that employee's
// day in Inputs, with the review dialog.
export function BreakReviewListModal({
  cases,
  onOpen,
  onClose,
}: {
  cases: BreakReviewCase[] | null;
  onOpen: (c: BreakReviewCase) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Breaks to review" onClose={onClose} wide>
      <p className="break-review-intro">
        These breaks were closed automatically at the end of the day, not by the employee, so their end time is not
        reliable. Until a break is reviewed, productivity keeps the work recorded during it. Payroll uses the break as
        recorded until it is corrected.
      </p>
      {cases === null ? (
        <p>Loading…</p>
      ) : cases.length === 0 ? (
        <p>No breaks need review.</p>
      ) : (
        <table className="break-review-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Employee</th>
              <th>Break as recorded</th>
              <th>Work recorded during it</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.breakId}>
                <td>{formatDateLong(c.date)}</td>
                <td>{c.employeeName}</td>
                <td>
                  {c.name ?? "Break"} {c.isPaid ? "(paid)" : "(unpaid)"} · {breakReviewSummary(c)}
                </td>
                <td>{c.overlappedWorkSeconds > 0 ? formatDurationHMS(c.overlappedWorkSeconds) : "None"}</td>
                <td>
                  <button type="button" onClick={() => onOpen(c)}>
                    Review
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="employee-form-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

// Review one break: correct its times, or confirm them as recorded. Both
// need a typed reason and an explicit confirmation; both are recorded in the
// break's correction history (time_entry_corrections) by PATCH
// /api/inputs/breaks/:id. Nothing is saved until Save.
export function BreakReviewModal({
  review,
  onClose,
  onSaved,
}: {
  review: Pick<BreakReviewCase, "breakId" | "employeeName" | "date" | "startedAt" | "endedAt" | "durationSeconds" | "isPaid">;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [mode, setMode] = useState<"correct" | "confirm">("correct");
  const [startValue, setStartValue] = useState(() => toTimeInputValue(review.startedAt));
  const [endValue, setEndValue] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startIso = startValue ? combineDateAndTimeToUtcIso(review.date, startValue) : null;
  const endIso = endValue ? combineDateAndTimeToUtcIso(review.date, endValue) : null;
  const newSeconds = startIso && endIso ? Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000) : null;
  const timesValid = mode === "confirm" || (newSeconds !== null && newSeconds > 0);
  const canSave = timesValid && reason.trim().length >= 3 && confirmed && !saving;
  // Paid hours move by the change in unpaid break time (a paid break is paid
  // either way; a break with no paid flag is unpaid, as in payroll,
  // workdayTotals.ts). Shown before saving so the change is never a surprise.
  const paidHoursNote =
    mode === "correct" && newSeconds !== null && newSeconds > 0 && review.isPaid !== true
      ? `Unpaid break ${formatDurationHMS(review.durationSeconds)} → ${formatDurationHMS(newSeconds)}: ${review.employeeName}'s paid hours for this day go up by about ${formatDurationHMS(Math.max(0, review.durationSeconds - newSeconds))}.`
      : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const body =
        mode === "confirm"
          ? { confirmAsRecorded: true, confirmed: true, reason: reason.trim() }
          : { startTime: startIso, endTime: endIso, confirmed: true, reason: reason.trim() };
      await api(`/api/inputs/breaks/${review.breakId}`, { method: "PATCH", body: JSON.stringify(body) });
      onSaved(mode === "confirm" ? "Break confirmed as recorded." : "Break corrected.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the review");
      setSaving(false);
    }
  }

  return (
    <Modal title="Review break" onClose={saving ? () => {} : onClose}>
      <form onSubmit={handleSubmit} className="employee-form break-review-form" noValidate>
        <p>
          <strong>{review.employeeName}</strong>, {formatDateLong(review.date)}. Recorded {breakReviewSummary(review)}. It
          was closed automatically at the end of the day, not by the employee.
        </p>
        <fieldset className="break-review-choice">
          <legend>What happened?</legend>
          <label>
            <input type="radio" name="break-review-mode" checked={mode === "correct"} onChange={() => setMode("correct")} />
            The break was shorter: correct its times
          </label>
          <label>
            <input type="radio" name="break-review-mode" checked={mode === "confirm"} onChange={() => setMode("confirm")} />
            The break is right as recorded
          </label>
        </fieldset>
        {mode === "correct" && (
          <div className="break-review-times">
            <label>
              Start
              <input type="time" step={1} value={startValue} onChange={(e) => setStartValue(e.target.value)} />
            </label>
            <label>
              End
              <input type="time" step={1} value={endValue} onChange={(e) => setEndValue(e.target.value)} />
            </label>
          </div>
        )}
        {mode === "correct" && endValue && !timesValid && <p className="error-text">The end must be after the start, on the same day.</p>}
        {paidHoursNote && <p className="break-review-payroll-note">{paidHoursNote}</p>}
        {mode === "correct" && (
          <p className="break-review-hint">
            As with any break correction in Inputs, work that overlaps the corrected break is trimmed to fit around it.
          </p>
        )}
        <label className="break-review-reason">
          Reason
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Confirmed with the employee: lunch ended at 12:30" />
        </label>
        <label className="break-review-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {mode === "correct" ? "I have checked these times. Saving updates payroll and productivity." : "I have checked that this break is right as recorded."}
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" disabled={!canSave}>
            {saving ? "Saving…" : "Save review"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
