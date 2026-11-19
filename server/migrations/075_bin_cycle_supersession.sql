-- Picking cycles: the most recent cycle before a weighing gets the credit.
-- See src/lib/binCycles.ts.
--
-- A bin can be filled, packed and emptied without ever being weighed, then
-- reused by someone else. When a different employee starts using a bin whose
-- cycle is unfinished, that earlier cycle is now SUPERSEDED (no weighing, no
-- credit), kept with all its scans, and flagged for administrator review. A
-- new cycle opens for the new employee, and the bin's next weighing credits
-- the latest cycle. An administrator can credit a superseded cycle instead
-- (bin_cycle_reviews, audited and idempotent).
--
-- Forward-only: 074 is already applied and unchanged. No existing row
-- changes. Greenhouses without LabourLink Scale have no cycles and are
-- unaffected.

alter table bin_cycles drop constraint bin_cycles_status_check;
alter table bin_cycles add constraint bin_cycles_status_check
  check (status in ('filling', 'awaiting_weighing', 'needs_review', 'closed', 'closed_unweighed', 'superseded'));

-- superseded: closed_at = when the next employee's cycle started; no weighing.
alter table bin_cycles drop constraint chk_bin_cycles_closed;
alter table bin_cycles add constraint chk_bin_cycles_closed check (
  (status in ('closed', 'closed_unweighed', 'superseded')) = (closed_at is not null)
  and (status = 'closed') = (weighing_id is not null)
  and (status <> 'closed_unweighed' or close_reason is not null)
);

alter table bin_cycles
  -- The cycle that replaced this one (the next employee's), or, after an
  -- administrator credited this cycle's chain differently, the cycle now
  -- credited. Deferred: the placement writes a chain of cycles in one
  -- transaction.
  add column superseded_by_cycle_id uuid references bin_cycles(id) deferrable initially deferred,
  -- Set once the superseded cycle's outcome is settled (its bin was weighed,
  -- closed, or tracking stopped). Until then it can still be re-placed when
  -- delayed events arrive.
  add column finalized_at timestamptz,
  -- Administrator review of a superseded cycle: open (to look at),
  -- confirmed (it really was superseded), reinstated (it was credited instead).
  add column review_status text check (review_status in ('open', 'confirmed', 'reinstated'));

alter table bin_cycles add constraint chk_bin_cycles_superseded check (
  (status <> 'superseded' or (superseded_by_cycle_id is not null and review_status is not null))
);
create index idx_bin_cycles_superseded_by on bin_cycles (superseded_by_cycle_id) where superseded_by_cycle_id is not null;
create index idx_bin_cycles_review on bin_cycles (review_status) where review_status = 'open';

-- Administrator review actions on superseded cycles. request_id makes each
-- action idempotent; the row is the audit record.
create table bin_cycle_reviews (
  request_id uuid primary key,
  cycle_id uuid not null references bin_cycles(id),
  action text not null check (action in ('reinstate', 'confirm')),
  weighing_id uuid references scale_weighings(id),
  previous_employee_id uuid references employees(id),
  new_employee_id uuid references employees(id),
  reason text not null check (length(trim(reason)) >= 3),
  performed_by_employee_id uuid not null references employees(id),
  performed_at timestamptz not null default now()
);
create index idx_bin_cycle_reviews_cycle on bin_cycle_reviews (cycle_id, performed_at);
