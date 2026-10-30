import { Request, Response } from "express";

// Activity Groups were replaced by direct employee → Job assignments
// (migration 067, lib/employeeActivityAssignments.ts). A desktop tab still
// running the previous version of LabourLink can still call the old group
// endpoints; every one of them now answers 410 with this message instead of
// changing anything, so a stale page can never create access that disagrees
// with the employees' assigned Jobs. The legacy tables are kept, unused,
// until the new release has been proven (see migration 067).
export const ACTIVITY_GROUPS_REMOVED_MESSAGE =
  "Activity Groups have been replaced by Jobs on each employee's form. Refresh LabourLink to continue.";

export function activityGroupsRemoved(_req: Request, res: Response) {
  res.status(410).json({ error: ACTIVITY_GROUPS_REMOVED_MESSAGE, code: "activity_groups_removed" });
}
