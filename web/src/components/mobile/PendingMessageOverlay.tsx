import { useEffect } from "react";
import { useMessages } from "../../context/MessagesContext";

// Full-screen, unclosable overlay for the oldest outstanding message — no
// backdrop click handler, no Escape handler, no close button: there is
// deliberately no way to dismiss this except pressing Acknowledge. Shown
// automatically whenever MessagesContext has a `current` message (driven by
// the server's outstanding-messages fetch, not any local/dismissed state),
// so force-closing and reopening the app, or navigating between mobile
// tabs, can never lose it — the next fetch just returns it again.
export function PendingMessageOverlay() {
  const { current, acknowledging, error, acknowledge } = useMessages();

  // Traps the browser/hardware back gesture while a message is showing: an
  // extra history entry is pushed the moment an overlay appears, and
  // immediately re-pushed if popstate fires (a back press), so back can
  // never navigate away from underneath the overlay or reveal whatever was
  // behind it. Removed automatically once acknowledged (`current` becomes
  // null and this effect's cleanup drops the listener).
  useEffect(() => {
    if (!current) return;
    window.history.pushState({ messageOverlay: true }, "");
    function trapBack() {
      window.history.pushState({ messageOverlay: true }, "");
    }
    window.addEventListener("popstate", trapBack);
    return () => window.removeEventListener("popstate", trapBack);
  }, [current]);

  if (!current) return null;

  return (
    <div className="message-overlay" role="alertdialog" aria-modal="true" aria-label="New message">
      <div className="message-overlay-panel">
        <p className="message-overlay-text">{current.messageText}</p>
        <p className="message-overlay-meta">
          {current.senderName} · {new Date(current.createdAt).toLocaleString()}
        </p>

        {error && <p className="error-text">{error}</p>}

        <button
          type="button"
          className="mobile-action-button mobile-action-primary message-overlay-ack"
          disabled={acknowledging}
          onClick={acknowledge}
        >
          {acknowledging ? "Acknowledging..." : "Acknowledge"}
        </button>
      </div>
    </div>
  );
}
