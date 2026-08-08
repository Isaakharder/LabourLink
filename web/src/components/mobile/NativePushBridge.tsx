import { useEffect } from "react";
import { useMessages } from "../../context/MessagesContext";
import { initAndroidPush } from "../../lib/push";

// No UI of its own — silently re-establishes native push registration and
// the notification-tap listener on every app start, but only if the
// employee already granted permission in an earlier session
// (requestPermission: false, see push.ts). Never prompts on its own;
// first-time opt-in only ever happens via SettingsScreen's explicit
// "Enable notifications" button. A no-op entirely outside the Android app.
export function NativePushBridge() {
  const { refresh } = useMessages();

  useEffect(() => {
    initAndroidPush(false, refresh).catch(() => {});
    // Runs once per mount (app start) — `refresh` is a stable useCallback
    // from MessagesContext, not expected to change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
