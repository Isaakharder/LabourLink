-- ============================================================
-- Migration 021: Restore system-required break activities
-- ============================================================
-- Migration 019 hard-deleted all activities including BREAK
-- and LUNCH, which the work engine looks up by code at runtime
-- (server/src/routes/work.ts: findActivityByCode).
-- Without these rows, POST /api/work/start-break and
-- POST /api/work/start-lunch return HTTP 500.
--
-- These are system activities, not demo data. They are not
-- shown in the Activities page (visible_on_mobile = false,
-- sort_order deliberately high) and cannot be archived or
-- deleted by the user.
-- ============================================================

BEGIN;

INSERT INTO activities
  (code, name, display_name, activity_group_id, default_unit_id,
   icon, color, visible_on_mobile, sort_order)
SELECT
  a.code, a.name, a.display_name,
  g.id,
  (SELECT id FROM units WHERE code = 'hours'),
  a.icon, a.color,
  FALSE,   -- hidden from mobile picker
  9999     -- sorted to the bottom
FROM (VALUES
  ('BREAK', 'Break',       'Break',       'coffee',   '#D97706'),
  ('LUNCH', 'Lunch Break', 'Lunch Break', 'utensils', '#B45309')
) AS a(code, name, display_name, icon, color)
JOIN activity_groups g ON g.name = 'Breaks';

COMMIT;
