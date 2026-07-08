-- ============================================================
-- Migration 005: Chapter 7 — Location Domain
-- ============================================================
-- Tables created (5):
--   greenhouses, phases, houses, rows, row_scan_codes
--
-- Tables extended (1):
--   sites — adds timezone column (table exists from migration 002)
--
-- No greenhouse/phase/house/row data is seeded.
-- Location data is customer-entered through the UI.
-- The two existing sites (GHA, GHB) from migration 003 are
-- inherited as-is; timezone defaults to 'Europe/Amsterdam'.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. Extend sites (exists from migration 002)
-- ============================================================
-- timezone governs all date/time boundaries (shift start,
-- payroll cut-off) for locations under a site.

ALTER TABLE sites
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam';

-- ============================================================
-- 1. greenhouses
-- ============================================================

CREATE TABLE greenhouses (
  id               SERIAL       PRIMARY KEY,
  site_id          INTEGER      NOT NULL REFERENCES sites (id),
  code             TEXT         NOT NULL,
  name             TEXT         NOT NULL,
  display_name     TEXT,
  map_width_m      NUMERIC(8,2),
  map_length_m     NUMERIC(8,2),
  orientation_deg  SMALLINT     NOT NULL DEFAULT 0
                   CHECK (orientation_deg BETWEEN 0 AND 359),
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT greenhouses_site_code_key  UNIQUE (site_id, code),
  CONSTRAINT greenhouses_code_format    CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);

CREATE INDEX ON greenhouses (site_id);
CREATE INDEX ON greenhouses (archived_at);

-- Active greenhouses per site, in display order
CREATE INDEX greenhouses_active_by_site
  ON greenhouses (site_id, sort_order)
  WHERE archived_at IS NULL;

CREATE TRIGGER greenhouses_updated_at
  BEFORE UPDATE ON greenhouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 2. phases
-- ============================================================

CREATE TABLE phases (
  id             SERIAL       PRIMARY KEY,
  greenhouse_id  INTEGER      NOT NULL REFERENCES greenhouses (id),
  code           TEXT         NOT NULL,
  name           TEXT         NOT NULL,
  display_name   TEXT,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT phases_greenhouse_code_key UNIQUE (greenhouse_id, code),
  CONSTRAINT phases_code_format         CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);

CREATE INDEX ON phases (greenhouse_id);
CREATE INDEX ON phases (archived_at);

CREATE INDEX phases_active_by_greenhouse
  ON phases (greenhouse_id, sort_order)
  WHERE archived_at IS NULL;

CREATE TRIGGER phases_updated_at
  BEFORE UPDATE ON phases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 3. houses
-- ============================================================

CREATE TABLE houses (
  id           SERIAL       PRIMARY KEY,
  phase_id     INTEGER      NOT NULL REFERENCES phases (id),
  code         TEXT         NOT NULL,
  name         TEXT         NOT NULL,
  display_name TEXT,
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT houses_phase_code_key UNIQUE (phase_id, code),
  CONSTRAINT houses_code_format    CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);

CREATE INDEX ON houses (phase_id);
CREATE INDEX ON houses (archived_at);

CREATE INDEX houses_active_by_phase
  ON houses (phase_id, sort_order)
  WHERE archived_at IS NULL;

CREATE TRIGGER houses_updated_at
  BEFORE UPDATE ON houses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 4. rows
-- ============================================================

CREATE TABLE rows (
  id          SERIAL       PRIMARY KEY,
  house_id    INTEGER      NOT NULL REFERENCES houses (id),
  code        TEXT         NOT NULL,
  name        TEXT,
  map_x_m     NUMERIC(8,3),
  map_y_m     NUMERIC(8,3),
  length_m    NUMERIC(6,2),
  direction   TEXT         CHECK (direction IN ('north','south','east','west')),
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT rows_house_code_key UNIQUE (house_id, code),
  CONSTRAINT rows_code_format    CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);

CREATE INDEX ON rows (house_id);
CREATE INDEX ON rows (archived_at);

CREATE INDEX rows_active_by_house
  ON rows (house_id, sort_order)
  WHERE archived_at IS NULL;

-- For Greenhouse View: rows with map coordinates
CREATE INDEX rows_map_coords
  ON rows (map_x_m, map_y_m)
  WHERE archived_at IS NULL AND map_x_m IS NOT NULL;

CREATE TRIGGER rows_updated_at
  BEFORE UPDATE ON rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 5. row_scan_codes
-- ============================================================
-- A row can carry multiple physical codes: QR at each end,
-- RFID chip, barcode label.  scan_code is globally unique
-- forever — archived codes cannot be reused, so an old label
-- can never accidentally resolve to a new row.

CREATE TABLE row_scan_codes (
  id          SERIAL       PRIMARY KEY,
  row_id      INTEGER      NOT NULL REFERENCES rows (id),
  scan_code   TEXT         NOT NULL,
  scan_type   TEXT         NOT NULL
              CHECK (scan_type IN ('qr','rfid','barcode','manual')),
  label       TEXT,
  is_primary  BOOLEAN      NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT row_scan_codes_scan_code_key UNIQUE (scan_code)
);

CREATE INDEX ON row_scan_codes (row_id);
CREATE INDEX ON row_scan_codes (archived_at);

-- Active codes per row (detail panel)
CREATE INDEX row_scan_codes_active_by_row
  ON row_scan_codes (row_id)
  WHERE archived_at IS NULL;

-- At most one active primary per row
CREATE UNIQUE INDEX row_scan_codes_primary
  ON row_scan_codes (row_id)
  WHERE is_primary = TRUE AND archived_at IS NULL;

CREATE TRIGGER row_scan_codes_updated_at
  BEFORE UPDATE ON row_scan_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
