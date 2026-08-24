-- Persists the saved-reports "Employees" selection server-side, replacing
-- the previous component-state-only filter on ReportViewPage.tsx (it was
-- already wired to filter GET /:id/data via a client-supplied ?employeeIds=
-- query param, but reset to empty ("all") on every page load/navigation and
-- was never stored anywhere — see reports.ts and ReportViewPage.tsx before
-- this migration).
--
-- Modeled as two real, typed columns rather than folding into the existing
-- `configuration` jsonb blob (which only holds `metrics`/`lastDateRange`
-- today) — this data needs real validation (a check constraint on the mode,
-- and "never empty when explicit") that jsonb can't enforce, and it's
-- genuinely a first-class part of the report's identity, not a display
-- preference.
--
-- `default 'all'` / `default '{}'` on ADD COLUMN populates every EXISTING
-- row with those defaults as part of this migration (Postgres applies a
-- non-volatile DEFAULT to pre-existing rows immediately when the column is
-- added — no separate UPDATE/backfill statement needed), so every saved
-- report that exists today keeps behaving exactly as it does now (all
-- eligible employees, dynamically including newly added ones).
alter table saved_reports
  add column employee_selection_mode text not null default 'all',
  add column employee_ids uuid[] not null default '{}';

alter table saved_reports
  add constraint chk_saved_reports_employee_selection_mode
  check (employee_selection_mode in ('all', 'selected'));

-- "selected" mode must always carry at least one id — enforced here too
-- (not just in server/src/routes/reports.ts's request validation), so this
-- invariant holds regardless of what writes this table in the future.
alter table saved_reports
  add constraint chk_saved_reports_employee_ids_nonempty_when_selected
  check (employee_selection_mode <> 'selected' or array_length(employee_ids, 1) > 0);

-- "all" mode never carries a stale id list — keeps the two fields from
-- silently disagreeing (e.g. a report left in 'all' mode after switching
-- back from 'selected' would otherwise still carry the old employee_ids
-- array, which nothing reads while mode='all' but is misleading to inspect).
alter table saved_reports
  add constraint chk_saved_reports_employee_ids_empty_when_all
  check (employee_selection_mode <> 'all' or array_length(employee_ids, 1) is null);
