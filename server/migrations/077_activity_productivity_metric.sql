-- Selectable productivity metric per Job (Basic Data -> Jobs).
--
-- A Job's productivity is either its existing row-count speed (stems/hour or
-- plants/hour, from density_source, unchanged) or kilograms/hour from
-- LabourLink Scale (src/lib/scaleProductivity.ts: verified net kilograms of
-- credited, weighed bins divided by the picking time matched to those same
-- bins).
--
-- Additive only. Every existing Job keeps productivity_metric = 'density',
-- so nothing it shows or calculates changes. density_source, speed_unit and
-- normal_speed are NOT reinterpreted: a kg/hour Job keeps its stems/plants
-- counts (row progress, Inputs, Reports and Productive TV still use them)
-- and its stems/plants normal speed; the kg/hour target is its own column.
-- Switching a Job back to its row-count metric restores exactly what it
-- showed before.
alter table activities
  add column productivity_metric text not null default 'density',
  add column scale_normal_kg_per_hour numeric(10, 2);

alter table activities add constraint chk_activities_productivity_metric
  check (productivity_metric in ('density', 'scale_kg'));
alter table activities add constraint chk_activities_scale_normal_kg_per_hour
  check (scale_normal_kg_per_hour is null or scale_normal_kg_per_hour > 0);
