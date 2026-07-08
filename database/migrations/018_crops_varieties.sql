BEGIN;

CREATE TABLE crops (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  planting_date DATE NOT NULL,
  pulling_date  DATE,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crops_pulling_after_planting CHECK (pulling_date IS NULL OR pulling_date >= planting_date)
);

CREATE TABLE varieties (
  id          SERIAL PRIMARY KEY,
  crop_id     INTEGER NOT NULL REFERENCES crops(id),
  name        TEXT NOT NULL,
  color       TEXT,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_varieties_crop_id ON varieties(crop_id);

-- Wire up the FKs that were left pending since migration 006
ALTER TABLE work_yields
  ADD CONSTRAINT fk_work_yields_crop    FOREIGN KEY (crop_id)    REFERENCES crops(id)     NOT VALID,
  ADD CONSTRAINT fk_work_yields_variety FOREIGN KEY (variety_id) REFERENCES varieties(id) NOT VALID;

COMMIT;
