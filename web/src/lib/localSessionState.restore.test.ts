// Cold-start / Android-process-restart local restore — proves the screen
// can be rebuilt entirely from durable local storage (SQLite/IndexedDB),
// with no network call, after a simulated "force-close and reopen" (here:
// resetting the journal's module-level connection cache, same convention
// localEventStore.test.ts uses — the underlying IndexedDB data survives,
// exactly like a real Android process restart leaves the on-disk database
// untouched). Uses the REAL web local-event-store path (webEventJournal),
// not a mock, so this is a genuine end-to-end proof of "restore the screen
// immediately from SQLite and the local event ledger."
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

import { getLocalEventStore } from "./localEventStore";
import { __resetJournalConnectionForTests } from "./webEventJournal";
import { persistServerMeSnapshot, restoreLocalSessionState } from "./localSessionState";
import { MeResponse } from "../context/WorkSessionContext";

const DEVICE_ID = "device-1";
const EMPLOYEE_ID = "emp-1";

const serverIdleSnapshot: MeResponse = {
  employee: { id: EMPLOYEE_ID, firstName: "Byron", lastName: "Escober", preferredLanguage: null, securityRole: "Employee" },
  status: "idle",
  currentActivity: null,
  since: null,
  previousActivity: null,
  recentJobs: [],
};

async function resetJournal() {
  await __resetJournalConnectionForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase("labourlink_journal");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("deleteDatabase blocked by a connection from a previous test"));
  });
}

// Simulates the app process actually restarting — resets the module-level
// connection cache only, leaving whatever's already durably on disk
// (IndexedDB, backed by fake-indexeddb's in-memory store for the life of
// this test process) exactly as it was, same as a real Android restart
// leaves the on-device SQLite file untouched.
async function simulateRestart() {
  await __resetJournalConnectionForTests();
}

beforeEach(async () => {
  await resetJournal();
});

describe("restoreLocalSessionState", () => {
  it("returns null when this device has never been paired (nothing durable to restore)", async () => {
    const restored = await restoreLocalSessionState(DEVICE_ID, null);
    expect(restored).toBeNull();
  });

  it("restart while working: reconstructs status=work with the correct activity from a pending work_start event alone (never synced to the server)", async () => {
    const store = getLocalEventStore();
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "work_start",
      occurredAtUtc: "2026-08-25T15:00:00.000Z",
      activityId: "activity-winding",
      greenhouseRowId: "row-12",
    });

    await simulateRestart();

    const restored = await restoreLocalSessionState(DEVICE_ID, {
      employeeId: EMPLOYEE_ID,
      firstName: "Byron",
      lastName: "Escober",
      lastVerifiedAt: "2026-08-25T08:00:00.000Z",
    });

    expect(restored?.status).toBe("work");
    expect(restored?.currentActivity?.id).toBe("activity-winding");
    expect(restored?.currentActivity?.row?.id).toBe("row-12");
  });

  it("restart while on break: reconstructs status=break from a pending break_start on top of the last real server snapshot", async () => {
    await persistServerMeSnapshot({
      ...serverIdleSnapshot,
      status: "work",
      currentActivity: {
        id: "activity-picking",
        name: "Picking",
        startedAt: "2026-08-25T13:00:00.000Z",
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: 0,
        row: null,
        carrier: null,
      },
    });
    const store = getLocalEventStore();
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "break_start",
      occurredAtUtc: "2026-08-25T15:30:00.000Z",
    });

    await simulateRestart();

    const restored = await restoreLocalSessionState(DEVICE_ID, {
      employeeId: EMPLOYEE_ID,
      firstName: "Byron",
      lastName: "Escober",
      lastVerifiedAt: "2026-08-25T08:00:00.000Z",
    });

    expect(restored?.status).toBe("break");
    // The interrupted run's own accumulated time carries forward into
    // previousActivity — proves the fold, not just a blank slate.
    expect(restored?.previousActivity?.id).toBe("activity-picking");
  });

  it("restart with multiple pending events: replays the full chain in order (work -> break -> resume -> new row) to the correct final state", async () => {
    const store = getLocalEventStore();
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "work_start",
      occurredAtUtc: "2026-08-25T11:00:00.000Z",
      activityId: "activity-winding",
      greenhouseRowId: "row-1",
    });
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "break_start",
      occurredAtUtc: "2026-08-25T13:00:00.000Z",
    });
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "break_end",
      occurredAtUtc: "2026-08-25T13:15:00.000Z",
      activityId: "activity-winding",
      greenhouseRowId: "row-1",
    });
    // The exact scenario from the brief: select the NEXT row after coming
    // back from a break, entirely offline, before any restart happens.
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "activity_switch",
      occurredAtUtc: "2026-08-25T15:00:00.000Z",
      activityId: "activity-winding",
      greenhouseRowId: "row-2",
    });

    await simulateRestart();

    const restored = await restoreLocalSessionState(DEVICE_ID, {
      employeeId: EMPLOYEE_ID,
      firstName: "Byron",
      lastName: "Escober",
      lastVerifiedAt: "2026-08-25T08:00:00.000Z",
    });

    expect(restored?.status).toBe("work");
    expect(restored?.currentActivity?.row?.id).toBe("row-2");

    const pending = await store.getPendingEvents(DEVICE_ID);
    expect(pending).toHaveLength(4); // nothing lost across the restart
  });

  it("falls back to an idle default built from the cached employee when this device has never received a real server response yet, still folding pending events on top", async () => {
    const store = getLocalEventStore();
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "work_start",
      occurredAtUtc: "2026-08-25T09:00:00.000Z",
      activityId: "activity-first-ever",
    });

    await simulateRestart();

    const restored = await restoreLocalSessionState(DEVICE_ID, {
      employeeId: EMPLOYEE_ID,
      firstName: "Brand",
      lastName: "New",
      lastVerifiedAt: "2026-08-25T08:00:00.000Z",
    });

    expect(restored?.employee.firstName).toBe("Brand");
    expect(restored?.status).toBe("work");
    expect(restored?.currentActivity?.id).toBe("activity-first-ever");
  });

  it("persistServerMeSnapshot persists the RAW response, not a folded one — a later restore folds CURRENTLY pending events onto it, never double-applying an event already baked into an earlier snapshot", async () => {
    await persistServerMeSnapshot(serverIdleSnapshot);
    const store = getLocalEventStore();
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "work_start",
      occurredAtUtc: "2026-08-25T10:00:00.000Z",
      activityId: "activity-a",
    });

    await simulateRestart();
    const firstRestore = await restoreLocalSessionState(DEVICE_ID, null);
    expect(firstRestore?.currentActivity?.id).toBe("activity-a");

    // The event syncs successfully (no longer pending) — simulating a
    // background sync round completing before the next restart.
    const [evt] = await store.getPendingEvents(DEVICE_ID);
    await store.markSyncResult(evt.clientEventId, { clientEventId: evt.clientEventId, status: "accepted" });

    // A brand new local action happens after that sync.
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "activity_switch",
      occurredAtUtc: "2026-08-25T11:00:00.000Z",
      activityId: "activity-b",
    });

    await simulateRestart();
    const secondRestore = await restoreLocalSessionState(DEVICE_ID, null);
    // Reflects the newest action, derived from exactly one still-pending
    // event folded onto the untouched original snapshot — not a
    // double-application artifact of a previously-folded snapshot.
    expect(secondRestore?.currentActivity?.id).toBe("activity-b");
    const stillPending = await store.getPendingEvents(DEVICE_ID);
    expect(stillPending).toHaveLength(1);
  });

  // Real reported v1.3 defect (Marshall Dela Cruz, offline): after
  // selecting Row 644/Bin 11 then changing only the carrier to Bin 14,
  // force-closing and reopening before either event synced must still show
  // Row 644/Bin 14 — not the "Where?"/"Which Carrier?" placeholders a
  // wiped row/carrier would fall back to. Uses the real IndexedDB-backed
  // store end to end, same as the other restart scenarios in this file.
  it("force-close/reopen before sync: Row 644/Bin 11 -> Bin 14 (carrier-only edit) restores as Row 644/Bin 14, not blank", async () => {
    const store = getLocalEventStore();
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "activity_switch",
      occurredAtUtc: "2026-08-27T14:00:00.000Z",
      activityId: "activity-picking-peppers",
      greenhouseRowId: "row-644",
      carrierId: "carrier-bin-11",
    });
    await store.appendEvent({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      eventType: "activity_switch",
      occurredAtUtc: "2026-08-27T14:05:00.000Z",
      activityId: "activity-picking-peppers",
      greenhouseRowId: null, // row unchanged — not resubmitted, exactly like a real carrier-only edit
      carrierId: "carrier-bin-14",
    });

    await simulateRestart();

    const restored = await restoreLocalSessionState(DEVICE_ID, {
      employeeId: EMPLOYEE_ID,
      firstName: "Redacted",
      lastName: "Employee",
      lastVerifiedAt: "2026-08-27T08:00:00.000Z",
    });

    expect(restored?.status).toBe("work");
    expect(restored?.currentActivity?.row?.id).toBe("row-644");
    expect(restored?.currentActivity?.carrier?.id).toBe("carrier-bin-14");
    const pending = await store.getPendingEvents(DEVICE_ID);
    expect(pending).toHaveLength(2); // both events survive the restart untouched
  });
});
