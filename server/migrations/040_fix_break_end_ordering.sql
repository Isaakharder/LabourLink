-- Data integrity bug in mobileTime.ts's POST /time-entries/break/end: the
-- fixed-break-item schedule match set a break's end time (overrides.startedAt,
-- which closes the open break) with NO check that it landed after the
-- break's own start — unlike the general break-rounding path a few lines
-- below, which already guards this with a two-step fallback. That let a
-- scheduled end time earlier than the break's actual start produce a
-- physically impossible negative-duration row.
--
-- Any such row is unrecoverable garbage, not honest historical data (there
-- is no real event a "break that ended before it started" could describe),
-- so it's removed outright here rather than soft-deleted — soft-delete
-- requires a real attributed admin (deleted_by_employee_id is not-null
-- when deleted_at is set), which doesn't exist for a migration-driven
-- cleanup. Doing this before the constraint below is added means this
-- migration succeeds on any database that accumulated rows from this same
-- code bug, not just the one it was diagnosed on.
delete from time_entries where ended_at is not null and ended_at <= started_at;

-- Guarantees this class of corruption can never be written again, by this
-- code path or any future one.
alter table time_entries
  add constraint chk_time_entries_ended_after_started
  check (ended_at is null or ended_at > started_at);
