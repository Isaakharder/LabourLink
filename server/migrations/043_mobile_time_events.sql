-- Server-side receipt ledger for the mobile local-first event log
-- (web/src/lib/localEventStore.ts). Every event a phone durably wrote to
-- its own on-device SQLite gets exactly one row here once the phone's sync
-- engine (web/src/lib/syncEngine.ts) manages to submit it — this table is
-- what makes that submission idempotent and orderable across retries,
-- lost-response replays, and 35 phones reconnecting at once.
--
-- No organization_id column: this deployment is genuinely single-tenant.
-- "A device cannot submit events for another organization" is satisfied by
-- device_id -> employee_id being resolved server-side from the existing,
-- already-enforced device_assignments join (requireDevice middleware),
-- never trusted from the request body — the same posture every other
-- mobile route in this codebase already has.
create table mobile_time_events (
  id uuid primary key default gen_random_uuid(),
  -- The phone's own client-generated event id (a uuid) — doubles as
  -- time_entries.idempotency_key once applied, same "one identifier
  -- throughout" convention as every other mobile mutation route.
  client_event_id uuid not null,
  device_id uuid not null references devices(id),
  -- Resolved server-side from device_assignments at the moment this batch
  -- was processed (req.device.employeeId) — never taken from the event
  -- payload, so a stale/manipulated client can't submit as anyone else.
  employee_id uuid not null references employees(id),
  device_seq bigint not null,
  event_type text not null check (event_type in ('work_start', 'activity_switch', 'break_start', 'break_end', 'end_day')),
  occurred_at_utc timestamptz not null,
  local_tz_offset_minutes integer not null,
  -- activityId/greenhouseRowId/carrierId/answers/densitySnapshot/
  -- configRevision as submitted by the device — kept verbatim for
  -- diagnostics/replay auditing even though the authoritative values
  -- actually applied are re-derived server-side (see validateActivityAndAnswers).
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processing_status text not null check (
    processing_status in ('accepted', 'duplicate', 'retryable_failure', 'permanent_conflict', 'sequence_gap')
  ),
  time_entry_id uuid references time_entries(id),
  conflict_reason text,
  conflict_detail jsonb,
  -- The actual idempotency guarantee: a batch resubmitting an event whose
  -- client_event_id this device has already recorded finds it here first
  -- and returns the stored result with zero side effects, before ever
  -- touching time_entries.
  unique (device_id, client_event_id)
);
create index idx_mobile_time_events_device_seq on mobile_time_events(device_id, device_seq);

-- One row per device, tracking how far its own device_seq stream has been
-- consumed in order — a device_seq arriving out of order relative to this
-- (a gap) halts further processing for THAT device without touching any
-- other device's independent sync progress.
create table device_sync_state (
  device_id uuid primary key references devices(id),
  last_processed_seq bigint not null default 0,
  last_synced_at timestamptz
);
