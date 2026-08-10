-- Saved report definitions for the desktop Reports page. Deliberately just
-- the definition (name, type, saved activity, selected metrics/options) —
-- report *results* are always regenerated from time_entries/row_completions
-- for whatever date range is currently selected, never stored here (see
-- server/src/lib/reportQueries.ts). This is the same "definition sits beside
-- the real source data, never duplicates it" pattern row_completions
-- (026_row_completions.sql) already uses.

create table saved_reports (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  report_type text not null check (report_type in ('activity', 'payroll')),
  -- Only meaningful for an Activity Report — see the check constraint below.
  -- Payroll reports have no natural activity_id in the current data model
  -- (breaks and whole-shift totals aren't activity-scoped), so this stays
  -- null for them rather than inventing a link that doesn't exist elsewhere.
  activity_id uuid references activities(id),
  -- Selected metrics/columns, type-specific options, and (purely as a
  -- reopen-time convenience default, never authoritative) the last date
  -- range this report was viewed with — see reports.ts's configuration
  -- shape. A saved report always remains free to change its date range on
  -- open; nothing here locks it.
  configuration jsonb not null default '{}'::jsonb,
  created_by uuid not null references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_saved_reports_activity_only_on_activity_type
    check (report_type = 'activity' or activity_id is null)
);

create index idx_saved_reports_updated_at on saved_reports(updated_at desc);
