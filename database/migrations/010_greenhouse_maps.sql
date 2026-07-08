BEGIN;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE greenhouse_maps (
  id         SERIAL      PRIMARY KEY,
  site_id    INTEGER     NOT NULL REFERENCES sites(id),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON greenhouse_maps(site_id);
CREATE TRIGGER greenhouse_maps_updated_at
  BEFORE UPDATE ON greenhouse_maps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE greenhouse_compartments (
  id         SERIAL       PRIMARY KEY,
  map_id     INTEGER      NOT NULL REFERENCES greenhouse_maps(id) ON DELETE CASCADE,
  name       TEXT         NOT NULL,
  width_ft   NUMERIC(8,2) NOT NULL,
  length_ft  NUMERIC(8,2) NOT NULL,
  x_ft       NUMERIC(8,2) NOT NULL DEFAULT 0,
  y_ft       NUMERIC(8,2) NOT NULL DEFAULT 0,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX ON greenhouse_compartments(map_id);
CREATE TRIGGER greenhouse_compartments_updated_at
  BEFORE UPDATE ON greenhouse_compartments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE greenhouse_rows (
  id             SERIAL       PRIMARY KEY,
  compartment_id INTEGER      NOT NULL REFERENCES greenhouse_compartments(id) ON DELETE CASCADE,
  row_number     INTEGER      NOT NULL,
  side           TEXT         NOT NULL CHECK (side IN ('left','right')),
  width_ft       NUMERIC(8,2) NOT NULL,
  length_ft      NUMERIC(8,2) NOT NULL,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  location_id    INTEGER      REFERENCES locations(id),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT gr_unique_compartment_row UNIQUE (compartment_id, row_number)
);
CREATE INDEX ON greenhouse_rows(compartment_id);
CREATE INDEX ON greenhouse_rows(location_id);
CREATE TRIGGER greenhouse_rows_updated_at
  BEFORE UPDATE ON greenhouse_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
