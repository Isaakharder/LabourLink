-- Employment Timeline: proper employment-period history, separate from
-- employees.is_active (a bare on/off flag with no history at all).
--
-- "Work Group" here is a deliberately DIFFERENT, new concept from the
-- existing employees.job_group column (001_initial_schema.sql) — job_group
-- is free-text informal tagging and is left completely untouched by this
-- migration. work_group is a structured, per-employment-period
-- classification (Greenhouse/Warehouse/Outdoor/Maintenance/Management/
-- Other). The two are named differently on purpose to avoid confusing them.
--
-- start_date/expected_finish_date/actual_finish_date are plain `date`
-- columns (never timestamptz), matching employees.start_date's own
-- convention (001_initial_schema.sql) and work_permit_expiry_date's
-- (047_work_permit_tracking.sql) — a date column has no time-of-day/offset
-- component, so it structurally cannot shift by a day across timezones.
-- Every server query reads these via to_char(..., 'YYYY-MM-DD'), same as
-- every other calendar-date column in this codebase.

-- Needed for the EXCLUDE constraint below: GiST indexes natively support
-- range-overlap (&&) operators, but not plain equality (=) — btree_gist
-- supplies a GiST operator class for equality so a single EXCLUDE
-- constraint can combine "same employee" + "overlapping date ranges" in one
-- real, DB-enforced check, not an application-layer SELECT-then-INSERT
-- that a race condition could slip past.
create extension if not exists btree_gist;

create table employee_employment_periods (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),

  start_date date not null,
  expected_finish_date date,
  actual_finish_date date,

  -- NULL = "Unspecified" — a real, selectable filter value for existing
  -- employees who haven't been classified yet, never auto-promoted to
  -- 'Other'. 'Other' is only ever set by an explicit user choice.
  employment_type text
    check (employment_type is null or employment_type in ('Permanent', 'Temporary', 'Seasonal', 'Other')),

  work_group text
    check (work_group is null or work_group in ('Greenhouse', 'Warehouse', 'Outdoor', 'Maintenance', 'Management', 'Other')),

  -- Only meaningful (and only ever populated) when work_group = 'Other'.
  work_group_other_description text
    check (work_group_other_description is null or work_group = 'Other'),

  notes text,

  -- Nullable: the one-time backfill below has no human actor (see its own
  -- comment). Every period created through the app (POST
  -- /api/employment-periods) always supplies this.
  created_by_employee_id uuid references employees(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_employment_periods_expected_after_start
    check (expected_finish_date is null or expected_finish_date >= start_date),
  constraint chk_employment_periods_actual_after_start
    check (actual_finish_date is null or actual_finish_date >= start_date)
);

create index idx_employment_periods_employee on employee_employment_periods(employee_id, start_date);

-- Real DB-level overlap prevention, not app-layer hope. The comparable end
-- date for range purposes is: actual finish if recorded, else expected
-- finish if set, else 'infinity' (an ongoing/open-ended period blocks any
-- later period for the same employee, by design — you can't be employed
-- twice at once, so the open period must get an expected/actual finish
-- before a next one can be scheduled/recorded).
--
-- Range bound is '[]' (both ends inclusive), matching "a finish date is the
-- last day worked." Postgres canonicalizes an inclusive-inclusive DATE
-- range to [start, finish+1) internally, so:
--   * Period A [start=Jan 1, finish=Jan 10] canonicalizes to [Jan 1, Jan 11)
--   * A next period starting Jan 10 (same day as A's finish) DOES overlap
--     (Jan 10 falls inside [Jan 1, Jan 11)) -> rejected. Correct: an
--     employee cannot be in two employments on the same calendar day.
--   * A next period starting Jan 11 (the day after A's finish) does NOT
--     overlap -> accepted.
alter table employee_employment_periods
  add constraint excl_employment_periods_no_overlap
  exclude using gist (
    employee_id with =,
    daterange(start_date, coalesce(actual_finish_date, expected_finish_date, 'infinity'::date), '[]') with &&
  );

-- Complete audit trail of every add/edit/removal — full before/after row
-- snapshots (not single-field, unlike time_entry_corrections'
-- 009_time_entry_corrections.sql) because a single period edit can touch
-- several columns at once (e.g. "record an actual finish" may set
-- actual_finish_date and notes together). Survives the period itself being
-- deleted (on delete set null, not cascade) — the audit trail must outlive
-- what it's auditing, same append-only-forever spirit as
-- employee_work_permit_history (047_work_permit_tracking.sql).
create table employee_employment_period_history (
  id uuid primary key default gen_random_uuid(),
  employment_period_id uuid references employee_employment_periods(id) on delete set null,
  employee_id uuid not null references employees(id),
  change_type text not null check (change_type in ('created', 'updated', 'deleted')),
  old_value jsonb,
  new_value jsonb,
  changed_by_employee_id uuid not null references employees(id),
  changed_at timestamptz not null default now(),
  reason text
);

create index idx_employment_period_history_employee on employee_employment_period_history(employee_id, changed_at desc);
create index idx_employment_period_history_period on employee_employment_period_history(employment_period_id, changed_at desc);

-- Nationality: additive expansion of the existing CHECK constraint
-- (005_employee_profile_fields.sql). Postgres has no "add a value to an
-- existing CHECK" operation, so this drops and recreates with the
-- superset — non-destructive, no column type change, no data touched.
-- Existing rows (Canadian/Mexican/null) already satisfy the new
-- constraint, so no UPDATE is needed or performed here.
alter table employees drop constraint chk_employees_nationality;
alter table employees add constraint chk_employees_nationality
  check (nationality is null or nationality in ('Canadian', 'Mexican', 'Jamaican', 'Guatemalan', 'Filipino', 'Thai'));

-- One-time backfill: exactly one period per employee, only from
-- employees.start_date (a required, reliable, already-populated field) —
-- never an invented date. Employees with a null start_date (a handful of
-- legacy rows predating that requirement) get NO period at all rather than
-- a fabricated one. employment_type/work_group/expected_finish/
-- actual_finish are all left NULL (Unspecified/open-ended) — an inactive
-- employee with no recorded finish date is deliberately left incomplete
-- rather than auto-completed from is_active. No audit-history row is
-- written for this system backfill (no human actor exists to attribute it
-- to; the change is fully documented here instead).
insert into employee_employment_periods (employee_id, start_date, created_by_employee_id)
select id, start_date, null
from employees
where start_date is not null;
