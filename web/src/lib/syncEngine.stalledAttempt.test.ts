// Regression test for the Jhang Jhang sync stall (2026-09-29..10-01): taps
// kept committing locally all day, but nothing reached the server for ~45h
// and then 54 events flushed at once. runSync sits behind singleFlight, and
// its local-store awaits had no time bound — one that never settles made
// every later trySyncSoon() join the same dead promise until the app was
// fully restarted.
//
// Proves: a stalled attempt is abandoned after SYNC_STEP_TIMEOUT_MS, a
// retry is scheduled on its own, and the still-pending offline events go
// out on that retry, unchanged and never dropped.
// @vitest-environment jsdom
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

// The tag-registration flush rides the same triggers; isolated here.
vi.mock("./pendingTagSync", () => ({ flushPendingTagRegistrations: () => Promise.resolve() }));
vi.mock("./device", () => ({
  getOrCreateDeviceIdentifier: () => "device-1",
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, api: mockApi };
});

const pendingEvent = (clientEventId: string, deviceSeq: number, occurredAtUtc: string) => ({
  clientEventId,
  deviceId: "device-1",
  employeeId: "emp-1",
  deviceSeq,
  eventType: "activity_switch" as const,
  occurredAtUtc,
  localTzOffsetMinutes: -240,
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
  vi.resetModules();
  vi.useFakeTimers();
  mockGetPendingEvents.mockReset();
  mockGetPendingCount.mockReset().mockResolvedValue(0);
  mockMarkSyncResult.mockReset().mockResolvedValue(undefined);
  mockGetSyncMeta.mockReset().mockResolvedValue({ lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null });
  mockSetSyncMeta.mockReset().mockResolvedValue(undefined);
  mockSetServerLastProcessedSeq.mockReset().mockResolvedValue(undefined);
  mockApi.mockReset();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncEngine: a stalled attempt can't block syncing forever", () => {
  it("abandons a hung attempt, retries on its own, and delivers the still-pending offline events intact", async () => {
    const events = [
      pendingEvent("evt-181", 181, "2026-09-29T19:49:30.000Z"),
      pendingEvent("evt-182", 182, "2026-09-29T20:27:53.000Z"),
    ];
    // First read hangs forever (the stalled local-store call); later reads work.
    mockGetPendingEvents.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(events);
    mockApi.mockResolvedValue({
      results: events.map((e) => ({ clientEventId: e.clientEventId, status: "accepted" })),
      deviceLastProcessedSeq: 182,
    });

    const { trySyncSoon, SYNC_STEP_TIMEOUT_MS } = await import("./syncEngine");

    const first = trySyncSoon();
    // Before the fix, every later trigger joined the same dead promise.
    const joined = trySyncSoon();
    await vi.advanceTimersByTimeAsync(SYNC_STEP_TIMEOUT_MS);
    await expect(first).resolves.toBeUndefined();
    await expect(joined).resolves.toBeUndefined();
    expect(mockApi).not.toHaveBeenCalled();

    // The scheduled backoff retry (5s base, +/-30% jitter) fires without any
    // new user action or lifecycle trigger.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [path, init] = mockApi.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/api/mobile/sync/events");
    const sent = JSON.parse(init.body).events as { clientEventId: string; deviceSeq: number; occurredAtUtc: string }[];
    expect(sent).toEqual([
      expect.objectContaining({ clientEventId: "evt-181", deviceSeq: 181, occurredAtUtc: "2026-09-29T19:49:30.000Z" }),
      expect.objectContaining({ clientEventId: "evt-182", deviceSeq: 182, occurredAtUtc: "2026-09-29T20:27:53.000Z" }),
    ]);
    expect(mockMarkSyncResult).toHaveBeenCalledTimes(2);
  });

  it("an explicit trigger after the timeout starts a fresh attempt instead of joining the stalled one", async () => {
    const events = [pendingEvent("evt-1", 1, "2026-10-01T11:21:15.000Z")];
    mockGetPendingEvents.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(events);
    mockApi.mockResolvedValue({ results: [{ clientEventId: "evt-1", status: "accepted" }] });

    const { trySyncSoon, SYNC_STEP_TIMEOUT_MS } = await import("./syncEngine");
    void trySyncSoon();
    await vi.advanceTimersByTimeAsync(SYNC_STEP_TIMEOUT_MS);

    await trySyncSoon(); // e.g. the employee's next tap, or "Sync now"
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("a stalled call that resolves LATER never resumes its attempt — no overlapping attempts, no extra submission", async () => {
    const events = [pendingEvent("evt-7", 7, "2026-09-30T11:27:37.000Z")];
    let releaseStalled!: (v: typeof events) => void;
    mockGetPendingEvents
      .mockImplementationOnce(() => new Promise((r) => (releaseStalled = r)))
      .mockResolvedValueOnce(events)
      .mockResolvedValue([]); // drained once the live attempt has submitted it
    let inFlight = 0;
    let maxInFlight = 0;
    mockApi.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1000));
      inFlight--;
      return { results: [{ clientEventId: "evt-7", status: "accepted" }] };
    });

    const { trySyncSoon, SYNC_STEP_TIMEOUT_MS } = await import("./syncEngine");
    void trySyncSoon();
    await vi.advanceTimersByTimeAsync(SYNC_STEP_TIMEOUT_MS);
    const retry = trySyncSoon(); // a fresh attempt, now that the stalled one has ended
    await vi.advanceTimersByTimeAsync(10);
    releaseStalled(events); // the abandoned native read finally answers
    await vi.advanceTimersByTimeAsync(60_000);
    await retry;

    expect(mockApi).toHaveBeenCalledTimes(1); // only the live attempt submitted
    expect(maxInFlight).toBe(1);
  });

  it("a hung status write after a successful POST re-sends (never drops) the event, and the late write adds nothing", async () => {
    const events = [pendingEvent("evt-9", 9, "2026-09-30T14:23:50.000Z")];
    mockGetPendingEvents.mockResolvedValue(events);
    let releaseMark!: () => void;
    mockMarkSyncResult.mockImplementationOnce(() => new Promise<void>((r) => (releaseMark = r))).mockResolvedValue(undefined);
    mockApi
      .mockResolvedValueOnce({ results: [{ clientEventId: "evt-9", status: "accepted" }] })
      .mockResolvedValueOnce({ results: [{ clientEventId: "evt-9", status: "duplicate" }] });
    mockGetPendingCount.mockResolvedValue(0);

    const { trySyncSoon, SYNC_STEP_TIMEOUT_MS } = await import("./syncEngine");
    void trySyncSoon();
    await vi.advanceTimersByTimeAsync(SYNC_STEP_TIMEOUT_MS + 10_000); // step times out, backoff retry runs

    expect(mockApi).toHaveBeenCalledTimes(2);
    const second = JSON.parse((mockApi.mock.calls[1] as [string, { body: string }])[1].body).events;
    expect(second.map((e: { clientEventId: string }) => e.clientEventId)).toEqual(["evt-9"]);
    expect(mockMarkSyncResult).toHaveBeenLastCalledWith("evt-9", expect.objectContaining({ status: "duplicate" }));

    releaseMark();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockApi).toHaveBeenCalledTimes(2);
  });
});
