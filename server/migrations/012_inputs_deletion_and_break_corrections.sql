-- Extends the Inputs page's correction tools (009_time_entry_corrections)
-- to also cover: editing a break's start/end time (with adjacent
-- work-entry timeline repair), soft-deleting an activity log or a break,
-- and suppressing auto-add reconciliation for a deleted auto-added break so
-- it doesn't just get silently recreated on the next status/day load.

-- ---------------------------------------------------------------------------
-- Soft delete on time_entries — never a hard delete. All three columns are
-- set together or not at all (see the check constraint below), and nothing
-- about a deleted row's original data is touched, so it stays fully
-- readable as its own audit trail; every normal read path is expected to
-- add `and deleted_at is null`.
-- ---------------------------------------------------------------------------

alter table time_entries
  add column deleted_at timestamptz,
  add column deleted_by_employee_id uuid references employees(id),
  add column deletion_reason text,
  add constraint chk_time_entries_deletion_consistency check (
    (deleted_at is null) = (deleted_by_employee_id is null) and
    (deleted_at is null) = (deletion_reason is null)
  );

-- ---------------------------------------------------------------------------
-- time_entry_corrections: a break's start time is now correctable the same
-- way its end time already is (and an activity run's end time) — same
-- table, same shape, just one more allowed field_name.
-- ---------------------------------------------------------------------------

alter table time_entry_corrections
  drop constraint time_entry_corrections_field_name_check;

alter table time_entry_corrections
  add constraint time_entry_corrections_field_name_check
  check (field_name in ('ended_at', 'started_at'));

-- ---------------------------------------------------------------------------
-- time_entry_deletions: one row per deletion action (not per affected
-- time_entries row) — a multi-fragment activity run deletes several rows
-- together, and this is what groups them as "one supervisor action" rather
-- than several independent-looking row flags. The affected rows' own
-- original field values remain directly queryable (soft delete, not
-- erasure), so this table only needs to record which rows, not what they
-- contained.
-- ---------------------------------------------------------------------------

create table time_entry_deletions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  deleted_by_employee_id uuid not null references employees(id),
  deletion_type text not null check (deletion_type in ('activity_run', 'break')),
  affected_time_entry_ids uuid[] not null,
  reason text not null check (char_length(trim(reason)) >= 3),
  deleted_at timestamptz not null default now()
);

create index idx_time_entry_deletions_employee on time_entry_deletions(employee_id);

-- ---------------------------------------------------------------------------
-- break_schedule_exceptions: suppresses auto-add reconciliation for one
-- (employee, break_profile_item, date) combination. Without this, deleting
-- an auto-added break would be pointless — reconcileEmployeeBreaks would
-- just see the scheduled window is unaccounted-for again on the very next
-- status fetch or Inputs load and re-add it. Manual (non-auto) breaks never
-- need a row here since reconciliation never touches them.
-- ---------------------------------------------------------------------------

create table break_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  break_profile_item_id uuid not null references break_profile_items(id),
  scheduled_date date not null,
  action text not null default 'suppressed' check (action in ('suppressed')),
  reason text not null check (char_length(trim(reason)) >= 3),
  created_by_employee_id uuid not null references employees(id),
  created_at timestamptz not null default now(),

  unique (employee_id, break_profile_item_id, scheduled_date)
);
