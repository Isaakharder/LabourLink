import { Pool, PoolClient } from "pg";

// Idempotently opens an active (employee, group) assignment — a second call
// for a pair that's already open is a no-op via ON CONFLICT against the
// partial unique index on (employee_id, activity_group_id) where
// unassigned_at is null, so no separate check-then-insert race is possible.
// Callers are responsible for confirming activityGroupId is a real, active
// group and employeeId a real employee before calling this — this function
// trusts it.
export async function addEmployeeToActivityGroup(
  client: Pool | PoolClient,
  employeeId: string,
  activityGroupId: string,
  assignedByEmployeeId: string | null
): Promise<void> {
  await client.query(
    `insert into employee_activity_group_assignments
       (employee_id, activity_group_id, assigned_by_employee_id)
     values ($1, $2, $3)
     on conflict (employee_id, activity_group_id) where unassigned_at is null do nothing`,
    [employeeId, activityGroupId, assignedByEmployeeId]
  );
}

// Idempotently closes whatever open assignment exists for this (employee,
// group) pair. A second call once it's already closed (or never existed) is
// a no-op.
export async function removeEmployeeFromActivityGroup(
  client: Pool | PoolClient,
  employeeId: string,
  activityGroupId: string
): Promise<void> {
  await client.query(
    `update employee_activity_group_assignments set unassigned_at = now()
     where employee_id = $1 and activity_group_id = $2 and unassigned_at is null`,
    [employeeId, activityGroupId]
  );
}
