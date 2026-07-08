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

-- ── Contract templates ────────────────────────────────────────────────────────
INSERT INTO contract_templates (name) VALUES
  ('General Contract'),
  ('Harvester Contract'),
  ('Packer Contract'),
  ('Supervisor Contract'),
  ('Manager Contract');

COMMIT;
