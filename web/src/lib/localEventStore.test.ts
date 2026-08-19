// Regression coverage for the local-first write path on the web platform,
// now routed entirely through webEventJournal.ts (native IndexedDB) rather
// than jeep-sqlite/WASM SQLite — see localEventStore.ts's own header
// comment for the real production incident (iOS Safari PWA: tapping
// "General" froze the UI forever) this replaced that architecture to fix.
// webEventJournal.test.ts covers the journal's own internals (timeouts,
// idempotent retries, non-poisoning connection) in depth; this file proves
// LocalEventStoreImpl correctly delegates to it on the web platform.
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

import { getLocalEventStore } from "./localEventStore";
import { __resetJournalConnectionForTests } from "./webEventJournal";

describe("LocalEventStoreImpl on the web platform", () => {
  beforeEach(async () => {
    await __resetJournalConnectionForTests();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("labourlink_journal");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("deleteDatabase blocked by a connection from a previous test"));
    });
  });

  it("appendEvent commits durably and resolves quickly (never touches jeep-sqlite/WASM)", async () => {
    const store = getLocalEventStore();
    const start = Date.now();
    const event = await store.appendEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: new Date().toISOString(),
      activityId: "activity-general",
    });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(event.deviceSeq).toBe(1);
    expect(event.syncStatus).toBe("pending");

    const pending = await store.getPendingEvents("device-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].clientEventId).toBe(event.clientEventId);
  });

  it("retrying appendEvent with the same clientEventId never creates a duplicate", async () => {
    const store = getLocalEventStore();
    const stableId = "tap-retry-id-1";
    const first = await store.appendEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: "2026-01-01T00:00:00.000Z",
      activityId: "activity-general",
      clientEventId: stableId,
    });
    const retry = await store.appendEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: "2026-01-01T00:00:09.000Z",
      activityId: "activity-general",
      clientEventId: stableId,
    });

    expect(retry.clientEventId).toBe(first.clientEventId);
    const pending = await store.getPendingEvents("device-1");
    expect(pending).toHaveLength(1);
  });

  it("getLatestWorkEventForDevice resolves what a break should resume", async () => {
    const store = getLocalEventStore();
    await store.appendEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: new Date().toISOString(),
      activityId: "activity-general",
    });
    const latestWork = await store.getLatestWorkEventForDevice("device-1");
    expect(latestWork?.activityId).toBe("activity-general");
  });
});
