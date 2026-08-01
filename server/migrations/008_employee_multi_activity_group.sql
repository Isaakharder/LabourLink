-- Allows an employee to belong to more than one active Activity Group at
-- once. Replaces the "one active assignment per employee" partial unique
-- index from 007 with "one active assignment per (employee, group)".

drop index idx_employee_activity_group_assignments_active_per_employee;

create unique index idx_employee_activity_group_assignments_active_per_employee_group
  on employee_activity_group_assignments(employee_id, activity_group_id)
  where unassigned_at is null;
