-- Greenhouse Layout: a rectangular property ("land") drawn to scale in real
-- feet, with rectangular greenhouse "phases" positioned within it. Schema
-- supports multiple lands (no single-row constraint), though the desktop
-- Setup UI initially just works with one at a time. Land-relative boundary
-- checks (a phase's right/bottom edge vs. its land's dimensions) can't be
-- expressed as a plain CHECK constraint since they depend on a different
-- table's row — that validation happens in the API route, inside a
-- transaction that locks the land row, not here.

-- ---------------------------------------------------------------------------
-- Land
-- ---------------------------------------------------------------------------

create table greenhouse_lands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  north_south_feet numeric not null,
  east_west_feet numeric not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_greenhouse_lands_north_south_positive check (north_south_feet > 0),
  constraint chk_greenhouse_lands_east_west_positive check (east_west_feet > 0)
);

-- Case/whitespace-insensitive uniqueness, additive alongside the plain
-- `unique` above — same pattern as activity_groups (007) and break_profiles
-- (010).
create unique index greenhouse_lands_name_normalized_key on greenhouse_lands (lower(trim(name)));
create index idx_greenhouse_lands_is_active on greenhouse_lands(is_active);

-- ---------------------------------------------------------------------------
-- Phases (rectangular greenhouse sections within a land)
-- ---------------------------------------------------------------------------

create table greenhouse_phases (
  id uuid primary key default gen_random_uuid(),
  land_id uuid not null references greenhouse_lands(id),
  name text not null,
  description text,
  north_south_feet numeric not null,
  east_west_feet numeric not null,
  x_feet_from_west numeric not null default 0,
  y_feet_from_north numeric not null default 0,
  is_active boolean not null default true,
  sort_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_greenhouse_phases_north_south_positive check (north_south_feet > 0),
  constraint chk_greenhouse_phases_east_west_positive check (east_west_feet > 0),
  constraint chk_greenhouse_phases_x_nonnegative check (x_feet_from_west >= 0),
  constraint chk_greenhouse_phases_y_nonnegative check (y_feet_from_north >= 0),

  -- Backstop against duplicate phase names within one land; primary
  -- validation (with a friendly error) happens in the route.
  unique (land_id, name)
);

create unique index greenhouse_phases_land_name_normalized_key
  on greenhouse_phases (land_id, lower(trim(name)));
create index idx_greenhouse_phases_land on greenhouse_phases(land_id);
