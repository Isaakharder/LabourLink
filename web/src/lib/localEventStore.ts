// The durable, offline-first local event log — the single source of truth
// for "what does this phone believe just happened," on both native Android
// (real SQLite via @capacitor-community/sqlite) and the browser/PWA (the
// same plugin's jeep-sqlite/IndexedDB backend, same schema, same queries).
// Every mobile time-tracking action goes through appendEvent() here FIRST,
// online or offline alike — see WorkSessionContext.tsx, which no longer
// branches on navigator.onLine at all for the local half of an action.
import { getSqliteConnection, isNativeSqlite } from "./sqlite/bootstrap";
import { DB_NAME, MIGRATIONS } from "./sqlite/schema";
import { uuid } from "./uuid";

export type LocalEventType = "work_start" | "activity_switch" | "break_start" | "break_end" | "end_day";

export interface NewLocalEvent {
  deviceId: string;
  employeeId: string;
  eventType: LocalEventType;
  occurredAtUtc: string; // ISO8601 — the true tap-time, captured by the caller before calling this
  activityId?: string | null;
  greenhouseRowId?: string | null;
  carrierId?: string | null;
  answers?: Record<string, unknown> | null;
  densitySnapshot?: { densityType: "plants" | "stems"; densityCountPerRow: number } | null;
  configRevision?: string | null;
}

export interface LocalEvent extends NewLocalEvent {
  clientEventId: string;
  deviceSeq: number;
  localTzOffsetMinutes: number;
  createdAtLocal: string;
  syncStatus: "pending" | "syncing" | "synced" | "conflict";
  syncAttempts: number;
  lastSyncError: string | null;
  serverResultJson: string | null;
}

export type SyncResultStatus = "accepted" | "duplicate" | "retryable_failure" | "permanent_conflict" | "sequence_gap";

export interface SyncResult {
  clientEventId: string;
  status: SyncResultStatus;
  detail?: unknown;
}

export interface SyncSummary {
  pendingCount: number;
  conflictCount: number;
  lastSuccessfulSyncAt: string | null;
  lastAttemptedSyncAt: string | null;
  lastError: string | null;
}

export interface SyncMeta {
  lastSuccessfulSyncAt: string | null;
  lastAttemptedSyncAt: string | null;
  lastError: string | null;
}

// Row/activity switches close the previous run and open the new one at the
// exact same tap instant — this type distinction exists purely so callers
// don't have to remember "work_start when idle, activity_switch when not";
// appendEvent() below normalizes both into the same underlying storage
// shape (the server ledger cares about event_type for its own routing, the
// local log just needs one consistent row per logical tap).
function isoNow(): string {
  return new Date().toISOString();
}

function localTzOffsetMinutes(): number {
  // JS getTimezoneOffset() is minutes WEST of UTC (backwards from the usual
  // "+/-HH:MM ahead of UTC" convention) — negate it so a positive number
  // here means "ahead of UTC," matching how humans/servers usually read it.
  return -new Date().getTimezoneOffset();
}

interface DbRow {
  [key: string]: unknown;
}

class LocalEventStoreImpl {
  private dbPromise: Promise<import("@capacitor-community/sqlite").SQLiteDBConnection> | null = null;

  private async getDb(): Promise<import("@capacitor-community/sqlite").SQLiteDBConnection> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = this.openAndMigrate();
    return this.dbPromise;
  }

  private async openAndMigrate(): Promise<import("@capacitor-community/sqlite").SQLiteDBConnection> {
    const sqlite = await getSqliteConnection();

    const consistency = await sqlite.checkConnectionsConsistency();
    const alreadyOpen = (await sqlite.isConnection(DB_NAME, false)).result;
    const db =
      consistency.result && alreadyOpen
        ? await sqlite.retrieveConnection(DB_NAME, false)
        : await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);
    await db.open();

    await db.execute(
      `create table if not exists schema_migrations (version integer primary key, applied_at text not null)`
    );
    const appliedRows = await db.query(`select version from schema_migrations`);
    const applied = new Set((appliedRows.values ?? []).map((r) => Number((r as DbRow).version)));

    for (const migration of MIGRATIONS.sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue;
      await db.beginTransaction();
      try {
        for (const statement of migration.statements) {
          // false = don't let execute() wrap itself in its OWN transaction —
          // it does by default, which conflicts with the beginTransaction()
          // above ("Already in transaction"). Every execute()/run() call
          // made between an explicit beginTransaction()/commitTransaction()
          // pair in this file passes false for the same reason.
          await db.execute(statement, false);
        }
        await db.run(
          `insert into schema_migrations (version, applied_at) values (?, ?)`,
          [migration.version, isoNow()],
          false
        );
        await db.commitTransaction();
      } catch (err) {
        await db.rollbackTransaction();
        throw err;
      }
    }
    this.schedulePersist();

    return db;
  }

  private persistPromise: Promise<void> | null = null;

  // jeep-sqlite (web/PWA) only writes from in-memory to its IndexedDB store
  // on an explicit saveToStore/close/closeConnection — never automatically
  // per statement the way native SQLite fsyncs to disk. Every durable write
  // in this file schedules this immediately afterward on that platform, so
  // "durable" means the same thing on both backends: survives a killed tab/
  // process, not just a killed JS heap.
  //
  // Fire-and-forget, deliberately never awaited by any caller — including
  // this class's own init/migration path (openAndMigrate above). Real,
  // measured incident: saveToStore() re-exports jeep-sqlite's ENTIRE
  // in-memory database and writes the resulting blob to IndexedDB — an
  // O(database size) operation, not a per-row write — and every write in
  // this file, including the very first one at init time, used to `await`
  // it before returning. On iOS Safari that made every single button tap
  // in the PWA visibly slow ("you press any button it takes a very long
  // time"): if that FIRST init-time save happened to hang (the same
  // documented WebKit IndexedDB hang behind the earlier "stuck on
  // Loading" incident), getDb()'s promise never resolved, which poisons
  // every future call in this file for the rest of the session — not just
  // the one save. None of that wait was ever actually needed: a write is
  // already committed and immediately queryable in the live in-memory WASM
  // database the moment db.commitTransaction() returns (every read in this
  // file goes through that same in-memory connection) — persisting to
  // IndexedDB only matters for surviving a killed tab/process, which
  // doesn't require the CALLER to wait for it.
  //
  // Chained onto any in-flight/pending persist (never fired concurrently —
  // jeep-sqlite serializes the whole DB per call, so overlapping calls
  // could race) and never awaited by the caller. A prior failure is
  // swallowed rather than left to permanently wedge every future persist
  // attempt behind a rejected promise.
  private schedulePersist(): void {
    if (isNativeSqlite()) return;
    this.persistPromise = (this.persistPromise ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const sqlite = await getSqliteConnection();
        await sqlite.saveToStore(DB_NAME);
      })
      .catch((err) => {
        console.error("[local-event-store] background persist to IndexedDB failed:", err);
      });
  }

  async init(): Promise<void> {
    await this.getDb();
  }

  // Durable local write + immediate device_seq assignment, one transaction.
  // Target: comfortably under 100ms for a single small row on both native
  // SQLite and the web wasm backend — see the Stage 1 timing smoke test.
  async appendEvent(event: NewLocalEvent): Promise<LocalEvent> {
    const db = await this.getDb();
    const clientEventId = uuid();
    const createdAtLocal = isoNow();
    const tzOffset = localTzOffsetMinutes();

    let deviceSeq = 0;
    await db.beginTransaction();
    try {
      const counterRows = await db.query(`select next_seq from device_seq_counter where device_id = ?`, [
        event.deviceId,
      ]);
      const currentNext = (counterRows.values?.[0] as DbRow | undefined)?.next_seq;
      deviceSeq = typeof currentNext === "number" ? currentNext : 1;

      await db.run(
        `insert into device_seq_counter (device_id, next_seq) values (?, ?)
         on conflict(device_id) do update set next_seq = excluded.next_seq`,
        [event.deviceId, deviceSeq + 1],
        false
      );

      await db.run(
        `insert into pending_events
           (client_event_id, device_id, employee_id, device_seq, event_type, occurred_at_utc,
            local_tz_offset_minutes, activity_id, greenhouse_row_id, carrier_id, answers_json,
            density_snapshot_json, config_revision, created_at_local, sync_status, sync_attempts)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
        [
          clientEventId,
          event.deviceId,
          event.employeeId,
          deviceSeq,
          event.eventType,
          event.occurredAtUtc,
          tzOffset,
          event.activityId ?? null,
          event.greenhouseRowId ?? null,
          event.carrierId ?? null,
          event.answers ? JSON.stringify(event.answers) : null,
          event.densitySnapshot ? JSON.stringify(event.densitySnapshot) : null,
          event.configRevision ?? null,
          createdAtLocal,
        ],
        false
      );

      await db.commitTransaction();
    } catch (err) {
      await db.rollbackTransaction();
      throw err;
    }
    this.schedulePersist();

    return {
      ...event,
      clientEventId,
      deviceSeq,
      localTzOffsetMinutes: tzOffset,
      createdAtLocal,
      syncStatus: "pending",
      syncAttempts: 0,
      lastSyncError: null,
      serverResultJson: null,
    };
  }

  private rowToEvent(row: DbRow): LocalEvent {
    return {
      clientEventId: String(row.client_event_id),
      deviceId: String(row.device_id),
      employeeId: String(row.employee_id),
      deviceSeq: Number(row.device_seq),
      eventType: row.event_type as LocalEventType,
      occurredAtUtc: String(row.occurred_at_utc),
      localTzOffsetMinutes: Number(row.local_tz_offset_minutes),
      activityId: (row.activity_id as string | null) ?? null,
      greenhouseRowId: (row.greenhouse_row_id as string | null) ?? null,
      carrierId: (row.carrier_id as string | null) ?? null,
      answers: row.answers_json ? JSON.parse(String(row.answers_json)) : null,
      densitySnapshot: row.density_snapshot_json ? JSON.parse(String(row.density_snapshot_json)) : null,
      configRevision: (row.config_revision as string | null) ?? null,
      createdAtLocal: String(row.created_at_local),
      syncStatus: row.sync_status as LocalEvent["syncStatus"],
      syncAttempts: Number(row.sync_attempts),
      lastSyncError: (row.last_sync_error as string | null) ?? null,
      serverResultJson: (row.server_result_json as string | null) ?? null,
    };
  }

  async getPendingEvents(deviceId: string, limit = 50): Promise<LocalEvent[]> {
    const db = await this.getDb();
    const res = await db.query(
      `select * from pending_events
       where device_id = ? and sync_status in ('pending', 'syncing')
       order by device_seq asc
       limit ?`,
      [deviceId, limit]
    );
    return (res.values ?? []).map((r) => this.rowToEvent(r as DbRow));
  }

  // Newest-wins replay of this device's own event log — the local source of
  // truth WorkSessionContext renders from immediately after appendEvent(),
  // never waiting on a server round trip. Independent of sync_status: a
  // still-pending event is exactly as real to the person holding the phone
  // as one the server has already acknowledged.
  async getLatestEventForDevice(deviceId: string): Promise<LocalEvent | null> {
    const db = await this.getDb();
    const res = await db.query(
      `select * from pending_events where device_id = ? order by device_seq desc limit 1`,
      [deviceId]
    );
    const row = res.values?.[0] as DbRow | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  // The most recent WORK-type event (work_start/activity_switch/break_end)
  // for this device, skipping over any break_start — used to resolve
  // exactly what a break is interrupting (activity/row/carrier) so
  // endBreak() can resume it precisely, without needing MeResponse's
  // smaller PreviousActivity shape (which doesn't carry row/carrier) or any
  // network round trip. Independent of sync_status: a still-pending local
  // event is just as real a "what was running" answer as a synced one.
  async getLatestWorkEventForDevice(deviceId: string): Promise<LocalEvent | null> {
    const db = await this.getDb();
    const res = await db.query(
      `select * from pending_events
       where device_id = ? and event_type in ('work_start', 'activity_switch', 'break_end')
       order by device_seq desc limit 1`,
      [deviceId]
    );
    const row = res.values?.[0] as DbRow | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  async markSyncResult(clientEventId: string, result: SyncResult): Promise<void> {
    const db = await this.getDb();
    const newStatus: LocalEvent["syncStatus"] =
      result.status === "accepted" || result.status === "duplicate"
        ? "synced"
        : result.status === "retryable_failure" || result.status === "sequence_gap"
          ? "pending"
          : "conflict";
    await db.run(
      `update pending_events
       set sync_status = ?, sync_attempts = sync_attempts + 1, last_sync_error = ?, server_result_json = ?
       where client_event_id = ?`,
      [
        newStatus,
        result.status === "accepted" || result.status === "duplicate" ? null : result.status,
        JSON.stringify(result),
        clientEventId,
      ]
    );
    this.schedulePersist();
  }

  async getPendingCount(deviceId: string): Promise<number> {
    const db = await this.getDb();
    const res = await db.query(
      `select count(*) as n from pending_events where device_id = ? and sync_status in ('pending', 'syncing')`,
      [deviceId]
    );
    return Number((res.values?.[0] as DbRow | undefined)?.n ?? 0);
  }

  async getSyncSummary(deviceId: string): Promise<SyncSummary> {
    const db = await this.getDb();
    const pending = await this.getPendingCount(deviceId);
    const conflictRes = await db.query(
      `select count(*) as n from pending_events where device_id = ? and sync_status = 'conflict'`,
      [deviceId]
    );
    const meta = await this.getSyncMeta(deviceId);
    return {
      pendingCount: pending,
      conflictCount: Number((conflictRes.values?.[0] as DbRow | undefined)?.n ?? 0),
      lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt,
      lastAttemptedSyncAt: meta.lastAttemptedSyncAt,
      lastError: meta.lastError,
    };
  }

  // Events the server explicitly rejected as a genuine conflict (never a
  // transient failure — see mobileTime.ts's POST /sync/events, which never
  // permanently records a retryable_failure/sequence_gap the way it does a
  // permanent_conflict). These sit here, visible for diagnostics, until an
  // administrator resolves the underlying issue server-side (see the
  // desktop Sync Conflicts page) — the device itself never retries or
  // discards one on its own; see SyncStatusScreen.tsx for why there's no
  // "clear" action here.
  async getConflictedEvents(deviceId: string): Promise<LocalEvent[]> {
    const db = await this.getDb();
    const res = await db.query(
      `select * from pending_events where device_id = ? and sync_status = 'conflict' order by device_seq desc`,
      [deviceId]
    );
    return (res.values ?? []).map((r) => this.rowToEvent(r as DbRow));
  }

  // Durable across app restarts (unlike an in-memory syncEngine.ts
  // variable) via the same generic reference_cache KV table
  // getCachedJson/setCachedJson already use — a dedicated per-device
  // key rather than a new table, since this is a single small blob, not a
  // list. Read by getSyncSummary above; written by syncEngine.ts after
  // every sync attempt (success or failure).
  async getSyncMeta(deviceId: string): Promise<SyncMeta> {
    const cached = await this.getCachedJson<SyncMeta>(`sync_meta:${deviceId}`);
    return cached?.value ?? { lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null };
  }

  async setSyncMeta(deviceId: string, meta: SyncMeta): Promise<void> {
    await this.setCachedJson(`sync_meta:${deviceId}`, meta);
  }

  // Diagnostic-only retention prune — never applied to anything still
  // 'pending'/'syncing'/'conflict'. See SyncStatusScreen.tsx for the human-
  // visible side of "recently acknowledged events kept for a short window."
  async pruneSyncedOlderThan(deviceId: string, cutoffIso: string): Promise<number> {
    const db = await this.getDb();
    const res = await db.run(`delete from pending_events where device_id = ? and sync_status = 'synced' and created_at_local < ?`, [
      deviceId,
      cutoffIso,
    ]);
    this.schedulePersist();
    return res.changes?.changes ?? 0;
  }

  // Durable key/value JSON cache — see referenceDataCache.ts, the one
  // caller of these. Deliberately generic (any JSON-serializable value)
  // rather than one method per data type, since every cached data type is
  // handled identically: fetch live, cache the whole response on success,
  // fall back to whatever's cached on failure.
  async getCachedJson<T>(cacheKey: string): Promise<{ value: T; cachedAt: string } | null> {
    const db = await this.getDb();
    const res = await db.query(`select json_value, cached_at from reference_cache where cache_key = ?`, [cacheKey]);
    const row = res.values?.[0] as DbRow | undefined;
    if (!row) return null;
    return { value: JSON.parse(String(row.json_value)) as T, cachedAt: String(row.cached_at) };
  }

  async setCachedJson(cacheKey: string, value: unknown): Promise<void> {
    const db = await this.getDb();
    await db.run(
      `insert into reference_cache (cache_key, json_value, cached_at) values (?, ?, ?)
       on conflict(cache_key) do update set json_value = excluded.json_value, cached_at = excluded.cached_at`,
      [cacheKey, JSON.stringify(value), isoNow()]
    );
    this.schedulePersist();
  }
}

let storeInstance: LocalEventStoreImpl | null = null;
export function getLocalEventStore(): LocalEventStoreImpl {
  if (!storeInstance) storeInstance = new LocalEventStoreImpl();
  return storeInstance;
}
