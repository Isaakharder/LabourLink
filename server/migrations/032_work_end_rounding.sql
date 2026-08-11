-- Configurable work-end rounding, per Break Profile (Basic Data > Breaks) —
-- the mirror of 030_work_start_rounding.sql's work-start rounding, applied
-- at the opposite end of the day. Applies only when an employee explicitly
-- finishes their workday through the mobile Finish Work flow (POST
-- /api/mobile/time-entries/end-day) — never to activity changes, break
-- starts/ends, automatically-resumed activities, manual Inputs entries or
-- corrections, or administratively entered end times. See
-- server/src/lib/workStartRounding.ts for the rounding math (shared,
-- direction-agnostic — the same "round forward/backward to the nearest
-- boundary" rule applies whether the instant being rounded is a start or
-- an end) and server/src/routes/mobileTime.ts for where it's applied.
--
-- Defaults (enabled=false) mean every existing break profile keeps its
-- current behavior with zero migration-time impact — this is additive
-- configuration, not a behavior change for anyone who doesn't opt in.
-- Deliberately independent of work_start_rounding_enabled/direction/
-- interval_minutes — an admin can enable one without the other.
alter table break_profiles
  add column work_end_rounding_enabled boolean not null default false,
  add column work_end_rounding_direction text not null default 'clockwise',
  add column work_end_rounding_interval_minutes integer not null default 5,
  add constraint chk_break_profiles_end_rounding_direction
    check (work_end_rounding_direction in ('clockwise', 'counter_clockwise')),
  add constraint chk_break_profiles_end_rounding_interval
    check (work_end_rounding_interval_minutes between 1 and 60);

-- time_entries.actual_ended_at already exists (010_break_profiles.sql) as
-- "the real tap timestamp, kept alongside the possibly-rounded ended_at,
-- for audit purposes" — used so far only when a fixed-break match closes
-- the entry that break interrupted (mobileTime.ts's break/end route).
-- Work-end rounding reuses the exact same column for the exact same
-- purpose: when rounding is applied to a Finish Work tap, actual_ended_at
-- holds the employee's original button-press timestamp and ended_at holds
-- the rounded, effective value every paid-time calculation, Inputs, and
-- report reads — the same relationship 030_work_start_rounding.sql
-- established between actual_started_at and started_at. No new column
-- needed. actual_ended_at stays null on a work row exactly as before
-- whenever rounding is disabled, not configured, or the entry was closed
-- by anything other than a genuine Finish Work tap (an activity change, a
-- break starting, a manual Inputs correction, or the daily-cutoff safety
-- net all close a row without ever touching actual_ended_at for that
-- reason).
