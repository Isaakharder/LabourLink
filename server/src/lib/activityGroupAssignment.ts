import { PoolClient } from "pg";

// Closes whatever active assignment the employee has (if any) and opens a
// new one to the given group, or just closes with no replacement when
// activityGroupId is null. Mirrors devices.ts's pairing-approve
// close-then-insert pattern; must run inside a caller-supplied transaction
// so the partial "one active assignment per employee" unique index is never
// briefly violated. Callers are responsible for confirming activityGroupId
// is a real, active group before calling this — this function trusts it.
export async function reassignEmployeeActivityGroup(
  client: PoolClient,
  employeeId: string,
  activityGroupId: string | null,
  assignedByEmployeeId: string | null
): Promise<void> {
  const current = await client.query(
    `select activity_group_id from employee_activity_group_assignments
     where employee_id = $1 and unassigned_at is null`,
    [employeeId]
  );
  const currentGroupId: string | null = current.rows[0]?.activity_group_id ?? null;

  // Already in the target state — avoid a churny extra history row for a
  // no-op "reassignment."
  if (currentGroupId === activityGroupId) return;

  await client.query(
    `update employee_activity_group_assignments set unassigned_at = now()
     where employee_id = $1 and unassigned_at is null`,
    [employeeId]
  );

  if (activityGroupId) {
    await client.query(
      `insert into employee_activity_group_assignments
         (employee_id, activity_group_id, assigned_by_employee_id)
       values ($1, $2, $3)`,
      [employeeId, activityGroupId, assignedByEmployeeId]
    );
  }
}
