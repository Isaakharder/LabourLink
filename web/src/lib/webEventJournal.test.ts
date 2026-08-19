// Real IndexedDB semantics (fake-indexeddb — a full, spec-accurate
// implementation for Node/jsdom, not a hand-rolled mock) so transaction
// timing/auto-commit behavior is genuinely representative, not guessed at.
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("webEventJournal", () => {
  beforeEach(async () => {
    // Fresh IndexedDB per test — fake-indexeddb keeps state in a module-
    // level map, so explicitly delete the DB and reset the journal's own
    // memoized connection between tests. The reset must actually .close()
    // any open connection first (not just drop the JS reference to it) —
    // deleteDatabase() blocks (onblocked, never onsuccess) for as long as
    // any connection stays open, same real IndexedDB semantics being
    // tested here, not a quirk of the fake.
    const { __resetJournalConnectionForTests } = await import("./webEventJournal");
    await __resetJournalConnectionForTests();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("labourlink_journal");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("deleteDatabase blocked — a connection from a previous test is still open"));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("appends an event and reads it back as pending", async () => {
    const { appendJournalEvent, getPendingJournalEvents } = await import("./webEventJournal");
    const event = await appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: new Date().toISOString(),
      activityId: "activity-1",
    });
    expect(event.deviceSeq).toBe(1);
    expect(event.syncStatus).toBe("pending");

    const pending = await getPendingJournalEvents("device-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].clientEventId).toBe(event.clientEventId);
    expect(pending[0].activityId).toBe("activity-1");
  });

  it("assigns strictly increasing deviceSeq across multiple events", async () => {
    const { appendJournalEvent } = await import("./webEventJournal");
    const e1 = await appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: new Date().toISOString(),
    });
    const e2 = await appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "activity_switch",
      occurredAtUtc: new Date().toISOString(),
    });
    const e3 = await appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "activity_switch",
      occurredAtUtc: new Date().toISOString(),
    });
    expect([e1.deviceSeq, e2.deviceSeq, e3.deviceSeq]).toEqual([1, 2, 3]);
  });

  it("retrying with the same clientEventId returns the existing event instead of creating a duplicate", async () => {
    const { appendJournalEvent, getPendingJournalEvents } = await import("./webEventJournal");
    const stableId = "retry-stable-id-1";
    const first = await appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: "2026-01-01T00:00:00.000Z",
      activityId: "activity-general",
      clientEventId: stableId,
    });
    const retry = await appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: "2026-01-01T00:00:05.000Z", // even a different tap-time on retry
      activityId: "activity-general",
      clientEventId: stableId,
    });

    expect(retry.clientEventId).toBe(first.clientEventId);
    expect(retry.deviceSeq).toBe(first.deviceSeq);
    expect(retry.occurredAtUtc).toBe(first.occurredAtUtc); // the original wins, not the retry's

    const pending = await getPendingJournalEvents("device-1");
    expect(pending).toHaveLength(1); // exactly one event, never two
  });

  it(
    "a hung indexedDB.open() times out and does not poison future calls (the core incident)",
    async () => {
      // Real timers deliberately, not fake ones: Promise.race raced
      // against a setTimeout-based rejection, combined with fake timers
      // firing many virtual milliseconds in one synchronous burst, is a
      // known source of spurious PromiseRejectionHandledWarning noise in
      // Node even when the rejection genuinely is handled (verified: the
      // assertions below pass either way) — real timers sidestep that
      // noise entirely for this one test, at the cost of it taking a few
      // real seconds.
      const realOpen = indexedDB.open.bind(indexedDB);
      const openSpy = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
        // Simulate the real-world hang: a request that never fires
        // onsuccess/onerror/onupgradeneeded at all.
        return { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null } as unknown as IDBOpenDBRequest;
      });

      const { appendJournalEvent } = await import("./webEventJournal");
      await expect(
        appendJournalEvent({
          deviceId: "device-1",
          employeeId: "emp-1",
          eventType: "work_start",
          occurredAtUtc: new Date().toISOString(),
        })
      ).rejects.toThrow(/timed out/);

      // The hung open() is done being used — restore the real
      // implementation for the retry, proving the NEXT call gets a
      // genuinely fresh attempt rather than being stuck behind the
      // poisoned promise from the first.
      openSpy.mockRestore();
      vi.spyOn(indexedDB, "open").mockImplementation(realOpen);

      const retry = await appendJournalEvent({
        deviceId: "device-1",
        employeeId: "emp-1",
        eventType: "work_start",
        occurredAtUtc: new Date().toISOString(),
      });
      expect(retry.deviceSeq).toBe(1);
    },
    10000
  );

  it("markJournalSyncResult transitions status correctly and getPendingJournalEvents excludes synced events", async () => {
    const { appendJournalEvent, getPendingJournalEvents, markJournalSyncResult } = await import("./webEventJournal");
    const event = await appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: new Date().toISOString(),
    });
    await markJournalSyncResult(event.clientEventId, { clientEventId: event.clientEventId, status: "accepted" });

    const pending = await getPendingJournalEvents("device-1");
    expect(pending).toHaveLength(0);
  });

  it("kv cache (used for reference data and sync meta) round-trips", async () => {
    const { getJournalCachedJson, setJournalCachedJson } = await import("./webEventJournal");
    await setJournalCachedJson("activities", { activities: [{ id: "a1", name: "General" }] });
    const result = await getJournalCachedJson<{ activities: { id: string; name: string }[] }>("activities");
    expect(result?.value.activities[0].name).toBe("General");
  });

  it("survives an immediate close/reopen — the selected job is still there after a simulated app restart", async () => {
    const journal = await import("./webEventJournal");
    const event = await journal.appendJournalEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: new Date().toISOString(),
      activityId: "activity-general",
    });

    // Simulate the app being closed immediately after the tap: tear down
    // the in-memory connection WITHOUT deleting the underlying database —
    // real IndexedDB data outlives the page/tab, only the open connection
    // object doesn't.
    await journal.__resetJournalConnectionForTests();

    // A "reopen" is just the next call — openDb() inside the journal has
    // no cached connection anymore, so this exercises a genuinely fresh
    // indexedDB.open() against the same on-disk (well, on-fake-disk) data.
    const afterRestart = await journal.getPendingJournalEvents("device-1");
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0].clientEventId).toBe(event.clientEventId);
    expect(afterRestart[0].activityId).toBe("activity-general");
  });
});
