-- Enables SYSTEM-DETECTED row completion (server/src/lib/
-- rowCompletionAutomation.ts) alongside the existing admin-confirmed
-- workflow (server/src/routes/rowCompletions.ts) this table already
-- supports. Until now a row_completions record was a single, permanent
-- fact — this adds the vocabulary needed for one to be automatically
-- superseded when the same physical row is re-entered and re-finished
-- within the same ~7-day row-work cycle (rowCompletionCandidates.ts's
-- CYCLE_GAP_DAYS), without ever destroying the original record.
--
-- status:
--   'active'     — the current, authoritative completion for its
--                  row+activity+density (at most one per key at a time).
--   'reopened'   — an 'active' completion whose row was re-entered (same or
--                  a different employee, same ~7-day cycle) while that new
--                  visit is STILL open. Set the moment re-entry is detected
--                  (openEntry()'s insert step, via
--                  markRowReopenedIfApplicable) — deliberately NOT counted
--                  by the report attribution query's completion filter, so
--                  the physical row stops counting as completed for the
--                  whole window the worker is back on it, exactly like it
--                  was never finished. Resolved the next time the row is
--                  genuinely left again: completeRowVisitIfApplicable finds
--                  it (alongside 'active') and folds it into a fresh
--                  'active' completion, same as any other re-entry.
--   'superseded' — replaced by a later completion covering the same
--                  physical row (re-entry evidence it wasn't really
--                  finished) — kept permanently for audit, never deleted.
-- source distinguishes an admin's manual Review-modal confirmation from
-- one this automation created on its own — purely informational (nothing
-- reads it to change behavior), useful for support/debugging.
alter table row_completions
  add column status text not null default 'active'
    check (status in ('active', 'reopened', 'superseded')),
  add column source text not null default 'manual'
    check (source in ('manual', 'automatic')),
  add column superseded_by_completion_id uuid references row_completions(id);

-- A completion can only supersede a LATER one, never itself or a completion
-- that supersedes it — cheap sanity check, not a full cycle guard (a real
-- cycle would require recursion this constraint can't express, but the
-- application code never produces one: a completion is only ever marked
-- superseded at the moment its replacement is inserted).
alter table row_completions
  add constraint chk_row_completions_supersede_not_self
  check (superseded_by_completion_id is null or superseded_by_completion_id <> id);

-- Powers "is there already an active (or reopened) completion for this
-- row+activity+type" — the automation's own entry-time reopen check and
-- exit-time combine check, and the report attribution query's
-- `status = 'active'` filter (a strict subset of this predicate).
create index idx_row_completions_active_lookup
  on row_completions (greenhouse_row_id, activity_id, density_type)
  where status in ('active', 'reopened');
