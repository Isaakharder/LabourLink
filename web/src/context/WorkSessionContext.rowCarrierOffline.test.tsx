// Real reported v1.3 offline defect (Marshall Dela Cruz): offline, working
// Picking Peppers at Phase 2 / Row 644 / Bin 11, changed only the carrier
// to Bin 14. The timer kept running and Recent Jobs/the commit itself were
// fine, but the active row/carrier buttons fell back to their placeholder
// text ("Where?"/"Which Carrier?") until reconnection. Root cause (see
// localSessionState.ts's applyLocalEventToMe): a same-activity event that
// omits a question it didn't change (by design — see HomeScreen's
// currentAnswersFor) was treated as clearing that question instead of
// preserving it. Fixed there; this file proves the fix holds end to end
// through WorkSessionProvider for the scenarios the investigation called
// out specifically: same-render-cycle display, a hanging /me, a failed
// background reconciliation, and reconnection not disturbing the locally
// selected assignment or timestamps.
//
// A SECOND, deeper defect surfaced during physical device testing of the
// v1.4 build above: even the very FIRST offline selection (a complete
// row+carrier pick, not a same-activity edit) showed the placeholders —
// on real hardware, the very first pending event's own greenhouse_row_id/
// carrier_id columns were null despite the full answers array being
// correct. Root cause (see WorkSessionContext.tsx's performInternal): the
// extraction looked for `a.questionType === "greenhouse_row"` on each
// answers entry, but the actual wire shape submitQuestionFlow sends (and
// the server itself expects) never carries a questionType field — the
// type is inferred from which id property is present. The `.find()` never
// matched, so greenhouseRowId/carrierId were unconditionally null on
// EVERY row/carrier-based activity_switch/work_start, not just a
// follow-up edit. The last describe block below locks this in directly
// against performInternal's own extraction, not just its downstream fold.
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

// Stable identities — see WorkSessionContext.coldStart.test.tsx's own
// comment on why a mock that mints a fresh vi.fn() per render breaks
// loadMe()'s useCallback identity and causes a real re-render loop.
const { mockSetServerReachable, mockRefreshCachedEmployee, mockMarkUnpaired } = vi.hoisted(() => ({
  mockSetServerReachable: vi.fn(),
  mockRefreshCachedEmployee: vi.fn(),
  mockMarkUnpaired: vi.fn(),
}));

vi.mock("../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({
    cachedEmployee: {
      employeeId: "emp-1",
      firstName: "Redacted",
      lastName: "Employee",
      preferredLanguage: null,
      lastVerifiedAt: "2026-08-27T08:00:00.000Z",
    },
    markUnpaired: mockMarkUnpaired,
    serverReachable: true,
    setServerReachable: mockSetServerReachable,
    refreshCachedEmployee: mockRefreshCachedEmployee,
  }),
}));

import { WorkSessionProvider, useWorkSession } from "./WorkSessionContext";

function wrapper({ children }: { children: ReactNode }) {
  return <WorkSessionProvider>{children}</WorkSessionProvider>;
}

const ACTIVITY_ID = "activity-picking-peppers";
const ROW_644_ID = "row-644";
const BIN_11_ID = "carrier-bin-11";
const BIN_14_ID = "carrier-bin-14";

function idleMeResponse() {
  return {
    employee: { id: "emp-1", firstName: "Redacted", lastName: "Employee", preferredLanguage: null, securityRole: "Employee" },
    status: "idle" as const,
    currentActivity: null,
    since: null,
    previousActivity: null,
    recentJobs: [],
  };
}

// The event this scenario's SECOND action (carrier-only edit) produces —
// row absent by design, exactly like HomeScreen's confirmSingleQuestionEdit
// building an answer set around the unchanged question.
function carrierOnlyEditEvent(deviceSeq: number, occurredAtUtc: string) {
  return {
    deviceId: "dev-1",
    employeeId: "emp-1",
    eventType: "activity_switch" as const,
    occurredAtUtc,
    activityId: ACTIVITY_ID,
    greenhouseRowId: null,
    carrierId: BIN_14_ID,
    clientEventId: `evt-carrier-edit-${deviceSeq}`,
    deviceSeq,
    localTzOffsetMinutes: 0,
    createdAtLocal: occurredAtUtc,
    syncStatus: "pending" as const,
    syncAttempts: 0,
    lastSyncError: null,
    serverResultJson: null,
  };
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

describe("offline row/carrier assignment stays visible without a server round trip", () => {
  it("timer starts and the active row/carrier appear in the SAME render cycle as the carrier-only edit", async () => {
    // Cold-started already mid-job at Row 644/Bin 11 (restored locally,
    // matching the real scenario — this isn't the very first action).
    mockGetPendingEvents.mockResolvedValue([
      {
        clientEventId: "evt-initial",
        deviceId: "dev-1",
        employeeId: "emp-1",
        deviceSeq: 1,
        eventType: "activity_switch",
        occurredAtUtc: "2026-08-27T14:00:00.000Z",
        localTzOffsetMinutes: 0,
        activityId: ACTIVITY_ID,
        greenhouseRowId: ROW_644_ID,
        carrierId: BIN_11_ID,
        answers: null,
        createdAtLocal: "2026-08-27T14:00:00.000Z",
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      },
    ]);
    mockApi.mockImplementation((path: string) => (path === "/api/mobile/me" ? new Promise(() => {}) : Promise.resolve(idleMeResponse())));

    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID));

    const newEvent = carrierOnlyEditEvent(2, "2026-08-27T14:05:00.000Z");
    mockAppendEvent.mockResolvedValueOnce(newEvent);
    // getPendingEvents isn't consulted by the immediate optimistic commit
    // path — only by fold-on-arrival/restore — so no further mock wiring
    // is needed for this specific assertion.

    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", {
        activityId: ACTIVITY_ID,
        answers: [{ questionId: "q-carrier", carrierId: BIN_14_ID }],
      });
    });

    // Everything the active screen needs — timer basis (startedAt), row,
    // carrier — is present together, in the state produced by this one
    // synchronous local commit. No network call was awaited to get here.
    expect(result.current.me?.currentActivity?.startedAt).toBe("2026-08-27T14:05:00.000Z");
    expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(result.current.me?.currentActivity?.carrier?.id).toBe(BIN_14_ID);
    expect(result.current.busy).toBe(false);
  });

  it("a hanging /api/mobile/me never blanks the row/carrier a local edit just set", async () => {
    mockGetPendingEvents.mockResolvedValue([
      {
        clientEventId: "evt-initial",
        deviceId: "dev-1",
        employeeId: "emp-1",
        deviceSeq: 1,
        eventType: "activity_switch",
        occurredAtUtc: "2026-08-27T14:00:00.000Z",
        localTzOffsetMinutes: 0,
        activityId: ACTIVITY_ID,
        greenhouseRowId: ROW_644_ID,
        carrierId: BIN_11_ID,
        answers: null,
        createdAtLocal: "2026-08-27T14:00:00.000Z",
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      },
    ]);
    // Every /me call hangs forever — including any triggered later by the
    // carrier edit's own background sync attempt.
    mockApi.mockImplementation((path: string) => (path === "/api/mobile/me" ? new Promise(() => {}) : Promise.resolve({ results: [] })));

    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID));

    mockAppendEvent.mockResolvedValueOnce(carrierOnlyEditEvent(2, "2026-08-27T14:05:00.000Z"));
    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", {
        activityId: ACTIVITY_ID,
        answers: [{ questionId: "q-carrier", carrierId: BIN_14_ID }],
      });
    });

    expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(result.current.me?.currentActivity?.carrier?.id).toBe(BIN_14_ID);

    // Give any hung request's microtasks a chance to matter — still hung,
    // still no effect on what's displayed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID);
  });

  it("a failed (rejected, not hanging) background reconciliation does not blank the row/carrier either", async () => {
    mockGetPendingEvents.mockResolvedValue([
      {
        clientEventId: "evt-initial",
        deviceId: "dev-1",
        employeeId: "emp-1",
        deviceSeq: 1,
        eventType: "activity_switch",
        occurredAtUtc: "2026-08-27T14:00:00.000Z",
        localTzOffsetMinutes: 0,
        activityId: ACTIVITY_ID,
        greenhouseRowId: ROW_644_ID,
        carrierId: BIN_11_ID,
        answers: null,
        createdAtLocal: "2026-08-27T14:00:00.000Z",
        syncStatus: "pending",
        syncAttempts: 0,
        lastSyncError: null,
        serverResultJson: null,
      },
    ]);
    mockApi.mockImplementation((path: string) =>
      path === "/api/mobile/me" ? Promise.reject(new TypeError("network error")) : Promise.resolve({ results: [] })
    );

    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID));

    mockAppendEvent.mockResolvedValueOnce(carrierOnlyEditEvent(2, "2026-08-27T14:05:00.000Z"));
    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", {
        activityId: ACTIVITY_ID,
        answers: [{ questionId: "q-carrier", carrierId: BIN_14_ID }],
      });
    });

    // A follow-up reconciliation attempt (e.g. the reconnect poll) that
    // fails outright must not touch me at all.
    await act(async () => {
      result.current.loadMe();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(result.current.me?.currentActivity?.carrier?.id).toBe(BIN_14_ID);
  });

  it("reconnection syncing both events successfully does not change the locally selected assignment or the events' own timestamps", async () => {
    const initialEvent = {
      clientEventId: "evt-initial",
      deviceId: "dev-1",
      employeeId: "emp-1",
      deviceSeq: 1,
      eventType: "activity_switch" as const,
      occurredAtUtc: "2026-08-27T14:00:00.000Z",
      localTzOffsetMinutes: 0,
      activityId: ACTIVITY_ID,
      greenhouseRowId: ROW_644_ID,
      carrierId: BIN_11_ID,
      answers: null,
      createdAtLocal: "2026-08-27T14:00:00.000Z",
      syncStatus: "pending" as const,
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    };
    mockGetPendingEvents.mockResolvedValue([initialEvent]);
    mockApi.mockImplementation((path: string) => (path === "/api/mobile/me" ? new Promise(() => {}) : Promise.resolve({ results: [] })));

    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID));

    const carrierEditEvent = carrierOnlyEditEvent(2, "2026-08-27T14:05:00.000Z");
    mockAppendEvent.mockResolvedValueOnce(carrierEditEvent);
    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", {
        activityId: ACTIVITY_ID,
        answers: [{ questionId: "q-carrier", carrierId: BIN_14_ID }],
      });
    });
    expect(result.current.me?.currentActivity?.carrier?.id).toBe(BIN_14_ID);

    // Reconnection: both events sync successfully in one batch, and the
    // server's own reconciled snapshot (once reachable) reports back
    // exactly the same assignment the employee already sees locally —
    // the fix means this must be a no-op from the employee's perspective.
    let syncEventsCallCount = 0;
    mockApi.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/api/mobile/sync/events") {
        syncEventsCallCount++;
        const body = JSON.parse(options?.body as string);
        // The events sent to the server carry their ORIGINAL timestamps,
        // unaltered by anything client-side.
        expect(body.events.map((e: { occurredAtUtc: string }) => e.occurredAtUtc)).toEqual([
          "2026-08-27T14:00:00.000Z",
          "2026-08-27T14:05:00.000Z",
        ]);
        return Promise.resolve({
          results: [
            { clientEventId: initialEvent.clientEventId, status: "accepted" },
            { clientEventId: carrierEditEvent.clientEventId, status: "accepted" },
          ],
        });
      }
      if (path === "/api/mobile/me") {
        return Promise.resolve({
          employee: idleMeResponse().employee,
          status: "work",
          currentActivity: {
            id: ACTIVITY_ID,
            name: "Picking Peppers",
            startedAt: "2026-08-27T14:05:00.000Z",
            accumulatedWorkedSecondsBeforeCurrentEntry: 0,
            minimumDurationMinutes: 0,
            row: { id: ROW_644_ID, label: "Phase 2 · Row 644" },
            carrier: { id: BIN_14_ID, name: "Bin 14" },
          },
          since: null,
          previousActivity: null,
          recentJobs: [],
        });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    mockGetPendingEvents.mockResolvedValue([initialEvent, carrierEditEvent]);

    await act(async () => {
      await result.current.flush();
      await Promise.resolve();
    });

    expect(syncEventsCallCount).toBe(1); // synced once, not duplicated
    expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(result.current.me?.currentActivity?.carrier?.id).toBe(BIN_14_ID);
    expect(result.current.me?.currentActivity?.startedAt).toBe("2026-08-27T14:05:00.000Z");
  });
});

describe("performInternal correctly extracts row/carrier from the REAL wire-format answers array", () => {
  it("the very first offline selection (Row 644, Bin 11) — a complete pick, not an edit — stores the real ids on the local event, not null", async () => {
    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.verified).toBe(true));

    mockAppendEvent.mockResolvedValueOnce({
      deviceId: "dev-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: "2026-08-27T14:00:00.000Z",
      activityId: ACTIVITY_ID,
      greenhouseRowId: ROW_644_ID,
      carrierId: BIN_11_ID,
      clientEventId: "evt-first-pick",
      deviceSeq: 1,
      localTzOffsetMinutes: 0,
      createdAtLocal: "2026-08-27T14:00:00.000Z",
      syncStatus: "pending",
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    });

    // The exact wire shape submitQuestionFlow's answersPayload builds and
    // POST /api/mobile/time-entries/work actually expects — no
    // questionType field on either entry.
    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", {
        activityId: ACTIVITY_ID,
        answers: [
          { questionId: "q-row", greenhouseRowId: ROW_644_ID },
          { questionId: "q-carrier", carrierId: BIN_11_ID },
        ],
      });
    });

    // Asserts on what performInternal actually COMPUTED and handed to the
    // store, not just what a mocked return value says — this is what
    // catches the real bug (the extraction silently produced null/null
    // here before the fix, even though appendEvent would have happily
    // stored whatever it was given).
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ greenhouseRowId: ROW_644_ID, carrierId: BIN_11_ID })
    );
    expect(result.current.me?.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(result.current.me?.currentActivity?.carrier?.id).toBe(BIN_11_ID);
  });

  it("an answers payload that is not an array (e.g. {}) is treated as no answers, never throws, and still commits the event", async () => {
    const { result } = renderHook(() => useWorkSession(), { wrapper });
    await waitFor(() => expect(result.current.verified).toBe(true));

    mockAppendEvent.mockResolvedValueOnce({
      deviceId: "dev-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: "2026-08-27T14:00:00.000Z",
      activityId: "activity-no-questions",
      greenhouseRowId: null,
      carrierId: null,
      clientEventId: "evt-no-questions",
      deviceSeq: 1,
      localTzOffsetMinutes: 0,
      createdAtLocal: "2026-08-27T14:00:00.000Z",
      syncStatus: "pending",
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    });

    await act(async () => {
      await result.current.perform("/api/mobile/time-entries/work", { activityId: "activity-no-questions", answers: {} });
    });

    expect(result.current.error).toBeNull();
    expect(result.current.me?.status).toBe("work");
    expect(mockAppendEvent).toHaveBeenCalledWith(expect.objectContaining({ greenhouseRowId: null, carrierId: null }));
  });
});
