import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";

interface TimeCorrectionModalProps {
  subjectLabel: string;
  fieldLabel: string;
  oldDisplay: string;
  newDisplay: string;
  submitting: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

// Generalized from the activity-run end-time-only version: same reason-gated
// confirm flow, now also reused for a break's start or end time. subjectLabel
// carries the activity/break name and fieldLabel the timestamp being changed
// ("End Time" / "Start Time"), so the sentence below stays accurate for both.
export function TimeCorrectionModal({
  subjectLabel,
  fieldLabel,
  oldDisplay,
  newDisplay,
  submitting,
  error,
  onConfirm,
  onCancel,
}: TimeCorrectionModalProps) {
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 3;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reasonValid || submitting) return;
    onConfirm(reason.trim());
  }

  return (
    <Modal title="Reason for correction" onClose={submitting ? () => {} : onCancel}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <p>
          Changing <strong>{subjectLabel}</strong> {fieldLabel.toLowerCase()} from <strong>{oldDisplay}</strong> to{" "}
          <strong>{newDisplay}</strong>.
        </p>
        <label>
          Reason *
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Employee forgot to change activity"
            autoFocus
            required
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={submitting || !reasonValid}>
            {submitting ? "Saving..." : "Save correction"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
