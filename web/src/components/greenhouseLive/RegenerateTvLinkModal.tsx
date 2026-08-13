import { Modal } from "../ui/Modal";

interface RegenerateTvLinkModalProps {
  displayName: string;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

// Confirmation for GreenhousePage's Regenerate TV Link button — every
// selected display already has an active TV link (a fresh one is minted the
// instant a display is created, see routes/greenhouseDisplays.ts's POST /),
// so this always fires, not just when a link happens to be visible. The old
// URL 404s on its very next poll once regenerated, so a TV still showing it
// goes blank until reopened with the new one — this warning is the one
// chance to back out before that happens.
export function RegenerateTvLinkModal({ displayName, submitting, error, onConfirm, onCancel }: RegenerateTvLinkModalProps) {
  return (
    <Modal title="Regenerate TV Link?" onClose={submitting ? () => {} : onCancel}>
      <p>
        This display already has a TV link. Regenerating it may stop the current TV from working until the new link
        is opened. Do you want to regenerate it?
      </p>
      <p className="greenhouse-office-regenerate-target">"{displayName}"</p>
      {error && <p className="error-text">{error}</p>}
      <div className="employee-form-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="button" className="employee-form-save" onClick={onConfirm} disabled={submitting}>
          {submitting ? "Regenerating..." : "Regenerate"}
        </button>
      </div>
    </Modal>
  );
}
