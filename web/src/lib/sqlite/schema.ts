// Local SQLite schema for the offline event queue + reference-data cache.
// Same "numbered, applied once, tracked, never rewritten in place"
// philosophy as server/migrations/ — see localEventStore.ts's init() for the
// runner. Kept in its own array (not a raw multi-statement string) so a
// later addition is always a NEW entry, never an edit to an already-shipped
// one already applied on real phones.
export interface SchemaMigration {
  version: number;
  statements: string[];
}

export const DB_NAME = "labourlink_events";

export const MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    statements: [
      // The append-only local event log — the source of truth for what
      // this phone believes happened, independent of whether it's ever
      // reached the server yet. client_event_id is generated on-device
      // (uuid()) and doubles as time_entries.idempotency_key once synced —
      // one identifier, not two, all the way through.
      `create table if not exists pending_events (
        client_event_id text primary key,
        device_id text not null,
        employee_id text not null,
        device_seq integer not null,
        event_type text not null,
        occurred_at_utc text not null,
        local_tz_offset_minutes integer not null,
        activity_id text,
        greenhouse_row_id text,
        carrier_id text,
        answers_json text,
        density_snapshot_json text,
        config_revision text,
        created_at_local text not null,
        sync_status text not null default 'pending',
        sync_attempts integer not null default 0,
        last_sync_error text,
        server_result_json text
      )`,
      `create unique index if not exists idx_pending_events_device_seq
        on pending_events(device_id, device_seq)`,
      `create index if not exists idx_pending_events_sync_status
        on pending_events(sync_status)`,
      // One row per paired device this phone has ever been — device_seq is
      // monotonic PER DEVICE IDENTITY, so re-pairing (a new device row
      // server-side) starts a fresh, independent sequence rather than
      // continuing an old one under a different identity.
      `create table if not exists device_seq_counter (
        device_id text primary key,
        next_seq integer not null default 1
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      // Reference-data cache (activities+questions, greenhouse rows/phases,
      // carriers, NFC mappings, break profile) — a simple durable key/value
      // JSON blob per data type rather than a fully normalized relational
      // schema. Deliberate: every consumer (ActivityPicker, RowPickerSheet,
      // CarrierPickerSheet) already reads its ENTIRE list as one snapshot
      // every time (nothing ever queries "just one cached row" in
      // isolation), so a normalized schema would add real complexity for
      // zero functional benefit — this still fully satisfies "refresh when
      // online, keep the last valid cache if refresh fails" per
      // referenceDataCache.ts.
      `create table if not exists reference_cache (
        cache_key text primary key,
        json_value text not null,
        cached_at text not null
      )`,
    ],
  },
];
