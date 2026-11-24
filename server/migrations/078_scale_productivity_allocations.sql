-- Kilograms/hour: administrator decisions on how a weighed bin's net
-- kilograms are shared between the employees who picked into it
-- (src/lib/scaleProductivity.ts, Scale Weighings -> Review allocation).
--
-- PRODUCTIVITY REPORTING ONLY. Nothing here changes an employee's official
-- scale credit (scale_weighings.employee_id / status, scale_weighing_claims),
-- a picking cycle, a time entry or pay. A weighing still has exactly one
-- credited employee; these rows only decide which employees' kg/hour its
-- kilograms (and their own matched picking minutes) count towards.
--
-- Ordinary bins need no row here: a bin picked by one employee, or handed
-- from one employee to another while picking continues, is allocated
-- automatically in proportion to each employee's matched picking minutes.
-- Bins whose load boundary is uncertain (a gap or overnight handover, time
-- under another job, overlapping time, a late conflict) count for nobody
-- until an administrator decides here.
--
-- A decision is tied to the records it was made on (inputs_fingerprint:
-- the contributing employees, their matched seconds, the net weight and the
-- load start). If those change later (a time entry corrected in Inputs, a
-- delayed phone upload), the decision no longer applies and the bin returns
-- to review; it is never silently re-applied to different records.
--
-- Additive only: three new tables, no existing table or value changes.

create table scale_productivity_allocations (
  weighing_id uuid primary key references scale_weighings(id),
  activity_id uuid not null references activities(id),
  -- confirm: the calculated proportional allocation is right.
  -- override: the administrator excluded contributions and/or set kilograms.
  -- exclude: the bin counts for nobody's kg/hour.
  action text not null check (action in ('confirm', 'override', 'exclude')),
  -- proportional: kilograms follow matched minutes of the included employees.
  -- manual: kilograms entered by the administrator. Null for exclude.
  method text check (method in ('proportional', 'manual')),
  inputs_fingerprint text not null,
  net_g integer not null,
  reason text not null check (length(trim(reason)) >= 3),
  decided_by_employee_id uuid not null references employees(id),
  decided_at timestamptz not null default now(),
  constraint chk_spa_method check ((action = 'exclude') = (method is null)),
  constraint chk_spa_confirm_proportional check (action <> 'confirm' or method = 'proportional')
);

create table scale_productivity_allocation_shares (
  weighing_id uuid not null references scale_productivity_allocations(weighing_id) on delete cascade,
  employee_id uuid not null references employees(id),
  included boolean not null,
  matched_seconds integer not null check (matched_seconds >= 0),
  allocated_g integer not null check (allocated_g >= 0),
  primary key (weighing_id, employee_id),
  constraint chk_spa_share_excluded_zero check (included or allocated_g = 0)
);

-- Append-only: every decision and reset, with who, when, why, what it
-- replaced and the calculated allocation the administrator was shown.
create table scale_productivity_allocation_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  weighing_id uuid not null references scale_weighings(id),
  activity_id uuid not null references activities(id),
  action text not null check (action in ('confirm', 'override', 'exclude', 'reset')),
  reason text not null check (length(trim(reason)) >= 3),
  previous jsonb,
  next jsonb,
  proposal jsonb not null,
  performed_by_employee_id uuid not null references employees(id),
  performed_at timestamptz not null default now()
);
create index idx_spa_history_weighing on scale_productivity_allocation_history (weighing_id, performed_at);
