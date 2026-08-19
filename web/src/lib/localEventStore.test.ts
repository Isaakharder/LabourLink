// Regression test for a real production incident: on iOS Safari's
// standalone PWA, every button tap was visibly slow. Root cause:
// persistIfWeb()'s saveToStore() call — which re-exports jeep-sqlite's
// ENTIRE in-memory database to IndexedDB, an O(database size) operation —
// was awaited synchronously before every write (appendEvent, etc.)
// returned, directly in the hot per-tap path. This proves appendEvent()
// now resolves without waiting for that persist to finish, not just that
// it typechecks.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSqliteConnectionMock, isNativeSqliteMock, saveToStoreMock } = vi.hoisted(() => ({
  getSqliteConnectionMock: vi.fn(),
  isNativeSqliteMock: vi.fn(() => false),
  saveToStoreMock: vi.fn(),
}));

vi.mock("./sqlite/bootstrap", () => ({
  getSqliteConnection: getSqliteConnectionMock,
  isNativeSqlite: isNativeSqliteMock,
}));

vi.mock("./sqlite/schema", () => ({
  DB_NAME: "labourlink_test",
  MIGRATIONS: [],
}));

import { getLocalEventStore } from "./localEventStore";

function makeMockDb() {
  const rows: Record<string, unknown>[] = [];
  return {
    open: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ values: rows }),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    rollbackTransaction: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue({ changes: { changes: 1 } }),
  };
}

describe("LocalEventStoreImpl web persistence (appendEvent)", () => {
  beforeEach(() => {
    vi.resetModules();
    saveToStoreMock.mockReset();
    isNativeSqliteMock.mockReturnValue(false);

    const mockDb = makeMockDb();
    getSqliteConnectionMock.mockResolvedValue({
      checkConnectionsConsistency: vi.fn().mockResolvedValue({ result: false }),
      isConnection: vi.fn().mockResolvedValue({ result: false }),
      retrieveConnection: vi.fn().mockResolvedValue(mockDb),
      createConnection: vi.fn().mockResolvedValue(mockDb),
      saveToStore: saveToStoreMock,
    });
  });

  it("resolves without waiting for a slow saveToStore() to finish", async () => {
    let saveToStoreResolve!: () => void;
    saveToStoreMock.mockReturnValue(
      new Promise<void>((resolve) => {
        saveToStoreResolve = resolve;
      })
    );

    const store = getLocalEventStore();
    const start = Date.now();
    await store.appendEvent({
      deviceId: "device-1",
      employeeId: "emp-1",
      eventType: "work_start",
      occurredAtUtc: new Date().toISOString(),
    });
    const elapsed = Date.now() - start;

    // saveToStore() is still pending (never resolved) — appendEvent
    // returned anyway. Before the fix, this awaited saveToStore directly,
    // so the test would hang here (and time out) instead of reaching this
    // assertion.
    expect(elapsed).toBeLessThan(1000);
    expect(saveToStoreMock).toHaveBeenCalled();

    saveToStoreResolve();
  });
});
