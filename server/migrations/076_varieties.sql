-- Varieties and their planting by growing season: the configuration the
-- harvest forecast will build on. Additive only: no existing table, row or
-- constraint is touched, and nothing is backfilled.
--
-- Model
--   varieties                 the catalogue (name, notes, active), shared
--                             by every season.
--   growing_seasons           dated planting periods that never overlap.
--                             A season with no end date is still running.
--   variety_plantings         one variety planted in one season, with the
--                             total number of plants planted (optional
--                             until it is known).
--   variety_row_assignments   which variety each greenhouse row holds in a
--                             season: one variety per row per season.
--
-- History: a harvest on date D in row R belongs to the variety R held in
-- the season covering D. Next season's assignments are new rows here, so
-- they can never rewrite which variety a past harvest came from. Seasons
-- are kept, not overwritten; one with assignments can't be deleted.
--
-- Plant counts: variety_plantings.total_plants is what was actually
-- planted for the variety. Per-row figures are calculated from it
-- (proportional to each row's saved length) and are never stored, so they
-- can't be mistaken for counted values. The existing per-row "Plants per
-- row" settings (plant_densities / plant_density_rows, used for speed
-- reporting) are unchanged and stay the separate, entered figure.

create table varieties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_varieties_name_not_blank check (length(trim(name)) > 0)
);

-- Names are unique ignoring case and surrounding spaces, so "Bell Red" and
-- "bell red " can't both exist.
create unique index uq_varieties_name on varieties (lower(trim(name)));

create table growing_seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_on date not null,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_growing_seasons_name_not_blank check (length(trim(name)) > 0),
  constraint chk_growing_seasons_dates check (ends_on is null or ends_on >= starts_on)
);

create unique index uq_growing_seasons_name on growing_seasons (lower(trim(name)));
-- Overlap between seasons is rejected by the API inside a transaction that
-- locks this table (see routes/varieties.ts); a btree_gist exclusion
-- constraint would need an extension this project doesn't otherwise use.
create index idx_growing_seasons_starts_on on growing_seasons (starts_on);

create table variety_plantings (
  season_id uuid not null references growing_seasons(id),
  variety_id uuid not null references varieties(id),
  total_plants integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (season_id, variety_id),
  constraint chk_variety_plantings_total_plants check (total_plants is null or total_plants > 0)
);

create index idx_variety_plantings_variety on variety_plantings (variety_id);

-- A row assignment always belongs to a planting of that variety in that
-- season (composite foreign key), so a row can't point at a variety the
-- season doesn't have. Rows are referenced, never copied: their saved
-- length_ft is read live. A row soft-deleted from the layout keeps its
-- assignment (history) and simply stops counting toward current totals.
create table variety_row_assignments (
  season_id uuid not null,
  greenhouse_row_id uuid not null references greenhouse_rows(id),
  variety_id uuid not null,
  assigned_at timestamptz not null default now(),
  primary key (season_id, greenhouse_row_id),
  foreign key (season_id, variety_id) references variety_plantings (season_id, variety_id)
);

create index idx_variety_row_assignments_variety on variety_row_assignments (season_id, variety_id);
create index idx_variety_row_assignments_row on variety_row_assignments (greenhouse_row_id);
