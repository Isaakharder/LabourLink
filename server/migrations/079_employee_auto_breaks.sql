-- Per-employee automatic breaks (src/lib/scheduledBreaks.ts).
--
-- Nothing here changes an existing time entry, break or payroll figure.
-- Every new column defaults to "off"/null, and the payroll rule below takes
-- effect only for workdays on or after the day this migration is applied.
--
-- 1. employees.auto_breaks_enabled: the Auto breaks switch (Add/Edit
--    Employee). Off for every existing and new employee. When it is turned
--    on, auto_breaks_effective_from is set to that moment: only scheduled
--    break windows that START after it can be added automatically, so turning
--    it on never backfills an earlier day or an earlier window.
--    break_profile_assigned_at records when the employee's break profile was
--    last changed (null = before this migration).
--
-- 2. break_occurrences: one row per employee, scheduled break item and local
--    date, written once the window has started (by the auto-breaks worker,
--    or by a Start Break tap inside the window). It freezes that day's
--    schedule (start, end, paid) and whether Auto breaks applied, so editing
--    the profile or the employee afterwards can't change an occurrence that
--    has already started. A tapped or automatic break links to its
--    occurrence (time_entries.break_occurrence_id). It also records how an
--    automatic break split the employee's work (so a delayed phone event
--    can undo it exactly) and any review for Inputs "Breaks to review";
--    confirming a review changes no time entry.
--
-- 3. time_entries.resume_*: on a scheduled break, the job (row, bin and
--    density snapshot) the employee goes back to, and when they asked to go
--    back (resume_requested_at — End Break tapped before the scheduled end).
--    Work resumes at the scheduled end, never earlier.
--
-- 4. payroll_settings.unpaid_break_span_clip_from: from this date on,
--    payroll deducts only the part of an unpaid break that lies inside the
--    work span (first work start to last end). Earlier workdays keep the
--    previous rule, so deploying this changes no past payroll. Set to the
--    local (America/Toronto) date the migration is applied.
--
-- break_profile_items.auto_add is no longer read by the application
-- (Auto breaks moved to the employee); the column is kept so a rollback to
-- the previous release still finds it.

alter table employees
  add column auto_breaks_enabled boolean not null default false,
  add column auto_breaks_effective_from timestamptz,
  add column break_profile_assigned_at timestamptz,
  add constraint chk_employees_auto_breaks_effective
    check (not auto_breaks_enabled or auto_breaks_effective_from is not null);

create table break_occurrences (
  id uuid primary key default gen_random_uuid(),
  -- Employees and items are only ever deactivated in the app; the cascades
  -- only matter for test fixtures and manual cleanup.
  employee_id uuid not null references employees(id) on delete cascade,
  break_profile_item_id uuid not null references break_profile_items(id) on delete cascade,
  scheduled_date date not null,
  name text,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  is_paid boolean not null,
  fixed_break boolean not null,
  -- Auto breaks applied to this occurrence (frozen when it was written).
  auto_enabled boolean not null,
  -- pending: nothing recorded yet (Auto breaks keeps checking it until it
  --   is added, or expires).
  -- tapped: the employee's own Start Break matched it.
  -- auto_added: added automatically.
  -- expired: Auto breaks stopped checking it (see last_check_reason).
  -- reversed: an automatic break was just undone because the phone's
  --   delayed events showed it no longer qualified; it is decided again
  --   once that sync finishes.
  status text not null default 'pending'
    check (status in ('pending', 'tapped', 'auto_added', 'expired', 'reversed')),
  break_entry_id uuid references time_entries(id) on delete set null,
  last_check_reason text,
  last_checked_at timestamptz,
  -- How an automatic break split the employee's single work entry, so a
  -- delayed phone event can undo it exactly: the part before the window
  -- (null when the work started exactly at the window start) and the part
  -- after it. Only set when nothing was deleted.
  auto_before_entry_id uuid references time_entries(id) on delete set null,
  auto_after_entry_id uuid references time_entries(id) on delete set null,
  -- The delayed phone event that undid the automatic break, if any.
  reversal jsonb,
  -- Breaks to review (Inputs): why this occurrence needs a supervisor's
  -- look (not added, shortened, recorded as an ordinary break, or a
  -- conflict), and the supervisor's confirmation. Confirming only records
  -- the review: it never adds a break or changes any time.
  review_reason text,
  review_detail jsonb,
  review_flagged_at timestamptz,
  review_confirmed_at timestamptz,
  review_confirmed_by_employee_id uuid references employees(id) on delete set null,
  review_confirm_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint chk_break_occurrences_window check (scheduled_end > scheduled_start),
  unique (employee_id, break_profile_item_id, scheduled_date)
);
create index idx_break_occurrences_pending on break_occurrences (scheduled_end) where status = 'pending' and auto_enabled;
create index idx_break_occurrences_employee_date on break_occurrences (employee_id, scheduled_date);
create index idx_break_occurrences_review on break_occurrences (review_flagged_at)
  where review_reason is not null and review_confirmed_at is null;

alter table time_entries
  add column break_occurrence_id uuid references break_occurrences(id) on delete set null,
  add column resume_activity_id uuid references activities(id),
  add column resume_greenhouse_row_id uuid references greenhouse_rows(id),
  add column resume_carrier_id uuid references carriers(id),
  add column resume_density_type text check (resume_density_type is null or resume_density_type in ('plants', 'stems')),
  add column resume_density_count_per_row integer,
  add column resume_requested_at timestamptz,
  add constraint chk_time_entries_resume_only_on_break
    check (entry_type = 'break' or (resume_activity_id is null and resume_requested_at is null));
create index idx_time_entries_open_occurrence_break
  on time_entries (employee_id) where break_occurrence_id is not null and ended_at is null and deleted_at is null;

create table payroll_settings (
  id boolean primary key default true check (id),
  unpaid_break_span_clip_from date not null,
  updated_at timestamptz not null default now()
);
insert into payroll_settings (unpaid_break_span_clip_from)
values ((now() at time zone 'America/Toronto')::date);
