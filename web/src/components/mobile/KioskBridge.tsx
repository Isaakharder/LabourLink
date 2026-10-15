import { useEffect, useRef, useState } from "react";
import { useMessages } from "../../context/MessagesContext";
import { useWorkSession } from "../../context/WorkSessionContext";
import { alertKioskMessage, onKioskNavigationBlocked, reportKioskStatus, useKioskDevice } from "../../lib/kiosk";
import { initAndroidPush, setForegroundPushHandler } from "../../lib/push";

// How often a kiosk phone re-checks for outstanding messages while it sits
// in the foreground. FCM (via the foreground push handler) is the fast
// path; this is the safety net for a delayed/dropped push, since a kiosk
// phone never backgrounds and so never gets MessagesContext's resume
// refresh.
export const KIOSK_MESSAGE_POLL_MS = 60_000;

// Kiosk phones only (lib/kiosk.ts) — renders nothing and does nothing
// anywhere else. Mounted once in MobileLayout, inside MessagesProvider and
// WorkSessionProvider.
export function KioskBridge() {
  const { pending: messages, refresh } = useMessages();
  const { pending: pendingEvents } = useWorkSession();
  const kiosk = useKioskDevice();
  const [blockedNotice, setBlockedNotice] = useState(false);
  const seen = useRef<Set<string>>(new Set());

  // Foreground push + periodic safety-net refresh. Permission is requested
  // directly here: on a kiosk phone there's no one else who would ever tap
  // Settings > Enable notifications (the EMM policy normally pre-grants it,
  // which makes this silent).
  useEffect(() => {
    if (!kiosk) return;
    setForegroundPushHandler(refresh);
    // Let any registration NativePushBridge already started settle first —
    // singleFlight would otherwise hand back that call, which was set up
    // before the foreground handler existed.
    initAndroidPush(false, refresh)
      .catch(() => null)
      .then(() => initAndroidPush(true, refresh))
      .catch(() => {});
    const poll = window.setInterval(refresh, KIOSK_MESSAGE_POLL_MS);
    return () => {
      window.clearInterval(poll);
      setForegroundPushHandler(null);
    };
  }, [kiosk, refresh]);

  // Sound + vibration whenever a message this session hasn't alerted for
  // yet shows up (including one still outstanding after a restart).
  useEffect(() => {
    if (!kiosk) return;
    let fresh = false;
    for (const m of messages) {
      if (!seen.current.has(m.recipientId)) {
        seen.current.add(m.recipientId);
        fresh = true;
      }
    }
    if (fresh) alertKioskMessage().catch(() => {});
  }, [kiosk, messages]);

  // Last-known status for the native maintenance screen.
  useEffect(() => {
    if (!kiosk) return;
    reportKioskStatus().catch(() => {});
    const t = window.setInterval(() => reportKioskStatus().catch(() => {}), KIOSK_MESSAGE_POLL_MS);
    return () => window.clearInterval(t);
  }, [kiosk, pendingEvents]);

  useEffect(() => {
    if (!kiosk) return;
    let hideTimer: number | undefined;
    let remove: (() => void) | null = null;
    let alive = true;
    onKioskNavigationBlocked(() => {
      setBlockedNotice(true);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setBlockedNotice(false), 4000);
    }).then((r) => {
      if (alive) remove = r;
      else r();
    });
    return () => {
      alive = false;
      window.clearTimeout(hideTimer);
      remove?.();
    };
  }, [kiosk]);

  if (!kiosk || !blockedNotice) return null;
  return (
    <div className="kiosk-notice" role="status">
      Links outside LabourLink can’t be opened on this phone.
    </div>
  );
}
