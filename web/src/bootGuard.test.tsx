// Startup white-screen regressions (Khen Lagto / Jhang Jhang Ulefone phones,
// 2026-10-01): the app must never be left on a blank page. Covers
// public/boot-guard.js (pre-React), AppErrorBoundary (render crash), and
// DevicePairingContext's identity-recovery bound — and that every Retry is
// a plain reload that leaves identity and pending offline work alone.
// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BOOT_GUARD_SOURCE = readFileSync(resolve(__dirname, "../public/boot-guard.js"), "utf8");
const INDEX_HTML = readFileSync(resolve(__dirname, "../index.html"), "utf8");

type Guard = { booted: boolean; failed: boolean; code: string | null; timeoutMs: number; markBooted: () => void };

function installGuard(): Guard {
  delete (window as unknown as { __llBootGuard?: unknown }).__llBootGuard;
  document.body.innerHTML = '<div id="root"><div class="boot-screen" role="status"><p>Loading LabourLink…</p></div></div>';
  // Indirect eval runs it as a classic global script, like the real <script> tag.
  (0, eval)(BOOT_GUARD_SOURCE);
  return (window as unknown as { __llBootGuard: Guard }).__llBootGuard;
}

function stubReload() {
  const reload = vi.fn();
  Object.defineProperty(window, "location", { value: { ...window.location, reload }, configurable: true, writable: true });
  return reload;
}

const originalLocation = window.location;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true });
});

describe("index.html", () => {
  it("paints a loading screen before any script runs, and loads the guard before the app bundle", () => {
    expect(INDEX_HTML).toMatch(/<div id="root">\s*<div class="boot-screen"/);
    expect(INDEX_HTML.indexOf('src="/boot-guard.js"')).toBeGreaterThan(-1);
    expect(INDEX_HTML.indexOf('src="/boot-guard.js"')).toBeLessThan(INDEX_HTML.indexOf('src="/src/main.tsx"'));
  });
});

describe("boot-guard.js", () => {
  it("replaces a stalled startup with a Retry screen instead of staying blank", () => {
    const guard = installGuard();
    vi.advanceTimersByTime(guard.timeoutMs);
    expect(guard.failed).toBe(true);
    expect(document.getElementById("root")!.textContent).toContain("LabourLink couldn’t start");
    expect(document.getElementById("root")!.textContent).toContain("Code: TIMEOUT");
    expect(document.getElementById("boot-retry")).not.toBeNull();
  });

  it("stands down once React signals a successful mount", () => {
    const guard = installGuard();
    guard.markBooted();
    vi.advanceTimersByTime(guard.timeoutMs * 2);
    expect(guard.failed).toBe(false);
    expect(document.getElementById("root")!.textContent).toContain("Loading LabourLink");
  });

  it("shows the error screen immediately when the app bundle fails to load", () => {
    const guard = installGuard();
    const script = document.createElement("script");
    document.body.appendChild(script);
    script.dispatchEvent(new Event("error"));
    expect(guard.code).toBe("SCRIPT");
  });

  it("ignores an unrelated <img> load error", () => {
    const guard = installGuard();
    const img = document.createElement("img");
    document.body.appendChild(img);
    img.dispatchEvent(new Event("error"));
    expect(guard.failed).toBe(false);
  });

  it("shows only an error category for an exception, never its message", () => {
    const guard = installGuard();
    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("secret device 8fc5ddc4 detail"), message: "x" }));
    expect(guard.code).toBe("JS-TypeError");
    expect(document.body.textContent).not.toContain("8fc5ddc4");
  });

  it("Retry only reloads — paired identity and pending work in storage are untouched", () => {
    localStorage.setItem("labourlink_device_identifier", "keep-me");
    localStorage.setItem("labourlink_device_paired", "true");
    const reload = stubReload();
    const guard = installGuard();
    vi.advanceTimersByTime(guard.timeoutMs);
    document.getElementById("boot-retry")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("labourlink_device_identifier")).toBe("keep-me");
    expect(localStorage.getItem("labourlink_device_paired")).toBe("true");
  });
});

describe("AppErrorBoundary", () => {
  it("shows a Retry screen instead of a blank page when rendering throws", async () => {
    const { AppErrorBoundary } = await import("./components/AppErrorBoundary");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = stubReload();
    function Boom(): never {
      throw new RangeError("boom with private detail");
    }
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    );
    expect(screen.getByText("LabourLink couldn’t start")).toBeTruthy();
    expect(screen.getByText(/Code: RENDER-RangeError-/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("private detail");
    screen.getByText("Retry").click();
    expect(reload).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("DevicePairingContext identity recovery", () => {
  it("a hung recovery ends on a Retry screen — never the pairing screen, which would mint a new identity", async () => {
    vi.resetModules();
    vi.doMock("./lib/device", async () => {
      const actual = await vi.importActual<typeof import("./lib/device")>("./lib/device");
      return { ...actual, recoverDeviceIdentityFromBackup: () => new Promise<void>(() => {}) };
    });
    const { DevicePairingProvider, useDevicePairing, IDENTITY_RECOVERY_TIMEOUT_MS } = await import(
      "./context/DevicePairingContext"
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    function Status() {
      return <p>status={useDevicePairing().status}</p>;
    }
    render(
      <DevicePairingProvider>
        <Status />
      </DevicePairingProvider>
    );
    expect(screen.getByText("status=checking")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(IDENTITY_RECOVERY_TIMEOUT_MS);
    });
    expect(screen.getByText("status=recoveryFailed")).toBeTruthy();
    consoleError.mockRestore();
    vi.doUnmock("./lib/device");
  });
});
