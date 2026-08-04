-- Optional greenhouse row a work time_entries row is attached to. Nullable
-- — most activities have no row question, and all pre-existing history has
-- none. References greenhouse_rows directly (the persisted final geometry,
-- see 013_greenhouse_rows.sql) — greenhouse_rows is only ever soft-deleted
-- (deleted_at), never hard-deleted, so this FK can never dangle and needs
-- no ON DELETE action.
alter table time_entries
  add column greenhouse_row_id uuid references greenhouse_rows(id),
  add constraint chk_time_entries_row_only_on_work
    check (entry_type = 'work' or greenhouse_row_id is null);

-- Backs both the live greenhouse map's per-row employee lookups
-- (GET /api/greenhouse/live) and the job-chain walk's row-equality check
-- (accumulateChainSeconds in mobileTime.ts).
create index idx_time_entries_greenhouse_row
  on time_entries(greenhouse_row_id)
  where greenhouse_row_id is not null;
