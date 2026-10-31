-- LabourLink Scale: weighing stations, the weighings they upload, and the
-- server-side assignment of each weighing to the employee who filled the bin
-- (see server/src/lib/scaleMatching.ts for the rule, and
-- server/src/routes/scale.ts for the station API).
--
-- Additive only: four new tables and one partial index on
-- mobile_time_events. No existing row, column or constraint is touched.
--
-- Single-tenant schema (see 043_mobile_time_events.sql): no organization
-- column. A station is authenticated by its own hashed token, never by
-- anything in the request body.

-- One row per physical weighing station. The station sends
-- `Authorization: Bearer <token>`; only the sha256 hash is stored, same
-- scheme as integration_tokens (054). Created with
-- `npm run scale:station-token`, which prints the token once.
--
-- credits_enabled: while false (the default) weighings are stored and
-- matched exactly as in production, but every one is recorded as a trial
-- (scale_weighings.credits_live = false) and never counts as an employee
-- credit. Turning it on is an explicit, one-row administrator action.
create table scale_stations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null,
  is_active boolean not null default true,
  credits_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create unique index scale_stations_token_hash_key on scale_stations (token_hash);
create unique index scale_stations_name_key on scale_stations (lower(trim(name)));

-- One row per weighing a station recorded. Never deleted or rewritten:
-- corrections are separate, audited rows (scale_weighing_events), and the
-- weights, bin and times below never change after insert.
--
-- status:
--   pending       no verified phone claim yet; re-evaluated until pending_until
--   credited      exactly one employee claimed the bin in this bin-use cycle
--   needs_review  two or more employees, a duplicate, or another anomaly; nobody credited
--   expired       still no claim 24 h after weighed_at; never credited
--   voided        an administrator voided a credit (the original employee is kept)
-- Credited, needs_review, expired and voided are final for the matcher.
create table scale_weighings (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references scale_stations(id),
  -- The station's own UUID for this weighing; uploads are idempotent on it.
  station_weighing_id uuid not null,
  carrier_id uuid not null references carriers(id),
  rfid_tag text not null,
  gross_g integer not null,
  tare_g integer not null,
  net_g integer not null,
  samples_g jsonb not null default '[]'::jsonb,
  -- Station clock (NTP). received_at is the server's clock.
  weighed_at timestamptz not null,
  received_at timestamptz not null default now(),
  status text not null default 'pending',
  employee_id uuid references employees(id),
  pending_until timestamptz not null,
  resolved_at timestamptz,
  match_reason text,
  -- Snapshot of scale_stations.credits_enabled when the weighing arrived.
  credits_live boolean not null,
  -- A second weighing of the same bin within five minutes: kept for the
  -- record, never credited, never counted in production totals.
  is_duplicate boolean not null default false,
  constraint scale_weighings_station_weighing_key unique (station_id, station_weighing_id),
  constraint chk_scale_weighings_status check (status in ('pending', 'credited', 'needs_review', 'expired', 'voided')),
  constraint chk_scale_weighings_weights check (gross_g > 0 and tare_g > 0 and net_g = gross_g - tare_g),
  -- An employee is attached only to a credit (or to a voided credit, which
  -- keeps the original employee for the record).
  constraint chk_scale_weighings_employee check ((status in ('credited', 'voided')) = (employee_id is not null)),
  constraint chk_scale_weighings_duplicate_not_credited check (not (is_duplicate and status in ('credited', 'voided')))
);
create index idx_scale_weighings_carrier_time on scale_weighings (carrier_id, weighed_at);
create index idx_scale_weighings_weighed_at on scale_weighings (weighed_at);
create index idx_scale_weighings_pending on scale_weighings (pending_until) where status = 'pending';
create index idx_scale_weighings_employee on scale_weighings (employee_id, weighed_at) where employee_id is not null;

-- The phone events that credited a weighing. mobile_time_event_id is the
-- primary key, so the database itself guarantees one phone event can never
-- credit two weighings.
create table scale_weighing_claims (
  mobile_time_event_id uuid primary key references mobile_time_events(id),
  weighing_id uuid not null references scale_weighings(id),
  employee_id uuid not null references employees(id),
  created_at timestamptz not null default now()
);
create index idx_scale_weighing_claims_weighing on scale_weighing_claims (weighing_id);

-- Phone events that did NOT credit a weighing but matter for review:
--   competing      claims by two or more employees in one cycle (needs_review)
--   late_conflict  a different employee's claim inside an already credited
--                  cycle; the credit is unchanged
create table scale_weighing_flags (
  id uuid primary key default gen_random_uuid(),
  weighing_id uuid not null references scale_weighings(id),
  mobile_time_event_id uuid not null references mobile_time_events(id),
  employee_id uuid not null references employees(id),
  kind text not null check (kind in ('competing', 'late_conflict')),
  created_at timestamptz not null default now(),
  constraint scale_weighing_flags_once unique (weighing_id, mobile_time_event_id)
);
create index idx_scale_weighing_flags_weighing on scale_weighing_flags (weighing_id);

-- Append-only history of every weighing: received, each status change and
-- (later) administrator corrections. actor_employee_id is null for the
-- station and the automatic matcher.
create table scale_weighing_events (
  id uuid primary key default gen_random_uuid(),
  weighing_id uuid not null references scale_weighings(id),
  kind text not null,
  from_status text,
  to_status text,
  employee_id uuid references employees(id),
  actor_employee_id uuid references employees(id),
  reason text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index idx_scale_weighing_events_weighing on scale_weighing_events (weighing_id, created_at);

-- Claim lookup: accepted bin-choosing phone events by occurrence time.
-- Partial, so it only covers work starts and activity switches.
create index idx_mobile_time_events_scale_claims
  on mobile_time_events (occurred_at_utc)
  where processing_status = 'accepted' and event_type in ('work_start', 'activity_switch');
