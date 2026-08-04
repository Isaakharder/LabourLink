import { Modal } from "../ui/Modal";

interface DeactivatePhaseModalProps {
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeactivatePhaseModal({ submitting, error, onConfirm, onCancel }: DeactivatePhaseModalProps) {
  return (
    <Modal title="Deactivate Phase?" onClose={submitting ? () => {} : onCancel}>
      <p>
        Are you sure you want to deactivate this phase? The phase and its rows will remain in the system but will no
        longer be active.
      </p>
      {error && <p className="error-text">{error}</p>}
      <div className="employee-form-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="button" className="greenhouse-phase-deactivate-confirm" onClick={onConfirm} disabled={submitting}>
          {submitting ? "Deactivating..." : "Deactivate Phase"}
        </button>
      </div>
    </Modal>
  );
}
