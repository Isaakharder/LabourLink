-- Read-only preflight check for migration 052
-- (idx_time_entries_manual_scheduled_break_once).
--
-- Run this against production BEFORE applying migration 052. It finds any
-- (employee_id, break_profile_item_id, scheduled_break_date) combination
-- that already has more than one live ('manual' source, not soft-deleted)
-- time_entries row — exactly the shape the new unique index forbids. If
-- this returns ANY rows, applying migration 052 as-is will fail outright
-- (CREATE UNIQUE INDEX aborts on the first duplicate it finds) and the
-- migration transaction rolls back cleanly — nothing is left partially
-- applied — but it's better to know in advance and decide how to handle
-- the existing duplicates (which this query deliberately does NOT modify)
-- than to discover it during a deploy.
--
-- This is read-only. It changes nothing.
select
  employee_id,
  break_profile_item_id,
  scheduled_break_date,
  count(*) as duplicate_count,
  array_agg(id order by created_at) as time_entry_ids,
  array_agg(started_at order by created_at) as started_at_values,
  array_agg(ended_at order by created_at) as ended_at_values
from time_entries
where source = 'manual'
  and break_profile_item_id is not null
  and deleted_at is null
group by employee_id, break_profile_item_id, scheduled_break_date
having count(*) > 1
order by duplicate_count desc, employee_id, scheduled_break_date;
