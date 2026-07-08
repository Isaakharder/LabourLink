BEGIN;

-- Drop old constraint first so the UPDATE doesn't violate it
ALTER TABLE greenhouse_rows DROP CONSTRAINT greenhouse_rows_side_check;

-- Migrate existing data to compass orientation
UPDATE greenhouse_rows SET side = 'west' WHERE side = 'left';
UPDATE greenhouse_rows SET side = 'east' WHERE side = 'right';

-- Add the new constraint
ALTER TABLE greenhouse_rows ADD CONSTRAINT greenhouse_rows_side_check
  CHECK (side IN ('north', 'south', 'east', 'west'));

COMMIT;
