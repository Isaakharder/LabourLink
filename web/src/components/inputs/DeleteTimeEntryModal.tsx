import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";

interface DeleteTimeEntryModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  // Activity-log deletion still asks for a typed reason; break deletion
  // doesn't (the server records a fixed reason for it instead — see
  // BREAK_DELETION_REASON in inputs.ts) — plain confirm/cancel only.
  requireReason: boolean;
  submitting: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

// Shared by activity-log and break deletion — both need the same
// explain-then-confirm shape, just different title/message/confirmLabel
// text and whether a reason is collected. Deliberately at least one
// explicit click apart from row selection (select row -> Delete action ->
// this modal -> confirm) so nothing here can be triggered in a single tap.
export function DeleteTimeEntryModal({
  title,
  message,
  confirmLabel,
  requireReason,
  submitting,
  error,
  onConfirm,
  onCancel,
}: DeleteTimeEntryModalProps) {
  const [reason, setReason] = useState("");
  const reasonValid = !requireReason || reason.trim().length >= 3;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reasonValid || submitting) return;
    onConfirm(reason.trim());
  }

  return (
    <Modal title={title} onClose={submitting ? () => {} : onCancel}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <p>{message}</p>
        {requireReason && (
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
        )}
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
