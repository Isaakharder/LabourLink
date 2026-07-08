BEGIN;

-- Rename generic width/length to compass-direction names.
-- east_west_ft  = horizontal (X axis) extent of the compartment.
-- north_south_ft = vertical  (Y axis) extent of the compartment.
ALTER TABLE greenhouse_compartments
  RENAME COLUMN width_ft  TO east_west_ft;
ALTER TABLE greenhouse_compartments
  RENAME COLUMN length_ft TO north_south_ft;

COMMIT;
