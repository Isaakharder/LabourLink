import { ReactNode, useEffect } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  // Larger variant for content that genuinely needs a wide, tall surface
  // (e.g. a multi-group form) — distinct from `wide` so existing callers
  // are unaffected.
  xl?: boolean;
  // Optional pinned action row rendered below the scrollable body, outside
  // its own scroll area — e.g. Save/Cancel that must stay reachable
  // regardless of how tall the body's content gets.
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, wide, xl, footer }: ModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-panel${wide ? " modal-panel-wide" : ""}${xl ? " modal-panel-xl" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
