-- "Forgot PIN" self-service reset requests.
-- Mirrors the pairing_requests pattern: an unauthenticated actor creates a
-- short-lived row, something later resolves it. Here resolution is the
-- emailed token itself rather than an admin approval.

create table password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  token_hash text not null unique, -- sha256 hex digest; raw token is never stored
  status text not null default 'pending' check (status in ('pending', 'used', 'expired')),

  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  used_at timestamptz
);

create index idx_password_reset_requests_employee on password_reset_requests(employee_id);

-- At most one live request per employee — a fresh "forgot PIN" click
-- supersedes any earlier still-pending link rather than piling up.
create unique index idx_password_reset_requests_one_pending_per_employee
  on password_reset_requests (employee_id)
  where status = 'pending';
