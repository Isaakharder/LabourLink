-- ============================================================
-- Migration 003: Development seed data
-- ============================================================
-- Creates one company, two sites, three teams, five contract
-- templates, and eight employees that mirror the UI mock data.
-- Timeline events are excluded — the activity system is not
-- built yet.  Devices are excluded — no hardware in dev.
-- ============================================================

BEGIN;

-- ── Company ──────────────────────────────────────────────────────────────────
INSERT INTO companies (name) VALUES ('Greenhouse Operations BV');

-- ── Sites ────────────────────────────────────────────────────────────────────
INSERT INTO sites (company_id, name, code)
SELECT id, 'Greenhouse A', 'GHA' FROM companies WHERE name = 'Greenhouse Operations BV'
UNION ALL
SELECT id, 'Greenhouse B', 'GHB' FROM companies WHERE name = 'Greenhouse Operations BV';

-- ── Teams ────────────────────────────────────────────────────────────────────
INSERT INTO teams (site_id, name)
SELECT id, 'Team Alpha' FROM sites WHERE code = 'GHA'
UNION ALL
SELECT id, 'Team Beta'  FROM sites WHERE code = 'GHA'
UNION ALL
SELECT id, 'Team Gamma' FROM sites WHERE code = 'GHB';

-- ── Contract templates ────────────────────────────────────────────────────────
INSERT INTO contract_templates (name) VALUES
  ('General Contract'),
  ('Harvester Contract'),
  ('Packer Contract'),
  ('Supervisor Contract'),
  ('Manager Contract');

-- ── Employees ────────────────────────────────────────────────────────────────
INSERT INTO employees (employee_number, first_name, last_name, date_of_birth, phone, email, notes)
VALUES
  ('EMP-0001', 'Jan',    'van der Berg', '1985-03-14', '+31 6 12345678', 'jan.vandenberg@example.com',    'Reliable and experienced harvester. Completed first aid training in March 2024.'),
  ('EMP-0002', 'Maria',  'Santos',       '1992-07-22', '+31 6 23456789', 'maria.santos@example.com',      NULL),
  ('EMP-0003', 'Peter',  'Kowalski',     '1979-11-30', '+31 6 34567890', NULL,                             'Responsible for transport between Greenhouse A and B. Holds HGV licence class CE.'),
  ('EMP-0004', 'Lisa',   'Chen',         '1988-05-03', '+31 6 45678901', 'lisa.chen@labourlink.local',     'Supervises Teams Alpha and Beta at Greenhouse A. Primary contact for new employee onboarding.'),
  ('EMP-0005', 'Ahmed',  'Hassan',       '1995-09-18', '+31 6 56789012', NULL,                             NULL),
  ('EMP-0006', 'Elena',  'Popescu',      '1990-02-14', '+31 6 67890123', 'elena.popescu@example.com',      'On extended leave. Expected to return Q3 2026.'),
  ('EMP-0007', 'Thomas', 'Müller',       '1975-12-01', '+31 6 78901234', 'thomas.muller@labourlink.local', 'Site manager for Greenhouse A. Also oversees operations at Greenhouse B.'),
  ('EMP-0008', 'Fatima', 'Al-Rashidi',   '1998-04-30', '+31 6 89012345', NULL,                             NULL);

-- Advance employee number sequence past the seeded values
SELECT setval('employee_number_seq', 8);

-- ── Credentials (no PINs in seed) ────────────────────────────────────────────
INSERT INTO employee_credentials (employee_id)
SELECT id FROM employees ORDER BY employee_number;

-- ── Security role assignments ─────────────────────────────────────────────────
INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2019-01-07'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0001' AND sr.name = 'General';

INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2021-03-15'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0002' AND sr.name = 'General';

INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2017-08-21'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0003' AND sr.name = 'Crew Leader';

INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2018-04-09'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0004' AND sr.name = 'Supervisor';

INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2023-06-05'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0005' AND sr.name = 'General';

INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2020-09-01'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0006' AND sr.name = 'General';

INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2015-01-01'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0007' AND sr.name = 'Manager';

INSERT INTO employee_security_role_assignments (employee_id, security_role_id, started_at)
SELECT e.id, sr.id, '2025-02-10'
FROM employees e, security_roles sr
WHERE e.employee_number = 'EMP-0008' AND sr.name = 'General';

-- ── Employment records ────────────────────────────────────────────────────────

-- Jan van der Berg (EMP-0001) — active, Harvester, Greenhouse A, Team Alpha, supervised by Lisa Chen
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, team_id, supervisor_id, started_on)
SELECT e.id, s.id, jr.id, ct.id, t.id, sup.id, '2019-01-07'
FROM employees e, sites s, job_roles jr, contract_templates ct, teams t, employees sup
WHERE e.employee_number  = 'EMP-0001'
  AND s.code             = 'GHA'
  AND jr.name            = 'Harvester'
  AND ct.name            = 'Harvester Contract'
  AND t.name             = 'Team Alpha'
  AND sup.employee_number = 'EMP-0004';

-- Maria Santos (EMP-0002) — career change: General → Packer
-- Ended record
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, team_id, started_on, ended_on)
SELECT e.id, s.id, jr.id, ct.id, t.id, '2021-03-15', '2022-06-30'
FROM employees e, sites s, job_roles jr, contract_templates ct, teams t
WHERE e.employee_number = 'EMP-0002'
  AND s.code            = 'GHA'
  AND jr.name           = 'General'
  AND ct.name           = 'General Contract'
  AND t.name            = 'Team Beta';

-- Current record
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, team_id, supervisor_id, started_on)
SELECT e.id, s.id, jr.id, ct.id, t.id, sup.id, '2022-07-01'
FROM employees e, sites s, job_roles jr, contract_templates ct, teams t, employees sup
WHERE e.employee_number  = 'EMP-0002'
  AND s.code             = 'GHA'
  AND jr.name            = 'Packer'
  AND ct.name            = 'Packer Contract'
  AND t.name             = 'Team Beta'
  AND sup.employee_number = 'EMP-0004';

-- Peter Kowalski (EMP-0003) — active, Driver, Greenhouse B, no team
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, started_on)
SELECT e.id, s.id, jr.id, ct.id, '2017-08-21'
FROM employees e, sites s, job_roles jr, contract_templates ct
WHERE e.employee_number = 'EMP-0003'
  AND s.code            = 'GHB'
  AND jr.name           = 'Driver'
  AND ct.name           = 'General Contract';

-- Lisa Chen (EMP-0004) — career change: Harvester → Supervisor
-- Ended record
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, team_id, started_on, ended_on)
SELECT e.id, s.id, jr.id, ct.id, t.id, '2018-04-09', '2020-12-31'
FROM employees e, sites s, job_roles jr, contract_templates ct, teams t
WHERE e.employee_number = 'EMP-0004'
  AND s.code            = 'GHA'
  AND jr.name           = 'Harvester'
  AND ct.name           = 'Harvester Contract'
  AND t.name            = 'Team Alpha';

-- Current record
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, started_on)
SELECT e.id, s.id, jr.id, ct.id, '2021-01-01'
FROM employees e, sites s, job_roles jr, contract_templates ct
WHERE e.employee_number = 'EMP-0004'
  AND s.code            = 'GHA'
  AND jr.name           = 'Supervisor'
  AND ct.name           = 'Supervisor Contract';

-- Ahmed Hassan (EMP-0005) — active, Harvester, Greenhouse B, Team Gamma, supervised by Peter Kowalski
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, team_id, supervisor_id, started_on)
SELECT e.id, s.id, jr.id, ct.id, t.id, sup.id, '2023-06-05'
FROM employees e, sites s, job_roles jr, contract_templates ct, teams t, employees sup
WHERE e.employee_number  = 'EMP-0005'
  AND s.code             = 'GHB'
  AND jr.name            = 'Harvester'
  AND ct.name            = 'Harvester Contract'
  AND t.name             = 'Team Gamma'
  AND sup.employee_number = 'EMP-0003';

-- Elena Popescu (EMP-0006) — INACTIVE: employment ended 2026-05-15
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, team_id, supervisor_id, started_on, ended_on)
SELECT e.id, s.id, jr.id, ct.id, t.id, sup.id, '2020-09-01', '2026-05-15'
FROM employees e, sites s, job_roles jr, contract_templates ct, teams t, employees sup
WHERE e.employee_number  = 'EMP-0006'
  AND s.code             = 'GHA'
  AND jr.name            = 'Packer'
  AND ct.name            = 'General Contract'
  AND t.name             = 'Team Beta'
  AND sup.employee_number = 'EMP-0004';

-- Thomas Müller (EMP-0007) — career change: Supervisor → Manager
-- Ended record
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, started_on, ended_on)
SELECT e.id, s.id, jr.id, ct.id, '2015-01-01', '2018-12-31'
FROM employees e, sites s, job_roles jr, contract_templates ct
WHERE e.employee_number = 'EMP-0007'
  AND s.code            = 'GHA'
  AND jr.name           = 'Supervisor'
  AND ct.name           = 'Supervisor Contract';

-- Current record
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, started_on)
SELECT e.id, s.id, jr.id, ct.id, '2019-01-01'
FROM employees e, sites s, job_roles jr, contract_templates ct
WHERE e.employee_number = 'EMP-0007'
  AND s.code            = 'GHA'
  AND jr.name           = 'Manager'
  AND ct.name           = 'Manager Contract';

-- Fatima Al-Rashidi (EMP-0008) — active, Harvester, Greenhouse A, Team Alpha, supervised by Lisa Chen
INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, team_id, supervisor_id, started_on)
SELECT e.id, s.id, jr.id, ct.id, t.id, sup.id, '2025-02-10'
FROM employees e, sites s, job_roles jr, contract_templates ct, teams t, employees sup
WHERE e.employee_number  = 'EMP-0008'
  AND s.code             = 'GHA'
  AND jr.name            = 'Harvester'
  AND ct.name            = 'Harvester Contract'
  AND t.name             = 'Team Alpha'
  AND sup.employee_number = 'EMP-0004';

COMMIT;
