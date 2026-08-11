-- Administrator-created manual entries from the Inputs page (Add work
-- start / Add break / Add activity) — server/src/routes/inputs.ts's POST
-- /work-start, /breaks, /activities.
--
-- Mirrors the existing deleted_at/deleted_by_employee_id/deletion_reason
-- pattern (012_inputs_deletion_and_break_corrections.sql) rather than
-- extending time_entry_corrections: corrections model "one field on an
-- existing row changed from X to Y," which doesn't fit a brand-new row (no
-- old value, and a creation touches several fields — activity, times, row,
-- carrier — at once, not one at a time). time_entry_deletions was already
-- added as its own sibling table for the same reason (a deletion doesn't
-- fit the field-correction shape either). A creation needs even less: the
-- row's own columns already hold every entered value and its own
-- created_at already holds when — the only two things missing are who and
-- why, so those are the only two columns added here. Both null together
-- means "not manually created" (a mobile-app or server-reconciliation row,
-- same as every row before this migration); both set together means a
-- manually created one — the check constraint below is the same "both or
-- neither" shape the deletion columns already use.
alter table time_entries
  add column created_by_employee_id uuid references employees(id),
  add column creation_reason text,
  add constraint chk_time_entries_creation_consistency check (
    (created_by_employee_id is null) = (creation_reason is null)
  );

create index idx_time_entries_created_by on time_entries(created_by_employee_id) where created_by_employee_id is not null;

-- device_id has been not-null since the very first schema
-- (003_activities_and_time_entries.sql) — every row until now genuinely
-- did originate from a paired phone. A manually-created entry has no
-- originating device at all, so the column has to allow null rather than
-- pointing at some invented placeholder "admin" device row, which would
-- misrepresent it as phone-originated and pollute device management/
-- reporting with a fake device. Confirmed safe: nothing in the codebase
-- reads time_entries.device_id for any computation, join, or display —
-- it's write-only, set at insert time and never queried back.
alter table time_entries
  alter column device_id drop not null;
