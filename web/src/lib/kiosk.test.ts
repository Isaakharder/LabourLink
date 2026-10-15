// @vitest-environment jsdom
//
// lib/kiosk.ts must be a strict no-op everywhere except an EMM-enrolled
// kiosk phone (decided natively): iOS, the browser build and a personal
// Android install never even register the plugin.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  platform: "web",
  pluginAvailable: false,
  status: { kioskDevice: false, locked: false, maintenanceActive: false },
  registerCalls: 0,
  openMaintenance: vi.fn(async (_r: unknown) => {}),
  reportStatus: vi.fn(async (_r: unknown) => {}),
  alert: vi.fn(async () => {}),
  listeners: {} as Record<string, (arg: unknown) => void>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => state.platform,
    isPluginAvailable: () => state.pluginAvailable,
    isNativePlatform: () => state.platform !== "web",
  },
  registerPlugin: () => {
    state.registerCalls++;
    return {
      getStatus: async () => state.status,
      openMaintenance: state.openMaintenance,
      reportStatus: state.reportStatus,
      alert: state.alert,
      addListener: async (event: string, cb: (arg: unknown) => void) => {
        state.listeners[event] = cb;
        return { remove: () => {} };
      },
    };
  },
}));

vi.mock("./localEventStore", () => ({
  getLocalEventStore: () => ({
    getSyncSummary: async () => ({ pendingCount: 3, conflictCount: 0, lastSuccessfulSyncAt: "2026-10-12T10:00:00Z", lastAttemptedSyncAt: null, lastError: null }),
  }),
}));

import { alertKioskMessage, getKioskStatus, openKioskMaintenance, resetKioskStatusCache } from "./kiosk";
import { DEVICE_ID_KEY } from "./device";

beforeEach(() => {
  resetKioskStatusCache();
  localStorage.clear();
  state.registerCalls = 0;
  state.openMaintenance.mockClear();
  state.alert.mockClear();
});

afterEach(() => {
  state.platform = "web";
  state.pluginAvailable = false;
  state.status = { kioskDevice: false, locked: false, maintenanceActive: false };
});

describe("kiosk on non-kiosk platforms", () => {
  it.each(["web", "ios"])("%s: never a kiosk device and never registers the native plugin", async (platform) => {
    state.platform = platform;
    state.pluginAvailable = platform === "ios";
    expect((await getKioskStatus()).kioskDevice).toBe(false);
    await openKioskMaintenance();
    await alertKioskMessage();
    expect(state.registerCalls).toBe(0);
    expect(state.openMaintenance).not.toHaveBeenCalled();
    expect(state.alert).not.toHaveBeenCalled();
  });

  it("personal Android install: native plugin reports not-kiosk, so nothing happens", async () => {
    state.platform = "android";
    state.pluginAvailable = true;
    expect((await getKioskStatus()).kioskDevice).toBe(false);
    await openKioskMaintenance();
    await alertKioskMessage();
    expect(state.openMaintenance).not.toHaveBeenCalled();
    expect(state.alert).not.toHaveBeenCalled();
  });
});

describe("managed config arriving after LabourLink started", () => {
  it("re-reads status when the native side reports a config change", async () => {
    state.platform = "android";
    state.pluginAvailable = true;
    expect((await getKioskStatus()).kioskDevice).toBe(false);
    // EMM delivers kiosk_mode_enabled=true a moment after first launch.
    state.status = { kioskDevice: true, locked: true, maintenanceActive: false };
    state.listeners.statusChanged?.(state.status);
    await Promise.resolve();
    expect((await getKioskStatus()).kioskDevice).toBe(true);
  });
});

describe("kiosk on an enrolled kiosk phone", () => {
  beforeEach(() => {
    state.platform = "android";
    state.pluginAvailable = true;
    state.status = { kioskDevice: true, locked: true, maintenanceActive: false };
  });

  it("opens maintenance with the current identity and pending count", async () => {
    localStorage.setItem(DEVICE_ID_KEY, "dev-123");
    await openKioskMaintenance();
    expect(state.openMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({ deviceIdentifier: "dev-123", pendingCount: 3, lastSyncAt: "2026-10-12T10:00:00Z" })
    );
  });

  it("never mints a device identifier just to show the maintenance screen", async () => {
    await openKioskMaintenance();
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBeNull();
    expect(state.openMaintenance).toHaveBeenCalledWith(expect.objectContaining({ deviceIdentifier: null, pendingCount: -1 }));
  });

  it("alerts for a message", async () => {
    await alertKioskMessage();
    expect(state.alert).toHaveBeenCalledTimes(1);
  });
});
