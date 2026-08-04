-- Persisted config for a break-room-style TV display of the live greenhouse
-- map. A display is reached via an unguessable token embedded directly in
-- its URL (see server/src/lib/displayToken.ts) — no admin login is ever
-- required to leave it open. Only the token's sha256 digest is stored here,
-- the same scheme password_reset_requests.token_hash (006) already uses.
--
-- The office control page (/greenhouse) edits a DRAFT in the browser and
-- only writes here on explicit Save/Publish (PUT /api/greenhouse/displays/
-- :id) — the TV never sees anything until that happens. date_start/date_end
-- are plain calendar dates (APP_TIMEZONE), resolved to instants at query
-- time the same way the existing /live?date= endpoint already does.
create table greenhouse_displays (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  display_key_hash text not null,
  land_id uuid not null references greenhouse_lands(id),
  -- null = no activity filter (all activities contribute to row state).
  -- Deliberately not restricted to is_active activities — a display
  -- published against an activity that's later deactivated should keep
  -- rendering its historical state, not start failing.
  activity_id uuid references activities(id),
  date_start date not null,
  date_end date not null,
  is_active boolean not null default true,
  updated_by_employee_id uuid references employees(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint chk_greenhouse_displays_date_range check (date_end >= date_start)
);

-- Hot path: every TV poll (~10s) hashes its URL token and looks this up,
-- unauthenticated. Unique also backstops a hash collision ever granting
-- cross-display access.
create unique index idx_greenhouse_displays_key_hash on greenhouse_displays (display_key_hash);
create index idx_greenhouse_displays_land on greenhouse_displays (land_id);

-- No seed row here — server/migrations/README.md's rule against baking seed
-- data into schema migrations applies the same way it already does for
-- create-admin. The initial "Break Area TV" display is created via
-- `npm run create-greenhouse-display` (server/src/cli/createGreenhouseDisplay.ts).
