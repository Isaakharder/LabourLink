-- ============================================================
-- Migration 007: Chapter 10 — Contract Profiles
-- ============================================================
-- Adds contract_profiles: versioned configuration per contract template.
-- Each profile represents the rules effective from a given date.
-- Payroll rules (wages, overtime, breaks) are placeholders for future chapters.
-- ============================================================

BEGIN;

CREATE TABLE contract_profiles (
  id                          SERIAL       PRIMARY KEY,
  contract_template_id        INTEGER      NOT NULL REFERENCES contract_templates(id),
  effective_from              DATE         NOT NULL,

  -- Hours & scheduling
  hours_per_week              NUMERIC(5,2),
  work_start_rounding_rule    TEXT         NOT NULL DEFAULT 'none'
                              CHECK (work_start_rounding_rule IN ('none','round_up','round_down','nearest')),
  work_start_rounding_minutes INTEGER      NOT NULL DEFAULT 15
                              CHECK (work_start_rounding_minutes > 0 AND work_start_rounding_minutes <= 60),
  allow_night_work            BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Placeholders — rules populated in future chapters
  public_holiday_rule         TEXT,        -- e.g. 'standard', 'double_pay', 'time_off'

  archived_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT cp_unique_template_date UNIQUE (contract_template_id, effective_from)
);

-- Most recent active profile per template (primary read path)
CREATE INDEX cp_template_date
  ON contract_profiles (contract_template_id, effective_from DESC)
  WHERE archived_at IS NULL;

CREATE TRIGGER contract_profiles_updated_at
  BEFORE UPDATE ON contract_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
