// @vitest-environment jsdom
//
// The kiosk-only foreground push listener: registered only while
// setForegroundPushHandler() has a handler (kiosk phones), so a personal
// Android install's listener set — and therefore its behaviour — is
// exactly what it was before.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listeners: new Map<string, (arg: unknown) => void>(),
}));

vi.mock("./platform", () => ({ isNativePlatform: () => true, isWebPushSupported: () => false }));
vi.mock("./api", () => ({ api: vi.fn(async () => ({})) }));
vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    checkPermissions: async () => ({ receive: "granted" }),
    requestPermissions: async () => ({ receive: "granted" }),
    removeAllListeners: async () => {
      h.listeners.clear();
    },
    addListener: (event: string, cb: (arg: unknown) => void) => {
      h.listeners.set(event, cb);
    },
    register: () => {
      queueMicrotask(() => h.listeners.get("registration")?.({ value: "tok" }));
    },
  },
}));

import { initAndroidPush, setForegroundPushHandler } from "./push";

beforeEach(() => {
  localStorage.clear();
  h.listeners.clear();
  setForegroundPushHandler(null);
});

describe("foreground push handler", () => {
  it("is not registered on a non-kiosk phone (no handler set)", async () => {
    await initAndroidPush(false, () => {});
    expect([...h.listeners.keys()].sort()).toEqual(["pushNotificationActionPerformed", "registration", "registrationError"]);
  });

  it("routes a foreground push to the kiosk handler", async () => {
    const onForeground = vi.fn();
    setForegroundPushHandler(onForeground);
    await initAndroidPush(false, () => {});
    h.listeners.get("pushNotificationReceived")?.({ data: { type: "message" } });
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it("survives a later re-registration (e.g. Settings > Enable notifications)", async () => {
    const onForeground = vi.fn();
    setForegroundPushHandler(onForeground);
    await initAndroidPush(false, () => {});
    await initAndroidPush(true, () => {});
    h.listeners.get("pushNotificationReceived")?.({});
    expect(onForeground).toHaveBeenCalledTimes(1);
  });
});
