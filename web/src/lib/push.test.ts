import { beforeAll, describe, expect, it } from "vitest";

// push.ts transitively imports api.ts, whose module-level resolveApiUrl()
// reads `window.location` under Vite's dev mode (which vitest's default
// test mode also sets import.meta.env.DEV to) — same stub as api.test.ts,
// needed before the very first import.
let push: typeof import("./push");

beforeAll(async () => {
  (globalThis as { window?: unknown }).window ??= { location: { protocol: "http:", hostname: "localhost" } };
  push = await import("./push");
});

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

describe("shouldSkipPushRegistration", () => {
  it("skips only when token, identifier and the server's registration all match", () => {
    expect(push.shouldSkipPushRegistration({ token: "t1", deviceIdentifier: DEVICE_A }, "t1", DEVICE_A, true)).toBe(true);
  });

  it("does not skip a refreshed (rotated) token", () => {
    expect(push.shouldSkipPushRegistration({ token: "t1", deviceIdentifier: DEVICE_A }, "t2", DEVICE_A, true)).toBe(false);
  });

  it("does not skip a device's first-ever registration (nothing registered yet)", () => {
    expect(push.shouldSkipPushRegistration(null, "t1", DEVICE_A, null)).toBe(false);
  });

  it("re-registers when the server no longer holds the registration (disabled after an FCM rejection), even with an unchanged token", () => {
    expect(push.shouldSkipPushRegistration({ token: "t1", deviceIdentifier: DEVICE_A }, "t1", DEVICE_A, false)).toBe(false);
  });

  it("re-registers after a re-pair under a new device identifier, even with an unchanged token", () => {
    expect(push.shouldSkipPushRegistration({ token: "t1", deviceIdentifier: DEVICE_A }, "t1", DEVICE_B, true)).toBe(false);
  });

  it("re-registers once when the cache is the legacy bare-token format (no identifier recorded)", () => {
    const legacy = push.parseLastRegistration("t1");
    expect(legacy).toEqual({ token: "t1", deviceIdentifier: null });
    expect(push.shouldSkipPushRegistration(legacy, "t1", DEVICE_A, true)).toBe(false);
  });

  it("trusts the cache when the server can't be reached (offline phone), and re-checks next time", () => {
    expect(push.shouldSkipPushRegistration({ token: "t1", deviceIdentifier: DEVICE_A }, "t1", DEVICE_A, null)).toBe(true);
  });
});

describe("parseLastRegistration", () => {
  it("round-trips the JSON format", () => {
    expect(push.parseLastRegistration(JSON.stringify({ token: "t1", deviceIdentifier: DEVICE_A }))).toEqual({
      token: "t1",
      deviceIdentifier: DEVICE_A,
    });
  });

  it("returns null when nothing is stored (fresh install or reinstall)", () => {
    expect(push.parseLastRegistration(null)).toBeNull();
  });
});

describe("shouldRequestPermission", () => {
  it("asks once after pairing on a fresh install or reinstall (Android 13+ starts with notifications off)", () => {
    expect(push.shouldRequestPermission("askOnce", "prompt", false)).toBe(true);
  });

  it("never re-asks automatically once it has asked on this install", () => {
    expect(push.shouldRequestPermission("askOnce", "prompt", true)).toBe(false);
  });

  it("respects a refusal: never auto-prompts for denied or prompt-with-rationale", () => {
    expect(push.shouldRequestPermission("askOnce", "denied", false)).toBe(false);
    expect(push.shouldRequestPermission("askOnce", "prompt-with-rationale", false)).toBe(false);
  });

  it("silent mode (every resume) never prompts", () => {
    expect(push.shouldRequestPermission("silent", "prompt", false)).toBe(false);
  });

  it("Settings' explicit button asks whenever Android still allows it", () => {
    expect(push.shouldRequestPermission("ask", "prompt", true)).toBe(true);
    expect(push.shouldRequestPermission("ask", "prompt-with-rationale", true)).toBe(true);
    expect(push.shouldRequestPermission("ask", "denied", true)).toBe(false);
  });

  it("does nothing once permission is granted", () => {
    expect(push.shouldRequestPermission("ask", "granted", false)).toBe(false);
  });
});
