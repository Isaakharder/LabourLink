import { FormEvent } from "react";
import { Modal } from "../ui/Modal";

interface BreakCorrectionPreviewModalProps {
  messages: string[];
  workedMinutesRemoved: number;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

// Shown only when correcting a break would trim/split/delete at least one
// other activity entry — computed server-side (POST .../correction-
// preview) from the exact same plan Save applies, so this can never
// describe something different from what actually happens. A break-only
// correction with no such side effect skips this entirely and saves
// directly, same as every other correction on the Inputs page (see
// InputsPage.tsx's own comment on why this is a narrow, deliberate
// exception rather than a reintroduction of the removed confirmation-
// modal convention).
export function BreakCorrectionPreviewModal({
  messages,
  workedMinutesRemoved,
  submitting,
  error,
  onConfirm,
  onCancel,
}: BreakCorrectionPreviewModalProps) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    onConfirm();
  }

  return (
    <Modal title="Confirm break correction" onClose={submitting ? () => {} : onCancel}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {messages.map((message, i) => (
          <p key={i}>{message}</p>
        ))}
        {workedMinutesRemoved > 0 && (
          <p className="field-hint">
            Worked time will decrease by {workedMinutesRemoved} minute{workedMinutesRemoved === 1 ? "" : "s"} in total.
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={submitting}>
            {submitting ? "Saving..." : "Save correction"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
