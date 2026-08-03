-- Break Profiles: reusable named sets of scheduled breaks (e.g. "Greenhouse
-- Employees": Morning 9:00-9:15, Lunch 12:00-1:00, Afternoon 3:00-3:15) that
-- can be assigned to employees. Reuses the existing time_entries table for
-- actual break rows (no parallel recording system) — this migration only
-- adds the schedule tables plus the columns time_entries/employees need to
-- link a recorded break back to the schedule item it came from.

-- ---------------------------------------------------------------------------
-- Break profiles
-- ---------------------------------------------------------------------------

create table break_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case/whitespace-insensitive uniqueness, additive alongside the plain
-- `unique` above — same pattern as activity_groups (007) and employees (002).
create unique index break_profiles_name_normalized_key on break_profiles (lower(trim(name)));
create index idx_break_profiles_is_active on break_profiles(is_active);

-- ---------------------------------------------------------------------------
-- Break profile items (the individual scheduled breaks within a profile)
-- ---------------------------------------------------------------------------

create table break_profile_items (
  id uuid primary key default gen_random_uuid(),
  break_profile_id uuid not null references break_profiles(id),
  name text,
  start_time time not null,
  end_time time not null,
  is_paid boolean not null default false,
  fixed_break boolean not null default false,
  auto_add boolean not null default false,
  -- Grace window either side of the scheduled time within which a manual
  -- Start/End Break tap gets rounded to the scheduled time instead of the
  -- actual tap time. Configurable per item; 10 minutes is the documented
  -- default.
  fixed_start_window_minutes integer not null default 10,
  fixed_end_window_minutes integer not null default 10,
  sort_order integer not null,
  -- Soft-delete, not a plain boolean toggle exposed anywhere directly —
  -- editing a profile's schedule (BreaksTab) upserts by id and marks
  -- anything removed from the submitted set inactive rather than deleting
  -- it outright. time_entries.break_profile_item_id (below) references
  -- this table with no ON DELETE action, so once an item has ever been
  -- matched to a recorded break, hard-deleting it would break every future
  -- edit to the profile it belongs to.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_break_profile_items_end_after_start check (end_time > start_time)
);

create index idx_break_profile_items_profile on break_profile_items(break_profile_id);

-- Backstop against duplicate identical schedule rows within one profile —
-- primary validation happens in the route, this is the DB-level guarantee.
-- Scoped to active rows only: a removed (soft-deleted) item must not block
-- re-adding the same start/end time later.
create unique index break_profile_items_profile_time_active_key
  on break_profile_items (break_profile_id, start_time, end_time)
  where is_active = true;

-- ---------------------------------------------------------------------------
-- Employee <-> break profile assignment (single current link, no history
-- table — deactivating a profile intentionally leaves this pointer in place
-- so the assignment stays visible; see plan notes in the Base Data feature).
-- ---------------------------------------------------------------------------

alter table employees
  add column break_profile_id uuid references break_profiles(id);

create index idx_employees_break_profile on employees(break_profile_id);

-- ---------------------------------------------------------------------------
-- time_entries: link a recorded break back to the schedule item it came
-- from (manually fixed-matched or auto-added), carry paid/unpaid, and keep
-- both the actual tap timestamp and the possibly-rounded recorded timestamp
-- for audit purposes.
-- ---------------------------------------------------------------------------

alter table time_entries
  add column break_profile_item_id uuid references break_profile_items(id),
  add column scheduled_break_date date,
  add column source text not null default 'manual' check (source in ('manual', 'auto')),
  add column actual_started_at timestamptz,
  add column actual_ended_at timestamptz,
  -- Only meaningful for entry_type = 'break'; null for work rows and for
  -- legacy/unclassified breaks recorded before this migration.
  add column is_paid boolean;

-- Idempotency backstop for server-side auto-add reconciliation: the same
-- employee/profile-item/date combination can never be auto-added twice.
-- Manual fixed-matches are deliberately not covered by this index (a
-- second manual tap near the same scheduled time is a real, if rare, human
-- action, not a reconciliation bug) — reconciliation's own pre-check is
-- what stops it from double-adding on top of an existing manual match.
create unique index idx_time_entries_auto_break_once
  on time_entries (employee_id, break_profile_item_id, scheduled_break_date)
  where source = 'auto' and break_profile_item_id is not null;
