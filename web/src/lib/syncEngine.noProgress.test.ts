// @vitest-environment jsdom
//
// A sync round that the server answers 200 but that moves nothing forward
// (every event sequence_gap / retryable_failure) must back off instead of
// immediately re-sending the identical batch. A physical iPhone did exactly
// that ~5 times a second against the demo API (build 1.8.5 (14)).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetPendingEvents, mockGetPendingCount, mockMarkSyncResult, mockGetSyncMeta, mockSetSyncMeta, mockSetServerLastProcessedSeq, mockApi } =
  vi.hoisted(() => ({
    mockGetPendingEvents: vi.fn(),
    mockGetPendingCount: vi.fn(),
    mockMarkSyncResult: vi.fn(),
    mockGetSyncMeta: vi.fn(),
    mockSetSyncMeta: vi.fn(),
    mockSetServerLastProcessedSeq: vi.fn(),
    mockApi: vi.fn(),
  }));

vi.mock("./localEventStore", () => ({
  getLocalEventStore: () => ({
    getPendingEvents: mockGetPendingEvents,
    getPendingCount: mockGetPendingCount,
    markSyncResult: mockMarkSyncResult,
    getSyncMeta: mockGetSyncMeta,
    setSyncMeta: mockSetSyncMeta,
    setServerLastProcessedSeq: mockSetServerLastProcessedSeq,
  }),
}));
vi.mock("./device", () => ({ getOrCreateDeviceIdentifier: () => "device-1" }));
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, api: mockApi };
});

const event = (deviceSeq: number) => ({
  clientEventId: `evt-${deviceSeq}`,
  deviceId: "device-1",
  employeeId: "emp-1",
  deviceSeq,
  eventType: "activity_switch" as const,
  occurredAtUtc: "2026-10-09T23:30:00.000Z",
  localTzOffsetMinutes: -240,
  activityId: "activity-a",
  greenhouseRowId: null,
  carrierId: null,
  answers: null,
  createdAtLocal: "2026-10-09T23:30:00.000Z",
  syncStatus: "pending" as const,
  syncAttempts: 0,
  lastSyncError: null,
  serverResultJson: null,
});

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mockGetPendingEvents.mockReset();
  mockGetPendingCount.mockReset();
  mockMarkSyncResult.mockReset().mockResolvedValue(undefined);
  mockGetSyncMeta.mockReset().mockResolvedValue({ lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null });
  mockSetSyncMeta.mockReset().mockResolvedValue(undefined);
  mockSetServerLastProcessedSeq.mockReset().mockResolvedValue(undefined);
  mockApi.mockReset();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("syncRoundMadeProgress", () => {
  it("is true only when at least one event reached a final answer", async () => {
    const { syncRoundMadeProgress } = await import("./syncEngine");
    expect(syncRoundMadeProgress([{ status: "sequence_gap" }, { status: "retryable_failure" }])).toBe(false);
    expect(syncRoundMadeProgress([])).toBe(false);
    expect(syncRoundMadeProgress([{ status: "sequence_gap" }, { status: "accepted" }])).toBe(true);
    expect(syncRoundMadeProgress([{ status: "duplicate" }])).toBe(true);
    expect(syncRoundMadeProgress([{ status: "permanent_conflict" }])).toBe(true);
  });
});

describe("syncEngine: no-progress rounds back off", () => {
  it("does not hammer the server when every event comes back sequence_gap", async () => {
    const pending = [13, 14, 15, 16, 17].map(event);
    mockGetPendingEvents.mockResolvedValue(pending);
    mockGetPendingCount.mockResolvedValue(5);
    mockApi.mockResolvedValue({
      results: pending.map((e) => ({ clientEventId: e.clientEventId, status: "sequence_gap", detail: { expectedDeviceSeq: 1, gotDeviceSeq: e.deviceSeq } })),
      deviceLastProcessedSeq: 0,
    });

    const callTimes: number[] = [];
    mockApi.mockImplementation(async () => {
      callTimes.push(Date.now());
      return {
        results: pending.map((e) => ({ clientEventId: e.clientEventId, status: "sequence_gap", detail: { expectedDeviceSeq: 1, gotDeviceSeq: e.deviceSeq } })),
        deviceLastProcessedSeq: 0,
      };
    });

    const { trySyncSoon, hasSyncProblem } = await import("./syncEngine");
    await trySyncSoon();
    expect(mockApi).toHaveBeenCalledTimes(1);

    // Before the fix this was an immediate retry loop (~5 requests/second).
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockApi).toHaveBeenCalledTimes(1);

    // Two minutes: exponential backoff (5s x 2^n, +/-30% jitter) allows only a
    // handful of attempts, each gap at least as long as the last.
    await vi.advanceTimersByTimeAsync(115_000);
    const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i]);
    expect(callTimes.length).toBeGreaterThanOrEqual(3);
    expect(callTimes.length).toBeLessThanOrEqual(6);
    expect(gaps[0]).toBeGreaterThanOrEqual(7000); // 10s x 0.7
    expect(gaps[1]).toBeGreaterThanOrEqual(14000); // 20s x 0.7
    gaps.slice(1).forEach((g, i) => expect(g).toBeGreaterThanOrEqual(gaps[i]));
    expect(hasSyncProblem()).toBe(true);

    // The events themselves are untouched — still pending, nothing dropped.
    expect(mockMarkSyncResult.mock.calls.every(([, r]) => (r as { status: string }).status === "sequence_gap")).toBe(true);
  });

  it("keeps draining immediately while rounds do make progress", async () => {
    const first = [1, 2].map(event);
    const second = [3].map(event);
    mockGetPendingEvents.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue([]);
    mockGetPendingCount.mockResolvedValueOnce(1).mockResolvedValue(0);
    mockApi
      .mockResolvedValueOnce({ results: first.map((e) => ({ clientEventId: e.clientEventId, status: "accepted" })), deviceLastProcessedSeq: 2 })
      .mockResolvedValueOnce({ results: second.map((e) => ({ clientEventId: e.clientEventId, status: "accepted" })), deviceLastProcessedSeq: 3 });

    const { trySyncSoon, hasSyncProblem } = await import("./syncEngine");
    await trySyncSoon();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(hasSyncProblem()).toBe(false);
  });
});
