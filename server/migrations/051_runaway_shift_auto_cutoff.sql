-- Runaway-shift safety cutoff: stops midnight rollover from perpetually
-- resetting a shift's apparent age when no genuine employee/device or
-- administrator action has occurred in a very long time. See
-- server/src/lib/runawayShiftAutoCutoff.ts.
--
-- Root cause this exists for: dailyCutoff.ts (020_daily_cutoff.sql) computes
-- staleness from the currently-open row's OWN started_at, but midnight
-- rollover (049_midnight_rollover.sql) refreshes that started_at every local
-- midnight — so a chain that's genuinely been abandoned for days always
-- looks under a day old to dailyCutoff, which can then never fire. Confirmed
-- in production: auto_closed_at has never been set on a single row.

-- Distinct from auto_closed_at: that column is dailyCutoff's own marker for
-- an unrelated failure mode (rollover never running at all) and is
-- deliberately left untouched by this migration/feature. safety_cutoff_at
-- marks a row closed specifically by the new runaway-shift mechanism, so
-- payroll/reporting can special-case it (see workdayTotals.ts) without
-- changing dailyCutoff's existing, unrelated, display-only behavior.
-- genuine_anchor_at records the last-known-genuine-action instant the
-- cutoff was computed and anchored against, captured once at cutoff time
-- rather than re-walked on every later payroll/report read. Both nullable;
-- both cleared together whenever a supervisor sets a real end time (see the
-- inputs.ts correction routes that already clear auto_closed_at the same
-- way, and longShiftAdminEnd.ts's extended endLongOpenShift).
alter table time_entries
  add column safety_cutoff_at timestamptz,
  add column genuine_anchor_at timestamptz;

alter table time_entries
  add constraint chk_genuine_anchor_requires_cutoff
    check (genuine_anchor_at is null or safety_cutoff_at is not null);

-- Fourth source value: a work continuation created by breakReconciliation.ts's
-- automatic split when an employee worked through a scheduled auto-add break
-- untouched. Previously this row's INSERT omitted `source` entirely and
-- silently took the table's default 'manual' — indistinguishable from a real
-- tap or a genuine admin manual entry, which is exactly wrong when the row
-- being split was itself already a synthetic midnight_rollover continuation.
-- Distinct from 'auto' (already means "the break entry itself") and from
-- 'midnight_rollover' (not a midnight event).
alter table time_entries
  drop constraint time_entries_source_check,
  add constraint time_entries_source_check
    check (source in ('manual', 'auto', 'midnight_rollover', 'break_reconciliation'));

-- The configurable safety-cutoff threshold: once an employee's continuous
-- open-shift chain has gone this many hours since the last GENUINE action
-- anywhere in the chain (see findGenuineAnchor), midnight rollover stops
-- creating further continuations and closes the chain at exactly
-- genuine_anchor_at + this many hours, rather than an unbounded chain.
-- Default (72h) reuses dailyCutoff's own long-standing
-- DAILY_CUTOFF_STALE_DAYS=3 "something is badly wrong" number — that
-- threshold was always meant to be this backstop, it just could never fire
-- because rollover kept resetting the open row's own started_at. Lower
-- bound (24h) is deliberately never faster than one full day, since a
-- legitimate overnight shift can genuinely run close to that long. Ordering
-- against long_open_shift_alert_threshold_hours (the review-only alert
-- should fire well before this automatic cutoff) is validated at the
-- application layer (PATCH /org-settings), not as a DB CHECK — a hard
-- cross-column CHECK here would break a legitimate standalone update to the
-- OTHER threshold the moment it crossed this one.
alter table org_settings
  add column auto_safety_cutoff_threshold_hours integer not null default 72
    check (auto_safety_cutoff_threshold_hours between 24 and 336);

-- Backs both the admin "needs review" queue (runawayChainRecovery.ts) and
-- the payroll-exclusion lookup (reportQueries.ts) — expected to be a
-- near-empty set at all times, since this mechanism's whole point is to
-- stop the set from ever growing unbounded.
create index idx_time_entries_safety_cutoff_pending
  on time_entries(employee_id) where safety_cutoff_at is not null and deleted_at is null;
