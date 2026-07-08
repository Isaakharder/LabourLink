BEGIN;

ALTER TABLE greenhouse_row_blocks
  ADD COLUMN along_wall_start TEXT NOT NULL DEFAULT 'near'
    CHECK (along_wall_start IN ('near', 'far', 'centered', 'custom')),
  ADD COLUMN along_wall_offset_ft NUMERIC(8,2) NOT NULL DEFAULT 0;

COMMIT;
