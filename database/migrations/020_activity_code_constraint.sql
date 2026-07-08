-- ============================================================
-- Migration 020: Relax activity code constraint
-- ============================================================
-- Old: ^[A-Z0-9]{1,8}$  (no underscores, max 8 chars)
-- New: ^[A-Z0-9]+(_[A-Z0-9]+)*$
--   • Uppercase letters and digits only (no lowercase, no specials)
--   • Single underscores as separators; none leading, trailing, or consecutive
--   • No length limit — auto-generated codes can be as long as the name
-- ============================================================

BEGIN;

ALTER TABLE activities
  DROP CONSTRAINT activities_code_format,
  ADD  CONSTRAINT activities_code_format
    CHECK (code ~ '^[A-Z0-9]+(_[A-Z0-9]+)*$');

COMMIT;
