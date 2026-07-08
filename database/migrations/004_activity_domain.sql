-- ============================================================
-- Migration 004: Chapter 6 — Activity Domain
-- ============================================================
-- Tables created (3):
--   units, activity_groups, activities
-- ============================================================

BEGIN;

-- ============================================================
-- 1. units
-- ============================================================

CREATE TABLE units (
  id          SERIAL       PRIMARY KEY,
  code        TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT units_code_key UNIQUE (code)
);

CREATE INDEX ON units (archived_at);

CREATE TRIGGER units_updated_at
  BEFORE UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO units (sort_order, code, name) VALUES
  (1, 'hours',    'Hours'),
  (2, 'pieces',   'Pieces'),
  (3, 'kg',       'Kilograms'),
  (4, 'boxes',    'Boxes'),
  (5, 'plants',   'Plants'),
  (6, 'rows',     'Rows'),
  (7, 'carriers', 'Carriers');

-- ============================================================
-- 2. activity_groups
-- ============================================================

CREATE TABLE activity_groups (
  id           SERIAL       PRIMARY KEY,
  name         TEXT         NOT NULL,
  display_name TEXT,
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT activity_groups_name_key UNIQUE (name)
);

CREATE TRIGGER activity_groups_updated_at
  BEFORE UPDATE ON activity_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO activity_groups (sort_order, name, display_name) VALUES
  (1, 'Greenhouse Jobs', 'Greenhouse Jobs'),
  (2, 'Warehouse Jobs',  'Warehouse Jobs'),
  (3, 'Scout',           'Scout'),
  (4, 'Breaks',          'Breaks'),
  (5, 'General',         'General');

-- ============================================================
-- 3. activities
-- ============================================================

CREATE TABLE activities (
  id                  SERIAL       PRIMARY KEY,
  code                TEXT         NOT NULL,
  name                TEXT         NOT NULL,
  display_name        TEXT,
  activity_group_id   INTEGER      NOT NULL REFERENCES activity_groups (id),
  default_unit_id     INTEGER      REFERENCES units (id),
  icon                TEXT,
  color               TEXT,
  requires_location   BOOLEAN      NOT NULL DEFAULT FALSE,
  requires_carrier    BOOLEAN      NOT NULL DEFAULT FALSE,
  requires_yield      BOOLEAN      NOT NULL DEFAULT FALSE,
  requires_crop       BOOLEAN      NOT NULL DEFAULT FALSE,
  requires_note       BOOLEAN      NOT NULL DEFAULT FALSE,
  requires_photo      BOOLEAN      NOT NULL DEFAULT FALSE,
  requires_question   BOOLEAN      NOT NULL DEFAULT FALSE,
  visible_on_mobile   BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order          INTEGER      NOT NULL DEFAULT 0,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT activities_code_key UNIQUE (code),
  CONSTRAINT activities_code_format CHECK (code ~ '^[A-Z0-9]{1,8}$')
);

CREATE INDEX ON activities (activity_group_id);
CREATE INDEX ON activities (archived_at);

-- Mobile list query: active, visible, ordered within group
CREATE INDEX activities_mobile_list
  ON activities (activity_group_id, sort_order)
  WHERE (archived_at IS NULL AND visible_on_mobile = TRUE);

CREATE TRIGGER activities_updated_at
  BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
