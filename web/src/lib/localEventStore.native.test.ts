// Regression coverage for the NATIVE (Capacitor SQLite) appendEvent path —
// the path actually involved in the Nattawat N incident ("UNIQUE constraint
// failed: pending_events.device_id, pending_events.device_seq (code 2067)",
// captured live via adb logcat on 2026-09-14). localEventStore.test.ts only
// covers the WEB/webEventJournal.ts path (the real @capacitor-community/
// sqlite plugin has no Node/jsdom implementation to test against); this
// file exercises the same appendEvent() entry point with a small in-memory
// fake standing in for the native SQLite connection — just enough of
// query/run/beginTransaction/commitTransaction/rollbackTransaction,
// including transactional rollback and a real UNIQUE(device_id, device_seq)
// constraint, to prove the actual allocation/collision-recovery ORCHESTRATION
// in appendEvent (not just the pure logic already covered by
// localSequenceAssignment.test.ts).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

interface FakeRow {
  [key: string]: unknown;
}

// Minimal in-memory stand-in for the on-device labourlink_eventsSQLite.db —
// deliberately just enough of the schema/queries localEventStore.ts actually
// issues, not a general SQL engine. structuredClone-based snapshot/restore
// gives real transactional rollback semantics (the actual property this
// fix's "one serialized transaction" requirement depends on).
class FakeSqliteDb {
  deviceSeqCounter = new Map<string, { device_id: string; next_seq: number }>();
  pendingEvents = new Map<string, FakeRow>(); // keyed by client_event_id (its real PRIMARY KEY)
  referenceCache = new Map<string, { cache_key: string; json_value: string; cached_at: string }>();
  private snapshot: {
    counter: Map<string, { device_id: string; next_seq: number }>;
    events: Map<string, FakeRow>;
  } | null = null;

  async open() {}
  async execute() {
    // schema_migrations / CREATE TABLE / CREATE INDEX statements — this
    // fake's tables already exist as the Maps above, so every DDL/tracking
    // statement is a safe no-op.
  }

  async beginTransaction() {
    this.snapshot = {
      counter: new Map(this.deviceSeqCounter),
      events: new Map(this.pendingEvents),
    };
  }
  async commitTransaction() {
    this.snapshot = null;
  }
  async rollbackTransaction() {
    if (this.snapshot) {
      this.deviceSeqCounter = this.snapshot.counter;
      this.pendingEvents = this.snapshot.events;
    }
    this.snapshot = null;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ values?: FakeRow[] }> {
    if (sql.includes("select version from schema_migrations")) return { values: [] };
    if (sql.includes("select next_seq from device_seq_counter")) {
      const row = this.deviceSeqCounter.get(String(params[0]));
      return { values: row ? [{ next_seq: row.next_seq }] : [] };
    }
    if (sql.includes("select max(device_seq) as m from pending_events where device_id = ? and sync_status")) {
      const [deviceId] = params as [string];
      const max = this.maxSeq((r) => r.device_id === deviceId && r.sync_status === "synced");
      return { values: [{ m: max }] };
    }
    if (sql.includes("select max(device_seq) as m from pending_events")) {
      const [deviceId] = params as [string];
      const max = this.maxSeq((r) => r.device_id === deviceId);
      return { values: [{ m: max }] };
    }
    if (sql.includes("select client_event_id from pending_events where device_id = ? and device_seq = ?")) {
      const [deviceId, seq] = params as [string, number];
      const row = [...this.pendingEvents.values()].find((r) => r.device_id === deviceId && r.device_seq === seq);
      return { values: row ? [{ client_event_id: row.client_event_id }] : [] };
    }
    if (sql.includes("select * from pending_events where client_event_id = ?")) {
      const row = this.pendingEvents.get(String(params[0]));
      return { values: row ? [row] : [] };
    }
    if (sql.includes("select * from pending_events where device_id = ? and device_seq = ?")) {
      const [deviceId, seq] = params as [string, number];
      const row = [...this.pendingEvents.values()].find((r) => r.device_id === deviceId && r.device_seq === seq);
      return { values: row ? [row] : [] };
    }
    if (sql.includes("select * from pending_events where device_id = ? order by device_seq desc limit 1")) {
      const [deviceId] = params as [string];
      const rows = [...this.pendingEvents.values()].filter((r) => r.device_id === deviceId);
      rows.sort((a, b) => (b.device_seq as number) - (a.device_seq as number));
      return { values: rows[0] ? [rows[0]] : [] };
    }
    if (sql.includes("select json_value, cached_at from reference_cache")) {
      const row = this.referenceCache.get(String(params[0]));
      return { values: row ? [{ json_value: row.json_value, cached_at: row.cached_at }] : [] };
    }
    throw new Error(`FakeSqliteDb.query: unhandled statement: ${sql}`);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes?: { changes: number } }> {
    if (sql.includes("insert into schema_migrations")) return {};
    if (sql.includes("insert into device_seq_counter")) {
      const [deviceId, nextSeq] = params as [string, number];
      this.deviceSeqCounter.set(deviceId, { device_id: deviceId, next_seq: nextSeq });
      return {};
    }
    if (sql.includes("insert into pending_events")) {
      const [
        clientEventId,
        deviceId,
        employeeId,
        deviceSeq,
        eventType,
        occurredAtUtc,
        localTzOffsetMinutes,
        activityId,
        greenhouseRowId,
        carrierId,
        answersJson,
        densitySnapshotJson,
        configRevision,
        createdAtLocal,
      ] = params;
      // PRIMARY KEY(client_event_id) — a different bug class than this
      // fix's target collision; kept realistic but not the focus here.
      if (this.pendingEvents.has(String(clientEventId))) {
        throw new Error("UNIQUE constraint failed: pending_events.client_event_id");
      }
      const collision = [...this.pendingEvents.values()].some(
        (r) => r.device_id === deviceId && r.device_seq === deviceSeq
      );
      if (collision) {
        throw new Error("UNIQUE constraint failed: pending_events.device_id, pending_events.device_seq (code 2067)");
      }
      this.pendingEvents.set(String(clientEventId), {
        client_event_id: clientEventId,
        device_id: deviceId,
        employee_id: employeeId,
        device_seq: deviceSeq,
        event_type: eventType,
        occurred_at_utc: occurredAtUtc,
        local_tz_offset_minutes: localTzOffsetMinutes,
        activity_id: activityId,
        greenhouse_row_id: greenhouseRowId,
        carrier_id: carrierId,
        answers_json: answersJson,
        density_snapshot_json: densitySnapshotJson,
        config_revision: configRevision,
        created_at_local: createdAtLocal,
        sync_status: "pending",
        sync_attempts: 0,
        last_sync_error: null,
        server_result_json: null,
      });
      return {};
    }
    if (sql.includes("insert into reference_cache")) {
      const [cacheKey, jsonValue, cachedAt] = params as [string, string, string];
      this.referenceCache.set(cacheKey, { cache_key: cacheKey, json_value: jsonValue, cached_at: cachedAt });
      return {};
    }
    if (sql.includes("update pending_events") && sql.includes("set sync_status")) {
      const [status, error, resultJson, clientEventId] = params as [string, string | null, string, string];
      const row = this.pendingEvents.get(clientEventId);
      if (row) {
        row.sync_status = status;
        row.sync_attempts = (row.sync_attempts as number) + 1;
        row.last_sync_error = error;
        row.server_result_json = resultJson;
      }
      return {};
    }
    throw new Error(`FakeSqliteDb.run: unhandled statement: ${sql}`);
  }

  private maxSeq(predicate: (r: FakeRow) => boolean): number | null {
    const seqs = [...this.pendingEvents.values()].filter(predicate).map((r) => r.device_seq as number);
    return seqs.length ? Math.max(...seqs) : null;
  }
}

// Shared across whichever LocalEventStoreImpl instance is under test in a
// given test — reassigned fresh in beforeEach, but a test that wants to
// simulate "same on-disk file, new process" (restart recovery) creates a
// SECOND store instance pointed at THIS SAME db without resetting it.
let fakeDb = new FakeSqliteDb();

vi.mock("./sqlite/bootstrap", () => ({
  isNativeSqlite: () => true,
  getSqliteConnection: async () => ({
    checkConnectionsConsistency: async () => ({ result: true }),
    isConnection: async () => ({ result: false }),
    createConnection: async () => fakeDb,
    retrieveConnection: async () => fakeDb,
    saveToStore: async () => {},
  }),
}));

import { getLocalEventStore, LocalSequenceAllocationError, __resetLocalEventStoreForTests } from "./localEventStore";

describe("LocalEventStoreImpl native (SQLite) appendEvent", () => {
  beforeEach(() => {
    fakeDb = new FakeSqliteDb();
    __resetLocalEventStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function ev(overrides: Partial<Parameters<ReturnType<typeof getLocalEventStore>["appendEvent"]>[0]> = {}) {
    return {
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "activity_switch" as const,
      occurredAtUtc: "2026-09-14T18:53:40.000Z",
      activityId: "activity-picking",
      greenhouseRowId: "row-1",
      carrierId: "carrier-1",
      ...overrides,
    };
  }

  it("allocates sequential device_seq values on ordinary, uncontested appends (offline the whole time — no network call ever happens)", async () => {
    const store = getLocalEventStore();
    const a = await store.appendEvent(ev());
    const b = await store.appendEvent(ev({ clientEventId: "second" }));
    expect(a.deviceSeq).toBe(1);
    expect(b.deviceSeq).toBe(2);
  });

  // The actual incident: device_seq_counter drifted below what's already in
  // pending_events (root cause traced to the app's own ColdStartWatchdog
  // repeatedly recreating the Activity during a slow cold start — see
  // localSequenceAssignment.ts's header). appendEvent must recover on its
  // own, not just inherit the drifted counter.
  it("counter drift: recovers when device_seq_counter is stale/lower than an existing pending_events row", async () => {
    fakeDb.pendingEvents.set("already-synced-20", {
      client_event_id: "already-synced-20",
      device_id: "device-1",
      employee_id: "emp-1",
      device_seq: 20,
      event_type: "activity_switch",
      occurred_at_utc: "2026-09-14T17:23:24.055Z",
      local_tz_offset_minutes: 480,
      sync_status: "synced",
      sync_attempts: 1,
    });
    fakeDb.deviceSeqCounter.set("device-1", { device_id: "device-1", next_seq: 5 }); // drifted low

    const store = getLocalEventStore();
    const result = await store.appendEvent(ev());
    expect(result.deviceSeq).toBe(21);
  });

  it("existing pending sequence: a live (not-yet-synced) row at the computed seq is treated the same as an acknowledged one — floors above it", async () => {
    fakeDb.pendingEvents.set("still-pending-20", {
      client_event_id: "still-pending-20",
      device_id: "device-1",
      employee_id: "emp-1",
      device_seq: 20,
      event_type: "break_start",
      occurred_at_utc: "2026-09-14T17:00:00.000Z",
      local_tz_offset_minutes: 480,
      sync_status: "pending",
      sync_attempts: 0,
    });
    fakeDb.deviceSeqCounter.set("device-1", { device_id: "device-1", next_seq: 5 });

    const store = getLocalEventStore();
    const result = await store.appendEvent(ev());
    expect(result.deviceSeq).toBe(21);
  });

  it("acknowledged sequences: floors above the highest synced row even if the counter and every other pending row were pruned away", async () => {
    fakeDb.pendingEvents.set("synced-only-row", {
      client_event_id: "synced-only-row",
      device_id: "device-1",
      employee_id: "emp-1",
      device_seq: 9,
      event_type: "work_start",
      occurred_at_utc: "2026-09-14T11:00:00.000Z",
      local_tz_offset_minutes: 480,
      sync_status: "synced",
      sync_attempts: 1,
    });
    // No device_seq_counter row at all for this device — a fresh/reset
    // local identity that still happens to share a pending_events row.
    const store = getLocalEventStore();
    const result = await store.appendEvent(ev());
    expect(result.deviceSeq).toBe(10);
  });

  it("server sequence reconciliation: floors above the persisted server last_processed_seq after a local reset", async () => {
    const store = getLocalEventStore();
    await store.setServerLastProcessedSeq("device-1", 20);
    // Nothing else in local storage knows about seq 20 at all.
    const result = await store.appendEvent(ev());
    expect(result.deviceSeq).toBe(21);
  });

  it("same-client-event retry: re-appending with the identical clientEventId after it already landed returns the existing event, never a second row", async () => {
    const store = getLocalEventStore();
    const first = await store.appendEvent(ev({ clientEventId: "stable-tap-id" }));
    expect(first.deviceSeq).toBe(1);

    // Simulate the exact incident shape: something else already advanced
    // device_seq_counter to 1 again (as if a second, racing caller had
    // already reserved it) so a naive re-append would recompute seq 1 and
    // collide with the row THIS SAME logical tap already wrote.
    fakeDb.deviceSeqCounter.set("device-1", { device_id: "device-1", next_seq: 1 });

    const retry = await store.appendEvent(ev({ clientEventId: "stable-tap-id" }));
    expect(retry.deviceSeq).toBe(1);
    expect(retry.clientEventId).toBe("stable-tap-id");
    expect(fakeDb.pendingEvents.size).toBe(1); // never a second row
  });

  it("different-event collision: recalculates the floor and retries exactly once, succeeding on the retry", async () => {
    // A different event already occupies seq 1 (device_seq_counter wrongly
    // still says next_seq=1 too, forcing the first attempt to collide).
    fakeDb.pendingEvents.set("someone-elses-tap", {
      client_event_id: "someone-elses-tap",
      device_id: "device-1",
      employee_id: "emp-1",
      device_seq: 1,
      event_type: "break_start",
      occurred_at_utc: "2026-09-14T10:00:00.000Z",
      local_tz_offset_minutes: 480,
      sync_status: "pending",
      sync_attempts: 0,
    });
    fakeDb.deviceSeqCounter.set("device-1", { device_id: "device-1", next_seq: 1 });

    const store = getLocalEventStore();
    const result = await store.appendEvent(ev({ clientEventId: "my-new-tap" }));
    expect(result.deviceSeq).toBe(2);
    expect(fakeDb.pendingEvents.size).toBe(2);
  });

  // Never looped indefinitely — a SECOND collision (the bounded retry also
  // lands on an already-taken seq) must stop and throw a distinguishable
  // error rather than retry forever the way the real incident's background
  // sync did (the same identical error, once a second, for over half a
  // minute).
  it("never loops indefinitely: gives up with LocalSequenceAllocationError after the one bounded retry also collides", async () => {
    const store = getLocalEventStore();
    const originalRun = fakeDb.run.bind(fakeDb);
    let insertAttempts = 0;
    vi.spyOn(fakeDb, "run").mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("insert into pending_events")) {
        insertAttempts++;
        throw new Error("UNIQUE constraint failed: pending_events.device_id, pending_events.device_seq (code 2067)");
      }
      return originalRun(sql, params);
    });

    await expect(store.appendEvent(ev())).rejects.toThrow(LocalSequenceAllocationError);
    expect(insertAttempts).toBe(2); // exactly one initial attempt + one retry, never more
  });

  it("concurrent taps: two overlapping appendEvent calls never collide — the append lock serializes them into distinct sequential seqs", async () => {
    const store = getLocalEventStore();
    const [a, b] = await Promise.all([
      store.appendEvent(ev({ clientEventId: "concurrent-a" })),
      store.appendEvent(ev({ clientEventId: "concurrent-b" })),
    ]);
    const seqs = [a.deviceSeq, b.deviceSeq].sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2]);
    expect(fakeDb.pendingEvents.size).toBe(2);
  });

  // Restart recovery: a brand-new LocalEventStoreImpl instance (simulating
  // an app process restart — see WorkSessionContext's own investigation
  // finding that a restart alone did NOT clear the real incident, because
  // both device_seq_counter and pending_events live in the same persisted
  // file) reading the SAME underlying storage must still allocate correctly
  // on its very first call, with no in-memory state carried over.
  it("restart recovery: a freshly constructed store reading pre-existing (drifted) persisted state allocates correctly on its first call", async () => {
    fakeDb.pendingEvents.set("pre-existing-20", {
      client_event_id: "pre-existing-20",
      device_id: "device-1",
      employee_id: "emp-1",
      device_seq: 20,
      event_type: "activity_switch",
      occurred_at_utc: "2026-09-14T17:23:24.055Z",
      local_tz_offset_minutes: 480,
      sync_status: "synced",
      sync_attempts: 1,
    });
    fakeDb.deviceSeqCounter.set("device-1", { device_id: "device-1", next_seq: 5 });

    // __resetLocalEventStoreForTests() below stands in for "process
    // restart" — a fresh singleton, fresh in-memory dbPromise/appendLock,
    // same underlying fakeDb (the persisted file).
    __resetLocalEventStoreForTests();
    const restarted = getLocalEventStore();
    const result = await restarted.appendEvent(ev());
    expect(result.deviceSeq).toBe(21);
  });

  it("never deletes, renumbers, or overwrites an existing pending event, even across a collision+retry", async () => {
    fakeDb.pendingEvents.set("someone-elses-tap", {
      client_event_id: "someone-elses-tap",
      device_id: "device-1",
      employee_id: "emp-1",
      device_seq: 1,
      event_type: "break_start",
      occurred_at_utc: "2026-09-14T10:00:00.000Z",
      local_tz_offset_minutes: 480,
      sync_status: "pending",
      sync_attempts: 0,
    });
    fakeDb.deviceSeqCounter.set("device-1", { device_id: "device-1", next_seq: 1 });
    const before = { ...fakeDb.pendingEvents.get("someone-elses-tap") };

    const store = getLocalEventStore();
    await store.appendEvent(ev({ clientEventId: "my-new-tap" }));

    expect(fakeDb.pendingEvents.get("someone-elses-tap")).toEqual(before);
  });
});
