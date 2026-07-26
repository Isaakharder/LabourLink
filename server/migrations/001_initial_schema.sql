-- LabourLink V2 — Initial schema
-- Phase 1: employees, devices, pairing, and role lookup tables.
-- Do not add tables for activities, work sessions, payroll, or greenhouse logic here.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Lookup tables
-- ---------------------------------------------------------------------------

create table security_roles (
  id serial primary key,
  name text not null unique,
  rank int not null unique -- higher rank = more privileged; used for simple comparisons later
);

insert into security_roles (name, rank) values
  ('Employee', 1),
  ('Crew Leader', 2),
  ('Supervisor', 3),
  ('Manager', 4),
  ('Administrator', 5);

create table team_roles (
  id serial primary key,
  name text not null unique
);

insert into team_roles (name) values
  ('Team Member'),
  ('Team Leader'),
  ('Assistant Team Leader');

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------

create table employees (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  gender text,
  date_of_birth date,
  email text unique,
  phone_number text,
  job_group text,
  start_date date,
  is_active boolean not null default true,

  security_role_id int not null references security_roles(id),
  team_role_id int not null references team_roles(id),
  settings_pin_hash text not null, -- bcrypt hash; the PIN itself is never stored

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_employees_is_active on employees(is_active);

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

create table devices (
  id uuid primary key default gen_random_uuid(),
  device_identifier text not null unique, -- generated client-side on first launch, persisted locally
  device_name text,
  app_version text,
  last_seen timestamptz,
  date_paired timestamptz,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_devices_is_active on devices(is_active);

-- ---------------------------------------------------------------------------
-- Device assignments (current + historical employee <-> device links)
-- ---------------------------------------------------------------------------

create table device_assignments (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz -- null while the assignment is current
);

-- Only one active (unassigned_at is null) assignment per device at a time.
create unique index idx_device_assignments_active_per_device
  on device_assignments(device_id)
  where unassigned_at is null;

create index idx_device_assignments_employee on device_assignments(employee_id);

-- ---------------------------------------------------------------------------
-- Pairing requests
-- ---------------------------------------------------------------------------

create table pairing_requests (
  id uuid primary key default gen_random_uuid(),
  pairing_code text not null,
  device_identifier text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'expired', 'used')),

  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  approved_by_employee_id uuid references employees(id),
  approved_at timestamptz,
  resulting_device_id uuid references devices(id)
);

-- A given pairing code can only be "live" (pending) once at a time.
create unique index idx_pairing_requests_active_code
  on pairing_requests(pairing_code)
  where status = 'pending';

create index idx_pairing_requests_device on pairing_requests(device_identifier);
