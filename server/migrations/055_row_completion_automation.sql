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
--   'superseded' — replaced by a later completion covering the same
--                  physical row (re-entry evidence it wasn't really
--                  finished) — kept permanently for audit, never deleted.
-- source distinguishes an admin's manual Review-modal confirmation from
-- one this automation created on its own — purely informational (nothing
-- reads it to change behavior), useful for support/debugging.
alter table row_completions
  add column status text not null default 'active'
    check (status in ('active', 'superseded')),
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

-- Powers "is there already an active completion for this row+activity+type"
-- — the automation's own re-entry/reopen check, and the report attribution
-- query's `status = 'active'` filter.
create index idx_row_completions_active_lookup
  on row_completions (greenhouse_row_id, activity_id, density_type)
  where status = 'active';
