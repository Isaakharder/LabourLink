import { useEffect, useState } from "react";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { DEVICE_ID_KEY, getCachedEmployeeSummary } from "./device";
import { getLocalEventStore } from "./localEventStore";

// JS side of Android kiosk mode (native: web/android/.../kiosk/). Kiosk
// mode only exists on a company phone enrolled in the EMM, which delivers
// LabourLink's kiosk_mode_enabled managed configuration and allowlists it
// for lock task — the native plugin decides that, never anything here.
// Everywhere else (personal Android installs, iOS, browser/PWA) every
// export below resolves to "not a kiosk device" / does nothing, so regular
// behaviour is unchanged.

export interface KioskStatus {
  kioskDevice: boolean;
  locked: boolean;
  maintenanceActive: boolean;
}

interface StatusReport {
  deviceIdentifier: string | null;
  pendingCount: number;
  lastSyncAt: string | null;
  employee: string | null;
}

interface LabourLinkKioskPlugin {
  getStatus(): Promise<KioskStatus>;
  reportStatus(report: StatusReport): Promise<void>;
  openMaintenance(report: StatusReport): Promise<void>;
  alert(): Promise<void>;
  addListener(event: "navigationBlocked", cb: (e: { url: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "statusChanged", cb: (s: KioskStatus) => void): Promise<PluginListenerHandle>;
}

const NOT_KIOSK: KioskStatus = { kioskDevice: false, locked: false, maintenanceActive: false };

// Registered lazily, and only on Android where the native plugin exists —
// importing this module must stay side-effect free for iOS, the browser
// build and every test that mocks @capacitor/core.
let plugin: LabourLinkKioskPlugin | null = null;
function kiosk(): LabourLinkKioskPlugin {
  if (!plugin) plugin = registerPlugin<LabourLinkKioskPlugin>("LabourLinkKiosk");
  return plugin;
}

function pluginAvailable(): boolean {
  try {
    return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("LabourLinkKiosk");
  } catch {
    return false;
  }
}

let statusPromise: Promise<KioskStatus> | null = null;
const subscribers = new Set<(s: KioskStatus) => void>();
let listening = false;

function fetchStatus(): Promise<KioskStatus> {
  statusPromise = kiosk()
    .getStatus()
    .catch(() => NOT_KIOSK)
    .then((s) => {
      subscribers.forEach((cb) => cb(s));
      return s;
    });
  return statusPromise;
}

// Cached, but re-read whenever the native side reports a managed-config
// change: the EMM can deliver kiosk config after LabourLink has already
// started (e.g. the first launch on a freshly enrolled phone), and a stale
// "not kiosk" would leave the maintenance entry and message polling off
// until the next restart.
export function getKioskStatus(): Promise<KioskStatus> {
  if (!pluginAvailable()) return Promise.resolve(NOT_KIOSK);
  if (!listening) {
    listening = true;
    kiosk()
      .addListener("statusChanged", () => {
        fetchStatus();
      })
      .catch(() => {});
  }
  return statusPromise ?? fetchStatus();
}

// React hook: whether this is an enrolled kiosk phone, kept current.
export function useKioskDevice(): boolean {
  const [kioskDevice, setKioskDevice] = useState(false);
  useEffect(() => {
    let alive = true;
    const onStatus = (s: KioskStatus) => {
      if (alive) setKioskDevice(s.kioskDevice);
    };
    subscribers.add(onStatus);
    getKioskStatus().then(onStatus);
    return () => {
      alive = false;
      subscribers.delete(onStatus);
    };
  }, []);
  return kioskDevice;
}

// Test-only.
export function resetKioskStatusCache(): void {
  statusPromise = null;
  listening = false;
  subscribers.clear();
}

// Never creates an identifier (unlike getOrCreateDeviceIdentifier) — the
// maintenance screen must only ever display what's already there.
async function collectStatus(): Promise<StatusReport> {
  const deviceIdentifier = localStorage.getItem(DEVICE_ID_KEY);
  const employee = getCachedEmployeeSummary();
  let pendingCount = -1;
  let lastSyncAt: string | null = null;
  if (deviceIdentifier) {
    try {
      const summary = await getLocalEventStore().getSyncSummary(deviceIdentifier);
      pendingCount = summary.pendingCount;
      lastSyncAt = summary.lastSuccessfulSyncAt;
    } catch {
      // Shown as "unknown" on the maintenance screen.
    }
  }
  return {
    deviceIdentifier,
    pendingCount,
    lastSyncAt,
    employee: employee ? `${employee.firstName} ${employee.lastName}` : null,
  };
}

export async function openKioskMaintenance(): Promise<void> {
  if (!(await getKioskStatus()).kioskDevice) return;
  await kiosk().openMaintenance(await collectStatus());
}

// Keeps the native side's last-known status fresh so the maintenance
// screen can still show it if the WebView later fails to start.
export async function reportKioskStatus(): Promise<void> {
  if (!(await getKioskStatus()).kioskDevice) return;
  await kiosk().reportStatus(await collectStatus()).catch(() => {});
}

export async function alertKioskMessage(): Promise<void> {
  if (!(await getKioskStatus()).kioskDevice) return;
  await kiosk().alert().catch(() => {});
}

export async function onKioskNavigationBlocked(cb: (url: string) => void): Promise<() => void> {
  if (!(await getKioskStatus()).kioskDevice) return () => {};
  const handle = await kiosk().addListener("navigationBlocked", (e) => cb(e.url));
  return () => {
    handle.remove();
  };
}
