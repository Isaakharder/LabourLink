BEGIN;

-- Canvas extents stored on the map — user-controlled, anchor = (0,0)
ALTER TABLE greenhouse_maps
  ADD COLUMN IF NOT EXISTS north_extent_ft NUMERIC(8,2) NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS south_extent_ft NUMERIC(8,2) NOT NULL DEFAULT 1500,
  ADD COLUMN IF NOT EXISTS east_extent_ft  NUMERIC(8,2) NOT NULL DEFAULT 800,
  ADD COLUMN IF NOT EXISTS west_extent_ft  NUMERIC(8,2) NOT NULL DEFAULT 200;

-- Backfill existing maps from compartment bounding-box + 200 ft padding
-- Maps with no compartments keep the defaults above.
UPDATE greenhouse_maps gm
SET
  north_extent_ft = GREATEST(200,
    COALESCE(
      0 - (SELECT MIN(c.y_ft) FROM greenhouse_compartments c WHERE c.map_id = gm.id) + 200,
      200
    )
  ),
  south_extent_ft = GREATEST(500,
    COALESCE(
      (SELECT MAX(c.y_ft + c.north_south_ft) FROM greenhouse_compartments c WHERE c.map_id = gm.id) + 200,
      1500
    )
  ),
  east_extent_ft = GREATEST(200,
    COALESCE(
      (SELECT MAX(c.x_ft + c.east_west_ft) FROM greenhouse_compartments c WHERE c.map_id = gm.id) + 200,
      800
    )
  ),
  west_extent_ft = GREATEST(200,
    COALESCE(
      0 - (SELECT MIN(c.x_ft) FROM greenhouse_compartments c WHERE c.map_id = gm.id) + 200,
      200
    )
  )
WHERE EXISTS (
  SELECT 1 FROM greenhouse_compartments c WHERE c.map_id = gm.id
);

COMMIT;
