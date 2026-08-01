-- Phase 5: activity groups, activity group membership, and employee<->group
-- assignment history. Additive only — activities/time_entries are extended,
-- never recreated.

alter table activities
  add column normal_speed numeric,
  add column speed_unit text,
  add column minimum_duration_minutes integer not null default 0,
  add column updated_at timestamptz not null default now();

alter table activities
  add constraint chk_activities_normal_speed_positive
    check (normal_speed is null or normal_speed > 0);
alter table activities
  add constraint chk_activities_minimum_duration_nonnegative
    check (minimum_duration_minutes >= 0);

-- Case/whitespace-insensitive uniqueness, additive alongside the existing
-- plain `unique` on name — same pattern as 002_normalize_employee_email.sql.
create unique index activities_name_normalized_key on activities (lower(trim(name)));

-- ---------------------------------------------------------------------------
-- Activity groups
-- ---------------------------------------------------------------------------

create table activity_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index activity_groups_name_normalized_key on activity_groups (lower(trim(name)));
create index idx_activity_groups_is_active on activity_groups(is_active);

-- ---------------------------------------------------------------------------
-- Activity group membership
-- ---------------------------------------------------------------------------

create table activity_group_activities (
  id uuid primary key default gen_random_uuid(),
  activity_group_id uuid not null references activity_groups(id) on delete cascade,
  -- No cascade — activities are never hard-deleted, only deactivated, so
  -- there's nothing for a delete to cascade from in practice.
  activity_id uuid not null references activities(id),
  unique (activity_group_id, activity_id)
);

create index idx_activity_group_activities_activity on activity_group_activities(activity_id);

-- ---------------------------------------------------------------------------
-- Employee <-> activity group assignments (current + historical)
-- Structural mirror of device_assignments in 001_initial_schema.sql.
-- ---------------------------------------------------------------------------

create table employee_activity_group_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  activity_group_id uuid not null references activity_groups(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  assigned_by_employee_id uuid references employees(id) on delete set null
);

-- Only one active (unassigned_at is null) group assignment per employee.
create unique index idx_employee_activity_group_assignments_active_per_employee
  on employee_activity_group_assignments(employee_id)
  where unassigned_at is null;

create index idx_employee_activity_group_assignments_group
  on employee_activity_group_assignments(activity_group_id);
