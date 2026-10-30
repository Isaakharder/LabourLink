-- Direct employee → Job assignments, replacing Activity Groups.
--
-- "Jobs" in the interface are `activities` here (internal names unchanged).
-- Until now an employee could use a Job only through Activity Groups: the
-- active Jobs in every active group the employee currently belongs to
-- (lib/activitySelection.ts). This table states the same thing directly,
-- one row per employee and Job, with the same history shape as
-- employee_activity_group_assignments: a row is open while unassigned_at is
-- null, closing it keeps the row (who/when) instead of deleting it.
--
-- Effective rule after this migration (lib/activitySelection.ts): an
-- employee may use a Job when they have an open row for it here AND the Job
-- is active. Exactly as before, whether the employee is active is not part
-- of the rule (deactivating an employee closes their rows instead), and a
-- Job's own active flag is applied at read time, so deactivating a Job
-- hides it without touching anyone's assignment and reactivating it brings
-- it back for the same employees.
--
-- Safe to apply before the application change is deployed: nothing below
-- alters or removes an existing table, and the old code keeps reading and
-- writing Activity Groups. The legacy group tables stay (unused by the new
-- code) as rollback evidence until a later migration drops them.

create table employee_activity_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  -- The application never hard-deletes a Job (only deactivates it), and a
  -- Job used by any time entry can't be deleted at all. Cascading keeps
  -- fixture/QA cleanup that deletes unused Jobs working, old code included.
  activity_id uuid not null references activities(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by_employee_id uuid references employees(id) on delete set null,
  unassigned_at timestamptz,
  unassigned_by_employee_id uuid references employees(id) on delete set null,
  -- How the row was created: 'direct' (Employee form), or carried over from
  -- Activity Groups by this migration's backfill / by the transition sync
  -- below while the old application is still running.
  source text not null default 'direct'
    constraint chk_employee_activity_assignments_source
      check (source in ('direct', 'activity_group_backfill', 'activity_group_sync')),
  constraint chk_employee_activity_assignments_unassigned_after_assigned
    check (unassigned_at is null or unassigned_at >= assigned_at)
);

-- One open assignment per (employee, Job); also the index for "this
-- employee's Jobs" (leading employee_id).
create unique index idx_employee_activity_assignments_open_employee_activity
  on employee_activity_assignments (employee_id, activity_id)
  where unassigned_at is null;

-- "Which employees are assigned to this Job."
create index idx_employee_activity_assignments_open_activity
  on employee_activity_assignments (activity_id, employee_id)
  where unassigned_at is null;

-- History lookups ("was this Job assigned when this offline event
-- happened?") for the phone sync path.
create index idx_employee_activity_assignments_history
  on employee_activity_assignments (employee_id, activity_id, assigned_at);

-- ---------------------------------------------------------------------------
-- Backfill: one open row per (employee, Job) reachable through an open group
-- assignment to an active group — the union across all of an employee's
-- groups, without duplicates. Jobs that are currently inactive are included
-- on purpose: they are not usable now (the active check is applied at read
-- time, same as before), but reactivating such a Job gives it back to exactly
-- the employees who would have regained it through their groups. Inactive
-- groups and closed group assignments contribute nothing, as before.
-- assigned_at is the earliest of the contributing group assignments, so an
-- offline event recorded while that access already existed still syncs.
-- ---------------------------------------------------------------------------

insert into employee_activity_assignments (employee_id, activity_id, assigned_at, assigned_by_employee_id, source)
select eaga.employee_id,
       aga.activity_id,
       min(eaga.assigned_at),
       (array_agg(eaga.assigned_by_employee_id order by eaga.assigned_at))[1],
       'activity_group_backfill'
from employee_activity_group_assignments eaga
join activity_groups ag on ag.id = eaga.activity_group_id and ag.is_active = true
join activity_group_activities aga on aga.activity_group_id = ag.id
where eaga.unassigned_at is null
group by eaga.employee_id, aga.activity_id;

-- ---------------------------------------------------------------------------
-- Transition sync. Between applying this migration and deploying the new
-- application, the old application still edits Activity Groups; these
-- triggers mirror every such edit into the direct assignments, recomputing
-- an affected employee's open rows from their groups with the same rule as
-- the backfill. The new application never writes the group tables (its
-- legacy group endpoints refuse with "refresh LabourLink"), so after the
-- deploy the triggers stay dormant. They are dropped together with the
-- group tables by a later migration.
-- ---------------------------------------------------------------------------

create function sync_employee_activity_assignments_from_groups(p_employee_id uuid)
returns void
language plpgsql
as $$
begin
  if p_employee_id is null or not exists (select 1 from employees where id = p_employee_id) then
    return;
  end if;

  update employee_activity_assignments eaa
  set unassigned_at = greatest(now(), eaa.assigned_at)
  where eaa.employee_id = p_employee_id
    and eaa.unassigned_at is null
    and not exists (
      select 1
      from employee_activity_group_assignments eaga
      join activity_groups ag on ag.id = eaga.activity_group_id and ag.is_active = true
      join activity_group_activities aga on aga.activity_group_id = ag.id
      where eaga.employee_id = p_employee_id
        and eaga.unassigned_at is null
        and aga.activity_id = eaa.activity_id
    );

  insert into employee_activity_assignments (employee_id, activity_id, assigned_by_employee_id, source)
  select distinct on (aga.activity_id) p_employee_id, aga.activity_id, eaga.assigned_by_employee_id, 'activity_group_sync'
  from employee_activity_group_assignments eaga
  join activity_groups ag on ag.id = eaga.activity_group_id and ag.is_active = true
  join activity_group_activities aga on aga.activity_group_id = ag.id
  where eaga.employee_id = p_employee_id
    and eaga.unassigned_at is null
  order by aga.activity_id, eaga.assigned_at
  on conflict (employee_id, activity_id) where unassigned_at is null do nothing;
end;
$$;

create function trg_sync_activity_assignments_from_group_assignment()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform sync_employee_activity_assignments_from_groups(old.employee_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.employee_id is distinct from old.employee_id
                                       or new.activity_group_id is distinct from old.activity_group_id
                                       or new.unassigned_at is distinct from old.unassigned_at) then
    perform sync_employee_activity_assignments_from_groups(new.employee_id);
  end if;
  return null;
end;
$$;

create function trg_sync_activity_assignments_from_group_membership()
returns trigger
language plpgsql
as $$
declare
  groups uuid[];
  emp uuid;
begin
  groups := case tg_op
    when 'INSERT' then array[new.activity_group_id]
    when 'DELETE' then array[old.activity_group_id]
    else array[old.activity_group_id, new.activity_group_id]
  end;
  for emp in
    select distinct employee_id
    from employee_activity_group_assignments
    where activity_group_id = any(groups) and unassigned_at is null
  loop
    perform sync_employee_activity_assignments_from_groups(emp);
  end loop;
  return null;
end;
$$;

create function trg_sync_activity_assignments_from_group_status()
returns trigger
language plpgsql
as $$
declare
  emp uuid;
begin
  if new.is_active is distinct from old.is_active then
    for emp in
      select distinct employee_id
      from employee_activity_group_assignments
      where activity_group_id = new.id and unassigned_at is null
    loop
      perform sync_employee_activity_assignments_from_groups(emp);
    end loop;
  end if;
  return null;
end;
$$;

create trigger sync_activity_assignments_on_group_assignment
  after insert or update or delete on employee_activity_group_assignments
  for each row execute function trg_sync_activity_assignments_from_group_assignment();

create trigger sync_activity_assignments_on_group_membership
  after insert or update or delete on activity_group_activities
  for each row execute function trg_sync_activity_assignments_from_group_membership();

create trigger sync_activity_assignments_on_group_status
  after update of is_active on activity_groups
  for each row execute function trg_sync_activity_assignments_from_group_status();

-- ---------------------------------------------------------------------------
-- Access. The API connects as the database owner, which these statements
-- don't affect. On Supabase, keep the new table and functions out of reach
-- of the public REST roles (no-ops where those roles don't exist).
-- ---------------------------------------------------------------------------

revoke all on function sync_employee_activity_assignments_from_groups(uuid) from public;
revoke all on function trg_sync_activity_assignments_from_group_assignment() from public;
revoke all on function trg_sync_activity_assignments_from_group_membership() from public;
revoke all on function trg_sync_activity_assignments_from_group_status() from public;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table employee_activity_assignments from %I', r);
      execute format('revoke all on function sync_employee_activity_assignments_from_groups(uuid) from %I', r);
    end if;
  end loop;
end;
$$;
