// Direct employee → Job assignments (employee_activity_assignments, migration
// 067), which replaced Activity Groups. "Jobs" in the interface are
// `activities` here. An employee may use a Job while they have an open row
// for it (unassigned_at is null) AND the Job is active — see
// lib/activitySelection.ts, which applies that rule everywhere a Job is
// offered or accepted.
//
// Rows are closed, never deleted, so who assigned/removed a Job and when is
// kept, and the phone sync path can tell whether a Job was assigned at the
// moment an offline event happened.
import { PoolClient } from "pg";
import { lockEmployeeForManualEntry } from "./manualTimeEntries";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shape check only (array of UUIDs, deduped). Existence and active status
// are checked inside the saving transaction (setEmployeeActivityAssignments)
// so a Job deactivated a moment earlier can't slip in.
export function parseActivityIds(raw: unknown): { activityIds: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "activityIds must be a list" };
  if (!raw.every((id) => typeof id === "string" && UUID_RE.test(id))) {
    return { error: "One or more selected Jobs are invalid" };
  }
  return { activityIds: [...new Set(raw as string[])] };
}

export class ActivityAssignmentError extends Error {}

export interface ActivityAssignmentChange {
  added: string[];
  removed: string[];
}

// Makes the employee's open assignments to ACTIVE Jobs exactly
// `activityIds` (an empty list means no Jobs, never "all Jobs"). Assignments
// to inactive Jobs are left as they are: they can't be added or chosen, but
// are kept so reactivating the Job gives it back. Must run inside the
// caller's transaction; takes the same per-employee advisory lock as every
// time-entry write, so it's serialized with concurrent edits of the same
// employee and with the employee's own work events. Throws
// ActivityAssignmentError (roll back, answer 400) for an unknown or inactive
// Job.
export async function setEmployeeActivityAssignments(
  client: PoolClient,
  employeeId: string,
  activityIds: string[],
  actorEmployeeId: string | null
): Promise<ActivityAssignmentChange> {
  await lockEmployeeForManualEntry(client, employeeId);

  if (activityIds.length) {
    // FOR SHARE: a concurrent deactivation of one of these Jobs waits for
    // this save instead of racing it.
    const { rows } = await client.query<{ id: string; name: string; is_active: boolean }>(
      "select id, name, is_active from activities where id = any($1::uuid[]) for share",
      [activityIds]
    );
    if (rows.length !== activityIds.length) {
      throw new ActivityAssignmentError("One or more selected Jobs no longer exist. Refresh and try again.");
    }
    const inactive = rows.filter((r) => !r.is_active).map((r) => r.name);
    if (inactive.length) {
      throw new ActivityAssignmentError(
        `${inactive.join(", ")} ${inactive.length === 1 ? "is" : "are"} inactive and can't be assigned. Refresh and try again.`
      );
    }
  }

  const { rows: current } = await client.query<{ activity_id: string }>(
    `select eaa.activity_id
     from employee_activity_assignments eaa
     join activities a on a.id = eaa.activity_id and a.is_active = true
     where eaa.employee_id = $1 and eaa.unassigned_at is null`,
    [employeeId]
  );
  const currentIds = new Set(current.map((r) => r.activity_id));
  const desired = new Set(activityIds);
  const removed = [...currentIds].filter((id) => !desired.has(id));
  const added = activityIds.filter((id) => !currentIds.has(id));

  if (removed.length) {
    await client.query(
      `update employee_activity_assignments
       set unassigned_at = greatest(now(), assigned_at), unassigned_by_employee_id = $3
       where employee_id = $1 and activity_id = any($2::uuid[]) and unassigned_at is null`,
      [employeeId, removed, actorEmployeeId]
    );
  }
  if (added.length) {
    await client.query(
      `insert into employee_activity_assignments (employee_id, activity_id, assigned_by_employee_id, source)
       select $1, unnest($2::uuid[]), $3, 'direct'
       on conflict (employee_id, activity_id) where unassigned_at is null do nothing`,
      [employeeId, added, actorEmployeeId]
    );
  }
  return { added, removed };
}

// Deactivating an employee ends every assignment (active and inactive Jobs
// alike), the same way it used to end their Activity Group assignments, so a
// reactivated employee starts with no Jobs until someone assigns them.
export async function closeAllEmployeeActivityAssignments(
  client: PoolClient,
  employeeId: string,
  actorEmployeeId: string | null
): Promise<void> {
  await client.query(
    `update employee_activity_assignments
     set unassigned_at = greatest(now(), assigned_at), unassigned_by_employee_id = $2
     where employee_id = $1 and unassigned_at is null`,
    [employeeId, actorEmployeeId]
  );
}
