-- Fixes a latent gap exposed by the forward-rounding boundary fix in
-- mobileTime.ts's openEntry(): the "one open entry per employee" unique
-- index (003_activities_and_time_entries.sql) only ever excluded
-- ended_at is null, never accounting for deleted_at (added later, in
-- 012_inputs_deletion_and_break_corrections.sql) — every OTHER "is this
-- entry actually open" check in the codebase already requires BOTH
-- `ended_at is null and deleted_at is null` (getOpenEntry, openEntry's own
-- locked peek, etc.), but this index never matched that same definition.
--
-- This was harmless until now because no code path ever soft-deleted a
-- still-open (ended_at is null) row: every existing deletion route
-- (POST /activity-runs/:id/delete) explicitly requires the target to
-- already be closed first. openEntry()'s new pre-rounding-boundary void
-- path is the first to soft-delete a row while it's still open (a
-- never-actually-paid placeholder voided in favor of a different-kind
-- event arriving before its own rounded boundary, e.g. Start Break just
-- after a work-start that rounded forward) — and the stale index then
-- rejected the immediately-following insert of the new entry as a
-- duplicate "open row for this employee", even though the voided row no
-- longer represents anything open. Confirmed via a real failing test
-- (mobileTime.roundingBoundary.test.ts) showing the void's own UPDATE
-- succeeding but the surrounding transaction rolling back on the
-- subsequent INSERT's 23505, silently reverting to the pre-void state.
drop index idx_time_entries_one_open_per_employee;

create unique index idx_time_entries_one_open_per_employee
  on time_entries (employee_id)
  where ended_at is null and deleted_at is null;
