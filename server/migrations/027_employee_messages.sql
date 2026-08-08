-- Employee messaging: admin-authored messages broadcast to one, several, or
-- all active employees, requiring an explicit on-device acknowledgement
-- before the recipient can dismiss it (see server/src/routes/mobileMessages.ts).
-- Recipients are snapshotted at send time into employee_message_recipients,
-- never re-derived live from employees.is_active — an employee deactivated
-- after a send must still show up in that send's history (see the "all
-- employees" path in server/src/routes/messages.ts, which resolves the
-- actual active employee list once, at send time, and inserts one row per
-- employee).

create table employee_messages (
  id uuid primary key default gen_random_uuid(),
  message_text text not null,
  created_by_employee_id uuid not null references employees(id),
  -- Informational only — records how the send was initiated ("all active
  -- employees at the time" vs "hand-picked"). The actual recipient set is
  -- always the employee_message_recipients rows below; this flag is never
  -- consulted to determine who a message went to.
  all_employees boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_employee_messages_created_at on employee_messages(created_at desc);

create table employee_message_recipients (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references employee_messages(id) on delete cascade,
  employee_id uuid not null references employees(id),

  -- Best-effort: set the first time a push send was attempted for this
  -- recipient. Never proof the phone actually received anything — only that
  -- the server tried. See delivered_at for the real "the phone has this"
  -- signal.
  push_sent_at timestamptz,
  -- Set the first time the paired device actually fetches this message via
  -- GET /api/mobile/messages/outstanding — the one server-verifiable
  -- delivery signal. Never set merely because a push notification was sent.
  delivered_at timestamptz,
  -- Set only when the employee taps Acknowledge on their own paired device
  -- (see POST /api/mobile/messages/:recipientId/acknowledge, which scopes
  -- strictly to the requesting device's own employee_id).
  acknowledged_at timestamptz,

  created_at timestamptz not null default now(),

  -- One recipient row per employee per message — a resend/retry must never
  -- create a duplicate outstanding copy of the same message for the same
  -- employee.
  unique (message_id, employee_id)
);

create index idx_employee_message_recipients_message on employee_message_recipients(message_id);
-- Powers "does this employee have any outstanding (unacknowledged)
-- message" — the mobile app's one mandatory check, on every app start,
-- resume, and after pairing.
create index idx_employee_message_recipients_employee_unacked
  on employee_message_recipients(employee_id) where acknowledged_at is null;
