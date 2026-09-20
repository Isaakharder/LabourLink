// Safari stale-auth investigation: api() must tell AuthContext apart
// exactly two kinds of 401 —
//   1. "the desktop session actually died" (requireAuth rejecting with no
//      `code` — see server/src/middleware/auth.ts) — this is the one that
//      should clear the stale cached identity and bounce to /login.
//   2. everything else that happens to be a 401: /api/auth/login rejecting
//      bad credentials, /api/auth/me's routine "not logged in yet" check on
//      a plain unauthenticated page load, and any coded (device-auth-style)
//      401 — none of these mean "you were signed in and now aren't," and
//      must never trigger the global bounce-to-login handling.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, onSessionExpired } from "./api";

const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("onSessionExpired", () => {
  it("fires for a bare 401 (no code) from an ordinary protected route", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: "Session expired or invalid" })
    ) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onSessionExpired((message) => received.push(message));
    try {
      await expect(api("/api/inputs/daily?employeeId=e1&date=2026-01-01")).rejects.toThrow();
      expect(received).toEqual(["Session expired or invalid"]);
    } finally {
      unsubscribe();
    }
  });

  it("does not fire for /api/auth/login's own 401 (bad credentials, handled locally by the login form)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: "Invalid email or PIN" })
    ) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onSessionExpired((message) => received.push(message));
    try {
      await expect(api("/api/auth/login", { method: "POST", body: "{}" })).rejects.toThrow();
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("does not fire for /api/auth/me's bootstrap 401 (plain unauthenticated page load, never logged in)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: "Not authenticated" })
    ) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onSessionExpired((message) => received.push(message));
    try {
      await expect(api("/api/auth/me")).rejects.toThrow();
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("does not fire for a coded 401 (device-auth style — a different rejection entirely)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: "This device has been deactivated.", code: "DEVICE_INACTIVE" })
    ) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onSessionExpired((message) => received.push(message));
    try {
      await expect(api("/api/mobile/me")).rejects.toThrow();
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("never fires for a successful response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onSessionExpired((message) => received.push(message));
    try {
      await api("/api/inputs/daily?employeeId=e1&date=2026-01-01");
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("stops notifying after unsubscribe", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: "Session expired or invalid" })
    ) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onSessionExpired((message) => received.push(message));
    unsubscribe();
    await expect(api("/api/inputs/daily?employeeId=e1&date=2026-01-01")).rejects.toThrow();
    expect(received).toEqual([]);
  });
});
