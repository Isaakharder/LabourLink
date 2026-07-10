-- ============================================================
-- Migration 023 — Phase 1 Authentication: users & sessions
-- ============================================================
-- Introduces a dedicated login-account concept (`users`), fully
-- decoupled from `employees` (an employee is a payroll/HR record;
-- a user is a login credential that may optionally reference one).
--
-- Sessions are stored server-side in Postgres (not JWT/localStorage)
-- so they can be listed and revoked from the admin panel.
-- ============================================================

BEGIN;

-- ============================================================
-- users
-- ============================================================

CREATE TABLE users (
  id                     SERIAL       PRIMARY KEY,
  company_id             INTEGER      NOT NULL REFERENCES companies (id),
  employee_id            INTEGER      REFERENCES employees (id),
  email                  TEXT         NOT NULL,
  password_hash          TEXT         NOT NULL,
  role_id                INTEGER      NOT NULL REFERENCES security_roles (id),
  is_active              BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at          TIMESTAMPTZ,
  failed_login_attempts  INTEGER      NOT NULL DEFAULT 0,
  locked_until           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Login identifier unique within a company, not globally
CREATE UNIQUE INDEX users_company_email_key ON users (company_id, lower(email));

CREATE INDEX ON users (company_id);
CREATE INDEX ON users (employee_id);

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- sessions
-- ============================================================
-- One row per active login session. `sid` is the cryptographically
-- random id express-session generates and stores (signed) in the
-- HttpOnly cookie — the cookie itself never carries user/company data.

CREATE TABLE sessions (
  sid          TEXT         PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  company_id   INTEGER      NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  sess         JSONB        NOT NULL,
  user_agent   TEXT,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  revoked_at   TIMESTAMPTZ
);

-- Fast "list this user's active sessions" for the admin panel
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE (revoked_at IS NULL);
CREATE INDEX ON sessions (expires_at);

COMMIT;
