-- Phase 3/4: core activities and mobile time tracking.

create table activities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true
);

insert into activities (name, sort_order) values
  ('Winding & Pruning', 1),
  ('Picking Peppers', 2);

-- One row per open-or-closed work/break span. At most one row per employee
-- may be open (ended_at is null) at a time — that single invariant is what
-- "start work / change activity / break / end day" all reduce to: close
-- whatever is open, optionally open a new row.
create table time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  device_id uuid not null references devices(id),
  entry_type text not null check (entry_type in ('work', 'break')),
  activity_id uuid references activities(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,

  -- Client-generated key so a retried/duplicated tap replays the same
  -- result instead of opening a second entry.
  idempotency_key uuid not null unique,

  created_at timestamptz not null default now(),

  constraint chk_time_entries_activity_matches_type check (
    (entry_type = 'work' and activity_id is not null) or
    (entry_type = 'break' and activity_id is null)
  )
);

create unique index idx_time_entries_one_open_per_employee
  on time_entries (employee_id)
  where ended_at is null;

create index idx_time_entries_employee on time_entries (employee_id, started_at desc);
