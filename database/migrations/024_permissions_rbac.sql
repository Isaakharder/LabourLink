-- ============================================================
-- Migration 024 — Phase 1 Authentication: permissions & RBAC
-- ============================================================
-- Reuses the existing `security_roles` catalog (General, Crew
-- Leader, Supervisor, Manager, Admin) rather than inventing a
-- parallel role system. Adds a normalized permission catalog and
-- a role -> permission join so grants are data, not hardcoded.
-- ============================================================

BEGIN;

CREATE TABLE permissions (
  id          SERIAL PRIMARY KEY,
  code        TEXT   NOT NULL UNIQUE,
  description TEXT   NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES security_roles (id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions (id)    ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

INSERT INTO permissions (code, description) VALUES
  ('employees:view',  'View employee records'),
  ('employees:edit',  'Create and edit employee records'),
  ('contracts:view',  'View contract templates and profiles'),
  ('contracts:edit',  'Create and edit contract templates and profiles'),
  ('crops:view',      'View crops and varieties'),
  ('crops:edit',      'Create and edit crops and varieties'),
  ('greenhouse:view', 'View greenhouse maps and layout'),
  ('greenhouse:edit', 'Create and edit greenhouse maps and layout'),
  ('locations:view',  'View sites, locations, and location groups'),
  ('locations:edit',  'Create and edit sites, locations, and location groups'),
  ('users:manage',    'Create, edit, deactivate users, and reset passwords'),
  ('roles:manage',    'Assign roles and permissions to users');

-- Admin: full access
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM security_roles WHERE name = 'Admin'), id FROM permissions;

-- Manager: full view/edit on domain modules, no user/role administration
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM security_roles WHERE name = 'Manager'), id FROM permissions
WHERE code NOT IN ('users:manage', 'roles:manage');

-- Supervisor: view everything, edit day-to-day operational modules only
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM security_roles WHERE name = 'Supervisor'), id FROM permissions
WHERE code IN (
  'employees:view', 'contracts:view',
  'crops:view', 'crops:edit',
  'greenhouse:view', 'greenhouse:edit',
  'locations:view', 'locations:edit'
);

-- Crew Leader: read-only across domain modules
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM security_roles WHERE name = 'Crew Leader'), id FROM permissions
WHERE code IN (
  'employees:view', 'contracts:view', 'crops:view',
  'greenhouse:view', 'locations:view'
);

-- General: no application permissions (mobile clock-in/out only, unaffected by Phase 1)

COMMIT;
