import { beforeEach, describe, expect, it } from "vitest";
import { createFakeStorage } from "./testUtils/fakeStorage";

// device.ts reads/writes `localStorage` (a browser global) directly rather
// than taking it as a parameter, so it has to exist before the module is
// imported — hence the dynamic import inside beforeEach rather than a
// top-level one.
let device: typeof import("./device");

beforeEach(async () => {
  (globalThis as { localStorage?: Storage }).localStorage = createFakeStorage();
  device = await import("./device");
});

describe("getOrCreateDeviceIdentifier", () => {
  it("generates an identifier once and reuses it on every later call", () => {
    const first = device.getOrCreateDeviceIdentifier();
    const second = device.getOrCreateDeviceIdentifier();
    const third = device.getOrCreateDeviceIdentifier();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("persists the identifier so a later call finds the same one already there", () => {
    const id = device.getOrCreateDeviceIdentifier();
    expect(localStorage.getItem(device.DEVICE_ID_KEY)).toBe(id);
  });
});

describe("isDeactivationErrorCode", () => {
  it("is true for exactly the three admin-action codes", () => {
    expect(device.isDeactivationErrorCode("DEVICE_INACTIVE")).toBe(true);
    expect(device.isDeactivationErrorCode("DEVICE_UNASSIGNED")).toBe(true);
    expect(device.isDeactivationErrorCode("EMPLOYEE_INACTIVE")).toBe(true);
  });

  it("is false for the two 'never a recognized device' codes", () => {
    expect(device.isDeactivationErrorCode("DEVICE_NOT_FOUND")).toBe(false);
    expect(device.isDeactivationErrorCode("INVALID_DEVICE_IDENTIFIER")).toBe(false);
  });

  it("is false for an unrecognized code, undefined, or null", () => {
    expect(device.isDeactivationErrorCode("SOMETHING_ELSE")).toBe(false);
    expect(device.isDeactivationErrorCode(undefined)).toBe(false);
    expect(device.isDeactivationErrorCode(null)).toBe(false);
  });

  it("every DEACTIVATION_ERROR_CODES entry has a distinct message", () => {
    const messages = device.DEACTIVATION_ERROR_CODES.map((code) => device.DEACTIVATION_MESSAGES[code]);
    expect(new Set(messages).size).toBe(device.DEACTIVATION_ERROR_CODES.length);
  });
});

describe("clearDevicePaired / resetDeviceIdentity", () => {
  it("both clear pairing state but keep the device identifier intact", () => {
    const id = device.getOrCreateDeviceIdentifier();
    device.markDevicePaired();
    device.setCachedEmployeeSummary({
      employeeId: "e1",
      firstName: "Jane",
      lastName: "Doe",
      lastVerifiedAt: new Date().toISOString(),
    });

    device.clearDevicePaired();
    expect(device.isDevicePaired()).toBe(false);
    expect(device.getCachedEmployeeSummary()).toBeNull();
    expect(device.getOrCreateDeviceIdentifier()).toBe(id);

    device.markDevicePaired();
    device.resetDeviceIdentity();
    expect(device.isDevicePaired()).toBe(false);
    expect(device.getOrCreateDeviceIdentifier()).toBe(id);
  });
});
