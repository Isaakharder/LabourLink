// Native-IndexedDB-backed durable event journal for the web/PWA platform
// ONLY (native Android never imports this file — it uses real SQLite via
// @capacitor-community/sqlite directly, which has none of the problems
// this exists to work around).
//
// Real incident this replaces jeep-sqlite/WASM SQLite for: on iOS Safari's
// standalone "Add to Home Screen" PWA, jeep-sqlite's saveToStore() (which
// re-exports its ENTIRE in-memory database and writes the blob to
// IndexedDB) was observed to hang indefinitely — and because the
// connection used to reach it is a module-level memoized singleton
// (sqlite/bootstrap.ts's connectionPromise, and this file's own former
// dbPromise equivalent), ONE hang permanently poisoned every future local
// write for the rest of the session: appendEvent() -> getDb() -> the same
// stuck promise -> hangs forever -> perform()'s try/finally never
// completes (a hang isn't a rejection — finally only runs once the
// awaited promise SETTLES) -> every button stays disabled forever. Two
// earlier, narrower fixes (a timeout on one caller's read, and making the
// LATER saveToStore() call fire-and-forget) did not touch this: the hang
// is earlier, in the CONNECTION step itself, and the singleton caching
// meant even a successfully-recovered caller left the underlying
// connection poisoned for everyone after it.
//
// This module never touches jeep-sqlite, WASM, or a full-database export.
// Every operation is a small, targeted native indexedDB read/write — the
// browser's own built-in per-record durability, not an emulated SQL layer
// on top of it. Every request (open, transaction) is wrapped in a bounded
// timeout that, on expiry, clears the cached connection promise so the
// NEXT call gets a fresh attempt instead of being stuck behind a
// permanently-poisoned one — see openDb()'s own comment.
import { uuid } from "./uuid";

const DB_NAME = "labourlink_journal";
const DB_VERSION = 1;
const STORE_PENDING_EVENTS = "pending_events";
const STORE_SEQ_COUNTER = "device_seq_counter";
const STORE_KV = "kv_cache";
const INDEX_BY_DEVICE_STATUS = "by_device_status";
const INDEX_BY_DEVICE_SEQ = "by_device_seq";

export type JournalEventType = "work_start" | "activity_switch" | "break_start" | "break_end" | "end_day";
export type JournalSyncStatus = "pending" | "syncing" | "synced" | "conflict";

export interface NewJournalEvent {
  deviceId: string;
  employeeId: string;
  eventType: JournalEventType;
  occurredAtUtc: string;
  activityId?: string | null;
  greenhouseRowId?: string | null;
  carrierId?: string | null;
  answers?: Record<string, unknown> | null;
  densitySnapshot?: { densityType: "plants" | "stems"; densityCountPerRow: number } | null;
  configRevision?: string | null;
  // Optional, caller-supplied stable id for retry-safety: if a tap times
  // out client-side but the original attempt actually lands moments
  // later, retrying with the SAME clientEventId must not create a second
  // event. Omitted callers get a fresh uuid() minted here, same as always.
  clientEventId?: string;
}

export interface JournalEvent extends Required<Omit<NewJournalEvent, "clientEventId">> {
  clientEventId: string;
  deviceSeq: number;
  localTzOffsetMinutes: number;
  createdAtLocal: string;
  syncStatus: JournalSyncStatus;
  syncAttempts: number;
  lastSyncError: string | null;
  serverResultJson: string | null;
}

export interface JournalSyncResult {
  clientEventId: string;
  status: "accepted" | "duplicate" | "retryable_failure" | "permanent_conflict" | "sequence_gap";
  detail?: unknown;
}

function isoNow(): string {
  return new Date().toISOString();
}

function localTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  // Both losing sides of the race get a no-op safety catch: `promise` may
  // settle later on its own (a slow-but-not-truly-hung request finally
  // firing after we've stopped waiting on it), and `timeout`'s own
  // rejection can otherwise surface as a spurious unhandled-rejection
  // warning under fake timers, which resolve/reject many ticks in a
  // single synchronous burst — a known artifact of Promise.race combined
  // with a setTimeout-based rejection, not a sign either promise is
  // genuinely uncaught (the caller below always awaits the raced result).
  promise.catch(() => {});
  const race = Promise.race([promise, timeout]);
  race.catch(() => {});
  return race.finally(() => clearTimeout(timer));
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

const OPEN_TIMEOUT_MS = 3000;
const TRANSACTION_TIMEOUT_MS = 3000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDbAttempt(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PENDING_EVENTS)) {
        const store = db.createObjectStore(STORE_PENDING_EVENTS, { keyPath: "clientEventId" });
        store.createIndex(INDEX_BY_DEVICE_SEQ, ["deviceId", "deviceSeq"], { unique: true });
        store.createIndex(INDEX_BY_DEVICE_STATUS, ["deviceId", "syncStatus"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SEQ_COUNTER)) {
        db.createObjectStore(STORE_SEQ_COUNTER, { keyPath: "deviceId" });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: "cacheKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    // A second, older-version connection left open in another tab blocks
    // a version-bump upgrade — surfaced as a real, actionable rejection
    // rather than left to hang silently (there's only ever one DB_VERSION
    // today, so this is defensive for the day there's a second one).
    req.onblocked = () => reject(new Error("IndexedDB open blocked by another open connection"));
  });
}

// The core "must not permanently poison the cached initialization promise"
// requirement: openDb() is memoized (repeat callers within the same
// successful session reuse one open connection, avoiding a fresh
// indexedDB.open() per call) — but the memoized promise is cleared the
// moment it fails OR times out, so the very next call gets a genuinely
// fresh attempt instead of being permanently stuck behind a hung one. The
// original hung request may still resolve later in the background after
// we stop waiting on it here; nothing holds a reference to it once
// dbPromise is cleared, so it's simply garbage collected.
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = withTimeout(openDbAttempt(), OPEN_TIMEOUT_MS, "IndexedDB open").catch((err) => {
    if (dbPromise === attempt) dbPromise = null;
    throw err;
  });
  dbPromise = attempt;
  return attempt;
}

// Every read/write below goes through one bounded-timeout transaction —
// same "never let a hang wait forever, never let a failure poison future
// calls" posture as openDb() above, at the per-operation level. `fn` must
// only issue IDBRequests (or await their promises) — never an unrelated
// macrotask like fetch()/setTimeout mid-transaction, which would let the
// browser auto-commit the transaction early and throw
// TransactionInactiveError on the next request.
async function runTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  const db = await openDb();
  return withTimeout(
    new Promise<T>((resolve, reject) => {
      let settled = false;
      let result: T;
      const tx = db.transaction(storeNames, mode);
      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      tx.onerror = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error("IndexedDB transaction failed"));
        }
      };
      tx.onabort = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        }
      };
      fn(tx)
        .then((r) => {
          result = r;
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
          try {
            tx.abort();
          } catch {
            // already finished — nothing to abort
          }
        });
    }),
    TRANSACTION_TIMEOUT_MS,
    "IndexedDB transaction"
  );
}

function toJournalEvent(row: Record<string, unknown>): JournalEvent {
  return {
    clientEventId: String(row.clientEventId),
    deviceId: String(row.deviceId),
    employeeId: String(row.employeeId),
    deviceSeq: Number(row.deviceSeq),
    eventType: row.eventType as JournalEventType,
    occurredAtUtc: String(row.occurredAtUtc),
    localTzOffsetMinutes: Number(row.localTzOffsetMinutes),
    activityId: (row.activityId as string | null) ?? null,
    greenhouseRowId: (row.greenhouseRowId as string | null) ?? null,
    carrierId: (row.carrierId as string | null) ?? null,
    answers: (row.answers as Record<string, unknown> | null) ?? null,
    densitySnapshot: (row.densitySnapshot as JournalEvent["densitySnapshot"]) ?? null,
    configRevision: (row.configRevision as string | null) ?? null,
    createdAtLocal: String(row.createdAtLocal),
    syncStatus: row.syncStatus as JournalSyncStatus,
    syncAttempts: Number(row.syncAttempts),
    lastSyncError: (row.lastSyncError as string | null) ?? null,
    serverResultJson: (row.serverResultJson as string | null) ?? null,
  };
}

// Durable local write + immediate device_seq assignment, one IndexedDB
// transaction — both the counter bump and the event insert commit
// together or not at all. If `event.clientEventId` is supplied and a
// record with that id already exists (a retry of a tap whose first
// attempt timed out client-side but actually landed), the existing record
// is returned as-is rather than inserted again — the whole point of
// accepting a caller-supplied id at all (see NewJournalEvent's comment).
export async function appendJournalEvent(event: NewJournalEvent): Promise<JournalEvent> {
  const clientEventId = event.clientEventId ?? uuid();
  const createdAtLocal = isoNow();
  const tzOffset = localTzOffsetMinutes();

  return runTransaction([STORE_PENDING_EVENTS, STORE_SEQ_COUNTER], "readwrite", async (tx) => {
    const eventsStore = tx.objectStore(STORE_PENDING_EVENTS);

    const existing = await reqToPromise(eventsStore.get(clientEventId));
    if (existing) {
      return toJournalEvent(existing as Record<string, unknown>);
    }

    const counterStore = tx.objectStore(STORE_SEQ_COUNTER);
    const counterRow = (await reqToPromise(counterStore.get(event.deviceId))) as
      | { deviceId: string; nextSeq: number }
      | undefined;
    const deviceSeq = counterRow?.nextSeq ?? 1;
    await reqToPromise(counterStore.put({ deviceId: event.deviceId, nextSeq: deviceSeq + 1 }));

    const record: Record<string, unknown> = {
      clientEventId,
      deviceId: event.deviceId,
      employeeId: event.employeeId,
      deviceSeq,
      eventType: event.eventType,
      occurredAtUtc: event.occurredAtUtc,
      localTzOffsetMinutes: tzOffset,
      activityId: event.activityId ?? null,
      greenhouseRowId: event.greenhouseRowId ?? null,
      carrierId: event.carrierId ?? null,
      answers: event.answers ?? null,
      densitySnapshot: event.densitySnapshot ?? null,
      configRevision: event.configRevision ?? null,
      createdAtLocal,
      syncStatus: "pending" satisfies JournalSyncStatus,
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    };
    await reqToPromise(eventsStore.add(record));
    return toJournalEvent(record);
  });
}

export async function getPendingJournalEvents(deviceId: string, limit = 50): Promise<JournalEvent[]> {
  return runTransaction([STORE_PENDING_EVENTS], "readonly", async (tx) => {
    const store = tx.objectStore(STORE_PENDING_EVENTS);
    const index = store.index(INDEX_BY_DEVICE_STATUS);
    const results: JournalEvent[] = [];
    for (const status of ["pending", "syncing"] as JournalSyncStatus[]) {
      const range = IDBKeyRange.only([deviceId, status]);
      const rows = await reqToPromise(index.getAll(range));
      results.push(...(rows as Record<string, unknown>[]).map(toJournalEvent));
    }
    results.sort((a, b) => a.deviceSeq - b.deviceSeq);
    return results.slice(0, limit);
  });
}

async function getAllForDevice(deviceId: string): Promise<JournalEvent[]> {
  return runTransaction([STORE_PENDING_EVENTS], "readonly", async (tx) => {
    const store = tx.objectStore(STORE_PENDING_EVENTS);
    const index = store.index(INDEX_BY_DEVICE_SEQ);
    const range = IDBKeyRange.bound([deviceId, -Infinity], [deviceId, Infinity]);
    const rows = await reqToPromise(index.getAll(range));
    return (rows as Record<string, unknown>[]).map(toJournalEvent).sort((a, b) => a.deviceSeq - b.deviceSeq);
  });
}

export async function getLatestJournalEventForDevice(deviceId: string): Promise<JournalEvent | null> {
  const all = await getAllForDevice(deviceId);
  return all.length ? all[all.length - 1] : null;
}

export async function getLatestWorkJournalEventForDevice(deviceId: string): Promise<JournalEvent | null> {
  const all = await getAllForDevice(deviceId);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].eventType === "work_start" || all[i].eventType === "activity_switch" || all[i].eventType === "break_end") {
      return all[i];
    }
  }
  return null;
}

export async function markJournalSyncResult(clientEventId: string, result: JournalSyncResult): Promise<void> {
  await runTransaction([STORE_PENDING_EVENTS], "readwrite", async (tx) => {
    const store = tx.objectStore(STORE_PENDING_EVENTS);
    const existing = (await reqToPromise(store.get(clientEventId))) as Record<string, unknown> | undefined;
    if (!existing) return undefined as unknown as void;
    const newStatus: JournalSyncStatus =
      result.status === "accepted" || result.status === "duplicate"
        ? "synced"
        : result.status === "retryable_failure" || result.status === "sequence_gap"
          ? "pending"
          : "conflict";
    existing.syncStatus = newStatus;
    existing.syncAttempts = Number(existing.syncAttempts ?? 0) + 1;
    existing.lastSyncError = result.status === "accepted" || result.status === "duplicate" ? null : result.status;
    existing.serverResultJson = JSON.stringify(result);
    await reqToPromise(store.put(existing));
    return undefined as unknown as void;
  });
}

export async function getPendingJournalCount(deviceId: string): Promise<number> {
  const pending = await getPendingJournalEvents(deviceId, Number.MAX_SAFE_INTEGER);
  return pending.length;
}

export async function getConflictedJournalEvents(deviceId: string): Promise<JournalEvent[]> {
  return runTransaction([STORE_PENDING_EVENTS], "readonly", async (tx) => {
    const store = tx.objectStore(STORE_PENDING_EVENTS);
    const index = store.index(INDEX_BY_DEVICE_STATUS);
    const range = IDBKeyRange.only([deviceId, "conflict"]);
    const rows = await reqToPromise(index.getAll(range));
    return (rows as Record<string, unknown>[]).map(toJournalEvent).sort((a, b) => b.deviceSeq - a.deviceSeq);
  });
}

export async function pruneJournalSyncedOlderThan(deviceId: string, cutoffIso: string): Promise<number> {
  return runTransaction([STORE_PENDING_EVENTS], "readwrite", async (tx) => {
    const store = tx.objectStore(STORE_PENDING_EVENTS);
    const index = store.index(INDEX_BY_DEVICE_STATUS);
    const range = IDBKeyRange.only([deviceId, "synced"]);
    const rows = (await reqToPromise(index.getAll(range))) as Record<string, unknown>[];
    let deleted = 0;
    for (const row of rows) {
      if (String(row.createdAtLocal) < cutoffIso) {
        await reqToPromise(store.delete(String(row.clientEventId)));
        deleted++;
      }
    }
    return deleted;
  });
}

export async function getJournalCachedJson<T>(cacheKey: string): Promise<{ value: T; cachedAt: string } | null> {
  return runTransaction([STORE_KV], "readonly", async (tx) => {
    const store = tx.objectStore(STORE_KV);
    const row = (await reqToPromise(store.get(cacheKey))) as { jsonValue: string; cachedAt: string } | undefined;
    if (!row) return null;
    return { value: JSON.parse(row.jsonValue) as T, cachedAt: row.cachedAt };
  });
}

export async function setJournalCachedJson(cacheKey: string, value: unknown): Promise<void> {
  await runTransaction([STORE_KV], "readwrite", async (tx) => {
    const store = tx.objectStore(STORE_KV);
    await reqToPromise(store.put({ cacheKey, jsonValue: JSON.stringify(value), cachedAt: isoNow() }));
    return undefined as unknown as void;
  });
}

// Test-only escape hatch — closes and clears the memoized connection so
// each test starts from a genuinely fresh state instead of reusing a
// connection (or a poisoned promise) left over from a previous test.
// Actually calling .close() matters: indexedDB.deleteDatabase() blocks
// (fires onblocked, never onsuccess) as long as ANY connection to that
// database is still open, even one nothing references anymore — clearing
// just the promise variable isn't enough to let a test's own cleanup
// delete the database.
export async function __resetJournalConnectionForTests(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return;
  try {
    const db = await pending;
    db.close();
  } catch {
    // already failed/timed out — nothing open to close
  }
}
