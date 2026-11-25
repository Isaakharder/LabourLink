-- Bin picking cycles: every harvest weighing belongs to at most one picking
-- cycle, and a cycle is closed by at most one weighing. See
-- src/lib/binCycles.ts for the rules and docs/picking-cycles-cutover.md for
-- the cutover, stop and restart steps.
--
-- A cycle is opened by an employee's phone bin choice (work_start /
-- activity_switch answering a carrier question, or bin_rescan: scanning the
-- bin already in use again) and closed by the bin's next weighing, by an
-- administrator ("closed without weighing"), or by stopping cycle tracking.
-- A bin weighed again with no new phone scan has no cycle and is never
-- credited.
--
-- Nothing here touches existing data. Cycle tracking stays OFF (the existing
-- matching rule applies unchanged) until a tracking period is started:
--   insert into bin_cycle_tracking (started_at, note) values (now(), '...');
-- and is stopped with:
--   update bin_cycle_tracking set stopped_at = now() where stopped_at is null;
-- Phone scans outside a period never open a cycle; weighings outside a period
-- keep the existing rule, which after a stop never uses a scan from before
-- the stop. No historical cycles are inferred.

create table bin_cycle_tracking (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  stopped_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  constraint chk_bin_cycle_tracking_period check (stopped_at is null or stopped_at > started_at)
);
create unique index bin_cycle_tracking_one_open on bin_cycle_tracking ((true)) where stopped_at is null;

create table bin_cycles (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references carriers(id),
  -- filling / awaiting_weighing / needs_review: open (at most one per bin).
  -- closed: a weighing closed it (weighing_id; whether anyone was credited is
  -- that weighing's status). closed_unweighed: an administrator closed it, or
  -- cycle tracking was stopped while it was open.
  status text not null check (status in ('filling', 'awaiting_weighing', 'needs_review', 'closed', 'closed_unweighed')),
  -- The first employee who chose the bin in this cycle.
  employee_id uuid not null references employees(id),
  opened_at timestamptz not null,
  last_scan_at timestamptz not null,
  awaiting_since timestamptz,
  review_reason text,
  weighing_id uuid references scale_weighings(id),
  closed_at timestamptz,
  close_reason text,
  closed_by_employee_id uuid references employees(id), -- null: closed by the system (tracking stopped)
  close_request_id uuid,
  -- Administrator resolution of a needs-review cycle's weighing.
  resolved_employee_id uuid references employees(id),
  resolved_by_employee_id uuid references employees(id),
  resolved_at timestamptz,
  resolution_reason text,
  resolution_previous_status text,
  resolution_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bin_cycles_one_per_weighing unique (weighing_id),
  constraint bin_cycles_close_request_key unique (close_request_id),
  constraint bin_cycles_resolution_request_key unique (resolution_request_id),
  constraint chk_bin_cycles_closed check (
    (status in ('closed', 'closed_unweighed')) = (closed_at is not null)
    and (status = 'closed') = (weighing_id is not null)
    and (status <> 'closed_unweighed' or close_reason is not null)
  ),
  constraint chk_bin_cycles_resolution check (
    (resolved_at is null) = (resolved_employee_id is null)
    and (resolved_at is null) = (resolved_by_employee_id is null)
    and (resolved_at is null) = (resolution_reason is null)
    and (resolved_at is null or status = 'closed')
  )
);
create unique index bin_cycles_one_open_per_bin on bin_cycles (carrier_id)
  where status in ('filling', 'awaiting_weighing', 'needs_review');
create index idx_bin_cycles_carrier_closed on bin_cycles (carrier_id, closed_at);

-- One row per accepted phone bin choice made during a tracking period, so a
-- bin's scans can be read without scanning every phone event. A scan belongs
-- to at most one cycle (cycle_id null = not yet placed).
create table bin_scans (
  mobile_time_event_id uuid primary key references mobile_time_events(id),
  carrier_id uuid not null references carriers(id),
  employee_id uuid not null references employees(id),
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  clock_trusted boolean not null,
  cycle_id uuid references bin_cycles(id),
  created_at timestamptz not null default now()
);
create index idx_bin_scans_carrier_time on bin_scans (carrier_id, occurred_at);
create index idx_bin_scans_cycle on bin_scans (cycle_id);

-- Audit history of every cycle change.
create table bin_cycle_events (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references bin_cycles(id),
  kind text not null,
  from_status text,
  to_status text,
  employee_id uuid references employees(id),
  actor_employee_id uuid references employees(id),
  weighing_id uuid references scale_weighings(id),
  mobile_time_event_id uuid references mobile_time_events(id),
  reason text,
  detail jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index idx_bin_cycle_events_cycle on bin_cycle_events (cycle_id, created_at);

-- bin_rescan: the phone scanned the bin it is already using again (a new
-- picking cycle if the bin was weighed since). It changes no time entry.
alter table mobile_time_events drop constraint mobile_time_events_event_type_check;
alter table mobile_time_events add constraint mobile_time_events_event_type_check
  check (event_type in ('work_start', 'activity_switch', 'break_start', 'break_end', 'end_day', 'bin_rescan'));
