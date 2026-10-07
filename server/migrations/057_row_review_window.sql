-- Row review window: the number of calendar days that separates one
-- row-work cycle from the next (rowCompletionCandidates.ts's
-- assignCycleIndexes). Replaces the fixed CYCLE_GAP_DAYS = 7 constant.
-- For the same row + activity + density type, two consecutive unresolved
-- visits whose work dates (organization timezone) are fewer than this many
-- calendar dates apart belong to the same review cycle; a gap of exactly
-- this many dates or more starts a new cycle. Administrator-editable from
-- Setup > Row Review.
--
-- Numbered 057: 055 is reserved by the not-yet-released
-- 055_row_completion_automation.sql on another branch; 056 is
-- 056_employee_groups.sql.
--
-- Additive: one new column on the existing org_settings singleton
-- (049_midnight_rollover.sql). The default of 7 is exactly the old fixed
-- boundary, so applying this migration changes no grouping, review badge,
-- report figure or speed until an Administrator saves a different value.
-- Confirmed row completions (row_completions / row_completion_segments) are
-- never read or written by this setting — only unresolved visits regroup.
alter table org_settings
  add column row_review_window_days integer not null default 7
    check (row_review_window_days between 1 and 365);
