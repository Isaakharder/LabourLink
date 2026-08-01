import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";

interface CorrectionReasonModalProps {
  activityName: string;
  oldEndTimeDisplay: string;
  newEndTimeDisplay: string;
  submitting: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function CorrectionReasonModal({
  activityName,
  oldEndTimeDisplay,
  newEndTimeDisplay,
  submitting,
  error,
  onConfirm,
  onCancel,
}: CorrectionReasonModalProps) {
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
          Changing <strong>{activityName}</strong> end time from <strong>{oldEndTimeDisplay}</strong> to{" "}
          <strong>{newEndTimeDisplay}</strong>.
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
