-- Configurable break rounding, per Break Profile (Basic Data > Breaks) — a
-- third, independent rounding setting alongside 030_work_start_rounding.sql
-- and 032_work_end_rounding.sql, but unlike those two (each governing one
-- boundary of the workday), this single enabled/direction/interval group
-- governs BOTH ends of a break: starting a break (clocking out for it) and
-- ending one (returning to work). See server/src/lib/workStartRounding.ts
-- for the rounding math (shared, direction-agnostic) and
-- server/src/routes/mobileTime.ts's POST /time-entries/break/start and
-- POST /time-entries/break/end for where it's applied.
--
-- Only applies when a break does NOT already match a scheduled fixed-break
-- item within its configured grace window (break_profile_items.fixed_break
-- / fixed_start_window_minutes / fixed_end_window_minutes, 010_break_
-- profiles.sql) — a fixed-item match already snaps to an exact scheduled
-- time, which this setting deliberately never layers additional rounding on
-- top of. Never applied to activity changes, manual Inputs entries or
-- corrections, or work-start/work-end (independent of work_start_rounding_*/
-- work_end_rounding_* above — an admin can enable any subset of the three).
--
-- Defaults (enabled=false) mean every existing break profile keeps its
-- current behavior with zero migration-time impact.
alter table break_profiles
  add column break_rounding_enabled boolean not null default false,
  add column break_rounding_direction text not null default 'clockwise',
  add column break_rounding_interval_minutes integer not null default 5,
  add constraint chk_break_profiles_break_rounding_direction
    check (break_rounding_direction in ('clockwise', 'counter_clockwise')),
  add constraint chk_break_profiles_break_rounding_interval
    check (break_rounding_interval_minutes between 1 and 60);

-- time_entries.actual_started_at/actual_ended_at already exist
-- (010_break_profiles.sql) as "the real tap timestamp, kept alongside the
-- possibly-rounded started_at/ended_at, for audit purposes" — used so far
-- for work-start/work-end rounding and fixed-break-item matching. Break
-- rounding reuses the exact same columns for the exact same purpose on a
-- break row itself: actual_started_at holds the employee's original Start
-- Break tap, actual_ended_at holds the original End Break tap, and
-- started_at/ended_at hold the rounded, effective values every paid/unpaid
-- calculation, Inputs, and report reads. No new column needed.
