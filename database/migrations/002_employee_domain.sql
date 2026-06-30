-- ============================================================
-- Migration 002: Chapter 3 — Employee Domain
-- ============================================================
-- Drops the three placeholder tables from migration 001 and
-- creates the full employee domain schema in dependency order.
--
-- Tables created (14):
--   companies, sites, security_roles, job_roles, teams,
--   contract_templates, employees, employee_sensitive_data,
--   employee_credentials, employee_security_role_assignments,
--   employment_records, devices, device_assignments,
--   device_login_history
-- ============================================================

BEGIN;

-- ============================================================
-- Drop placeholders from migration 001
-- ============================================================

DROP TABLE IF EXISTS employment_history;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS contract_templates;

-- ============================================================
-- Shared trigger function: keep updated_at current
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Sequence: employee_number
-- API generates: 'EMP-' || LPAD(nextval('employee_number_seq')::text, 4, '0')
-- ============================================================

CREATE SEQUENCE employee_number_seq START 1;

-- ============================================================
-- 1. companies
-- ============================================================

CREATE TABLE companies (
  id          SERIAL       PRIMARY KEY,
  name        TEXT         NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 2. sites
-- ============================================================

CREATE TABLE sites (
  id          SERIAL       PRIMARY KEY,
  company_id  INTEGER      NOT NULL REFERENCES companies (id),
  name        TEXT         NOT NULL,
  code        TEXT         NOT NULL,
  address     TEXT,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT sites_company_code_key UNIQUE (company_id, code)
);

CREATE INDEX ON sites (company_id);

CREATE TRIGGER sites_updated_at
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 3. security_roles
-- ============================================================

CREATE TABLE security_roles (
  id          SERIAL       PRIMARY KEY,
  name        TEXT         NOT NULL,
  description TEXT,
  is_default  BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT security_roles_name_key UNIQUE (name)
);

-- Exactly one default role permitted
CREATE UNIQUE INDEX security_roles_one_default
  ON security_roles (is_default)
  WHERE (is_default = TRUE);

CREATE TRIGGER security_roles_updated_at
  BEFORE UPDATE ON security_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO security_roles (sort_order, name, description, is_default) VALUES
  (1, 'General',     'Regular employee — mobile clock-in/clock-out only',              TRUE),
  (2, 'Crew Leader', 'Can view team registrations and close shifts for others',         FALSE),
  (3, 'Supervisor',  'Can manage employees and registrations within their site',        FALSE),
  (4, 'Manager',     'Can manage all data including contracts and locations',           FALSE),
  (5, 'Admin',       'Full system access including configuration and user management',  FALSE);

-- ============================================================
-- 4. job_roles
-- ============================================================

CREATE TABLE job_roles (
  id          SERIAL       PRIMARY KEY,
  name        TEXT         NOT NULL,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT job_roles_name_key UNIQUE (name)
);

CREATE TRIGGER job_roles_updated_at
  BEFORE UPDATE ON job_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO job_roles (sort_order, name) VALUES
  (1, 'General'),
  (2, 'Harvester'),
  (3, 'Packer'),
  (4, 'Grader'),
  (5, 'Driver'),
  (6, 'Supervisor'),
  (7, 'Manager');

-- ============================================================
-- 5. teams
-- ============================================================

CREATE TABLE teams (
  id          SERIAL       PRIMARY KEY,
  site_id     INTEGER      NOT NULL REFERENCES sites (id),
  name        TEXT         NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT teams_site_name_key UNIQUE (site_id, name)
);

CREATE INDEX ON teams (site_id);

CREATE TRIGGER teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 6. contract_templates  (stub — Chapter 4 will ALTER this table)
-- ============================================================

CREATE TABLE contract_templates (
  id          SERIAL       PRIMARY KEY,
  name        TEXT         NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER contract_templates_updated_at
  BEFORE UPDATE ON contract_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 7. employees
-- ============================================================

CREATE TABLE employees (
  id              SERIAL       PRIMARY KEY,
  employee_number TEXT         NOT NULL,
  first_name      TEXT         NOT NULL,
  last_name       TEXT         NOT NULL,
  date_of_birth   DATE,
  phone           TEXT,
  email           TEXT,
  notes           TEXT,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT employees_number_key UNIQUE (employee_number)
);

CREATE INDEX ON employees (archived_at);
CREATE INDEX ON employees (last_name);

CREATE TRIGGER employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 8. employee_sensitive_data
-- ============================================================

CREATE TABLE employee_sensitive_data (
  id                   SERIAL       PRIMARY KEY,
  employee_id          INTEGER      NOT NULL REFERENCES employees (id),
  national_id_number   TEXT,
  national_id_country  TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT esd_employee_key UNIQUE (employee_id)
);

CREATE TRIGGER employee_sensitive_data_updated_at
  BEFORE UPDATE ON employee_sensitive_data
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 9. employee_credentials
-- ============================================================

CREATE TABLE employee_credentials (
  id          SERIAL       PRIMARY KEY,
  employee_id INTEGER      NOT NULL REFERENCES employees (id),
  pin_hash    TEXT,                               -- NULL = no PIN set
  pin_set_at  TIMESTAMPTZ,
  pin_set_by  INTEGER      REFERENCES employees (id),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT ec_employee_key UNIQUE (employee_id)
);

CREATE TRIGGER employee_credentials_updated_at
  BEFORE UPDATE ON employee_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 10. employee_security_role_assignments
-- ============================================================

CREATE TABLE employee_security_role_assignments (
  id               SERIAL       PRIMARY KEY,
  employee_id      INTEGER      NOT NULL REFERENCES employees (id),
  security_role_id INTEGER      NOT NULL REFERENCES security_roles (id),
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,                   -- NULL = currently active
  changed_by       INTEGER      REFERENCES employees (id),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Exactly one active role per employee
CREATE UNIQUE INDEX esra_current_unique
  ON employee_security_role_assignments (employee_id)
  WHERE (ended_at IS NULL);

CREATE INDEX ON employee_security_role_assignments (employee_id, started_at);

CREATE INDEX esra_role_active
  ON employee_security_role_assignments (security_role_id)
  WHERE (ended_at IS NULL);

-- ============================================================
-- 11. employment_records
-- ============================================================

CREATE TABLE employment_records (
  id                   SERIAL       PRIMARY KEY,
  employee_id          INTEGER      NOT NULL REFERENCES employees (id),
  site_id              INTEGER      NOT NULL REFERENCES sites (id),
  job_role_id          INTEGER      REFERENCES job_roles (id),
  contract_template_id INTEGER      REFERENCES contract_templates (id),
  team_id              INTEGER      REFERENCES teams (id),
  supervisor_id        INTEGER      REFERENCES employees (id),
  started_on           DATE         NOT NULL,
  ended_on             DATE,                      -- NULL = currently active
  notes                TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by           INTEGER      REFERENCES employees (id),

  CONSTRAINT er_date_range_check
    CHECK (ended_on IS NULL OR ended_on > started_on),

  CONSTRAINT er_no_self_supervise
    CHECK (supervisor_id IS NULL OR supervisor_id != employee_id)
);

-- Exactly one active employment record per employee
CREATE UNIQUE INDEX er_current_unique
  ON employment_records (employee_id)
  WHERE (ended_on IS NULL);

CREATE INDEX ON employment_records (employee_id, started_on);
CREATE INDEX ON employment_records (site_id);
CREATE INDEX ON employment_records (team_id);
CREATE INDEX ON employment_records (job_role_id);

-- ============================================================
-- 12. devices
-- ============================================================

CREATE TABLE devices (
  id          SERIAL       PRIMARY KEY,
  site_id     INTEGER      NOT NULL REFERENCES sites (id),
  name        TEXT         NOT NULL,
  identifier  TEXT         NOT NULL,              -- LabourLink UUID, set by mobile app on first launch
  is_shared   BOOLEAN      NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT devices_identifier_key UNIQUE (identifier)
);

CREATE INDEX ON devices (site_id);
CREATE INDEX ON devices (archived_at);

CREATE TRIGGER devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 13. device_assignments
-- ============================================================

CREATE TABLE device_assignments (
  id            SERIAL       PRIMARY KEY,
  device_id     INTEGER      NOT NULL REFERENCES devices (id),
  employee_id   INTEGER      NOT NULL REFERENCES employees (id),
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,                      -- NULL = currently active
  changed_by    INTEGER      NOT NULL REFERENCES employees (id),
  change_reason TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Exactly one active assignment per device
CREATE UNIQUE INDEX da_current_unique
  ON device_assignments (device_id)
  WHERE (ended_at IS NULL);

CREATE INDEX ON device_assignments (device_id, started_at);
CREATE INDEX ON device_assignments (employee_id);

-- ============================================================
-- 14. device_login_history
-- ============================================================

CREATE TABLE device_login_history (
  id             SERIAL       PRIMARY KEY,
  device_id      INTEGER      NOT NULL REFERENCES devices (id),
  employee_id    INTEGER      NOT NULL REFERENCES employees (id),
  logged_in_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  logged_out_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX ON device_login_history (device_id,   logged_in_at);
CREATE INDEX ON device_login_history (employee_id, logged_in_at);

-- Open sessions index — used to detect stale sessions
CREATE INDEX dlh_open_sessions
  ON device_login_history (device_id)
  WHERE (logged_out_at IS NULL);

COMMIT;
