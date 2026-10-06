-- Employee Groups: a named group an employee can belong to (at most one),
-- used to organize the employee list (Inputs sidebar, Employees > Employee
-- Groups tab). Purely organizational: nothing about time entries, activity
-- logs, speed calculations, employment periods, permissions, the free-text
-- employees.job_group, or Activity Groups reads this.
--
-- Numbered 056, not 055: 055 is reserved by the not-yet-released
-- 055_row_completion_automation.sql on another branch. The migration runner
-- applies every not-yet-applied file in name order, so the gap is harmless.
--
-- Single-tenant schema (see 043_mobile_time_events.sql): no organization
-- column. "Unique within the organization" is unique across this table,
-- and "can't use another organization's group" is the foreign key below —
-- an employee can only ever point at a group that exists here.
create table employee_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_employee_groups_name_not_blank check (length(trim(name)) > 0)
);

-- Case/whitespace-insensitive uniqueness, same pattern as activities and
-- activity_groups (007_activity_groups.sql).
create unique index employee_groups_name_normalized_key on employee_groups (lower(trim(name)));

-- Null = Ungrouped, which is where every existing employee starts.
-- on delete set null: deleting a group makes its employees Ungrouped and
-- never deletes or otherwise changes an employee.
alter table employees
  add column employee_group_id uuid references employee_groups(id) on delete set null;

create index idx_employees_employee_group on employees(employee_group_id);
