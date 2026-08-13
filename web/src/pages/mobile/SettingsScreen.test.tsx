// @vitest-environment jsdom
//
// Covers the mobile-browser Settings fix: the compact top-down layout (not
// the old .pairing-screen-style vertically-centered one), a Back button that
// uses app navigation (a React Router Link, never browser history) to
// return to Home, and — the actual bug — NFC-only admin tools (Register
// Existing Tag / Write New Tag / NFC Diagnostic) hidden whenever
// Capacitor.isNativePlatform() is false, regardless of the signed-in
// employee's role. @capacitor/core is mocked directly (not lib/platform) so
// these tests exercise the real isNativePlatform() -> Capacitor.
// isNativePlatform() call chain, not a stand-in for it. Same
// React-Testing-Library + per-module vi.mock() convention as
// InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "fs";
import { resolve } from "path";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen";

let mockIsNative = false;
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mockIsNative,
  },
}));

vi.mock("../../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({ cachedEmployee: { firstName: "Jane", lastName: "Doe" } }),
}));

vi.mock("../../context/MessagesContext", () => ({
  useMessages: () => ({ refresh: vi.fn() }),
}));

let mockSecurityRole = "Employee";
vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({
    online: true,
    pending: 0,
    flush: vi.fn(),
    me: { employee: { securityRole: mockSecurityRole } },
  }),
}));

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/mobile/settings"]}>
      <Routes>
        <Route path="/mobile/settings" element={<SettingsScreen />} />
        <Route path="/mobile/home" element={<div>Home Screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockIsNative = false;
  mockSecurityRole = "Employee";
});

afterEach(() => {
  cleanup();
});

describe("SettingsScreen — compact layout and header", () => {
  it("renders a header with the Settings title and a visible, labeled Back control", () => {
    renderSettings();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toBeInTheDocument();
  });

  it("puts the header at the top of .mobile-settings, inside the safe-area-aware content container", () => {
    const { container } = renderSettings();
    const root = container.querySelector(".mobile-settings");
    expect(root).not.toBeNull();
    // The header must be the very first thing rendered — nothing (e.g. a
    // leftover bare <h1>) sits above it, and it uses the classes
    // index.css's compact-layout/safe-area rules actually target.
    expect(root!.firstElementChild).toHaveClass("mobile-settings-header");
    expect(root!.querySelector(".mobile-settings-header .mobile-settings-back")).not.toBeNull();
  });

  it("still shows ordinary browser-supported settings (Notifications, Sync) regardless of platform", () => {
    mockIsNative = false;
    renderSettings();
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sync" })).toBeInTheDocument();
  });
});

describe("SettingsScreen — Back button navigation", () => {
  it("returns to Home via app routing (a Link to /mobile/home), not window.history", async () => {
    const user = userEvent.setup();
    renderSettings();
    const back = screen.getByRole("link", { name: /back to home/i });
    // Real app navigation, not a history pop: an <a>/Link with a fixed,
    // known destination — never `javascript:history.back()` or similar,
    // which could just as easily leave LabourLink entirely.
    expect(back).toHaveAttribute("href", "/mobile/home");
    await user.click(back);
    expect(screen.getByText("Home Screen")).toBeInTheDocument();
  });
});

describe("SettingsScreen — NFC admin tools gated on Capacitor.isNativePlatform()", () => {
  it("hides all NFC-only options in a mobile browser, even for an Administrator", () => {
    mockIsNative = false;
    mockSecurityRole = "Administrator";
    renderSettings();
    expect(screen.queryByText("Register Existing Tag")).not.toBeInTheDocument();
    expect(screen.queryByText("Write New Tag")).not.toBeInTheDocument();
    expect(screen.queryByText("NFC Diagnostic")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Admin Mode" })).not.toBeInTheDocument();
  });

  it("hides all NFC-only options in a mobile browser for a Manager too", () => {
    mockIsNative = false;
    mockSecurityRole = "Manager";
    renderSettings();
    expect(screen.queryByText("Register Existing Tag")).not.toBeInTheDocument();
    expect(screen.queryByText("Write New Tag")).not.toBeInTheDocument();
    expect(screen.queryByText("NFC Diagnostic")).not.toBeInTheDocument();
  });

  it("shows all three NFC options for an Administrator on native (Android) Capacitor", () => {
    mockIsNative = true;
    mockSecurityRole = "Administrator";
    renderSettings();
    expect(screen.getByText("Register Existing Tag")).toBeInTheDocument();
    expect(screen.getByText("Write New Tag")).toBeInTheDocument();
    expect(screen.getByText("NFC Diagnostic")).toBeInTheDocument();
  });

  it("shows the NFC options for a Manager on native Capacitor too — the role gate, not just the platform gate", () => {
    mockIsNative = true;
    mockSecurityRole = "Manager";
    renderSettings();
    expect(screen.getByText("Register Existing Tag")).toBeInTheDocument();
  });

  it("hides NFC options on native Capacitor for a non-admin Employee — the platform gate isn't the only one", () => {
    mockIsNative = true;
    mockSecurityRole = "Employee";
    renderSettings();
    expect(screen.queryByText("Register Existing Tag")).not.toBeInTheDocument();
    expect(screen.queryByText("Write New Tag")).not.toBeInTheDocument();
    expect(screen.queryByText("NFC Diagnostic")).not.toBeInTheDocument();
  });
});

// jsdom doesn't compute real layout/env(safe-area-inset-*), so the
// meaningful check here is at the CSS source level: the exact regression
// this bug report was about (the safe-area-inset-top padding on
// .mobile-content/.message-overlay only applying under a .platform-android
// ancestor class that iOS Safari/PWA never gets — see index.css and
// main.tsx) must not come back. Confirmed manually against a real build's
// response headers/rendering as well; this is the regression guard.
describe("index.css — safe-area-inset-top applies without a native-only gate", () => {
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  it("no longer scopes .mobile-content's safe-area padding behind .platform-android", () => {
    expect(css).not.toMatch(/\.platform-android\s+\.mobile-content/);
  });

  it("no longer scopes .message-overlay's safe-area padding behind .platform-android", () => {
    expect(css).not.toMatch(/\.platform-android\s+\.message-overlay/);
  });

  it("still applies env(safe-area-inset-top) to .mobile-content unconditionally", () => {
    const rules = css.match(/\.mobile-content\s*\{[^}]*\}/g) ?? [];
    expect(rules.some((rule) => rule.includes("env(safe-area-inset-top"))).toBe(true);
  });

  it("still applies env(safe-area-inset-top) to .message-overlay unconditionally", () => {
    // .message-overlay has more than one rule block (this safe-area one
    // plus its base positioning rule elsewhere) — checking that at least
    // one unscoped block carries it, rather than assuming which one comes
    // first in the file, is what actually matches the previous test's
    // guarantee that neither remaining block is .platform-android-gated.
    const rules = css.match(/\.message-overlay\s*\{[^}]*\}/g) ?? [];
    expect(rules.some((rule) => rule.includes("env(safe-area-inset-top"))).toBe(true);
  });
});
