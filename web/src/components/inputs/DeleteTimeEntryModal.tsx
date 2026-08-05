import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";

interface DeleteTimeEntryModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  submitting: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

// Shared by activity-log and break deletion — both need the same
// explain-then-confirm-with-reason shape, just different title/message/
// confirmLabel text. Deliberately two explicit clicks apart from row
// selection (select row -> Delete action -> this modal -> reason -> confirm)
// so nothing here can be triggered in a single tap.
export function DeleteTimeEntryModal({
  title,
  message,
  confirmLabel,
  submitting,
  error,
  onConfirm,
  onCancel,
}: DeleteTimeEntryModalProps) {
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 3;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reasonValid || submitting) return;
    onConfirm(reason.trim());
  }

  return (
    <Modal title={title} onClose={submitting ? () => {} : onCancel}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <p>{message}</p>
        <label>
          Reason *
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Duplicate activity registration"
            autoFocus
            required
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-delete" disabled={submitting || !reasonValid}>
            {submitting ? "Deleting..." : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
