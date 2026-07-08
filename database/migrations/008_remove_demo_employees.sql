-- ============================================================
-- Migration 008: Remove demo / seed employees
-- ============================================================
-- Removes the 8 employees inserted by 003_seed.sql
-- (EMP-0001 through EMP-0008) and all their dependent records.
--
-- Employees added after the seed (higher employee_number_seq
-- values) are not touched. Master data (companies, sites, teams,
-- contract_templates, locations, activities) is not affected.
--
-- Delete order follows FK dependency chain:
--   work_yields → work_registrations → work_events
--   → sync_batches → employee_day_sessions
--   → device_login_history → device_assignments
--   → employee_security_role_assignments
--   → employee_sensitive_data → employee_credentials
--   → employment_records → employees
-- ============================================================

BEGIN;

-- Capture demo employee IDs by the exact numbers from 003_seed.sql
CREATE TEMP TABLE _demo AS
SELECT id
FROM employees
WHERE employee_number IN (
  'EMP-0001', 'EMP-0002', 'EMP-0003', 'EMP-0004',
  'EMP-0005', 'EMP-0006', 'EMP-0007', 'EMP-0008'
);

-- ── 1. Work yields ────────────────────────────────────────────────────────────
-- References: work_registrations, work_events
DELETE FROM work_yields
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 2. Work registrations ─────────────────────────────────────────────────────
-- References: work_events, employee_day_sessions
DELETE FROM work_registrations
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 3. Work events ────────────────────────────────────────────────────────────
-- References: employee_day_sessions, sync_batches
-- Safety net: clear actor_id on events owned by non-demo employees
UPDATE work_events SET actor_id = NULL
WHERE actor_id IN (SELECT id FROM _demo)
  AND employee_id NOT IN (SELECT id FROM _demo);

DELETE FROM work_events
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 4. Sync batches ───────────────────────────────────────────────────────────
DELETE FROM sync_batches
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 5. Employee day sessions ──────────────────────────────────────────────────
DELETE FROM employee_day_sessions
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 6. Device login history ───────────────────────────────────────────────────
DELETE FROM device_login_history
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 7. Device assignments ─────────────────────────────────────────────────────
-- changed_by may reference any employee; null it out for non-demo assignments
UPDATE device_assignments SET changed_by = NULL
WHERE changed_by IN (SELECT id FROM _demo);

DELETE FROM device_assignments
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 8. Security role assignments ──────────────────────────────────────────────
-- changed_by safety net for non-demo employees
UPDATE employee_security_role_assignments SET changed_by = NULL
WHERE changed_by IN (SELECT id FROM _demo)
  AND employee_id NOT IN (SELECT id FROM _demo);

DELETE FROM employee_security_role_assignments
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 9. Sensitive data ─────────────────────────────────────────────────────────
DELETE FROM employee_sensitive_data
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 10. Credentials ──────────────────────────────────────────────────────────
-- pin_set_by safety net for non-demo employees
UPDATE employee_credentials SET pin_set_by = NULL
WHERE pin_set_by IN (SELECT id FROM _demo)
  AND employee_id NOT IN (SELECT id FROM _demo);

DELETE FROM employee_credentials
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 11. Employment records ────────────────────────────────────────────────────
-- Null out supervisor_id/created_by on non-demo employees' records first
UPDATE employment_records SET supervisor_id = NULL
WHERE supervisor_id IN (SELECT id FROM _demo)
  AND employee_id NOT IN (SELECT id FROM _demo);

UPDATE employment_records SET created_by = NULL
WHERE created_by IN (SELECT id FROM _demo)
  AND employee_id NOT IN (SELECT id FROM _demo);

DELETE FROM employment_records
WHERE employee_id IN (SELECT id FROM _demo);

-- ── 12. Employees ─────────────────────────────────────────────────────────────
DELETE FROM employees
WHERE id IN (SELECT id FROM _demo);

COMMIT;
