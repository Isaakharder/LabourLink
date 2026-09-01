-- Midnight rollover: at each local midnight, an employee's still-open
-- time_entries row is closed at the boundary and an equivalent row is
-- immediately opened for the new day (server/src/lib/midnightRollover.ts),
-- so a shift genuinely spanning midnight reads as continuous rather than
-- being silently kicked to idle by the daily-cutoff safety net
-- (dailyCutoff.ts, which now only fires as a much-wider-threshold outer
-- fallback — see that file's own updated header comment).
--
-- Purely additive: no existing row is touched by this migration itself.

-- Set only on a rollover-created continuation row, pointing at the entry it
-- continues (the one just closed at the shared boundary timestamp). Null on
-- every ordinary row. This is what lets row-completion candidate resolution
-- (rowCompletionCandidates.ts) walk a visit across a midnight boundary
-- instead of treating the two halves as separate, independently-ambiguous
-- runs — the false "Needs review" bug this schema change exists to make
-- fixable. Self-referencing FK, not enforced not-null/unique: a genuine
-- rollover chain across N missed midnights produces N such rows, each
-- pointing at the previous one.
alter table time_entries
  add column rollover_of_entry_id uuid references time_entries(id);

create index idx_time_entries_rollover_of on time_entries(rollover_of_entry_id) where rollover_of_entry_id is not null;

-- Third source value, alongside 'manual' (a real tap or an admin's manual
-- Inputs entry) and 'auto' (breakReconciliation.ts's scheduled auto-add) —
-- 'midnight_rollover' marks a system-synthesized continuation row so it's
-- never confused with either. See time_entries.creation_reason's own
-- comment for why that column (used for admin-attributed manual entries)
-- can't be reused here: its check constraint requires a real employee_id,
-- and there is no employee to attribute a system rollover to.
alter table time_entries
  drop constraint time_entries_source_check,
  add constraint time_entries_source_check check (source in ('manual', 'auto', 'midnight_rollover'));

-- Singleton org-wide settings row — currently just the long-open-shift
-- alert threshold (server/src/lib/longOpenShiftAlerts.ts), Administrator-
-- editable from the desktop Settings page. `id boolean primary key default
-- true` plus the check below is the standard "exactly one row, ever"
-- pattern: a second insert always collides on the primary key.
create table org_settings (
  id boolean primary key default true,
  constraint org_settings_single_row check (id),

  -- Administrator/Manager alert (never an auto-stop) for a workday that has
  -- remained open — continuously, across any rolled-forward midnight
  -- boundaries — longer than this. Review-only; the employee is never
  -- automatically clocked out at this threshold.
  long_open_shift_alert_threshold_hours integer not null default 16
    check (long_open_shift_alert_threshold_hours between 1 and 168),

  updated_at timestamptz not null default now(),
  updated_by_employee_id uuid references employees(id)
);

insert into org_settings (id) values (true);
