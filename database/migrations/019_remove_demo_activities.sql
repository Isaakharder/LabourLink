-- ============================================================
-- Migration 019: Remove seeded demo activities
-- ============================================================
-- All 18 activities inserted by migration 004 had zero
-- work_events and zero work_registrations at time of removal.
-- Hard-deleted; no archiving needed.
-- Activity groups (Greenhouse Jobs, Warehouse Jobs, Scout,
-- Breaks, General) are retained as organisational structure.
-- ============================================================

BEGIN;

DELETE FROM activities;

COMMIT;
