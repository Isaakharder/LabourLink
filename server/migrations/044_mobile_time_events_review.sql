-- Admin review state for mobile_time_events rows that landed as
-- 'permanent_conflict' or 'sequence_gap' (043_mobile_time_events.sql) — the
-- structured review-queue requirement from the offline-first plan: never
-- auto-resolved, never silently dropped. An administrator marks one
-- reviewed after taking whatever real corrective action was needed
-- elsewhere (e.g. a manual Inputs correction) — this table only tracks
-- that a human has seen and dealt with it, it never itself mutates
-- time_entries.
alter table mobile_time_events add column resolved_at timestamptz;
alter table mobile_time_events add column resolved_by uuid references employees(id);
alter table mobile_time_events add column resolution_note text;

-- The admin conflicts list filters to unresolved rows by default — this is
-- the query that index serves.
create index idx_mobile_time_events_unresolved
  on mobile_time_events(received_at)
  where processing_status in ('permanent_conflict', 'sequence_gap') and resolved_at is null;
