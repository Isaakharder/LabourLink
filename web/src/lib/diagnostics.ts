// On-device diagnostics for Settings > Sync details — read-only snapshot of
// exactly the fields a supervisor or engineer needs to distinguish "this
// phone genuinely has no path to the server right now" from "something in
// the app is stuck" without needing adb. See the mobile offline
// investigation this exists to make visible: the previous absence of any
// of this made "the Wi-Fi icon looked off" impossible to confirm or refute
// from the device itself.
//
// No tokens, PINs, or employee-sensitive payloads — every field here is
// either a boolean/timestamp or this device's own installed-app identity.
import { isNativePlatform } from "./platform";
import { API_URL } from "./api";
import { getLocalEventStore } from "./localEventStore";
import { getOrCreateDeviceIdentifier } from "./device";

export interface DiagnosticsSnapshot {
  // versionName/versionCode as Android actually installed them — read live
  // from the OS via @capacitor/app's getInfo(), not the web bundle's own
  // build-time constant, so this can never disagree with what's really on
  // the device. Null on a non-native build (browser/PWA), where there is
  // no installed package to ask.
  appVersion: string | null;
  appBuild: string | null;
  apiUrl: string;
  // What @capacitor/network reports the active connection as. This app
  // holds no permission that can read the Wi-Fi radio's own on/off state
  // (see the mobile offline investigation — Android also blocks a
  // third-party app from ever toggling it) — "wifi"/"cellular"/"none"/
  // "unknown" is the most specific signal actually available, so this is
  // deliberately labeled "connection type," never "Wi-Fi enabled."
  connectionType: string;
  networkConnected: boolean;
  // Whether the last attempt to reach the LabourLink API actually got a
  // response — distinct from networkConnected (a phone can be on a live
  // Wi-Fi network with no path to this specific API).
  apiReachable: boolean;
  // Whether a basic local-store read just succeeded — the same read every
  // action already depends on (getPendingCount), so "not ready" here means
  // the exact thing that would also be blocking local actions right now.
  sqliteReady: boolean;
  referenceCache: {
    activities: string | null; // cachedAt (ISO) or null if never cached on this device
    rows: string | null;
    carriers: string | null;
  };
  pendingCount: number;
  lastLocalAction: {
    eventType: string;
    occurredAtUtc: string;
    // First 8 chars of the event's own clientEventId — same convention
    // SyncStatusScreen's conflict list already uses for "Diagnostic ID."
    diagnosticId: string;
  } | null;
}

// Must match referenceDataCache.ts's own CACHE_KEYS — duplicated here
// rather than imported, same convention localSessionState.ts already
// follows for the same reason (this file has no other need to depend on
// referenceDataCache.ts's picker-shaped response types).
const REFERENCE_CACHE_KEYS = {
  activities: "activities",
  rows: "greenhouse-rows",
  carriers: "carriers",
} as const;

export async function getDiagnosticsSnapshot(apiReachable: boolean): Promise<DiagnosticsSnapshot> {
  const store = getLocalEventStore();
  const deviceId = getOrCreateDeviceIdentifier();

  let appVersion: string | null = null;
  let appBuild: string | null = null;
  if (isNativePlatform()) {
    try {
      const { App } = await import("@capacitor/app");
      const info = await App.getInfo();
      appVersion = info.version;
      appBuild = info.build;
    } catch (err) {
      console.error("[diagnostics] failed to read native app info:", err);
    }
  }

  let connectionType = "unknown";
  let networkConnected = navigator.onLine;
  try {
    const { Network } = await import("@capacitor/network");
    const status = await Network.getStatus();
    connectionType = status.connectionType;
    networkConnected = status.connected;
  } catch (err) {
    console.error("[diagnostics] failed to read network status:", err);
  }

  let sqliteReady = false;
  let pendingCount = 0;
  try {
    pendingCount = await store.getPendingCount(deviceId);
    sqliteReady = true;
  } catch (err) {
    console.error("[diagnostics] local store read failed:", err);
  }

  const [activitiesCached, rowsCached, carriersCached, lastEvent] = await Promise.all([
    store.getCachedJson(REFERENCE_CACHE_KEYS.activities).catch(() => null),
    store.getCachedJson(REFERENCE_CACHE_KEYS.rows).catch(() => null),
    store.getCachedJson(REFERENCE_CACHE_KEYS.carriers).catch(() => null),
    store.getLatestEventForDevice(deviceId).catch(() => null),
  ]);

  return {
    appVersion,
    appBuild,
    apiUrl: API_URL || window.location.origin,
    connectionType,
    networkConnected,
    apiReachable,
    sqliteReady,
    referenceCache: {
      activities: activitiesCached?.cachedAt ?? null,
      rows: rowsCached?.cachedAt ?? null,
      carriers: carriersCached?.cachedAt ?? null,
    },
    pendingCount,
    lastLocalAction: lastEvent
      ? {
          eventType: lastEvent.eventType,
          occurredAtUtc: lastEvent.occurredAtUtc,
          diagnosticId: lastEvent.clientEventId.slice(0, 8),
        }
      : null,
  };
}
