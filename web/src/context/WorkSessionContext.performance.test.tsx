// @vitest-environment jsdom
// Stage 6 performance proof: "a 5-second simulated network latency must
// still leave the local screen transition under 250ms" — the core promise
// of the local-first redesign (see WorkSessionContext.tsx's own header
// comment: durable local write -> immediate UI update -> UNAWAITED
// background sync). This test makes the server (both /api/mobile/me and
// /api/mobile/sync/events) deliberately take 5 real seconds to respond,
// then measures how long commitLocalEvent's own promise (perform/
// startBreak/endBreak/confirmEndDay all funnel through it) takes to
// resolve — proving it's the LOCAL write, not the network round trip,
// that determines when control returns to the UI.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

const {
  mockAppendEvent,
  mockApi,
  mockGetPendingCount,
  mockGetPendingEvents,
  mockGetLatestWorkEvent,
  mockGetCachedJson,
  mockSetCachedJson,
  mockMarkSyncResult,
  mockGetSyncMeta,
  mockSetSyncMeta,
} = vi.hoisted(() => ({
  mockAppendEvent: vi.fn(),
  mockApi: vi.fn(),
  mockGetPendingCount: vi.fn(),
  mockGetPendingEvents: vi.fn(),
  mockGetLatestWorkEvent: vi.fn(),
  mockGetCachedJson: vi.fn(),
  mockSetCachedJson: vi.fn(),
  mockMarkSyncResult: vi.fn(),
  mockGetSyncMeta: vi.fn(),
  mockSetSyncMeta: vi.fn(),
}));

vi.mock("../lib/localEventStore", () => ({
  getLocalEventStore: () => ({
    appendEvent: mockAppendEvent,
    getPendingCount: mockGetPendingCount,
    getPendingEvents: mockGetPendingEvents,
    getLatestWorkEventForDevice: mockGetLatestWorkEvent,
    markSyncResult: mockMarkSyncResult,
    getSyncMeta: mockGetSyncMeta,
    setSyncMeta: mockSetSyncMeta,
    getCachedJson: mockGetCachedJson,
    setCachedJson: mockSetCachedJson,
  }),
  // A real (module-level, not per-store-instance) named export as of the
  // timestamped-checkpoint instrumentation added alongside the bounded
  // local-commit timeout — WorkSessionContext.tsx calls this directly, so
  // the mock needs to provide it too, even though this test doesn't
  // assert on its output.
  logCheckpoint: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: mockApi };
});

vi.mock("../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({
    cachedEmployee: { employeeId: "emp-1", firstName: "QA", lastName: "Performance", preferredLanguage: null, lastVerifiedAt: "2026-01-01T00:00:00.000Z" },
    markUnpaired: vi.fn(),
    serverReachable: true,
    setServerReachable: vi.fn(),
    refreshCachedEmployee: vi.fn(),
  }),
}));

// Imported after the mocks above so the real WorkSessionContext.tsx module
// (the actual commitLocalEvent/perform/startBreak implementation under
// test) resolves its own imports against the mocked versions.
import { WorkSessionProvider, useWorkSession } from "./WorkSessionContext";

const NETWORK_DELAY_MS = 5000;
const LOCAL_TRANSITION_BUDGET_MS = 250;

function delayedResolve<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

beforeEach(() => {
  mockAppendEvent.mockReset();
  mockApi.mockReset();
  mockGetPendingCount.mockReset().mockResolvedValue(1);
  // A non-empty pending queue — so syncEngine.ts's runSync() actually
  // attempts the (deliberately 5-second-delayed) POST /api/mobile/sync/
  // events call below, rather than seeing an empty queue and skipping the
  // network entirely. That's what proves this test's real point: even
  // when a sync genuinely fires, commitLocalEvent's own promise doesn't
  // wait for it.
  mockGetPendingEvents.mockReset().mockResolvedValue([
    {
      clientEventId: "evt-1",
      deviceId: "dev-1",
      employeeId: "emp-1",
      deviceSeq: 1,
      eventType: "break_start",
      occurredAtUtc: new Date().toISOString(),
      localTzOffsetMinutes: 0,
      activityId: null,
      greenhouseRowId: null,
      carrierId: null,
      answers: null,
      createdAtLocal: new Date().toISOString(),
      syncStatus: "pending",
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    },
  ]);
  mockGetLatestWorkEvent.mockReset().mockResolvedValue(null);
  mockGetCachedJson.mockReset().mockResolvedValue(null);
  mockSetCachedJson.mockReset().mockResolvedValue(undefined);
  mockMarkSyncResult.mockReset().mockResolvedValue(undefined);
  mockGetSyncMeta.mockReset().mockResolvedValue({ lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null });
  mockSetSyncMeta.mockReset().mockResolvedValue(undefined);

  // GET /api/mobile/me (the mount-time reconciliation) and POST
  // /api/mobile/sync/events (syncEngine.ts's own background submit) BOTH
  // take a real 5 seconds — everything a slow/high-latency connection
  // would delay, deliberately made as slow as the spec's own worst case.
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/mobile/me") {
      return delayedResolve(
        { employee: { id: "emp-1", firstName: "QA", lastName: "Performance", preferredLanguage: null, securityRole: "Employee" }, status: "idle", currentActivity: null, since: null, previousActivity: null, recentJobs: [] },
        NETWORK_DELAY_MS
      );
    }
    if (path === "/api/mobile/sync/events") {
      return delayedResolve({ results: [] }, NETWORK_DELAY_MS);
    }
    return Promise.reject(new Error(`unexpected path in performance test: ${path}`));
  });

  // The durable local write itself — real measurements elsewhere in this
  // project (native SQLite, real Android device) landed around 50ms; a
  // small fixed delay here stands in for that without needing the real
  // native plugin under vitest.
  mockAppendEvent.mockImplementation((event: Record<string, unknown>) =>
    delayedResolve(
      {
        ...event,
        clientEventId: "evt-1",
        deviceSeq: 1,
        localTzOffsetMinutes: 0,
        createdAtLocal: new Date().toISOString(),
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      },
      10
    )
  );
});

function wrapper({ children }: { children: ReactNode }) {
  return <WorkSessionProvider>{children}</WorkSessionProvider>;
}

describe("commitLocalEvent performance under simulated 5-second network latency", () => {
  it("startBreak's promise resolves in well under 250ms, never waiting on the (5-second) network", async () => {
    const { result } = renderHook(() => useWorkSession(), { wrapper });

    // Let the mount-time loadMe() kick off (it's in flight against the
    // 5-second-delayed mock — deliberately NOT awaited here, since a real
    // employee wouldn't wait for it either before the local-first UI is
    // interactive).
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/mobile/me"));

    const t0 = performance.now();
    await act(async () => {
      await result.current.startBreak();
    });
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(LOCAL_TRANSITION_BUDGET_MS);
    // Proves it's genuinely the LOCAL write path, not a mock returning
    // instantly by accident — appendEvent really was called.
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
    // And the slow sync call was fired (fire-and-forget) but its 5-second
    // resolution is NOT what the elapsed time above measured.
    expect(mockApi).toHaveBeenCalledWith("/api/mobile/sync/events", expect.anything());
  }, 10000);

  it("perform() (activity start/switch) is equally fast under the same 5-second network delay", async () => {
    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/mobile/me"));

    const t0 = performance.now();
    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", { activityId: "act-1", answers: {} });
    });
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(LOCAL_TRANSITION_BUDGET_MS);
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
  }, 10000);
});
