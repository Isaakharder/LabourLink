// Regression test for the exact reported production incident: tapping
// "General" on iOS Safari's PWA left the job sheet open, every option
// gray, and the UI never recovered. Simulates the underlying local store
// hanging indefinitely (the real root cause — see WorkSessionContext.tsx's
// commitLocalEvent comment and localEventStore.ts's header) and proves:
// (1) perform() still settles within the bounded timeout instead of
// hanging forever, (2) busy clears via the try/finally that a genuine
// hang would otherwise defeat, (3) a retry-eligible error and retry
// action are surfaced, (4) retrying reuses the EXACT SAME clientEventId
// (idempotency key) rather than minting a fresh one, so the underlying
// store — proven durable/dedup-safe by localEventStore.test.ts and
// webEventJournal.test.ts — can never end up with two events for one tap.
// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

const { mockAppendEvent, mockApi, mockGetPendingCount, mockGetPendingEvents, mockGetCachedJson, mockMarkSyncResult, mockGetSyncMeta, mockSetSyncMeta } =
  vi.hoisted(() => ({
    mockAppendEvent: vi.fn(),
    mockApi: vi.fn(),
    mockGetPendingCount: vi.fn(),
    mockGetPendingEvents: vi.fn(),
    mockGetCachedJson: vi.fn(),
    mockMarkSyncResult: vi.fn(),
    mockGetSyncMeta: vi.fn(),
    mockSetSyncMeta: vi.fn(),
  }));

vi.mock("../lib/localEventStore", () => ({
  getLocalEventStore: () => ({
    appendEvent: mockAppendEvent,
    getPendingCount: mockGetPendingCount,
    getPendingEvents: mockGetPendingEvents,
    getLatestWorkEventForDevice: vi.fn().mockResolvedValue(null),
    markSyncResult: mockMarkSyncResult,
    getSyncMeta: mockGetSyncMeta,
    setSyncMeta: mockSetSyncMeta,
    getCachedJson: mockGetCachedJson,
  }),
  logCheckpoint: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: mockApi };
});

vi.mock("../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({
    cachedEmployee: {
      employeeId: "emp-1",
      firstName: "QA",
      lastName: "TimeoutRetry",
      preferredLanguage: null,
      lastVerifiedAt: "2026-01-01T00:00:00.000Z",
    },
    markUnpaired: vi.fn(),
    serverReachable: true,
    setServerReachable: vi.fn(),
    refreshCachedEmployee: vi.fn(),
  }),
}));

import { WorkSessionProvider, useWorkSession } from "./WorkSessionContext";

function wrapper({ children }: { children: ReactNode }) {
  return <WorkSessionProvider>{children}</WorkSessionProvider>;
}

beforeEach(() => {
  mockAppendEvent.mockReset();
  mockApi.mockReset().mockResolvedValue({
    employee: { id: "emp-1", firstName: "QA", lastName: "TimeoutRetry", preferredLanguage: null, securityRole: "Employee" },
    status: "idle",
    currentActivity: null,
    since: null,
    previousActivity: null,
    recentJobs: [],
  });
  mockGetPendingCount.mockReset().mockResolvedValue(0);
  mockGetPendingEvents.mockReset().mockResolvedValue([]);
  mockGetCachedJson.mockReset().mockResolvedValue(null);
  mockMarkSyncResult.mockReset().mockResolvedValue(undefined);
  mockGetSyncMeta.mockReset().mockResolvedValue({ lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null });
  mockSetSyncMeta.mockReset().mockResolvedValue(undefined);
});

describe("perform() recovers from a hung local store instead of freezing forever", () => {
  it("times out, clears busy, surfaces a retryable error, and the retry reuses the same idempotency key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Simulate the real incident: the local store's write never settles
    // at all (no resolve, no reject) — exactly what a hung IndexedDB
    // connection looked like on the real iPhone.
    let capturedFirstEventId: string | undefined;
    mockAppendEvent.mockImplementationOnce((event: { clientEventId?: string }) => {
      capturedFirstEventId = event.clientEventId;
      return new Promise(() => {}); // never settles
    });

    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/mobile/me"));

    const idempotencyKey = "tap-general-stable-id";
    let performPromise!: Promise<void>;
    act(() => {
      performPromise = result.current.perform(
        "/api/mobile/time-entries/work",
        { activityId: "activity-general", idempotencyKey, clientStartedAt: new Date().toISOString() },
        { pendingLabel: "General" }
      );
    });

    // Still "busy" — the hung write hasn't settled yet, same as the real
    // incident's "every option gray" moment. This must NOT last forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.retryAction).toBeNull();

    // Advance past the bounded local-commit timeout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    await performPromise; // must have settled — not hung — by now

    expect(result.current.busy).toBe(false); // the try/finally a hang would have defeated DID run
    expect(result.current.error).toBeTruthy(); // a visible message, not silence
    expect(result.current.retryAction).not.toBeNull(); // a way forward, not a dead end
    expect(capturedFirstEventId).toBe(idempotencyKey);

    // Now simulate the retry succeeding (the underlying store recovered —
    // e.g. after the connection self-healed, exactly as
    // webEventJournal.test.ts proves it does).
    let capturedRetryEventId: string | undefined;
    mockAppendEvent.mockImplementationOnce((event: { clientEventId?: string }) => {
      capturedRetryEventId = event.clientEventId;
      return Promise.resolve({
        ...event,
        clientEventId: event.clientEventId,
        deviceSeq: 1,
        localTzOffsetMinutes: 0,
        createdAtLocal: new Date().toISOString(),
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      });
    });

    await act(async () => {
      result.current.retryAction?.();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.retryAction).toBeNull();
    // The whole point: retrying used the EXACT SAME idempotency key as the
    // original hung attempt, never a freshly-minted one — this is what
    // lets the (separately-tested) store dedupe it into exactly one event
    // rather than two.
    expect(capturedRetryEventId).toBe(idempotencyKey);
    expect(capturedRetryEventId).toBe(capturedFirstEventId);
    expect(mockAppendEvent).toHaveBeenCalledTimes(2); // the hung attempt + the retry, never more

    vi.useRealTimers();
  });
});
