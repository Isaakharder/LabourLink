import { beforeAll, describe, expect, it } from "vitest";

// push.ts transitively imports api.ts, whose module-level resolveApiUrl()
// reads `window.location` under Vite's dev mode (which vitest's default
// test mode also sets import.meta.env.DEV to) — same stub as api.test.ts,
// needed before the very first import.
let shouldSkipPushRegistration: typeof import("./push").shouldSkipPushRegistration;
let nativePushRegistrationBody: typeof import("./push").nativePushRegistrationBody;

beforeAll(async () => {
  (globalThis as { window?: unknown }).window ??= { location: { protocol: "http:", hostname: "localhost" } };
  ({ shouldSkipPushRegistration, nativePushRegistrationBody } = await import("./push"));
});

describe("shouldSkipPushRegistration", () => {
  it("skips when the token is unchanged from what's already registered", () => {
    expect(shouldSkipPushRegistration("token-a", "token-a")).toBe(true);
  });

  it("does not skip a genuinely new token", () => {
    expect(shouldSkipPushRegistration("token-a", "token-b")).toBe(false);
  });

  it("does not skip a device's first-ever registration (nothing registered yet)", () => {
    expect(shouldSkipPushRegistration(null, "token-a")).toBe(false);
  });
});

describe("nativePushRegistrationBody", () => {
  it("labels an iOS token as an APNs registration, never android_fcm", () => {
    expect(nativePushRegistrationBody("ios", "a1b2c3")).toEqual({ platform: "ios_apns", apnsToken: "a1b2c3" });
  });

  it("keeps Android's FCM registration body exactly as before", () => {
    expect(nativePushRegistrationBody("android", "fcm-token")).toEqual({ platform: "android_fcm", fcmToken: "fcm-token" });
  });
});
