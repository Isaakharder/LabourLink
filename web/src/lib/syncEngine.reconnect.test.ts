// "Reconnection syncs once without duplicates or altered timestamps" —
// several independent triggers (the browser 'online' event, a native
// app-resume event, a manual "Sync now") can all fire trySyncSoon() at
// once when connectivity returns. singleFlight is what's supposed to
// collapse them into exactly one real submission; this proves it actually
// does, and that the wire payload's timestamps go out byte-for-byte
// unaltered (toWire() must never re-derive or re-round them).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetPendingEvents, mockGetPendingCount, mockMarkSyncResult, mockGetSyncMeta, mockSetSyncMeta, mockApi } =
  vi.hoisted(() => ({
    mockGetPendingEvents: vi.fn(),
    mockGetPendingCount: vi.fn(),
    mockMarkSyncResult: vi.fn(),
    mockGetSyncMeta: vi.fn(),
    mockSetSyncMeta: vi.fn(),
    mockApi: vi.fn(),
  }));

vi.mock("./localEventStore", () => ({
  getLocalEventStore: () => ({
    getPendingEvents: mockGetPendingEvents,
    getPendingCount: mockGetPendingCount,
    markSyncResult: mockMarkSyncResult,
    getSyncMeta: mockGetSyncMeta,
    setSyncMeta: mockSetSyncMeta,
  }),
}));

vi.mock("./device", () => ({
  getOrCreateDeviceIdentifier: () => "device-1",
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, api: mockApi };
});

const pendingEvent = (clientEventId: string, occurredAtUtc: string) => ({
  clientEventId,
  deviceId: "device-1",
  employeeId: "emp-1",
  deviceSeq: 1,
  eventType: "work_start" as const,
  occurredAtUtc,
  localTzOffsetMinutes: 0,
  activityId: "activity-a",
  greenhouseRowId: null,
  carrierId: null,
  answers: null,
  createdAtLocal: occurredAtUtc,
  syncStatus: "pending" as const,
  syncAttempts: 0,
  lastSyncError: null,
  serverResultJson: null,
});

beforeEach(() => {
  vi.resetModules(); // syncEngine.ts's consecutiveFailures/backoffTimer are module-level — start each test clean
  mockGetPendingEvents.mockReset();
  mockGetPendingCount.mockReset().mockResolvedValue(0);
  mockMarkSyncResult.mockReset().mockResolvedValue(undefined);
  mockGetSyncMeta.mockReset().mockResolvedValue({ lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null });
  mockSetSyncMeta.mockReset().mockResolvedValue(undefined);
  mockApi.mockReset();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("syncEngine reconnection dedup", () => {
  it("three simultaneous triggers (reconnection) collapse into exactly one submission, with unaltered timestamps", async () => {
    const events = [pendingEvent("evt-a", "2026-08-25T15:00:07.012Z"), pendingEvent("evt-b", "2026-08-25T15:14:50.856Z")];
    mockGetPendingEvents.mockResolvedValue(events);
    mockApi.mockResolvedValue({
      results: [
        { clientEventId: "evt-a", status: "accepted" },
        { clientEventId: "evt-b", status: "accepted" },
      ],
    });

    const { trySyncSoon } = await import("./syncEngine");

    // Simulates the 'online' listener, a native resume event, and a manual
    // "Sync now" all firing within the same tick — the real shape of a
    // reconnection moment.
    await Promise.all([trySyncSoon(), trySyncSoon(), trySyncSoon()]);

    const syncCalls = mockApi.mock.calls.filter(([path]) => path === "/api/mobile/sync/events");
    expect(syncCalls).toHaveLength(1); // never duplicated across the three simultaneous triggers

    const body = JSON.parse(syncCalls[0][1].body as string);
    expect(body.events).toHaveLength(2);
    // Byte-for-byte unaltered — toWire() must never re-derive/re-round a
    // timestamp on its way to the server.
    expect(body.events[0].occurredAtUtc).toBe("2026-08-25T15:00:07.012Z");
    expect(body.events[1].occurredAtUtc).toBe("2026-08-25T15:14:50.856Z");

    expect(mockMarkSyncResult).toHaveBeenCalledWith("evt-a", expect.objectContaining({ status: "accepted" }));
    expect(mockMarkSyncResult).toHaveBeenCalledWith("evt-b", expect.objectContaining({ status: "accepted" }));
  });

  it("once the queue is empty, a further trySyncSoon() never re-submits", async () => {
    mockGetPendingEvents.mockResolvedValueOnce([pendingEvent("evt-a", "2026-08-25T15:00:00.000Z")]);
    mockApi.mockResolvedValue({ results: [{ clientEventId: "evt-a", status: "accepted" }] });

    const { trySyncSoon } = await import("./syncEngine");
    await trySyncSoon();
    expect(mockApi.mock.calls.filter(([path]) => path === "/api/mobile/sync/events")).toHaveLength(1);

    // The batch is gone now (already synced) — every subsequent call must
    // see an empty queue and skip the network entirely.
    mockGetPendingEvents.mockResolvedValue([]);
    await trySyncSoon();
    await trySyncSoon();

    expect(mockApi.mock.calls.filter(([path]) => path === "/api/mobile/sync/events")).toHaveLength(1);
  });
});
