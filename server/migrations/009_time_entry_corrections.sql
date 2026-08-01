-- First audit-trail table in this app. Records supervisor corrections to
-- time_entries fields (currently only ended_at, via the desktop Inputs
-- page). field_name/old_value/new_value are generic text so future
-- correction types can reuse this table without a schema change.

create table time_entry_corrections (
  id uuid primary key default gen_random_uuid(),
  time_entry_id uuid not null references time_entries(id),
  employee_id uuid not null references employees(id),
  changed_by_employee_id uuid not null references employees(id),
  field_name text not null check (field_name in ('ended_at')),
  old_value text not null,
  new_value text not null,
  reason text not null check (char_length(trim(reason)) >= 3),
  changed_at timestamptz not null default now()
);

create index idx_time_entry_corrections_time_entry on time_entry_corrections(time_entry_id);
create index idx_time_entry_corrections_employee on time_entry_corrections(employee_id);
