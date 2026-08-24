import { FormEvent } from "react";
import { Modal } from "../ui/Modal";

interface DeleteTimeEntryModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

// Shared by activity-log and break deletion — both need the same
// explain-then-confirm shape, just different title/message/confirmLabel
// text. Neither collects a typed reason (the server records a fixed reason
// for both — see ACTIVITY_LOG_DELETION_REASON/BREAK_DELETION_REASON in
// inputs.ts). Deliberately at least one explicit click apart from row
// selection (select row -> Delete action -> this modal -> confirm) so
// nothing here can be triggered in a single tap.
export function DeleteTimeEntryModal({
  title,
  message,
  confirmLabel,
  submitting,
  error,
  onConfirm,
  onCancel,
}: DeleteTimeEntryModalProps) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    onConfirm();
  }

  return (
    <Modal title={title} onClose={submitting ? () => {} : onCancel}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <p>{message}</p>
        {error && <p className="error-text">{error}</p>}
        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-delete" disabled={submitting}>
            {submitting ? "Deleting..." : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
