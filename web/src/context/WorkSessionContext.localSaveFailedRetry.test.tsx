// Regression test for the Nattawat N incident's follow-up fix: when the
// local commit fails OUTRIGHT (not a timeout) — e.g.
// LocalSequenceAllocationError from localEventStore.ts's native appendEvent
// after its one bounded sequence-collision retry — the UI must show the new
// specific "Couldn't save this job on the phone..." message (never the bare
// generic "Something went wrong" the real incident showed) and offer a
// working Retry that reuses the same idempotency key, exactly like the
// timeout case already covered by WorkSessionContext.timeoutRetry.test.tsx.
// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

const { mockAppendEvent, mockApi, mockGetPendingCount, mockGetPendingEvents, mockGetCachedJson, mockSetCachedJson, mockMarkSyncResult, mockGetSyncMeta, mockSetSyncMeta } =
  vi.hoisted(() => ({
    mockAppendEvent: vi.fn(),
    mockApi: vi.fn(),
    mockGetPendingCount: vi.fn(),
    mockGetPendingEvents: vi.fn(),
    mockGetCachedJson: vi.fn(),
    mockSetCachedJson: vi.fn(),
    mockMarkSyncResult: vi.fn(),
    mockGetSyncMeta: vi.fn(),
    mockSetSyncMeta: vi.fn(),
  }));

vi.mock("../lib/localEventStore", async () => {
  const actual = await vi.importActual<typeof import("../lib/localEventStore")>("../lib/localEventStore");
  return {
    LocalSequenceAllocationError: actual.LocalSequenceAllocationError,
    getLocalEventStore: () => ({
      appendEvent: mockAppendEvent,
      getPendingCount: mockGetPendingCount,
      getPendingEvents: mockGetPendingEvents,
      getLatestWorkEventForDevice: vi.fn().mockResolvedValue(null),
      markSyncResult: mockMarkSyncResult,
      getSyncMeta: mockGetSyncMeta,
      setSyncMeta: mockSetSyncMeta,
      getCachedJson: mockGetCachedJson,
      setCachedJson: mockSetCachedJson,
    }),
    logCheckpoint: vi.fn(),
  };
});

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: mockApi };
});

vi.mock("../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({
    cachedEmployee: {
      employeeId: "emp-1",
      firstName: "Nattawat",
      lastName: "N",
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
import { LocalSequenceAllocationError } from "../lib/localEventStore";

function wrapper({ children }: { children: ReactNode }) {
  return <WorkSessionProvider>{children}</WorkSessionProvider>;
}

beforeEach(() => {
  mockAppendEvent.mockReset();
  mockApi.mockReset().mockResolvedValue({
    employee: { id: "emp-1", firstName: "Nattawat", lastName: "N", preferredLanguage: null, securityRole: "Employee" },
    status: "idle",
    currentActivity: null,
    since: null,
    previousActivity: null,
    recentJobs: [],
  });
  mockGetPendingCount.mockReset().mockResolvedValue(0);
  mockGetPendingEvents.mockReset().mockResolvedValue([]);
  mockGetCachedJson.mockReset().mockResolvedValue(null);
  mockSetCachedJson.mockReset().mockResolvedValue(undefined);
  mockMarkSyncResult.mockReset().mockResolvedValue(undefined);
  mockGetSyncMeta.mockReset().mockResolvedValue({ lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null });
  mockSetSyncMeta.mockReset().mockResolvedValue(undefined);
});

describe("perform() recovers from a local write that fails outright (not a timeout)", () => {
  it("shows the specific 'couldn't save' message (never the bare generic one) and Retry reuses the same idempotency key", async () => {
    let capturedFirstEventId: string | undefined;
    mockAppendEvent.mockImplementationOnce((event: { clientEventId?: string }) => {
      capturedFirstEventId = event.clientEventId;
      return Promise.reject(
        new LocalSequenceAllocationError("gave up after 2 attempts; last attempted device_seq=21, conflicting clientEventId=other")
      );
    });

    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/mobile/me"));

    const idempotencyKey = "tap-picking-bin10-stable-id";
    await act(async () => {
      await result.current.perform(
        "/api/mobile/time-entries/work",
        {
          activityId: "activity-picking",
          answers: [
            { questionId: "q-row", greenhouseRowId: "row-1" },
            { questionId: "q-carrier", carrierId: "carrier-bin-10" },
          ],
          idempotencyKey,
          clientStartedAt: new Date().toISOString(),
        },
        { pendingLabel: "Picking Peppers" }
      );
    });

    expect(result.current.busy).toBe(false);
    // The specific, actionable text — not "Something went wrong".
    expect(result.current.error).toBe("Couldn't save this job on the phone. Tap Retry. Your current job is still active.");
    expect(result.current.retryAction).not.toBeNull();
    expect(capturedFirstEventId).toBe(idempotencyKey);

    // Retry succeeds (e.g. the app restarted, or the next attempt's
    // recomputed floor cleared the collision).
    let capturedRetryEventId: string | undefined;
    mockAppendEvent.mockImplementationOnce((event: { clientEventId?: string }) => {
      capturedRetryEventId = event.clientEventId;
      return Promise.resolve({
        ...event,
        clientEventId: event.clientEventId,
        deviceSeq: 22,
        localTzOffsetMinutes: 0,
        createdAtLocal: new Date().toISOString(),
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      });
    });

    await act(async () => {
      await result.current.retryAction?.();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.retryAction).toBeNull();
    expect(capturedRetryEventId).toBe(idempotencyKey);
    expect(mockAppendEvent).toHaveBeenCalledTimes(2); // the failed attempt + the retry, never more
  });
});
