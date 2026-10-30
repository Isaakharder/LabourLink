-- Desktop web sign-in sessions (see server/src/lib/webSessions.ts).
--
-- Until now a desktop sign-in was a single 12-hour JWT cookie with no way to
-- renew it, so an office PC signed in during the day was always back on the
-- login screen the next morning. A sign-in now creates one row here: the
-- browser holds a random refresh token in an httpOnly cookie (only its
-- sha256 digest is stored, same as password_reset_requests), and the
-- short-lived access JWT is silently re-issued from it while the row is
-- live. Revoking the row (sign out, employee deactivated, PIN reset) ends the
-- sign-in on its next renewal.
create table web_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  refresh_token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_refreshed_at timestamptz not null default now(),
  -- Sliding: pushed forward on every renewal, capped at absolute_expires_at.
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);

create index web_sessions_live_by_employee on web_sessions (employee_id) where revoked_at is null;
