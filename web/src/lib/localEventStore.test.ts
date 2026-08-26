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

  // "Preserve the existing... conflict review" — a permanent rejection
  // (e.g. this device was reassigned/deactivated, or the target row/
  // activity no longer exists by the time it synced) must stay reviewable,
  // never silently dropped, and must never take any OTHER still-pending
  // local event down with it.
  it("a permanently rejected event stays reviewable via getConflictedEvents, and never touches an unrelated pending event", async () => {
    const store = getLocalEventStore();
    const rejected = await store.appendEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "activity_switch",
      occurredAtUtc: "2026-01-01T00:00:00.000Z",
      activityId: "activity-stale",
    });
    const stillPending = await store.appendEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "break_start",
      occurredAtUtc: "2026-01-01T00:05:00.000Z",
    });

    await store.markSyncResult(rejected.clientEventId, {
      clientEventId: rejected.clientEventId,
      status: "permanent_conflict",
      detail: { reason: "Activity is no longer active" },
    });

    const conflicts = await store.getConflictedEvents("device-1");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].clientEventId).toBe(rejected.clientEventId);
    expect(conflicts[0].serverResultJson).toContain("Activity is no longer active");

    // The unrelated event is completely unaffected — still pending, not
    // marked as a conflict, not lost.
    const pending = await store.getPendingEvents("device-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].clientEventId).toBe(stillPending.clientEventId);
    expect(pending[0].syncStatus).toBe("pending");
  });
});
