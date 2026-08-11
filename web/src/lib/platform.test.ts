import { describe, expect, it } from "vitest";
import { shouldRenderMobileApp } from "./platform";

describe("shouldRenderMobileApp", () => {
  it("always renders the mobile app on a native platform, regardless of viewport", () => {
    expect(shouldRenderMobileApp(true, true)).toBe(true);
    expect(shouldRenderMobileApp(true, false)).toBe(true);
  });

  it("falls back to the viewport heuristic for the browser/PWA case", () => {
    expect(shouldRenderMobileApp(false, true)).toBe(true);
    expect(shouldRenderMobileApp(false, false)).toBe(false);
  });
});
