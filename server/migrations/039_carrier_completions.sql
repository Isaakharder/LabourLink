-- Bin/carrier completion tracking for the Picking dashboard card — the
-- carrier-scoped mirror of row_completions/row_completion_segments
-- (026_row_completions.sql). There is no weight/kg data anywhere in this
-- schema (carriers.tare_weight_kg, 035_carrier_tare_weight.sql, is only a
-- static empty-bin weight, never a fill weight), so unlike row_completions
-- there is no per-completion quantity column here: a confirmed bin always
-- counts as exactly 1 toward aggregateDensitySpeed's ratio-of-sums, giving
-- a genuine bins/hour rate rather than a fabricated kg/hour one.
create table carrier_completions (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references carriers(id),
  confirmed_by_employee_id uuid not null references employees(id),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index idx_carrier_completions_carrier on carrier_completions(carrier_id);

-- time_entry_id as the PRIMARY KEY (not a composite with carrier_completion_id)
-- is the actual "a work segment can belong to at most one completion" dedup
-- enforcement — identical convention to row_completion_segments.
create table carrier_completion_segments (
  time_entry_id uuid primary key references time_entries(id),
  carrier_completion_id uuid not null references carrier_completions(id)
);

create index idx_carrier_completion_segments_completion on carrier_completion_segments(carrier_completion_id);
