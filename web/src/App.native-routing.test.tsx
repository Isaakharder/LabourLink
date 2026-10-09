// @vitest-environment jsdom
//
// Regression coverage for the iOS platform work: App.tsx's top-level gate
// (shouldRenderMobileApp, lib/platform.ts) already guarantees a native
// build always renders MobileApp, never DesktopApp — and MobileApp's own
// router has no route for any desktop path, so anything unmatched (a
// desktop URL typed directly, a stale bookmark, a deep link) falls through
// its catch-all Navigate to /mobile/home. That guarantee was previously
// only proven at the unit level (platform.test.ts's shouldRenderMobileApp
// cases) — this exercises the real <App/> component tree end to end so a
// future change to App.tsx's route table can't silently reopen desktop
// routes to a native (Android or iOS — Capacitor.isNativePlatform() is
// platform-agnostic) build without a test failing.
//
// MobileLayout and HomeScreen are stubbed because their real
// implementations pull in WorkSessionProvider/MessagesProvider (live
// SQLite/network work unrelated to routing) — everything this test cares
// about is which route wins, not what that screen renders. Desktop page
// components are deliberately left un-mocked: if a regression ever let
// DesktopApp mount for a native platform, its real components (needing
// AuthProvider/api() plumbing this test never sets up) failing to resolve
// to the mobile stub text is exactly the kind of loud failure this test
// should produce.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("./context/DevicePairingContext", () => ({
  DevicePairingProvider: ({ children }: { children: React.ReactNode }) => children,
  useDevicePairing: () => ({ status: "paired" }),
}));

vi.mock("./components/mobile/MobileLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { MobileLayout: () => <Outlet /> };
});

vi.mock("./pages/mobile/HomeScreen", () => ({
  HomeScreen: () => <div>MOBILE_HOME_STUB</div>,
}));

beforeEach(() => {
  // jsdom has no matchMedia implementation — lib/useIsMobile.ts calls it
  // unconditionally on every render (its result is irrelevant here since
  // isNativePlatform() already forces the mobile branch, but the hook still
  // runs). A minimal stub is enough; nothing in this test needs it to ever
  // actually report a match.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => cleanup());

describe("App — native platform never reaches a desktop route", () => {
  it.each([
    ["/", "root"],
    ["/devices", "a top-level desktop-only page"],
    ["/employees/123", "a nested desktop-only page"],
    ["/reports/some-report-id", "a desktop deep link with a param"],
    ["/setup/pairing", "a desktop-only nested setup route"],
  ])("redirects %s (%s) to /mobile/home instead of rendering the desktop app", async (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByText("MOBILE_HOME_STUB")).toBeInTheDocument();
  });
});
