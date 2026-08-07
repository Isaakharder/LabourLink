-- Lets an activity declare it's driven by a row's Plants or Stems density
-- (plant_densities/plant_density_rows, 023/024), so Inputs can show a
-- calculated actual speed (density quantity / worked hours) instead of only
-- the static configured normal_speed (007_activity_groups.sql).
--
-- density_type/density_count_per_row on time_entries are a frozen snapshot
-- of the row's density at the moment the work entry was opened — not a live
-- FK to plant_densities. Unlike normal_speed (which Inputs joins live, so
-- editing it retroactively changes how past runs display), this feature
-- must not let editing a density later change an already-recorded run's
-- calculated speed, so the resolved value is captured once and never
-- re-read from plant_densities afterward.
alter table activities add column density_source text;
alter table activities add constraint chk_activities_density_source
  check (density_source is null or density_source in ('plants', 'stems'));

alter table time_entries add column density_type text;
alter table time_entries add column density_count_per_row integer;
alter table time_entries add constraint chk_time_entries_density_type
  check (density_type is null or density_type in ('plants', 'stems'));
alter table time_entries add constraint chk_time_entries_density_count_per_row_positive
  check (density_count_per_row is null or density_count_per_row > 0);
alter table time_entries add constraint chk_time_entries_density_paired
  check ((density_type is null) = (density_count_per_row is null));
alter table time_entries add constraint chk_time_entries_density_only_on_work
  check (entry_type = 'work' or (density_type is null and density_count_per_row is null));
