-- Records what actually happened when the server tried to notify each
-- message recipient, so the web and mobile screens stop presenting "a
-- recipient row exists" as "Sent".
--
-- Additive only: two nullable columns. No existing row loses data.
--
-- push_status (per recipient, per message):
--   null        not recorded (rows created before this migration, or a send
--               whose push attempt has not finished yet)
--   'accepted'  FCM/APNs/Web Push accepted the request for at least one of
--               the employee's registered devices. This is NOT proof the
--               phone displayed it; delivered_at (the phone fetched the
--               message) is the only server-verifiable signal for that.
--   'no_device' the employee had no active assigned device with an active
--               push registration, so nothing was attempted
--   'failed'    one or more registrations were attempted and none accepted
--
-- push_attempted_at is when that outcome was recorded. push_sent_at keeps
-- its existing meaning (first time a push was accepted).
alter table employee_message_recipients
  add column push_status text check (push_status in ('accepted', 'no_device', 'failed')),
  add column push_attempted_at timestamptz;

-- Historical rows: push_sent_at was only ever set after a successful send
-- call, so those rows are exactly 'accepted'. Everything else stays null
-- ("not recorded") because the old code never stored why a push was
-- skipped or failed.
update employee_message_recipients
set push_status = 'accepted', push_attempted_at = push_sent_at
where push_sent_at is not null and push_status is null;
