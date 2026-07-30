-- A double-invoked pairing mount effect (React StrictMode in dev, or a
-- retried request in general) can race two POST /api/pairing/request calls
-- for the same device before either has committed, producing two pending
-- rows instead of one being reused. One side of that race gets approved;
-- the other is orphaned and the status poll (which picks the row it thinks
-- is "latest") can end up watching the one nobody approved. Clean up any
-- such orphans, then close the race for good.

-- A pending row for a device that already has an approved row is a leftover
-- loser of the race — it will never be approved (the device is already
-- paired via its sibling request).
update pairing_requests orphan
set status = 'expired'
where orphan.status = 'pending'
  and exists (
    select 1 from pairing_requests approved
    where approved.device_identifier = orphan.device_identifier
      and approved.status = 'approved'
  );

-- Collapse any remaining pending-vs-pending duplicates (identical
-- created_at is possible under the race) down to the most recent one, using
-- id as a deterministic tie-break.
update pairing_requests p
set status = 'expired'
where p.status = 'pending'
  and exists (
    select 1 from pairing_requests newer
    where newer.device_identifier = p.device_identifier
      and newer.status = 'pending'
      and newer.id <> p.id
      and (newer.created_at, newer.id) > (p.created_at, p.id)
  );

create unique index idx_pairing_requests_one_pending_per_device
  on pairing_requests (device_identifier)
  where status = 'pending';
