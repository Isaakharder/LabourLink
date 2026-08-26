// Cold-start / offline-restore regression coverage for the mobile offline
// investigation: an already-paired device whose process was killed and
// reopened at a weak-signal spot used to show a name and an
// "offlineReconnecting" banner with NO action buttons at all until the
// first /api/mobile/me round trip finally landed. These tests prove the
// fix — restoreLocalSessionState populating `me`/`verified` from durable
// local storage BEFORE the network is ever awaited — end to end through
// WorkSessionProvider, using the same mocking conventions as
// WorkSessionContext.timeoutRetry.test.tsx / .performance.test.tsx.
// @vitest-environment jsdom
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
  logCheckpoint: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: mockApi };
});

// Stable function identities across renders — required here (unlike the
// other WorkSessionContext test files, which never call loadMe() enough
// times in one test to reveal it): applyMeResponse/loadMe's own useCallback
// deps include setServerReachable/refreshCachedEmployee, so a mock that
// mints a FRESH vi.fn() on every render (the real DevicePairingContext
// never does — its setters are useState setters / useCallback-wrapped)
// would give loadMe a new identity every render, re-firing its mount
// effect indefinitely. Stable mocks here match real-implementation
// behavior, not just test convenience.
const { mockSetServerReachable, mockRefreshCachedEmployee, mockMarkUnpaired } = vi.hoisted(() => ({
  mockSetServerReachable: vi.fn(),
  mockRefreshCachedEmployee: vi.fn(),
  mockMarkUnpaired: vi.fn(),
}));

vi.mock("../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({
    cachedEmployee: {
      employeeId: "emp-1",
      firstName: "Byron",
      lastName: "Escober",
      preferredLanguage: null,
      lastVerifiedAt: "2026-08-25T08:00:00.000Z",
    },
    markUnpaired: mockMarkUnpaired,
    serverReachable: true,
    setServerReachable: mockSetServerReachable,
    refreshCachedEmployee: mockRefreshCachedEmployee,
  }),
}));

import { WorkSessionProvider, useWorkSession, MeResponse } from "./WorkSessionContext";
import { setCachedEmployeeSummary } from "../lib/device";

function wrapper({ children }: { children: ReactNode }) {
  return <WorkSessionProvider>{children}</WorkSessionProvider>;
}

function idleMeResponse() {
  return {
    employee: { id: "emp-1", firstName: "Byron", lastName: "Escober", preferredLanguage: null, securityRole: "Employee" },
    status: "idle" as const,
    currentActivity: null,
    since: null,
    previousActivity: null,
    recentJobs: [],
  };
}

function workMeResponse(rowId: string) {
  return {
    employee: { id: "emp-1", firstName: "Byron", lastName: "Escober", preferredLanguage: null, securityRole: "Employee" },
    status: "work" as const,
    currentActivity: {
      id: "activity-winding",
      name: "Winding & Pruning",
      startedAt: "2026-08-25T09:00:00.000Z",
      accumulatedWorkedSecondsBeforeCurrentEntry: 0,
      minimumDurationMinutes: 0,
      row: { id: rowId, label: `Row ${rowId}` },
      carrier: null,
    },
    since: null,
    previousActivity: null,
    recentJobs: [],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockAppendEvent.mockReset();
  mockApi.mockReset().mockResolvedValue(idleMeResponse());
  mockGetPendingCount.mockReset().mockResolvedValue(0);
  mockGetPendingEvents.mockReset().mockResolvedValue([]);
  mockGetLatestWorkEvent.mockReset().mockResolvedValue(null);
  mockGetCachedJson.mockReset().mockResolvedValue(null);
  mockSetCachedJson.mockReset().mockResolvedValue(undefined);
  mockMarkSyncResult.mockReset().mockResolvedValue(undefined);
  mockGetSyncMeta.mockReset().mockResolvedValue({ lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null });
  mockSetSyncMeta.mockReset().mockResolvedValue(undefined);
});

describe("cold start / restart while offline", () => {
  it("start work, force-close, reopen offline: activity/row controls (verified=true) are available immediately, entirely from local storage, with /api/mobile/me never resolving", async () => {
    // Simulates the local event ledger already holding a work_start from
    // before the restart — exactly what a real SQLite/IndexedDB restart
    // would still have on disk.
    mockGetPendingEvents.mockResolvedValue([
      {
        clientEventId: "evt-work-1",
        deviceId: "dev-1",
        employeeId: "emp-1",
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: "2026-08-25T09:00:00.000Z",
        localTzOffsetMinutes: 0,
        activityId: "activity-winding",
        greenhouseRowId: "row-1",
        carrierId: null,
        answers: null,
        createdAtLocal: "2026-08-25T09:00:00.000Z",
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      },
    ]);
    // The one real permanently-hung call — exactly the reported "phone's
    // Wi-Fi appears off" moment: no response ever arrives.
    mockApi.mockImplementation((path: string) => (path === "/api/mobile/me" ? new Promise(() => {}) : Promise.resolve(idleMeResponse())));

    const { result } = renderHook(() => useWorkSession(), { wrapper });

    await waitFor(() => expect(result.current.verified).toBe(true));
    expect(result.current.me?.status).toBe("work");
    expect(result.current.me?.currentActivity?.row?.id).toBe("row-1");
    expect(result.current.busy).toBe(false);

    // The next row can be selected right now — local-first, no wait.
    mockAppendEvent.mockResolvedValueOnce({
      deviceId: "dev-1",
      employeeId: "emp-1",
      eventType: "activity_switch",
      occurredAtUtc: "2026-08-25T09:20:00.000Z",
      activityId: "activity-winding",
      greenhouseRowId: "row-2",
      clientEventId: "evt-row-2",
      deviceSeq: 2,
      localTzOffsetMinutes: 0,
      createdAtLocal: "2026-08-25T09:20:00.000Z",
      syncStatus: "pending",
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    });
    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", { activityId: "activity-winding", answers: {} });
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.me?.currentActivity?.row?.id).toBe("row-2");
  });

  it("restart offline while on break, with multiple pending events, restores the correct final status", async () => {
    mockGetPendingEvents.mockResolvedValue([
      {
        clientEventId: "evt-1",
        deviceId: "dev-1",
        employeeId: "emp-1",
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: "2026-08-25T09:00:00.000Z",
        localTzOffsetMinutes: 0,
        activityId: "activity-winding",
        greenhouseRowId: "row-1",
        carrierId: null,
        answers: null,
        createdAtLocal: "2026-08-25T09:00:00.000Z",
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      },
      {
        clientEventId: "evt-2",
        deviceId: "dev-1",
        employeeId: "emp-1",
        deviceSeq: 2,
        eventType: "break_start",
        occurredAtUtc: "2026-08-25T11:00:00.000Z",
        localTzOffsetMinutes: 0,
        activityId: null,
        greenhouseRowId: null,
        carrierId: null,
        answers: null,
        createdAtLocal: "2026-08-25T11:00:00.000Z",
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      },
    ]);
    mockApi.mockImplementation((path: string) => (path === "/api/mobile/me" ? new Promise(() => {}) : Promise.resolve(idleMeResponse())));

    const { result } = renderHook(() => useWorkSession(), { wrapper });

    await waitFor(() => expect(result.current.verified).toBe(true));
    expect(result.current.me?.status).toBe("break");
    // Restarting mid-break must never require re-reaching the server to
    // let the employee end break / resume work.
    expect(result.current.busy).toBe(false);
  });

  it("a permanently hanging /me request never blocks busy from clearing on a real action", async () => {
    mockApi.mockImplementation((path: string) => (path === "/api/mobile/me" ? new Promise(() => {}) : Promise.resolve(idleMeResponse())));
    mockAppendEvent.mockResolvedValue({
      deviceId: "dev-1",
      employeeId: "emp-1",
      eventType: "break_start",
      occurredAtUtc: "2026-08-25T09:00:00.000Z",
      clientEventId: "evt-1",
      deviceSeq: 1,
      localTzOffsetMinutes: 0,
      createdAtLocal: "2026-08-25T09:00:00.000Z",
      syncStatus: "pending",
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    });

    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/mobile/me"));

    await act(async () => {
      await result.current.startBreak();
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("a late /me response cannot overwrite a newer local row change (fold-on-arrival protects a still-pending event)", async () => {
    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.verified).toBe(true));

    const deferredMe = createDeferred<MeResponse>();
    let meCallCount = 0;
    mockApi.mockImplementation((path: string) => {
      if (path !== "/api/mobile/me") return Promise.resolve({ results: [] });
      meCallCount++;
      if (meCallCount === 1) return deferredMe.promise; // the slow, stale request
      return Promise.resolve(idleMeResponse());
    });

    act(() => {
      result.current.loadMe(); // fires the one call deferredMe answers
    });

    // While that request is still in flight, the employee selects the
    // next row entirely locally.
    const newRowEvent = {
      deviceId: "dev-1",
      employeeId: "emp-1",
      eventType: "activity_switch" as const,
      occurredAtUtc: "2026-08-25T09:20:00.000Z",
      activityId: "activity-winding",
      greenhouseRowId: "row-new",
      clientEventId: "evt-row-new",
      deviceSeq: 5,
      localTzOffsetMinutes: 0,
      createdAtLocal: "2026-08-25T09:20:00.000Z",
      syncStatus: "pending" as const,
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    };
    mockAppendEvent.mockResolvedValueOnce(newRowEvent);
    // The fold that runs when the stale response finally lands must see
    // this event as still pending — exactly what makes a real device safe
    // here (nothing has synced yet).
    mockGetPendingEvents.mockResolvedValue([newRowEvent]);

    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", { activityId: "activity-winding", answers: {} });
    });
    expect(result.current.me?.currentActivity?.row?.id).toBe("row-new");

    // Now the stale, pre-row-change response finally arrives.
    await act(async () => {
      deferredMe.resolve(workMeResponse("row-old"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.me?.currentActivity?.row?.id).toBe("row-new");
  });

  it("a late /me response cannot overwrite a newer local row change (out-of-order requests: a newer request's response always wins)", async () => {
    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.verified).toBe(true));

    const deferredOld = createDeferred<MeResponse>();
    const deferredNew = createDeferred<MeResponse>();
    let meCallCount = 0;
    mockApi.mockImplementation((path: string) => {
      if (path !== "/api/mobile/me") return Promise.resolve({ results: [] });
      meCallCount++;
      if (meCallCount === 1) return deferredOld.promise;
      if (meCallCount === 2) return deferredNew.promise;
      return Promise.resolve(idleMeResponse());
    });

    act(() => {
      result.current.loadMe(); // request A (older)
    });
    act(() => {
      result.current.loadMe(); // request B (newer) — issued after A, must always win
    });

    // B (the newer request) resolves first — the newer state is applied.
    await act(async () => {
      deferredNew.resolve(workMeResponse("row-from-newer-request"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.me?.currentActivity?.row?.id).toBe("row-from-newer-request");

    // A (older, now stale) resolves LATE — must be discarded entirely,
    // even though nothing is "pending" to fold-protect it here.
    await act(async () => {
      deferredOld.resolve(workMeResponse("row-from-stale-request"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.me?.currentActivity?.row?.id).toBe("row-from-newer-request");
  });
});

describe("reassignment protection is preserved by the cold-start restore path", () => {
  // applyMeResponse's detectReassignment compares against the REAL
  // lib/device.ts getCachedEmployeeSummary() (a separate, directly-imported
  // function — not the mocked useDevicePairing().cachedEmployee above), so
  // this scenario needs the real device-identity localStorage state
  // genuinely populated, same as an actually-paired phone would have it.
  beforeEach(() => {
    localStorage.clear();
    setCachedEmployeeSummary({
      employeeId: "emp-1",
      firstName: "Byron",
      lastName: "Escober",
      preferredLanguage: null,
      lastVerifiedAt: "2026-08-25T08:00:00.000Z",
    });
  });

  it("a reassignment-shaped /me response is held for review, never silently applied, and no pending local event is lost", async () => {
    // This device's own pending events belong to the CACHED employee
    // (emp-1) — a genuine local row change made before the server ever
    // reported the reassignment.
    const localRowChange = {
      clientEventId: "evt-local-row",
      deviceId: "dev-1",
      employeeId: "emp-1",
      deviceSeq: 1,
      eventType: "work_start" as const,
      occurredAtUtc: "2026-08-25T09:00:00.000Z",
      localTzOffsetMinutes: 0,
      activityId: "activity-a",
      greenhouseRowId: "row-1",
      carrierId: null,
      answers: null,
      createdAtLocal: "2026-08-25T09:00:00.000Z",
      syncStatus: "pending" as const,
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    };
    mockGetPendingEvents.mockResolvedValue([localRowChange]);

    // The server's /me now reports a DIFFERENT employee holding this
    // physical device — an admin reassigned it since the cached identity
    // was last verified.
    const reassignedResponse = {
      employee: { id: "emp-2", firstName: "Someone", lastName: "Else", preferredLanguage: null, securityRole: "Employee" },
      status: "idle" as const,
      currentActivity: null,
      since: null,
      previousActivity: null,
      recentJobs: [],
    };
    mockApi.mockImplementation((path: string) => (path === "/api/mobile/me" ? Promise.resolve(reassignedResponse) : Promise.resolve({ results: [] })));

    const { result } = renderHook(() => useWorkSession(), { wrapper });

    // Reviewable, not silently applied — the overlay's own job.
    await waitFor(() => expect(result.current.pendingReassignment).not.toBeNull());
    expect(result.current.pendingReassignment?.employee.id).toBe("emp-2");

    // The cached employee's own restored session (from local restore) is
    // untouched until acknowledged — still emp-1's in-progress work.
    expect(result.current.me?.employee.id).toBe("emp-1");
    expect(result.current.me?.status).toBe("work");

    // Nothing local was discarded by any of this.
    const lastResult = mockGetPendingEvents.mock.results[mockGetPendingEvents.mock.results.length - 1];
    const pending = await lastResult.value;
    expect(pending).toHaveLength(1);
    expect(pending[0].clientEventId).toBe("evt-local-row");
  });
});
