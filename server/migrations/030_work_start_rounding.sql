-- Configurable work-start rounding, per Break Profile (Basic Data > Breaks).
-- Applies only to an employee's first work entry of the day (the genuine
-- idle -> work transition) — never to breaks, activity changes, work-finish
-- times, or manual Inputs corrections. See server/src/lib/
-- workStartRounding.ts for the rounding math and
-- server/src/routes/mobileTime.ts for where it's applied.
--
-- Defaults (enabled=false) mean every existing break profile keeps its
-- current behavior with zero migration-time impact — this is additive
-- configuration, not a behavior change for anyone who doesn't opt in.
alter table break_profiles
  add column work_start_rounding_enabled boolean not null default false,
  add column work_start_rounding_direction text not null default 'clockwise',
  add column work_start_rounding_interval_minutes integer not null default 5,
  add constraint chk_break_profiles_rounding_direction
    check (work_start_rounding_direction in ('clockwise', 'counter_clockwise')),
  add constraint chk_break_profiles_rounding_interval
    check (work_start_rounding_interval_minutes between 1 and 60);

-- time_entries.actual_started_at already exists (010_break_profiles.sql) as
-- "the real tap timestamp, kept alongside the possibly-rounded started_at,
-- for audit purposes" — used so far only for fixed-break start matching.
-- Work-start rounding reuses the exact same column for the exact same
-- purpose: when rounding is applied, actual_started_at holds the employee's
-- original button-press timestamp and started_at holds the rounded,
-- effective value every paid-time calculation, Inputs, and report reads.
-- No new column needed. actual_started_at stays null on a work row exactly
-- as before whenever rounding is disabled or not configured — this feature
-- introduces no new column and no change in shape for anyone not using it.
