-- ============================================================
-- Migration 016: Backfill net_area_m2 on greenhouse-linked locations
-- ============================================================
-- The locations.net_area_m2 column already exists (added in 009).
-- Greenhouse rows have width_ft and length_ft; the linked location
-- was not getting net_area_m2 filled at creation time.
--
-- Formula: net_area_m2 = width_ft * length_ft * 0.09290304
-- (1 ft² = 0.09290304 m²)
--
-- Only rows where net_area_m2 IS NULL are updated, so manually
-- edited values are never overwritten.
-- ============================================================

BEGIN;

UPDATE locations l
SET net_area_m2 = ROUND(
  (gr.width_ft * gr.length_ft * 0.09290304)::numeric,
  2
)
FROM greenhouse_rows gr
WHERE gr.location_id = l.id
  AND l.net_area_m2 IS NULL;

COMMIT;
