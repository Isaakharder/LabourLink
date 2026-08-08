import { isNativePlatform, isWebPushSupported } from "./platform";
import { api } from "./api";

export type PushSetupResult = { ok: true } | { ok: false; reason: string };

// Local, non-authoritative "did this device already opt in" flag, purely
// for SettingsScreen's initial button label — same convention as
// device.ts's PAIRED_KEY: never trusted as proof of anything server-side,
// just avoids re-showing "Enable notifications" as if nothing had happened
// on every visit to Settings after it already succeeded once.
const PUSH_ENABLED_KEY = "labourlink_push_enabled";

export function isPushMarkedEnabled(): boolean {
  return localStorage.getItem(PUSH_ENABLED_KEY) === "true";
}

function markPushEnabled(): void {
  localStorage.setItem(PUSH_ENABLED_KEY, "true");
}

function clearPushEnabled(): void {
  localStorage.removeItem(PUSH_ENABLED_KEY);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Web Push (installed PWA / browser, including iPhone Home Screen PWA
// where Apple supports it). Only ever called from an explicit "Enable
// notifications" tap (SettingsScreen.tsx) — never automatically — so
// permission is always requested in direct response to a clear user
// action, never on first launch.
export async function subscribeWebPush(): Promise<PushSetupResult> {
  if (!isWebPushSupported()) {
    return { ok: false, reason: "Push notifications are not supported in this browser." };
  }
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!vapidPublicKey) {
    return { ok: false, reason: "Push notifications are not configured on this server yet." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "Notification permission was not granted." };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      }));

    await api("/api/mobile/push/register", {
      method: "POST",
      body: JSON.stringify({ platform: "web_push", subscription: subscription.toJSON() }),
    });
    markPushEnabled();
    return { ok: true };
  } catch {
    return { ok: false, reason: "Could not set up push notifications on this device." };
  }
}

// Android APK (Capacitor). `@capacitor/push-notifications` is dynamically
// imported so this module still loads fine in a plain browser/PWA context
// where the native plugin is irrelevant.
//
// `requestPermission: false` (used by NativePushBridge on every app start)
// only silently re-registers — and re-wires the tap listener — if
// permission was already granted in a previous session; it never prompts.
// `requestPermission: true` (used by SettingsScreen's explicit "Enable
// notifications" button) prompts if not yet decided.
export async function initAndroidPush(
  requestPermission: boolean,
  onNotificationTapped: () => void
): Promise<PushSetupResult | null> {
  if (!isNativePlatform()) return null;

  const { PushNotifications } = await import("@capacitor/push-notifications");

  let status = await PushNotifications.checkPermissions();
  if (status.receive !== "granted") {
    if (!requestPermission) return null;
    status = await PushNotifications.requestPermissions();
  }
  if (status.receive !== "granted") {
    return { ok: false, reason: "Notification permission was not granted." };
  }

  // Re-registering listeners on every call (mount, or an explicit re-enable
  // tap) would otherwise stack duplicate handlers across a session.
  await PushNotifications.removeAllListeners();

  return new Promise((resolve) => {
    PushNotifications.addListener("registration", (token) => {
      api("/api/mobile/push/register", {
        method: "POST",
        body: JSON.stringify({ platform: "android_fcm", fcmToken: token.value }),
      })
        .then(() => {
          markPushEnabled();
          resolve({ ok: true });
        })
        .catch(() => resolve({ ok: false, reason: "Could not save this device's push registration." }));
    });
    PushNotifications.addListener("registrationError", () => {
      resolve({ ok: false, reason: "Could not register for push notifications." });
    });
    // The actual message content/overlay always comes from the server's
    // outstanding-messages fetch (see MessagesContext.refresh), never from
    // the push payload itself — tapping the notification just triggers
    // that same fetch, same as the app resuming any other way.
    PushNotifications.addListener("pushNotificationActionPerformed", () => {
      onNotificationTapped();
    });
    PushNotifications.register();
  });
}

export async function unregisterPush(): Promise<void> {
  clearPushEnabled();
  await api("/api/mobile/push/unregister", { method: "POST" }).catch(() => {});
}
