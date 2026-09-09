import { FormEvent, KeyboardEvent, useEffect, useId, useRef } from "react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  // Shown on the confirm button in place of confirmLabel while `submitting`
  // is true (e.g. "Deactivating…") — distinct per caller, unlike the fixed
  // "Deleting..." text baked into DeleteTimeEntryModal.
  confirmingLabel: string;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

// Generic destructive-action confirmation dialog — the replacement for
// window.confirm() wherever an action needs a real accessible dialog
// (focus trapped inside it, focus restored to whatever triggered it on
// close) rather than the browser's native popup. Visually it's the same
// app chrome as the shared Modal (components/ui/Modal.tsx) — same
// .modal-overlay/.modal-panel/.modal-header/.modal-body classes, same
// .employee-form-actions/.employee-form-delete button styling already used
// by DeleteTimeEntryModal and DeactivatePhaseModal — but it manages its own
// DOM instead of wrapping Modal, since the focus trap and restore-on-close
// behavior below need a container ref Modal doesn't expose, and adding
// that to Modal itself would change behavior for every one of its other
// ~30 call sites, not just this one.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmingLabel,
  submitting,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const messageId = useId();

  // Default focus lands on Cancel (the safe action), not Deactivate — so a
  // stray Enter right after the dialog opens can't confirm the destructive
  // action before the admin has looked at it. Restores focus to whatever
  // was focused before the dialog opened (the row's own Deactivate button)
  // once it closes, same as any well-behaved dialog.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    cancelButtonRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    function handleWindowKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [submitting, onCancel]);

  // Keeps Tab/Shift+Tab cycling among this dialog's own focusable elements
  // (close button, Cancel, Deactivate) instead of escaping into the page
  // behind it.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panelRef.current.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panelRef.current.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    onConfirm();
  }

  function handleClose() {
    if (!submitting) onCancel();
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        ref={panelRef}
        className="modal-panel confirm-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={handleClose} disabled={submitting}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <form onSubmit={handleSubmit} className="employee-form" noValidate>
            <p id={messageId}>{message}</p>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <div className="employee-form-actions">
              <button type="button" ref={cancelButtonRef} onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="employee-form-delete" disabled={submitting} aria-busy={submitting}>
                {submitting ? confirmingLabel : confirmLabel}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
