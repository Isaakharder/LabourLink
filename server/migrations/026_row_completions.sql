-- Explicit, admin-confirmed "this physical row is done" record — sits
-- beside time_entries/plant_densities without rewriting either, same
-- pattern as time_entry_deletions (012_inputs_deletion_and_break_corrections.sql).
-- Needed because a physical row can be worked across more than one
-- ActivityRun (interrupted same day, or finished a different day) and the
-- density-speed calculation must count that row's quantity exactly once,
-- not once per run — see 025_activity_density_speed.sql's aggregation,
-- which this migration's application-code follow-up corrects.
create table row_completions (
  id uuid primary key default gen_random_uuid(),
  greenhouse_row_id uuid not null references greenhouse_rows(id),
  density_type text not null check (density_type in ('plants', 'stems')),
  -- Frozen at confirm time from the linked segments' own already-frozen
  -- time_entries.density_count_per_row — a second freeze on top of the
  -- first, so editing a density afterward can never change an already
  -- confirmed completion's quantity or speed.
  quantity_per_row integer not null check (quantity_per_row > 0),
  confirmed_by_employee_id uuid references employees(id),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- time_entry_id as the PRIMARY KEY (not just a foreign key) is the actual
-- "count once" enforcement — a single raw work segment can never be
-- claimed by two different completions.
create table row_completion_segments (
  time_entry_id uuid primary key references time_entries(id),
  row_completion_id uuid not null references row_completions(id) on delete cascade
);
create index idx_row_completion_segments_completion on row_completion_segments(row_completion_id);

-- Powers "find every candidate run for this row+type" — both the ambiguity
-- check on every Inputs load and the admin review modal.
create index idx_time_entries_density_row_type
  on time_entries(greenhouse_row_id, density_type)
  where density_type is not null and entry_type = 'work' and deleted_at is null;
