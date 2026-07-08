-- ============================================================
-- Migration 009: Location Domain Refactor
-- ============================================================
-- Replaces the rigid 5-level hierarchy (Site → Greenhouse →
-- Phase → House → Row) with a flat, flexible model:
--   Site → Locations  (any work area: rows, packing lines, etc.)
--   Locations optionally organised via Location Groups (M:M)
--
-- Tables added (4):
--   locations               — flat work areas per site
--   location_groups         — named groupings of locations
--   location_group_locations— many-to-many junction
--   location_scan_codes     — replaces row_scan_codes
--
-- Tables altered (2):
--   work_registrations      — row_id  → location_id; add completion_percentage
--   work_events             — row_id  → location_id; update event_type CHECK
--
-- Tables removed (5):
--   row_scan_codes, rows, houses, phases, greenhouses
--
-- Seed data updated: sample locations + location groups for GHA/GHB.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. locations
-- ============================================================
-- A Location is any discrete work area within a site.
-- Examples: Row 1, Packing Line 1, Loading Dock, Warehouse Zone A.
-- No enforced parent hierarchy — flat list per site.
-- ============================================================

CREATE TABLE locations (
  id               SERIAL       PRIMARY KEY,
  site_id          INTEGER      NOT NULL REFERENCES sites (id),
  code             TEXT         NOT NULL,
  name             TEXT         NOT NULL,
  abbreviated_name TEXT,
  net_area_m2      NUMERIC(10,2),
  map_x_m          NUMERIC(8,3),
  map_y_m          NUMERIC(8,3),
  map_length_m     NUMERIC(8,2),
  map_width_m      NUMERIC(8,2),
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT locations_site_code_key UNIQUE (site_id, code)
);

CREATE INDEX ON locations (site_id);
CREATE INDEX ON locations (archived_at);

CREATE INDEX locations_active_by_site
  ON locations (site_id, sort_order)
  WHERE archived_at IS NULL;

CREATE TRIGGER locations_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 2. location_groups
-- ============================================================
-- Named groupings of locations within a site.
-- A location can belong to zero, one, or many groups.
-- A group can contain any mix of locations from the same site.
-- ============================================================

CREATE TABLE location_groups (
  id          SERIAL       PRIMARY KEY,
  site_id     INTEGER      NOT NULL REFERENCES sites (id),
  code        TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  net_area_m2 NUMERIC(10,2),
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT location_groups_site_code_key UNIQUE (site_id, code)
);

CREATE INDEX ON location_groups (site_id);
CREATE INDEX ON location_groups (archived_at);

CREATE INDEX location_groups_active_by_site
  ON location_groups (site_id, sort_order)
  WHERE archived_at IS NULL;

CREATE TRIGGER location_groups_updated_at
  BEFORE UPDATE ON location_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 3. location_group_locations  (many-to-many junction)
-- ============================================================

CREATE TABLE location_group_locations (
  location_group_id  INTEGER  NOT NULL REFERENCES location_groups (id) ON DELETE CASCADE,
  location_id        INTEGER  NOT NULL REFERENCES locations (id)        ON DELETE CASCADE,
  PRIMARY KEY (location_group_id, location_id)
);

CREATE INDEX ON location_group_locations (location_id);

-- ============================================================
-- 4. location_scan_codes
-- ============================================================
-- Replaces row_scan_codes; same semantics but scoped to a
-- location rather than a row.
-- scan_code is globally unique forever (archived codes cannot
-- be reused, so an old label cannot resolve to a new location).
-- ============================================================

CREATE TABLE location_scan_codes (
  id           SERIAL       PRIMARY KEY,
  location_id  INTEGER      NOT NULL REFERENCES locations (id),
  scan_code    TEXT         NOT NULL,
  scan_type    TEXT         NOT NULL
               CHECK (scan_type IN ('qr', 'rfid', 'barcode', 'manual')),
  label        TEXT,
  is_primary   BOOLEAN      NOT NULL DEFAULT FALSE,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT location_scan_codes_scan_code_key UNIQUE (scan_code)
);

CREATE INDEX ON location_scan_codes (location_id);
CREATE INDEX ON location_scan_codes (archived_at);

CREATE INDEX location_scan_codes_active_by_location
  ON location_scan_codes (location_id)
  WHERE archived_at IS NULL;

-- At most one active primary per location
CREATE UNIQUE INDEX location_scan_codes_primary
  ON location_scan_codes (location_id)
  WHERE is_primary = TRUE AND archived_at IS NULL;

CREATE TRIGGER location_scan_codes_updated_at
  BEFORE UPDATE ON location_scan_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 5. Add completion_percentage to work_registrations
-- ============================================================
-- Optional field: supervisor or device can record what
-- percentage of a location was completed during this reg.
-- ============================================================

ALTER TABLE work_registrations
  ADD COLUMN completion_percentage NUMERIC(5,2)
  CONSTRAINT wr_completion_range
    CHECK (completion_percentage IS NULL OR
           (completion_percentage >= 0 AND completion_percentage <= 100));

-- ============================================================
-- 6. work_events: rename event types, rename column
-- ============================================================
-- Update any existing rows before changing the constraint.
UPDATE work_events SET event_type = 'SCAN_LOCATION'   WHERE event_type = 'SCAN_ROW';
UPDATE work_events SET event_type = 'CHANGE_LOCATION' WHERE event_type = 'CHANGE_ROW';

-- Drop the old event_type CHECK constraint and recreate it with
-- SCAN_LOCATION and CHANGE_LOCATION replacing SCAN_ROW and CHANGE_ROW.
ALTER TABLE work_events DROP CONSTRAINT work_events_event_type_check;

ALTER TABLE work_events ADD CONSTRAINT work_events_event_type_check
  CHECK (event_type IN (
    'CLOCK_IN',
    'CLOCK_OUT',
    'START_ACTIVITY',
    'SCAN_LOCATION',
    'CHANGE_LOCATION',
    'START_BREAK',
    'START_LUNCH',
    'RESUME',
    'ASSIGN_CARRIER',
    'REGISTER_YIELD',
    'SUPERVISOR_CORRECT',
    'SYSTEM_GAP_FILL',
    'SYSTEM_AUTO_CLOSE'
  ));

-- Drop old FK and rename column
ALTER TABLE work_events DROP CONSTRAINT work_events_row_id_fkey;
ALTER TABLE work_events RENAME COLUMN row_id TO location_id;
ALTER TABLE work_events ADD CONSTRAINT work_events_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations (id);

-- ============================================================
-- 7. work_registrations: rename column
-- ============================================================

ALTER TABLE work_registrations DROP CONSTRAINT work_registrations_row_id_fkey;
ALTER TABLE work_registrations RENAME COLUMN row_id TO location_id;
ALTER TABLE work_registrations ADD CONSTRAINT work_registrations_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations (id);

-- Drop old row-scoped index, add location-scoped equivalent
DROP INDEX wr_row_view;

CREATE INDEX wr_location_view
  ON work_registrations (location_id, started_at)
  WHERE location_id IS NOT NULL AND is_voided = FALSE;

-- ============================================================
-- 8. Drop old hierarchy tables (FK order)
-- ============================================================

DROP TABLE IF EXISTS row_scan_codes;
DROP TABLE IF EXISTS rows;
DROP TABLE IF EXISTS houses;
DROP TABLE IF EXISTS phases;
DROP TABLE IF EXISTS greenhouses;

-- ============================================================
-- 9. Seed: sample locations and location groups
-- ============================================================

-- Locations for site GHA
INSERT INTO locations (site_id, code, name, sort_order)
SELECT s.id, v.code, v.name, v.sort_order
FROM sites s
CROSS JOIN (VALUES
  ('R01',  'Row 1',          1),
  ('R02',  'Row 2',          2),
  ('R03',  'Row 3',          3),
  ('R04',  'Row 4',          4),
  ('R05',  'Row 5',          5),
  ('PACK', 'Packing Line 1', 10),
  ('DOCK', 'Loading Dock',   20)
) AS v(code, name, sort_order)
WHERE s.code = 'GHA';

-- Locations for site GHB
INSERT INTO locations (site_id, code, name, sort_order)
SELECT s.id, v.code, v.name, v.sort_order
FROM sites s
CROSS JOIN (VALUES
  ('R01', 'Row 1',          1),
  ('R02', 'Row 2',          2),
  ('R03', 'Row 3',          3),
  ('PACK','Packing Line 1', 10)
) AS v(code, name, sort_order)
WHERE s.code = 'GHB';

-- Location groups for site GHA
INSERT INTO location_groups (site_id, code, name, sort_order)
SELECT s.id, v.code, v.name, v.sort_order
FROM sites s
CROSS JOIN (VALUES
  ('SECT-A', 'Section A',     1),
  ('SECT-B', 'Section B',     2),
  ('PACKING','Packing Areas', 3)
) AS v(code, name, sort_order)
WHERE s.code = 'GHA';

-- Assign locations to groups (GHA)
INSERT INTO location_group_locations (location_group_id, location_id)
SELECT lg.id, l.id
FROM location_groups lg
JOIN sites s ON s.id = lg.site_id AND s.code = 'GHA'
JOIN locations l ON l.site_id = s.id
WHERE (lg.code = 'SECT-A' AND l.code IN ('R01', 'R02', 'R03'))
   OR (lg.code = 'SECT-B' AND l.code IN ('R04', 'R05'))
   OR (lg.code = 'PACKING' AND l.code IN ('PACK', 'DOCK'));

COMMIT;
