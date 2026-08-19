// The durable, offline-first local event log — the single source of truth
// for "what does this phone believe just happened."
//
// Native Android: real SQLite via @capacitor-community/sqlite, unchanged
// and untouched by anything below — it never had the problem this file's
// web path exists to work around.
//
// Web/PWA: as of the incident documented in webEventJournal.ts's own
// header comment, this NO LONGER goes through jeep-sqlite/WASM SQLite at
// all. A real, reproduced production incident (iOS Safari standalone PWA:
// tapping "General" left the job sheet open, every option went gray, and
// the UI never recovered) traced back to jeep-sqlite's connection/export
// machinery hanging indefinitely, combined with a module-level memoized
// connection promise that a single hang poisons for the rest of the
// session — no amount of awaiting-with-a-timeout at the CALLER level
// fixes that, since the underlying connection stays broken for everyone
// after. webEventJournal.ts is a small, dependency-free native-IndexedDB
// journal that replaces it entirely for the web platform: no WASM, no
// full-database export, and its own connection/transaction timeouts that
// self-heal (never leave a poisoned promise cached) instead of hanging
// forever.
import { getSqliteConnection, isNativeSqlite } from "./sqlite/bootstrap";
import { DB_NAME, MIGRATIONS } from "./sqlite/schema";
import { uuid } from "./uuid";
import * as journal from "./webEventJournal";

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
  // Caller-supplied stable id for retry-safety — see WorkSessionContext.tsx's
  // perform(): a tap that times out client-side (the local write may have
  // ACTUALLY landed a moment later, or may genuinely retry from scratch)
  // must never produce two events for one physical tap. Omitted callers
  // (nothing else in this codebase needs it) get a fresh uuid() minted
  // inside appendEvent, same as always.
  clientEventId?: string;
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

// Structured, timestamped instrumentation for the complete local-write
// path — added specifically to find the exact awaited operation that
// hangs on real iOS Safari PWA, rather than guessing. `[local-first]` is
// the filterable tag; every checkpoint carries the same correlationId so
// concurrent taps (e.g. a retry fired while the original attempt is still
// technically pending) can be told apart in the console log.
export function logCheckpoint(correlationId: string, checkpoint: string, extra?: Record<string, unknown>): void {
  console.log(`[local-first] ${checkpoint} id=${correlationId} t=${Date.now()}`, extra ?? "");
}

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

function journalEventToLocalEvent(e: journal.JournalEvent): LocalEvent {
  return {
    deviceId: e.deviceId,
    employeeId: e.employeeId,
    eventType: e.eventType,
    occurredAtUtc: e.occurredAtUtc,
    activityId: e.activityId,
    greenhouseRowId: e.greenhouseRowId,
    carrierId: e.carrierId,
    answers: (e.answers as Record<string, unknown> | null) ?? null,
    densitySnapshot: e.densitySnapshot,
    configRevision: e.configRevision,
    clientEventId: e.clientEventId,
    deviceSeq: e.deviceSeq,
    localTzOffsetMinutes: e.localTzOffsetMinutes,
    createdAtLocal: e.createdAtLocal,
    syncStatus: e.syncStatus,
    syncAttempts: e.syncAttempts,
    lastSyncError: e.lastSyncError,
    serverResultJson: e.serverResultJson,
  };
}

class LocalEventStoreImpl {
  private dbPromise: Promise<import("@capacitor-community/sqlite").SQLiteDBConnection> | null = null;

  // Native-only from here down to persistPromise — every one of these
  // methods is only ever reached when isNativeSqlite() is true (see each
  // public method's own branch below), so none of it needs its own
  // isNativeSqlite() guard internally.
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

  private schedulePersist(): void {
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
    if (isNativeSqlite()) await this.getDb();
    // No init step needed on web — webEventJournal opens lazily on first
    // real use, same self-healing connection semantics either way.
  }

  async appendEvent(event: NewLocalEvent): Promise<LocalEvent> {
    const correlationId = event.clientEventId ?? uuid();

    if (!isNativeSqlite()) {
      logCheckpoint(correlationId, "appendEvent:web:journal-write-start");
      const result = await journal.appendJournalEvent({ ...event, clientEventId: correlationId });
      logCheckpoint(correlationId, "appendEvent:web:journal-write-committed", { deviceSeq: result.deviceSeq });
      return journalEventToLocalEvent(result);
    }

    logCheckpoint(correlationId, "appendEvent:native:getDb-start");
    const db = await this.getDb();
    logCheckpoint(correlationId, "appendEvent:native:getDb-resolved");
    const clientEventId = correlationId;
    const createdAtLocal = isoNow();
    const tzOffset = localTzOffsetMinutes();

    let deviceSeq = 0;
    logCheckpoint(correlationId, "appendEvent:native:transaction-start");
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
      logCheckpoint(correlationId, "appendEvent:native:transaction-committed", { deviceSeq });
    } catch (err) {
      await db.rollbackTransaction();
      throw err;
    }
    this.schedulePersist();
    logCheckpoint(correlationId, "appendEvent:native:persist-scheduled");

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
    if (!isNativeSqlite()) {
      const events = await journal.getPendingJournalEvents(deviceId, limit);
      return events.map(journalEventToLocalEvent);
    }
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

  async getLatestEventForDevice(deviceId: string): Promise<LocalEvent | null> {
    if (!isNativeSqlite()) {
      const event = await journal.getLatestJournalEventForDevice(deviceId);
      return event ? journalEventToLocalEvent(event) : null;
    }
    const db = await this.getDb();
    const res = await db.query(
      `select * from pending_events where device_id = ? order by device_seq desc limit 1`,
      [deviceId]
    );
    const row = res.values?.[0] as DbRow | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  async getLatestWorkEventForDevice(deviceId: string): Promise<LocalEvent | null> {
    if (!isNativeSqlite()) {
      const event = await journal.getLatestWorkJournalEventForDevice(deviceId);
      return event ? journalEventToLocalEvent(event) : null;
    }
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
    if (!isNativeSqlite()) {
      await journal.markJournalSyncResult(clientEventId, result);
      return;
    }
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
    if (!isNativeSqlite()) return journal.getPendingJournalCount(deviceId);
    const db = await this.getDb();
    const res = await db.query(
      `select count(*) as n from pending_events where device_id = ? and sync_status in ('pending', 'syncing')`,
      [deviceId]
    );
    return Number((res.values?.[0] as DbRow | undefined)?.n ?? 0);
  }

  async getSyncSummary(deviceId: string): Promise<SyncSummary> {
    const pending = await this.getPendingCount(deviceId);
    const meta = await this.getSyncMeta(deviceId);
    if (!isNativeSqlite()) {
      const conflicts = await journal.getConflictedJournalEvents(deviceId);
      return {
        pendingCount: pending,
        conflictCount: conflicts.length,
        lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt,
        lastAttemptedSyncAt: meta.lastAttemptedSyncAt,
        lastError: meta.lastError,
      };
    }
    const db = await this.getDb();
    const conflictRes = await db.query(
      `select count(*) as n from pending_events where device_id = ? and sync_status = 'conflict'`,
      [deviceId]
    );
    return {
      pendingCount: pending,
      conflictCount: Number((conflictRes.values?.[0] as DbRow | undefined)?.n ?? 0),
      lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt,
      lastAttemptedSyncAt: meta.lastAttemptedSyncAt,
      lastError: meta.lastError,
    };
  }

  async getConflictedEvents(deviceId: string): Promise<LocalEvent[]> {
    if (!isNativeSqlite()) {
      const events = await journal.getConflictedJournalEvents(deviceId);
      return events.map(journalEventToLocalEvent);
    }
    const db = await this.getDb();
    const res = await db.query(
      `select * from pending_events where device_id = ? and sync_status = 'conflict' order by device_seq desc`,
      [deviceId]
    );
    return (res.values ?? []).map((r) => this.rowToEvent(r as DbRow));
  }

  async getSyncMeta(deviceId: string): Promise<SyncMeta> {
    const cached = await this.getCachedJson<SyncMeta>(`sync_meta:${deviceId}`);
    return cached?.value ?? { lastSuccessfulSyncAt: null, lastAttemptedSyncAt: null, lastError: null };
  }

  async setSyncMeta(deviceId: string, meta: SyncMeta): Promise<void> {
    await this.setCachedJson(`sync_meta:${deviceId}`, meta);
  }

  async pruneSyncedOlderThan(deviceId: string, cutoffIso: string): Promise<number> {
    if (!isNativeSqlite()) return journal.pruneJournalSyncedOlderThan(deviceId, cutoffIso);
    const db = await this.getDb();
    const res = await db.run(`delete from pending_events where device_id = ? and sync_status = 'synced' and created_at_local < ?`, [
      deviceId,
      cutoffIso,
    ]);
    this.schedulePersist();
    return res.changes?.changes ?? 0;
  }

  async getCachedJson<T>(cacheKey: string): Promise<{ value: T; cachedAt: string } | null> {
    if (!isNativeSqlite()) return journal.getJournalCachedJson<T>(cacheKey);
    const db = await this.getDb();
    const res = await db.query(`select json_value, cached_at from reference_cache where cache_key = ?`, [cacheKey]);
    const row = res.values?.[0] as DbRow | undefined;
    if (!row) return null;
    return { value: JSON.parse(String(row.json_value)) as T, cachedAt: String(row.cached_at) };
  }

  async setCachedJson(cacheKey: string, value: unknown): Promise<void> {
    if (!isNativeSqlite()) {
      await journal.setJournalCachedJson(cacheKey, value);
      return;
    }
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
