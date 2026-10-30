// Desktop sign-in lifetime, client side. The server keeps a sign-in alive in
// httpOnly cookies and renews it silently (server/src/routes/
// auth.webSessions.test.ts covers expiry, renewal, revocation and the
// 7-day+ lifetime with time advancement); what this file proves is that the
// web app never turns "couldn't reach the server" into "signed out", that a
// deliberate sign-out sticks even offline and across a reload, and that
// tabs follow each other. Uses the real api.ts against a fake server behind
// a mocked fetch, and fake timers for the reconnect backoff.
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AUTH_EVENT_KEY, AuthProvider, RECONNECT_DELAYS_MS, SIGN_OUT_PENDING_KEY, useAuth } from "./AuthContext";
import { api } from "../lib/api";
import App from "../App";

const originalFetch = global.fetch;

const MANAGER = { id: "emp-1", firstName: "Isaak", lastName: "Harder", securityRole: "Manager", teamRole: "Team Member" };

// The server as the browser sees it: the cookie jar is the server's session
// state here, since the client can't read httpOnly cookies anyway.
const server = {
  online: true,
  failing503: false,
  sessionValid: true,
  logoutCalls: 0,
  meCalls: 0,
  holdMe: null as null | Promise<void>,
};

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input), "http://office.local").pathname;
  if (!server.online) throw new TypeError("Failed to fetch");
  if (server.failing503) return json(503, { error: "Service temporarily unavailable" });
  if (path === "/api/auth/me") {
    server.meCalls++;
    if (server.holdMe) await server.holdMe;
    return server.sessionValid ? json(200, { employee: MANAGER }) : json(401, { error: "Session expired or invalid" });
  }
  if (path === "/api/auth/logout") {
    server.logoutCalls++;
    server.sessionValid = false;
    return { ok: true, status: 204, json: async () => undefined } as Response;
  }
  if (path === "/api/auth/login") {
    server.sessionValid = true;
    return json(200, { employee: MANAGER });
  }
  if (path.startsWith("/api/")) {
    return server.sessionValid ? json(200, {}) : json(401, { error: "Session expired or invalid" });
  }
  throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
}

function Consumer() {
  const { employee, loading, reconnecting, sessionExpiredMessage, logout, login } = useAuth();
  if (loading) return <p>{reconnecting ? "Reconnecting" : "Loading"}</p>;
  if (!employee) {
    return (
      <div>
        <p>Login screen</p>
        {sessionExpiredMessage && <p role="alert">{sessionExpiredMessage}</p>}
        <button onClick={() => void login("isaak@example.com", "1234")}>Sign in</button>
      </div>
    );
  }
  return (
    <div>
      <p>
        Signed in as {employee.firstName} {employee.lastName} ({employee.securityRole})
      </p>
      <button onClick={() => void logout()}>Sign out</button>
    </div>
  );
}

// One "browser tab": a fresh AuthProvider, as after a reload or relaunch.
function openTab() {
  return render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.assign(server, { online: true, failing503: false, sessionValid: true, logoutCalls: 0, meCalls: 0, holdMe: null });
  global.fetch = vi.fn(fakeFetch) as unknown as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  global.fetch = originalFetch;
});

describe("AuthContext — staying signed in", () => {
  it("restores the same employee and role after a browser restart", async () => {
    const first = openTab();
    await flush();
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
    first.unmount();

    // The next morning, a fresh page load: the server renews from the
    // persisted refresh cookie and /me answers.
    openTab();
    await flush();
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
  });

  it("shows Loading, not the login screen, while the session check is still in flight", async () => {
    let release!: () => void;
    server.holdMe = new Promise<void>((r) => (release = r));
    openTab();
    await flush();
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
    release();
    await flush();
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
  });

  it("starting offline (overnight network loss) reconnects instead of showing the login screen", async () => {
    server.online = false;
    openTab();
    await flush();
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();

    // Hours of backoff retries while still offline: never the login screen.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]);
      });
    }
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();

    // Connectivity returns: restored at once, without waiting out the backoff.
    server.online = true;
    const callsBefore = server.meCalls;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(server.meCalls).toBe(callsBefore + 1);
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
  });

  it("retries on its own (time-advanced) when no online event arrives", async () => {
    server.online = false;
    openTab();
    await flush();
    server.online = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    });
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
  });

  it("a server that can't renew right now (503) is retried, not treated as signed out", async () => {
    server.failing503 = true;
    openTab();
    await flush();
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
    server.failing503 = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    });
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
  });

  it("a 503 mid-use does not sign the user out", async () => {
    openTab();
    await flush();
    server.failing503 = true;
    await act(async () => {
      await api("/api/inputs/daily?employeeId=emp-1&date=2026-10-30").catch(() => {});
    });
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
  });

  it("the real app shows the reconnecting message, not the login form, when it starts offline", async () => {
    server.online = false;
    // A desktop-width window (useIsMobile -> false), so the office app renders.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }))
    );
    render(
      <MemoryRouter initialEntries={["/inputs"]}>
        <App />
      </MemoryRouter>
    );
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Can’t reach LabourLink. Reconnecting automatically…");
    expect(screen.queryByLabelText(/PIN/i)).not.toBeInTheDocument();
  });
});

describe("AuthContext — ending a sign-in", () => {
  it("a revoked or invalid session shows the login screen", async () => {
    server.sessionValid = false;
    openTab();
    await flush();
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    // A plain signed-out start, not "your session expired".
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a session revoked mid-use (renewal refused -> 401) signs out with an explanation", async () => {
    openTab();
    await flush();
    server.sessionValid = false;
    await act(async () => {
      await api("/api/inputs/daily?employeeId=emp-1&date=2026-10-30").catch(() => {});
    });
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Session expired or invalid");
  });

  it("Sign out removes the local session immediately and revokes it on the server", async () => {
    openTab();
    await flush();
    await act(async () => {
      screen.getByText("Sign out").click();
    });
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    await flush();
    expect(server.logoutCalls).toBe(1);
    expect(localStorage.getItem(SIGN_OUT_PENDING_KEY)).toBeNull();
  });

  it("Sign out while offline still signs out at once, survives a reload, and is finished when back online", async () => {
    const tab = openTab();
    await flush();
    server.online = false;
    await act(async () => {
      screen.getByText("Sign out").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(localStorage.getItem(SIGN_OUT_PENDING_KEY)).toBe("1");
    tab.unmount();

    // Reload while the server still considers the session valid (the
    // revoke never reached it): must NOT come back signed in.
    server.online = true;
    server.sessionValid = true;
    const meBefore = server.meCalls;
    openTab();
    await flush();
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(server.meCalls).toBe(meBefore);
    expect(server.logoutCalls).toBe(1);
    expect(server.sessionValid).toBe(false);
    expect(localStorage.getItem(SIGN_OUT_PENDING_KEY)).toBeNull();
  });

  it("a pending offline sign-out is sent as soon as the connection returns", async () => {
    openTab();
    await flush();
    server.online = false;
    await act(async () => {
      screen.getByText("Sign out").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    server.online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(server.logoutCalls).toBe(1);
    expect(localStorage.getItem(SIGN_OUT_PENDING_KEY)).toBeNull();
  });
});

describe("AuthContext — multiple tabs", () => {
  function fromOtherTab(type: "signed-in" | "signed-out") {
    const value = JSON.stringify({ type, at: Date.now() });
    localStorage.setItem(AUTH_EVENT_KEY, value);
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_EVENT_KEY, newValue: value }));
  }

  it("signing out in another tab signs this tab out", async () => {
    openTab();
    await flush();
    server.sessionValid = false;
    await act(async () => {
      fromOtherTab("signed-out");
    });
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("signing in in another tab signs this tab in without a PIN", async () => {
    server.sessionValid = false;
    openTab();
    await flush();
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    server.sessionValid = true;
    await act(async () => {
      fromOtherTab("signed-in");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Signed in as Isaak Harder (Manager)")).toBeInTheDocument();
  });

  it("two tabs open at once both stay signed in", async () => {
    openTab();
    openTab();
    await flush();
    expect(screen.getAllByText("Signed in as Isaak Harder (Manager)")).toHaveLength(2);
  });
});
