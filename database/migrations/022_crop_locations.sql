-- Crop locations: links greenhouse rows to crops
CREATE TABLE crop_locations (
  id          SERIAL PRIMARY KEY,
  crop_id     INTEGER      NOT NULL REFERENCES crops(id)            ON DELETE CASCADE,
  row_id      INTEGER      NOT NULL REFERENCES greenhouse_rows(id)  ON DELETE CASCADE,
  start_date  DATE,
  end_date    DATE,
  plant_count INTEGER,
  notes       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT crop_locations_unique UNIQUE (crop_id, row_id)
);

-- Plant density records: aggregate planting density measurements for a crop
CREATE TABLE crop_plant_density (
  id          SERIAL PRIMARY KEY,
  crop_id     INTEGER        NOT NULL REFERENCES crops(id) ON DELETE CASCADE,
  name        TEXT           NOT NULL DEFAULT 'Plants',
  plant_count INTEGER        NOT NULL,
  area_m2     NUMERIC(10, 2) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- Optional: rows associated with a density record (for future UI use)
CREATE TABLE crop_plant_density_rows (
  density_id  INTEGER NOT NULL REFERENCES crop_plant_density(id) ON DELETE CASCADE,
  row_id      INTEGER NOT NULL REFERENCES greenhouse_rows(id)    ON DELETE CASCADE,
  PRIMARY KEY (density_id, row_id)
);
