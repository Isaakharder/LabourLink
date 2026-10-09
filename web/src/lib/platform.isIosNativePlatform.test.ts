import { afterEach, describe, expect, it, vi } from "vitest";

// Separate file (not platform.test.ts) because this needs a fresh
// @capacitor/core mock per test case — isolated via vi.resetModules() +
// dynamic re-import, since isIosNativePlatform reads Capacitor.getPlatform()
// at call time, not at module-load time.
async function withMockedCapacitor(
  capacitor: { isNativePlatform: () => boolean; getPlatform?: () => string },
  run: (mod: typeof import("./platform")) => void
) {
  vi.resetModules();
  vi.doMock("@capacitor/core", () => ({ Capacitor: capacitor }));
  const mod = await import("./platform");
  run(mod);
}

afterEach(() => {
  vi.doUnmock("@capacitor/core");
  vi.resetModules();
});

describe("isIosNativePlatform", () => {
  it("is true for a native platform reporting 'ios'", async () => {
    await withMockedCapacitor({ isNativePlatform: () => true, getPlatform: () => "ios" }, (mod) => {
      expect(mod.isIosNativePlatform()).toBe(true);
    });
  });

  it("is false for a native platform reporting 'android' — Android's own behavior must never be reclassified", async () => {
    await withMockedCapacitor({ isNativePlatform: () => true, getPlatform: () => "android" }, (mod) => {
      expect(mod.isIosNativePlatform()).toBe(false);
    });
  });

  it("is false when not on a native platform at all, regardless of getPlatform", async () => {
    await withMockedCapacitor({ isNativePlatform: () => false, getPlatform: () => "ios" }, (mod) => {
      expect(mod.isIosNativePlatform()).toBe(false);
    });
  });

  it("does not throw and safely resolves false when a test mock omits getPlatform entirely", async () => {
    await withMockedCapacitor({ isNativePlatform: () => true }, (mod) => {
      expect(() => mod.isIosNativePlatform()).not.toThrow();
      expect(mod.isIosNativePlatform()).toBe(false);
    });
  });
});
