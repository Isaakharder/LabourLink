-- Migration 015: Store fixed physical coordinates per greenhouse row.
--
-- Root cause of deletion-shift bug: rows were rendered using their sequential
-- index within a block (blockRowRect(comp, block, i)).  Deleting row i shifts
-- indices for all subsequent rows, moving them visually.
--
-- Fix: store x_ft, y_ft, orientation at INSERT time.  Rendering reads stored
-- coords; sibling positions are never recalculated on deletion.

BEGIN;

ALTER TABLE greenhouse_rows
  ADD COLUMN IF NOT EXISTS x_ft       numeric(10,4),
  ADD COLUMN IF NOT EXISTS y_ft       numeric(10,4),
  ADD COLUMN IF NOT EXISTS orientation text;

-- Backfill: reproduce blockRowRect geometry for every existing row.
-- idx = 0-based sequential position within each block (ordered by row_number).
-- Formulas mirror shared/greenhouse-geometry.ts blockRowRect exactly.
WITH ranked AS (
  SELECT
    gr.id,
    gr.block_id,
    (ROW_NUMBER() OVER (PARTITION BY gr.block_id ORDER BY gr.row_number) - 1) AS idx
  FROM greenhouse_rows gr
),
params AS (
  SELECT
    r.id,
    r.idx::float,
    rb.orientation,
    rb.anchor_side,
    rb.offset_ft::float,
    rb.row_width_ft::float,
    rb.row_length_ft::float,
    (rb.row_width_ft + rb.row_spacing_ft)::float              AS step,
    rb.along_wall_start,
    rb.along_wall_offset_ft::float,
    gc.x_ft::float           AS cx,
    gc.y_ft::float           AS cy,
    gc.east_west_ft::float   AS cew,
    gc.north_south_ft::float AS cns
  FROM ranked r
  JOIN greenhouse_row_blocks rb ON rb.id = r.block_id
  JOIN greenhouse_compartments gc ON gc.id = rb.compartment_id
),
with_along AS (
  SELECT
    p.*,
    -- along_x: for east_west orientation, the x-coord where the row starts
    CASE WHEN p.orientation = 'east_west' THEN
      CASE p.along_wall_start
        WHEN 'far'      THEN p.cx + p.cew - p.row_length_ft - p.along_wall_offset_ft
        WHEN 'centered' THEN p.cx + (p.cew - p.row_length_ft) / 2.0
        ELSE                 p.cx + p.along_wall_offset_ft
      END
    END AS along_x,
    -- along_y: for north_south orientation, the y-coord where the row starts
    CASE WHEN p.orientation = 'north_south' THEN
      CASE p.along_wall_start
        WHEN 'far'      THEN p.cy + p.cns - p.row_length_ft - p.along_wall_offset_ft
        WHEN 'centered' THEN p.cy + (p.cns - p.row_length_ft) / 2.0
        ELSE                 p.cy + p.along_wall_offset_ft
      END
    END AS along_y
  FROM params p
),
final AS (
  SELECT
    id,
    orientation,
    -- x_ft: for north_south rows, x depends on anchor (east/west); for east_west rows, x = along_x
    CASE orientation
      WHEN 'north_south' THEN
        CASE anchor_side
          WHEN 'east' THEN cx + cew - offset_ft - row_width_ft - idx * step
          ELSE             cx + offset_ft + idx * step  -- west anchor
        END
      ELSE along_x  -- east_west: x = along-wall start position
    END AS x_ft,
    -- y_ft: for east_west rows, y depends on anchor (north/south); for north_south rows, y = along_y
    CASE orientation
      WHEN 'east_west' THEN
        CASE anchor_side
          WHEN 'north' THEN cy + offset_ft + idx * step
          ELSE              cy + cns - offset_ft - row_width_ft - idx * step  -- south anchor
        END
      ELSE along_y  -- north_south: y = along-wall start position
    END AS y_ft
  FROM with_along
)
UPDATE greenhouse_rows gr
SET
  x_ft        = f.x_ft,
  y_ft        = f.y_ft,
  orientation = f.orientation
FROM final f
WHERE gr.id = f.id;

-- Enforce NOT NULL now that all rows are backfilled
ALTER TABLE greenhouse_rows
  ALTER COLUMN x_ft        SET NOT NULL,
  ALTER COLUMN y_ft        SET NOT NULL,
  ALTER COLUMN orientation SET NOT NULL;

COMMIT;
