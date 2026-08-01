import { useEffect } from "react";

interface ConfirmEndDayModalProps {
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

// Reuses the same bottom-sheet visual pattern as ActivityPicker (backdrop +
// slide-up panel, .mobile-sheet* classes) for consistency, but is its own
// component since the content/interaction is a plain confirm, not a list.
export function ConfirmEndDayModal({ submitting, error, onConfirm, onCancel }: ConfirmEndDayModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Blocked while submitting — same rule as the backdrop/close button
      // below: a request in flight must not be dismissible out from under
      // itself, so the phone can never show "not working" while the server
      // might still be finishing the request.
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [submitting, onCancel]);

  return (
    <div className="mobile-sheet-backdrop" onClick={submitting ? undefined : onCancel}>
      <div
        className="mobile-sheet"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label="Finish work?"
      >
        <div className="mobile-sheet-header">
          <h2>Finish work?</h2>
          {!submitting && (
            <button type="button" className="mobile-sheet-close" onClick={onCancel} aria-label="Close">
              ×
            </button>
          )}
        </div>

        <p className="mobile-confirm-message">
          Are you sure you want to finish work for today? This will end your current job and clock you out.
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="mobile-confirm-actions">
          <button
            type="button"
            className="mobile-action-button mobile-action-primary"
            disabled={submitting}
            onClick={onCancel}
          >
            Keep Working
          </button>
          <button
            type="button"
            className="mobile-action-button mobile-action-danger"
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? "Finishing…" : "Finish Work"}
          </button>
        </div>
      </div>
    </div>
  );
}
