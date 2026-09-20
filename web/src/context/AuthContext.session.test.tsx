// The actual fix for the Safari stale-auth investigation: once any api()
// call reports the desktop session is dead (see api.sessionExpired.test.ts
// for exactly which 401s count), AuthContext must clear the stale cached
// employee and surface an explanatory message — instead of the previous
// behavior, where `employee` stayed populated (still showing e.g. "Isaak
// Harder" in the sidebar) while individual pages independently discovered
// they had no session and got stuck (Inputs' "Reconnecting…", never
// resolving). Uses the real api.ts (mocked fetch), not a mocked api module,
// so this proves the real wiring between api()'s notifier and AuthContext's
// subscription end to end.
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import { api } from "../lib/api";

const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function TestConsumer() {
  const { employee, loading, sessionExpiredMessage } = useAuth();
  if (loading) return <p>Loading...</p>;
  if (!employee) {
    return (
      <div>
        <p>Logged out</p>
        {sessionExpiredMessage && <p role="alert">Your session expired — please sign in again.</p>}
      </div>
    );
  }
  return <p>Signed in as {employee.firstName} {employee.lastName}</p>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe("AuthContext — stale-auth recovery", () => {
  it("clears the signed-in identity and shows a session-expired message when a later request 401s", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        employee: { id: "emp-1", firstName: "Isaak", lastName: "Harder", securityRole: "Administrator", teamRole: "Team Member" },
      })
    ) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await screen.findByText("Signed in as Isaak Harder");

    // A later page (e.g. Inputs' daily poll) makes its own api() call, which
    // the server rejects because the session died — same as what happens
    // when a cookie never actually got stored (the cross-site/ITP case) or
    // the 12h JWT genuinely expired mid-use.
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: "Session expired or invalid" })
    ) as unknown as typeof fetch;

    await act(async () => {
      await api("/api/inputs/daily?employeeId=emp-1&date=2026-01-01").catch(() => {});
    });

    await waitFor(() => {
      expect(screen.getByText("Logged out")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Your session expired — please sign in again.");
  });

  it("does not show a session-expired message on a plain, never-logged-in page load", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: "Not authenticated" })
    ) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await screen.findByText("Logged out");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
