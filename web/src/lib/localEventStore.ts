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
import { computeSequenceFloor, resolveSequenceConflict, SequenceFloorInputs } from "./localSequenceAssignment";
import { uuid } from "./uuid";
import * as journal from "./webEventJournal";

// Thrown when appendEvent's native path can't allocate a device_seq even
// after the one bounded retry — see localSequenceAssignment.ts's header for
// the incident this recovers from. Distinct from LocalCommitTimeoutError
// (WorkSessionContext.tsx) so a caller can tell "genuinely stuck, don't
// bother waiting longer" apart from "took too long, might still land."
export class LocalSequenceAllocationError extends Error {
  constructor(detail: string) {
    super(`local device_seq allocation failed: ${detail}`);
    this.name = "LocalSequenceAllocationError";
  }
}

// One retry after the first collision, per this fix's explicit "never loop
// indefinitely" requirement — a second collision means something more than
// ordinary read-before-write drift is going on and should surface as a real
// error rather than keep hammering the same doomed insert.
const MAX_SEQUENCE_ALLOCATION_ATTEMPTS = 2;

// Safe, non-PII diagnostic snapshot logged only when allocation truly gives
// up — error class, app version, and a short device-id suffix (same "first/
// last few chars only" convention diagnostics.ts already uses for
// clientEventId), plus the sequence numbers actually involved. Never an
// employee id, activity/row/carrier id, or anything from `answers`.
async function logSequenceAllocationFailure(
  deviceId: string,
  detail: Record<string, unknown>
): Promise<void> {
  let appVersion: string | null = null;
  try {
    if (isNativeSqlite()) {
      const { App } = await import("@capacitor/app");
      appVersion = (await App.getInfo()).version;
    }
  } catch {
    // Best-effort only — never let a diagnostics read block or fail the
    // error path it's trying to describe.
  }
  console.error("[local-first][sequence-allocation-failed]", {
    errorClass: "LocalSequenceAllocationError",
    appVersion,
    deviceIdSuffix: deviceId.slice(-8),
    ...detail,
  });
}

export type LocalEventType = "work_start" | "activity_switch" | "break_start" | "break_end" | "end_day";

export interface NewLocalEvent {
  deviceId: string;
  employeeId: string;
  eventType: LocalEventType;
  occurredAtUtc: string; // ISO8601 — the true tap-time, captured by the caller before calling this
  activityId?: string | null;
  greenhouseRowId?: string | null;
  carrierId?: string | null;
  // Opaque JSON storage — this store never parses it, just round-trips it
  // (JSON.stringify on write, JSON.parse on read). The actual runtime shape
  // is an array of { questionId, greenhouseRowId } / { questionId,
  // carrierId } entries (see WorkSessionContext.tsx's StoredAnswers) —
  // typed loosely here since nothing in this file cares.
  answers?: Record<string, unknown> | unknown[] | null;
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

// Recognizes SQLite's own "UNIQUE constraint failed: pending_events.
// device_id, pending_events.device_seq (code 2067)" message shape — the
// exact text captured from the Nattawat N incident's logcat — as distinct
// from every other possible native-insert failure (disk full, a genuinely
// different constraint, a plugin-level error), which must still propagate
// immediately rather than being treated as a retryable sequence collision.
function isSequenceCollisionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("pending_events") &&
    message.includes("device_seq")
  );
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

  // Serializes every native appendEvent call through this one in-process
  // chain so two overlapping calls (a retry firing before a prior attempt
  // truly settled, or — per the Nattawat N incident's logcat, which showed
  // ColdStartWatchdog recreating MainActivity 4 times during a slow cold
  // start — a freshly recreated Activity/WebView re-driving a commit while
  // an earlier context's attempt hadn't finished) can never both read
  // device_seq_counter before either has written it back. A single SQLite
  // transaction is atomic against ITSELF but not against a second,
  // independently-opened transaction reading the same row first — this is
  // the actual mutual-exclusion boundary that was missing before.
  private appendLock: Promise<unknown> = Promise.resolve();

  private async withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.appendLock.catch(() => {}).then(fn);
    // Chain the NEXT caller onto this attempt's settlement (success or
    // failure) regardless of outcome, so one failed attempt can never wedge
    // the lock for everyone after it.
    this.appendLock = run.catch(() => {});
    return run;
  }

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

  // Reads all four sequence-floor sources fresh — see
  // localSequenceAssignment.ts's SequenceFloorInputs for why each exists.
  // `select max(...)` over zero matching rows returns one row with a null
  // aggregate (not zero rows), so the null-check below is the normal case
  // for a brand-new device identity, not an error path.
  private async readSequenceFloorInputs(
    db: import("@capacitor-community/sqlite").SQLiteDBConnection,
    deviceId: string
  ): Promise<SequenceFloorInputs> {
    const counterRows = await db.query(`select next_seq from device_seq_counter where device_id = ?`, [deviceId]);
    const persistedCounterNextSeq = (counterRows.values?.[0] as DbRow | undefined)?.next_seq;

    const pendingMaxRows = await db.query(`select max(device_seq) as m from pending_events where device_id = ?`, [
      deviceId,
    ]);
    const highestPendingSeq = (pendingMaxRows.values?.[0] as DbRow | undefined)?.m;

    const ackMaxRows = await db.query(
      `select max(device_seq) as m from pending_events where device_id = ? and sync_status = 'synced'`,
      [deviceId]
    );
    const highestAcknowledgedSeq = (ackMaxRows.values?.[0] as DbRow | undefined)?.m;

    const serverCached = await this.getServerLastProcessedSeq(deviceId);

    return {
      persistedCounterNextSeq: typeof persistedCounterNextSeq === "number" ? persistedCounterNextSeq : null,
      highestPendingSeq: typeof highestPendingSeq === "number" ? highestPendingSeq : null,
      highestAcknowledgedSeq: typeof highestAcknowledgedSeq === "number" ? highestAcknowledgedSeq : null,
      serverLastProcessedSeq: serverCached,
    };
  }

  // Best-effort local cache of the server's device_sync_state.
  // last_processed_seq, keyed off the existing generic reference_cache
  // table (no new table needed) — see syncEngine.ts's write side.
  async getServerLastProcessedSeq(deviceId: string): Promise<number | null> {
    const cached = await this.getCachedJson<{ lastProcessedSeq: number }>(`server-last-processed-seq:${deviceId}`);
    return typeof cached?.value.lastProcessedSeq === "number" ? cached.value.lastProcessedSeq : null;
  }

  async setServerLastProcessedSeq(deviceId: string, lastProcessedSeq: number): Promise<void> {
    await this.setCachedJson(`server-last-processed-seq:${deviceId}`, { lastProcessedSeq });
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

    // Serialized: see appendLock's own comment for why two overlapping
    // callers must never both read device_seq_counter before either writes
    // it back.
    return this.withAppendLock(async () => {
      // Idempotent retry, checked up front — client_event_id is this row's
      // own PRIMARY KEY, so a retry with the identical clientEventId whose
      // local write already landed would otherwise hit THAT constraint
      // before ever reaching the (device_id, device_seq) one below,
      // bypassing the collision-recovery logic entirely. Same "check by
      // clientEventId before inserting" precedent as webEventJournal.ts's
      // appendJournalEvent on the web platform.
      const existingRows = await db.query(`select * from pending_events where client_event_id = ?`, [clientEventId]);
      const existingRow = existingRows.values?.[0] as DbRow | undefined;
      if (existingRow) {
        logCheckpoint(correlationId, "appendEvent:native:idempotent-retry-existing", {
          deviceSeq: Number(existingRow.device_seq),
        });
        return this.rowToEvent(existingRow);
      }

      let candidateSeq: number | null = null;

      for (let attempt = 1; attempt <= MAX_SEQUENCE_ALLOCATION_ATTEMPTS; attempt++) {
        const floorInputs = await this.readSequenceFloorInputs(db, event.deviceId);
        const seq = candidateSeq ?? computeSequenceFloor(floorInputs);
        logCheckpoint(correlationId, "appendEvent:native:transaction-start", { attempt, seq });

        await db.beginTransaction();
        try {
          // Counter reservation and event insertion in ONE serialized
          // transaction — a rollback on either statement failing reverts
          // both together, so the counter can never advance past a device_seq
          // that didn't actually get a pending_events row.
          await db.run(
            `insert into device_seq_counter (device_id, next_seq) values (?, ?)
             on conflict(device_id) do update set next_seq = excluded.next_seq`,
            [event.deviceId, seq + 1],
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
              seq,
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
          logCheckpoint(correlationId, "appendEvent:native:transaction-committed", { deviceSeq: seq });

          this.schedulePersist();
          logCheckpoint(correlationId, "appendEvent:native:persist-scheduled");
          return {
            ...event,
            clientEventId,
            deviceSeq: seq,
            localTzOffsetMinutes: tzOffset,
            createdAtLocal,
            syncStatus: "pending",
            syncAttempts: 0,
            lastSyncError: null,
            serverResultJson: null,
          };
        } catch (err) {
          await db.rollbackTransaction();
          if (!isSequenceCollisionError(err)) throw err;

          // Inspect the conflicting row rather than blindly incrementing —
          // never delete, renumber, or overwrite it either way, only ever
          // read it to decide idempotent-return vs. recompute-and-retry.
          const conflictRows = await db.query(
            `select client_event_id from pending_events where device_id = ? and device_seq = ?`,
            [event.deviceId, seq]
          );
          const existingClientEventId = String(
            (conflictRows.values?.[0] as DbRow | undefined)?.client_event_id ?? ""
          );
          const decision = resolveSequenceConflict(clientEventId, { deviceSeq: seq, existingClientEventId }, floorInputs);

          if (decision.kind === "idempotent") {
            logCheckpoint(correlationId, "appendEvent:native:sequence-collision-idempotent", { deviceSeq: seq });
            const existingRows = await db.query(
              `select * from pending_events where device_id = ? and device_seq = ?`,
              [event.deviceId, seq]
            );
            const existingRow = existingRows.values?.[0] as DbRow | undefined;
            if (existingRow) return this.rowToEvent(existingRow);
            // The row we just read moments ago is gone — genuinely never
            // expected (nothing in this codebase deletes a pending event by
            // device_seq), so this is a real allocation failure, not a
            // retryable case.
            await logSequenceAllocationFailure(event.deviceId, {
              clientEventId,
              attempt,
              deviceSeq: seq,
              reason: "idempotent match disappeared before it could be read back",
            });
            throw new LocalSequenceAllocationError("idempotent match disappeared before it could be read back");
          }

          logCheckpoint(correlationId, "appendEvent:native:sequence-collision-retry", {
            attempt,
            attemptedSeq: seq,
            retrySeq: decision.deviceSeq,
          });
          candidateSeq = decision.deviceSeq;

          if (attempt >= MAX_SEQUENCE_ALLOCATION_ATTEMPTS) {
            await logSequenceAllocationFailure(event.deviceId, {
              clientEventId,
              attempts: attempt,
              lastAttemptedSeq: seq,
              nextCandidateSeq: decision.deviceSeq,
            });
            throw new LocalSequenceAllocationError(
              `gave up after ${attempt} attempts; last attempted device_seq=${seq}, conflicting clientEventId=${existingClientEventId}`
            );
          }
          // Loop again with candidateSeq as the new attempt's seq.
        }
      }

      // Unreachable — the loop above always either returns or throws before
      // exhausting its bound — but keeps the function's return type honest
      // for TypeScript without a non-null assertion.
      throw new LocalSequenceAllocationError("sequence allocation loop exited without a result");
    });
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

// Test-only — forces the next getLocalEventStore() to construct a fresh
// instance (fresh dbPromise, fresh appendLock), simulating an app process
// restart against whatever underlying storage the test's mocked
// getSqliteConnection()/webEventJournal continues to serve. Same convention
// as webEventJournal.ts's own __resetJournalConnectionForTests.
export function __resetLocalEventStoreForTests(): void {
  storeInstance = null;
}
