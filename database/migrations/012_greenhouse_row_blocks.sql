BEGIN;

-- ── Row Blocks ─────────────────────────────────────────────────────────────────
-- Separates "which direction rows run" (orientation) from "which wall the block
-- starts against" (anchor_side). Both blocks on West and East can now share the
-- same North↔South orientation while being placed against different walls.

CREATE TABLE greenhouse_row_blocks (
  id             SERIAL        PRIMARY KEY,
  compartment_id INTEGER       NOT NULL REFERENCES greenhouse_compartments(id) ON DELETE CASCADE,
  -- 'north_south' = rows run N↔S (vertical strips stacked E-W)
  -- 'east_west'   = rows run E↔W (horizontal strips stacked N-S)
  orientation    TEXT          NOT NULL CHECK (orientation IN ('north_south', 'east_west')),
  -- Wall the first row abuts; must match orientation:
  --   north_south → east | west
  --   east_west   → north | south
  anchor_side    TEXT          NOT NULL CHECK (anchor_side IN ('north', 'east', 'south', 'west')),
  placement_mode TEXT          NOT NULL DEFAULT 'edge'
                               CHECK (placement_mode IN ('edge', 'continue', 'custom_offset')),
  -- Distance from anchor wall to the first row (0 = touching wall)
  offset_ft      NUMERIC(8,2)  NOT NULL DEFAULT 0,
  -- Depth of each row (perpendicular to row direction)
  row_width_ft   NUMERIC(8,2)  NOT NULL,
  -- Length of each row (parallel to row direction)
  row_length_ft  NUMERIC(8,2)  NOT NULL,
  -- Gap between consecutive rows within this block (default 0 = packed)
  row_spacing_ft NUMERIC(8,2)  NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX ON greenhouse_row_blocks(compartment_id);

CREATE TRIGGER greenhouse_row_blocks_updated_at
  BEFORE UPDATE ON greenhouse_row_blocks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Walkways ───────────────────────────────────────────────────────────────────

CREATE TABLE greenhouse_walkways (
  id               SERIAL        PRIMARY KEY,
  compartment_id   INTEGER       NOT NULL REFERENCES greenhouse_compartments(id) ON DELETE CASCADE,
  label            TEXT,
  -- 'north_south' = vertical corridor; 'east_west' = horizontal corridor
  orientation      TEXT          NOT NULL CHECK (orientation IN ('north_south', 'east_west')),
  width_ft         NUMERIC(8,2)  NOT NULL,
  -- Which wall the offset is measured from; 'centered' ignores offset_ft
  offset_from_side TEXT          NOT NULL DEFAULT 'centered'
                   CHECK (offset_from_side IN ('north', 'east', 'south', 'west', 'centered')),
  offset_ft        NUMERIC(8,2)  NOT NULL DEFAULT 0,
  -- Absolute position within the compartment (computed on save for canvas rendering)
  x_ft             NUMERIC(8,2)  NOT NULL DEFAULT 0,
  y_ft             NUMERIC(8,2)  NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX ON greenhouse_walkways(compartment_id);

CREATE TRIGGER greenhouse_walkways_updated_at
  BEFORE UPDATE ON greenhouse_walkways
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Link existing rows to blocks ───────────────────────────────────────────────

ALTER TABLE greenhouse_rows
  ADD COLUMN block_id INTEGER REFERENCES greenhouse_row_blocks(id) ON DELETE CASCADE;

-- Backfill: create one row block per existing (compartment_id, side) group.
-- Orientation is inferred: east/west anchor → north_south rows;
--                          north/south anchor → east_west rows.
INSERT INTO greenhouse_row_blocks
  (compartment_id, orientation, anchor_side, placement_mode, offset_ft, row_width_ft, row_length_ft)
SELECT
  compartment_id,
  CASE WHEN side IN ('east', 'west') THEN 'north_south' ELSE 'east_west' END AS orientation,
  side        AS anchor_side,
  'edge'      AS placement_mode,
  0           AS offset_ft,
  ROUND(AVG(width_ft),  2) AS row_width_ft,
  ROUND(AVG(length_ft), 2) AS row_length_ft
FROM greenhouse_rows
GROUP BY compartment_id, side;

-- Link each existing row to its block.
UPDATE greenhouse_rows gr
SET block_id = rb.id
FROM greenhouse_row_blocks rb
WHERE rb.compartment_id = gr.compartment_id
  AND rb.anchor_side    = gr.side;

-- ── Unique constraint migration ────────────────────────────────────────────────
-- Old: UNIQUE (compartment_id, row_number) prevented the same row number in
--      different blocks of the same compartment (e.g. west rows 1-79 and east
--      rows 2-80 would conflict at row 2).
-- New: UNIQUE (block_id, row_number) allows parallel blocks to reuse numbers.
-- Partial index (WHERE block_id IS NOT NULL) handles the nullable FK gracefully.

ALTER TABLE greenhouse_rows DROP CONSTRAINT gr_unique_compartment_row;

CREATE UNIQUE INDEX gr_unique_block_row
  ON greenhouse_rows (block_id, row_number)
  WHERE block_id IS NOT NULL;

COMMIT;
