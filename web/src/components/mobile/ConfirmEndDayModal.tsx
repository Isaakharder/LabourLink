import { useEffect } from "react";
import { Language, t } from "../../lib/i18n";

interface ConfirmEndDayModalProps {
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  language: Language;
}

// Reuses the same bottom-sheet visual pattern as ActivityPicker (backdrop +
// slide-up panel, .mobile-sheet* classes) for consistency, but is its own
// component since the content/interaction is a plain confirm, not a list.
export function ConfirmEndDayModal({ submitting, error, onConfirm, onCancel, language }: ConfirmEndDayModalProps) {
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
        aria-label={t(language, "finishWorkQuestion")}
      >
        <div className="mobile-sheet-header">
          <h2>{t(language, "finishWorkQuestion")}</h2>
          {!submitting && (
            <button type="button" className="mobile-sheet-close" onClick={onCancel} aria-label={t(language, "close")}>
              ×
            </button>
          )}
        </div>

        <p className="mobile-confirm-message">{t(language, "finishWorkConfirmMessage")}</p>

        {error && <p className="error-text">{error}</p>}

        <div className="mobile-confirm-actions">
          {/* "Finish Work" (the action this modal exists to confirm) must carry
              the visually prominent/primary treatment, and "Keep Working"
              (cancel) must not — every other confirm sheet in this app
              (RowPickerSheet, ActivityQuestionsModal) gives primary styling
              to the button that performs the flow's action, never to
              Cancel. This modal previously had it backwards: "Keep Working"
              was styled as the solid primary button and "Finish Work" as a
              plain outline, making it easy to tap the wrong one and walk
              away believing the day had ended when the request was never
              sent — see the root-cause investigation for a real incident
              this caused. */}
          <button
            type="button"
            className="mobile-action-button mobile-action-danger-solid"
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? t(language, "finishing") : t(language, "finishWork")}
          </button>
          <button type="button" className="mobile-action-button" disabled={submitting} onClick={onCancel}>
            {t(language, "keepWorking")}
          </button>
        </div>
      </div>
    </div>
  );
}
