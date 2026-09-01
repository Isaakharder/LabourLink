// @vitest-environment jsdom
//
// Confirms Stats' offline behavior explicitly (see localMidnightRollover
// work): Stats has no local-first computation of its own — it is entirely
// server-driven (loadStats -> GET /api/mobile/stats) — so opening it
// offline must never show misleading numbers. Two honest states instead:
// never-loaded-yet (offline, nothing to show) and stale-but-labeled
// (offline, showing what was last successfully loaded). Same
// vi.mock()-per-module + deferred-promise convention as DashboardPage.test.tsx.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatsScreen } from "./StatsScreen";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let online = true;
let handleApiErrorReturn = false;
let statsDeferred: Deferred<{ weeks: unknown[] }>;

vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({
    language: "en",
    online,
    handleApiError: () => handleApiErrorReturn,
  }),
}));

vi.mock("../../lib/api", () => ({
  api: vi.fn(() => statsDeferred.promise),
}));

function renderStats() {
  return render(
    <MemoryRouter initialEntries={["/mobile/stats"]}>
      <StatsScreen />
    </MemoryRouter>
  );
}

beforeEach(() => {
  online = true;
  handleApiErrorReturn = false;
  statsDeferred = createDeferred();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StatsScreen — offline behavior", () => {
  it("offline, never loaded: shows a clear offline message, never an indefinite unlabeled spinner", async () => {
    online = false;
    handleApiErrorReturn = true; // handleApiError's own network-unreachable case
    renderStats();
    await act(async () => {
      statsDeferred.reject(new Error("network unreachable"));
    });
    expect(await screen.findByText(/stats aren't available yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("online, still loading: shows the ordinary loading state (not the offline message)", () => {
    renderStats();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/stats aren't available yet/i)).not.toBeInTheDocument();
  });

  it("loaded successfully, then goes offline: keeps showing the data, labeled as possibly stale — never silently presented as current", async () => {
    renderStats();
    await act(async () => {
      statsDeferred.resolve({
        weeks: [{ offset: 0, weekStart: "2026-08-31", weekEnd: "2026-09-06", activities: [] }],
      });
    });
    await waitFor(() => expect(screen.getByText("This Week")).toBeInTheDocument());
    expect(screen.queryByText(/may not include today yet/i)).not.toBeInTheDocument();
    cleanup();

    online = false;
    // Same already-settled deferred (a resolved promise resolves again
    // immediately) — this render represents the end state "was loaded,
    // is now offline," not a live transition mid-session.
    renderStats();
    await waitFor(() => expect(screen.getByText("This Week")).toBeInTheDocument());
    expect(screen.getByText(/may not include today yet/i)).toBeInTheDocument();
  });

  it("a genuine, non-network error is shown as-is, never mistaken for offline", async () => {
    handleApiErrorReturn = false;
    renderStats();
    await act(async () => {
      statsDeferred.reject(new Error("boom"));
    });
    expect(await screen.findByText("Could not load stats")).toBeInTheDocument();
    expect(screen.queryByText(/stats aren't available yet/i)).not.toBeInTheDocument();
  });
});
