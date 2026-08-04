-- Greenhouse row layout: persistent map objects belonging to a phase
-- (011_greenhouse_layout.sql), additive only — 011 itself is untouched.
--
-- Coordinate model: row x_ft/y_ft are relative to their PHASE's own
-- north-west corner (not land-absolute), the same nesting pattern phases
-- already use relative to land (x_feet_from_west/y_feet_from_north). This
-- is a deliberate choice over land-absolute coordinates: rendering a row at
-- phase.xFeetFromWest + row.xFt / phase.yFeetFromNorth + row.yFt means a
-- row moves with its phase for free whenever the phase's own position
-- changes — no per-row row is ever rewritten when a phase is dragged. See
-- the greenhouseLayout.ts route changes in this same feature for how a
-- LAND resize (which already proportionally rescales every phase, see
-- PATCH /lands/:id) cascades the identical per-axis ratio to rows so they
-- stay valid without ever being "left behind."
--
-- greenhouse_row_batches is the creation recipe/history (what a supervisor
-- asked for — side, anchor, numbering, gap, offset); greenhouse_rows is
-- the persisted final geometry actually rendered and edited. Deleting one
-- row, or editing a later batch, never recomputes or moves any other row's
-- stored x/y — see the report for this feature for the full rationale.

-- ---------------------------------------------------------------------------
-- Row batches
-- ---------------------------------------------------------------------------

create table greenhouse_row_batches (
  id uuid primary key default gen_random_uuid(),
  phase_id uuid not null references greenhouse_phases(id),
  name text,
  start_side text not null check (start_side in ('north', 'south', 'east', 'west')),
  anchor_side text not null check (anchor_side in ('north', 'south', 'east', 'west')),
  row_width_ft numeric not null,
  row_length_ft numeric not null,
  row_gap_ft numeric not null default 0,
  offset_ft numeric not null default 0,
  numbering_mode text not null check (numbering_mode in ('all', 'odd', 'even')),
  start_row_number integer not null,
  end_row_number integer not null,
  -- 'continue' when this batch was placed to start immediately after the
  -- last-occupied position for the same phase/start_side (see
  -- computeContinuationOffset in lib/rowLayout.ts); null/omitted for a
  -- batch anchored purely from its own start_side edge. Informational only
  -- — the batch's rows already have their final baked-in geometry.
  continuation_mode text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint chk_greenhouse_row_batches_width_positive check (row_width_ft > 0),
  constraint chk_greenhouse_row_batches_length_positive check (row_length_ft > 0),
  constraint chk_greenhouse_row_batches_gap_nonnegative check (row_gap_ft >= 0),
  constraint chk_greenhouse_row_batches_offset_nonnegative check (offset_ft >= 0),
  constraint chk_greenhouse_row_batches_start_end check (end_row_number >= start_row_number),
  -- A start/anchor pair must span two different (perpendicular) axes — see
  -- the side/anchor mapping table in lib/rowLayout.ts. South+North or
  -- East+West (parallel/opposite pairs, including a side anchored to
  -- itself) have no deterministic meaning here and are rejected outright.
  constraint chk_greenhouse_row_batches_perpendicular_sides check (
    (start_side in ('north', 'south') and anchor_side in ('east', 'west')) or
    (start_side in ('east', 'west') and anchor_side in ('north', 'south'))
  )
);

create index idx_greenhouse_row_batches_phase on greenhouse_row_batches(phase_id);

-- ---------------------------------------------------------------------------
-- Rows — persisted final geometry, one row per physical greenhouse row.
-- ---------------------------------------------------------------------------

create table greenhouse_rows (
  id uuid primary key default gen_random_uuid(),
  phase_id uuid not null references greenhouse_phases(id),
  row_batch_id uuid references greenhouse_row_batches(id),
  row_number integer not null,
  -- Phase-relative, feet, from the phase's own north-west corner — see the
  -- header comment above.
  x_ft numeric not null,
  y_ft numeric not null,
  width_ft numeric not null,
  length_ft numeric not null,
  orientation text not null check (orientation in ('horizontal', 'vertical')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint chk_greenhouse_rows_x_nonnegative check (x_ft >= 0),
  constraint chk_greenhouse_rows_y_nonnegative check (y_ft >= 0),
  constraint chk_greenhouse_rows_width_positive check (width_ft > 0),
  constraint chk_greenhouse_rows_length_positive check (length_ft > 0)
);

create index idx_greenhouse_rows_phase on greenhouse_rows(phase_id);
create index idx_greenhouse_rows_batch on greenhouse_rows(row_batch_id);
create index idx_greenhouse_rows_row_number on greenhouse_rows(phase_id, row_number);

-- Two active rows in the same phase can never share a row number — the
-- partial index (deleted_at is null) means a deleted row's old number is
-- immediately free to reuse, matching "deleted entries excluded from
-- active uniqueness."
create unique index idx_greenhouse_rows_active_number_per_phase
  on greenhouse_rows (phase_id, row_number)
  where deleted_at is null;
