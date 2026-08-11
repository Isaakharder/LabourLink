import { useEffect } from "react";
import { useWorkSession } from "../../context/WorkSessionContext";

// Full-screen, unclosable overlay — same "no backdrop click, no Escape, no
// close button" convention as PendingMessageOverlay — shown the moment a
// server response's employee id differs from the one this phone was last
// paired to (WorkSessionContext's pendingReassignment/detectReassignment).
// The employee holding the phone must see and acknowledge this before any
// other screen becomes interactive again; it never applies the reassignment
// silently in the background. Acknowledging is purely local (the new
// employee's data already arrived with the response that triggered this —
// there's nothing left to fetch), so there's no loading/error state to show
// here the way PendingMessageOverlay has for its network-backed acknowledge.
export function ReassignmentOverlay() {
  const { pendingReassignment, acknowledgeReassignment } = useWorkSession();

  // Same back-gesture trap as PendingMessageOverlay — a reassignment must
  // never be dismissed by navigating away from underneath it.
  useEffect(() => {
    if (!pendingReassignment) return;
    window.history.pushState({ reassignmentOverlay: true }, "");
    function trapBack() {
      window.history.pushState({ reassignmentOverlay: true }, "");
    }
    window.addEventListener("popstate", trapBack);
    return () => window.removeEventListener("popstate", trapBack);
  }, [pendingReassignment]);

  if (!pendingReassignment) return null;

  const { firstName, lastName } = pendingReassignment.employee;

  return (
    <div className="message-overlay" role="alertdialog" aria-modal="true" aria-label="Device reassigned">
      <div className="message-overlay-panel">
        <p className="message-overlay-text">
          This phone is now assigned to {firstName} {lastName}.
        </p>
        <p className="message-overlay-meta">
          Any offline actions still waiting to sync are unaffected and will continue once you continue.
        </p>
        <button
          type="button"
          className="mobile-action-button mobile-action-primary message-overlay-ack"
          onClick={acknowledgeReassignment}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
