import { useEffect } from "react";
import { useMessages } from "../../context/MessagesContext";
import { initAndroidPush } from "../../lib/push";

// No UI of its own — silently re-establishes native push registration and
// the notification-tap listener on every app start AND every time the app
// returns to the foreground, but only if the employee already granted
// permission. On start it may also ask for permission once per install
// (see the comment on the first call below). A no-op entirely outside the
// Android app.
//
// Re-checking on every resume (not just mount) is what catches an FCM token
// rotated while the app process was killed or backgrounded — Android's
// process management can and does kill a backgrounded app, and nothing
// listens for Firebase's onNewToken while no JS is running, so a resume is
// the earliest point anything here can notice. initAndroidPush itself
// (push.ts) is wrapped in singleFlight and skips the server round-trip
// entirely when the token hasn't actually changed, so a resume that finds
// nothing new is cheap and never creates a redundant registration row.
export function NativePushBridge() {
  const { refresh } = useMessages();

  useEffect(() => {
    // Start: may ask Android for notification permission once per install
    // ("askOnce", push.ts). This bridge mounts only inside the paired app,
    // so the prompt comes after pairing, never on the pairing screen.
    // Every new install or reinstall starts with notifications off on
    // Android 13+, and before this an employee who never found Settings >
    // Enable notifications could never be notified (2026-11-10: 20 of 36
    // paired phones were in that state). A refusal is respected; Settings'
    // button can ask again.
    initAndroidPush("askOnce", refresh).catch(() => {});

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        initAndroidPush("silent", refresh).catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    // `refresh` is a stable useCallback from MessagesContext, not expected
    // to change identity — this still only needs to run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
