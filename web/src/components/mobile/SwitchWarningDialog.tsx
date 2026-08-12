import { useEffect } from "react";
import { Language, t } from "../../lib/i18n";
import { SwitchWarning } from "../../lib/nfcSwitchWarning";

interface SwitchWarningDialogProps {
  warning: SwitchWarning;
  targetKind: "row" | "carrier";
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  language: Language;
}

// Same bottom-sheet-as-modal pattern as ConfirmEndDayModal — a plain
// confirm, not a list, but reusing the .mobile-sheet* classes for visual
// consistency. Shown for exactly one warning at a time (see HomeScreen's
// switchWarning state and checkSwitchWarning's own priority ordering) —
// never stacked with another dialog.
export function SwitchWarningDialog({ warning, targetKind, submitting, onConfirm, onCancel, language }: SwitchWarningDialogProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [submitting, onCancel]);

  const message =
    warning.kind === "sameRow"
      ? t(language, targetKind === "row" ? "sameRowJustFinished" : "sameBinJustFinished")
      : t(language, targetKind === "row" ? "minimumDurationWarningRow" : "minimumDurationWarningBin", {
          elapsedMinutes: Math.floor(warning.elapsedSeconds / 60),
          minimumMinutes: warning.minimumMinutes,
        });

  const confirmLabel =
    warning.kind === "sameRow"
      ? t(language, targetKind === "row" ? "goBackIntoRow" : "goBackIntoBin")
      : t(language, targetKind === "row" ? "startNewRowAnyway" : "startNewBinAnyway");

  return (
    <div className="mobile-sheet-backdrop" onClick={submitting ? undefined : onCancel}>
      <div className="mobile-sheet" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={message}>
        <p className="mobile-confirm-message">{message}</p>

        <div className="mobile-confirm-actions">
          <button
            type="button"
            className="mobile-action-button mobile-action-primary"
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? t(language, "starting") : confirmLabel}
          </button>
          <button type="button" className="mobile-action-button" disabled={submitting} onClick={onCancel}>
            {t(language, "cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
