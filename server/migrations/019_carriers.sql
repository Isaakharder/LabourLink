-- Minimum viable Carrier model — required to make the "Which Carrier?"
-- activity question (question_type = 'carrier', see
-- 018_activity_questions_multi.sql) functional. Managed via Base Data >
-- Carriers (desktop) the same way activities/break profiles are: plain
-- name + notes + is_active, no history table of its own.

create table carriers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case/whitespace-insensitive uniqueness, same pattern as activities
-- (003_activities_and_time_entries.sql), break_profiles (010), etc.
create unique index carriers_name_normalized_key on carriers (lower(trim(name)));

-- Optional carrier a work time_entries row is attached to — same shape as
-- greenhouse_row_id (015_time_entries_greenhouse_row.sql): nullable (most
-- activities have no carrier question, all pre-existing history has none),
-- only ever meaningful on entry_type = 'work', never soft-deleted so this
-- FK can never dangle.
alter table time_entries
  add column carrier_id uuid references carriers(id),
  add constraint chk_time_entries_carrier_only_on_work
    check (entry_type = 'work' or carrier_id is null);

create index idx_time_entries_carrier
  on time_entries(carrier_id)
  where carrier_id is not null;
