-- Desktop Dashboard configuration: which activities' currently-active
-- employees appear as cards. The full row set of this table IS the config
-- (empty = nothing selected, no separate "is configured" flag needed) —
-- same "the join table's contents are the whole answer" shape as
-- activity_group_activities (007_activity_groups.sql). Single-tenant app
-- (see server/src/lib/timezone.ts's own APP_TIMEZONE comment / no
-- organization table anywhere in this schema), so this is the one shared
-- org-wide config, not scoped to any owner.
--
-- Deliberately has NO card_type column. A selected activity's dashboard
-- card type (row/stem work vs. picking) is 100% derivable at read time from
-- activities.density_source (not null -> row/stem, null -> picking, see
-- 025_activity_density_speed.sql) — storing a second, independently-edited
-- copy of that same fact here would drift the moment an admin changes an
-- activity's density_source after it's already on the dashboard.
create table dashboard_activities (
  activity_id uuid primary key references activities(id) on delete cascade,
  added_by_employee_id uuid references employees(id),
  created_at timestamptz not null default now()
);
