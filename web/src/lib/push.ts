import { isNativePlatform, isWebPushSupported } from "./platform";
import { api } from "./api";
import { singleFlight } from "./singleFlight";
import { DEVICE_ID_KEY } from "./device";

export type PushSetupResult = { ok: true } | { ok: false; reason: string };

// Local, non-authoritative "did this device already opt in" flag, purely
// for SettingsScreen's initial button label — same convention as
// device.ts's PAIRED_KEY: never trusted as proof of anything server-side,
// just avoids re-showing "Enable notifications" as if nothing had happened
// on every visit to Settings after it already succeeded once.
const PUSH_ENABLED_KEY = "labourlink_push_enabled";

// The FCM token this device last successfully registered with the server,
// and the device identifier it was registered under, stored as JSON
// {token, deviceIdentifier}. Builds before this stored the bare token;
// that still parses (with no identifier), so such a phone re-registers
// once. Never trusted on its own: see shouldSkipPushRegistration.
const PUSH_TOKEN_KEY = "labourlink_last_fcm_token";

// Set once the app has asked for notification permission by itself after
// pairing, so a "Don't allow" is respected and never re-prompted
// automatically. Settings' button can still ask again.
const PUSH_AUTO_ASKED_KEY = "labourlink_push_auto_asked";

export interface LastPushRegistration {
  token: string;
  deviceIdentifier: string | null;
}

export function isPushMarkedEnabled(): boolean {
  return localStorage.getItem(PUSH_ENABLED_KEY) === "true";
}

function markPushEnabled(): void {
  localStorage.setItem(PUSH_ENABLED_KEY, "true");
}

function clearPushEnabled(): void {
  localStorage.removeItem(PUSH_ENABLED_KEY);
}

export function parseLastRegistration(raw: string | null): LastPushRegistration | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LastPushRegistration> | null;
    if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
      return {
        token: parsed.token,
        deviceIdentifier: typeof parsed.deviceIdentifier === "string" ? parsed.deviceIdentifier : null,
      };
    }
  } catch {
    // Legacy format: the bare token string.
  }
  return { token: raw, deviceIdentifier: null };
}

function getLastRegistration(): LastPushRegistration | null {
  return parseLastRegistration(localStorage.getItem(PUSH_TOKEN_KEY));
}

function setLastRegistration(token: string, deviceIdentifier: string | null): void {
  localStorage.setItem(PUSH_TOKEN_KEY, JSON.stringify({ token, deviceIdentifier }));
}

function clearLastRegistration(): void {
  localStorage.removeItem(PUSH_TOKEN_KEY);
}

// Pure decision, split out so it's unit-testable without the native
// plugin. This used to rest on the local cache alone, which left a phone
// unreachable for good whenever the server no longer held its registration
// (disabled after an FCM rejection, or recorded under an older device row)
// while the token itself hadn't changed. A skip now needs all three: the
// same token, the same device identifier, and the server confirming it
// holds an active registration for this device.
//
// serverRegistered null = the status check couldn't reach the server. The
// cache is trusted then (a POST would fail offline too), and the next
// launch or resume checks again. Re-posting is always safe: the server
// treats an unchanged token as a no-op.
export function shouldSkipPushRegistration(
  last: LastPushRegistration | null,
  newToken: string,
  deviceIdentifier: string | null,
  serverRegistered: boolean | null
): boolean {
  if (!last || last.token !== newToken) return false;
  if (last.deviceIdentifier !== deviceIdentifier) return false;
  return serverRegistered !== false;
}

async function fetchServerRegistered(): Promise<boolean | null> {
  try {
    const res = await api<{ registered: boolean }>("/api/mobile/push/status");
    return !!res.registered;
  } catch {
    return null;
  }
}

// When the app may prompt for notification permission by itself:
//   "silent"  never prompt; re-register only if permission is already granted
//   "askOnce" prompt only if Android has never been asked on this install and
//             the app hasn't auto-asked before. Android 13+ starts every
//             install, a reinstall included, with notifications off.
//   "ask"     prompt if not yet decided (Settings' explicit button)
export type PushPermissionMode = "silent" | "askOnce" | "ask";

export function shouldRequestPermission(
  mode: PushPermissionMode,
  receive: string,
  alreadyAutoAsked: boolean
): boolean {
  if (receive === "granted" || receive === "denied") return false;
  if (mode === "ask") return true;
  if (mode === "askOnce") return receive === "prompt" && !alreadyAutoAsked;
  return false;
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
// NativePushBridge calls this with "askOnce" on start (it only mounts once
// the phone is paired) and "silent" on every resume; SettingsScreen's
// button uses "ask". Booleans are still accepted: true = "ask",
// false = "silent".
async function doInitAndroidPush(
  modeOrRequest: PushPermissionMode | boolean,
  onNotificationTapped: () => void
): Promise<PushSetupResult | null> {
  if (!isNativePlatform()) return null;
  const mode: PushPermissionMode =
    modeOrRequest === true ? "ask" : modeOrRequest === false ? "silent" : modeOrRequest;

  const { PushNotifications } = await import("@capacitor/push-notifications");

  let status = await PushNotifications.checkPermissions();
  if (status.receive !== "granted") {
    if (status.receive === "denied" && isPushMarkedEnabled()) {
      // Notifications were turned off in Android settings after being
      // enabled. Tell the server, so senders see "no registered device"
      // instead of a push this phone will never show.
      await unregisterPush();
    }
    const autoAsked = localStorage.getItem(PUSH_AUTO_ASKED_KEY) === "true";
    if (!shouldRequestPermission(mode, status.receive, autoAsked)) {
      return mode === "ask" && status.receive === "denied"
        ? { ok: false, reason: "Notifications are blocked for LabourLink in Android settings." }
        : null;
    }
    if (mode === "askOnce") localStorage.setItem(PUSH_AUTO_ASKED_KEY, "true");
    status = await PushNotifications.requestPermissions();
  }
  if (status.receive !== "granted") {
    return { ok: false, reason: "Notification permission was not granted." };
  }

  // Re-registering listeners on every call (mount, resume, or an explicit
  // re-enable tap) would otherwise stack duplicate handlers across a
  // session.
  await PushNotifications.removeAllListeners();

  return new Promise((resolve) => {
    PushNotifications.addListener("registration", async (token) => {
      const deviceIdentifier = localStorage.getItem(DEVICE_ID_KEY);
      const last = getLastRegistration();
      // The server is only asked when the cache would otherwise skip; a
      // changed token or identifier always posts.
      const serverRegistered =
        last && last.token === token.value && last.deviceIdentifier === deviceIdentifier
          ? await fetchServerRegistered()
          : null;
      if (shouldSkipPushRegistration(last, token.value, deviceIdentifier, serverRegistered)) {
        markPushEnabled();
        resolve({ ok: true });
        return;
      }
      api("/api/mobile/push/register", {
        method: "POST",
        body: JSON.stringify({ platform: "android_fcm", fcmToken: token.value }),
      })
        .then(() => {
          setLastRegistration(token.value, deviceIdentifier);
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

// Wrapped in singleFlight so overlapping calls — NativePushBridge's mount
// call landing close to a resume-triggered re-check, or two resumes firing
// in quick succession before the first settled — share one native call
// chain instead of each independently calling removeAllListeners()/
// addListener()/register(), which would race (one call's
// removeAllListeners() can wipe another's just-added listeners) and could
// otherwise double up the POST to the server.
export const initAndroidPush = singleFlight(doInitAndroidPush);

export async function unregisterPush(): Promise<void> {
  clearPushEnabled();
  clearLastRegistration();
  await api("/api/mobile/push/unregister", { method: "POST" }).catch(() => {});
}
