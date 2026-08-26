-- Work-permit expiry tracking on employee profiles + Dashboard alerts.
--
-- work_permit_expiry_date is deliberately a plain `date` (matching
-- employees.start_date's own type, 001_initial_schema.sql) — never a
-- timestamptz. A date column has no time-of-day/offset component at all,
-- so it structurally cannot shift by a day across timezones; every server
-- query below reads it via to_char(..., 'YYYY-MM-DD'), the same convention
-- start_date already uses (see server/src/routes/employees.ts), never via
-- pg's default Date-object parsing.
--
-- This is explicitly NOT the employee's Employment End Date and never
-- changes is_active — nothing here touches that column or any permission/
-- payroll/time-entry table.
alter table employees
  add column work_permit_expiry_date date,
  add column work_permit_notify_lead_months integer,
  add column work_permit_notify_lead_days integer;

-- Exactly one of the two lead settings whenever an expiry date is present
-- (never both, never neither) — the boolean XOR (<>) reads as "these two
-- 'is set' flags must differ." When work_permit_expiry_date is null,
-- neither is constrained (both null is the ordinary "no permit tracked"
-- state). The server always supplies a default (6 months) when an expiry
-- date is entered with no explicit lead — see workPermits.ts's
-- resolveNotifyLead — so this constraint is a defense-in-depth backstop,
-- not the primary mechanism.
alter table employees
  add constraint chk_employees_work_permit_lead_set_with_expiry
  check (
    work_permit_expiry_date is null
    or ((work_permit_notify_lead_months is not null) <> (work_permit_notify_lead_days is not null))
  );

alter table employees
  add constraint chk_employees_work_permit_lead_months_valid
  check (work_permit_notify_lead_months is null or work_permit_notify_lead_months in (1, 2, 3, 6, 12));

-- "Sensible positive value" — 1 to 3650 days (10 years). Guards against a
-- zero/negative value (meaningless) and an absurdly large one (a likely
-- typo, e.g. thousands of days) without being so tight it rejects a
-- legitimate multi-year custom lead time.
alter table employees
  add constraint chk_employees_work_permit_lead_days_valid
  check (work_permit_notify_lead_days is null or work_permit_notify_lead_days between 1 and 3650);

-- Complete audit trail of every expiry-date change, regardless of whether
-- it came through ordinary profile editing or the dedicated Renewed
-- action — both write here (see employees.ts's PATCH and
-- workPermits.ts's renewWorkPermit). old/new are both nullable: the first
-- time an expiry is ever entered has old_expiry_date null; clearing an
-- expiry (stopping alerts) has new_expiry_date null. Never updated once
-- written, same append-only convention as time_entry_corrections.
create table employee_work_permit_history (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  old_expiry_date date,
  new_expiry_date date,
  changed_by_employee_id uuid not null references employees(id),
  changed_at timestamptz not null default now(),
  reason text
);
create index idx_employee_work_permit_history_employee on employee_work_permit_history(employee_id, changed_at desc);

-- One row per Acknowledge click, scoped to the exact expiry_date value in
-- effect at that moment — deliberately append-only (never updated), which
-- is what makes two tabs racing to acknowledge harmless (two audit rows,
-- not a conflict) and is itself the complete "who/when" audit trail the
-- brief asks for. Whether an alert is currently snoozed is a computed
-- property (workPermits.ts's isSnoozed: now < latest matching row's
-- acknowledged_at + 7 days), not a separate stored flag that could go
-- stale.
create table work_permit_alert_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  expiry_date date not null,
  acknowledged_by_employee_id uuid not null references employees(id),
  acknowledged_at timestamptz not null default now()
);
create index idx_work_permit_ack_employee_expiry on work_permit_alert_acknowledgements(employee_id, expiry_date, acknowledged_at desc);

-- At most one cancellation per (employee, expiry_date) — unlike
-- acknowledgements, "cancelled" is a one-time boolean-like state, not a
-- repeatable event, so a second Cancel click on the same expiry-date
-- version is a genuine no-op (see workPermits.ts's cancelWorkPermitAlert:
-- on conflict do nothing) rather than a second audit row. A later expiry-
-- date change naturally has no matching cancellation row, which is the
-- entire mechanism behind "changing the expiry date creates a new alert
-- cycle automatically" — no separate bookkeeping needed.
create table work_permit_alert_cancellations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  expiry_date date not null,
  cancelled_by_employee_id uuid not null references employees(id),
  cancelled_at timestamptz not null default now(),
  reason text,
  unique (employee_id, expiry_date)
);
