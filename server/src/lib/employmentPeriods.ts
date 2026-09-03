// Employment Timeline: pure status math, plus the audit-write helper every
// mutation route shares. See 050_employment_timeline.sql for the schema and
// design rationale (overlap prevention is a real DB EXCLUDE constraint, not
// application-layer hope; a period's "current status" is always computed
// on read, never a stored column — same "computed, never stored" convention
// workPermits.ts's getActiveWorkPermitAlerts already uses).
//
// Every date here is a plain YYYY-MM-DD string, matching
// employee_employment_periods' own `date` columns — never a Date object,
// never a timezone conversion. "Today" is always the caller's own
// calendarDateInAppTimezone(new Date()) reading, passed in rather than
// computed inside these functions, so every function here is a pure,
// directly testable function of its string inputs.
import { Pool, PoolClient } from "pg";
import { addDaysToDateStr } from "./timezone";

export const EMPLOYMENT_TYPES = ["Permanent", "Temporary", "Seasonal", "Other"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_GROUPS = ["Greenhouse", "Warehouse", "Outdoor", "Maintenance", "Management", "Other"] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];

// v1 default — not user-configurable yet, same "named constant, not a
// setting" choice this codebase already makes elsewhere for a first cut
// (e.g. ACKNOWLEDGE_SNOOZE_DAYS in workPermits.ts).
export const STARTING_SOON_WINDOW_DAYS = 14;
export const FINISHING_SOON_WINDOW_DAYS = 14;

export type EmploymentPeriodStatus = "future" | "startingSoon" | "current" | "finishingSoon" | "overdue" | "completed";

export interface EmploymentPeriodDates {
  startDate: string;
  expectedFinishDate: string | null;
  actualFinishDate: string | null;
}

// Returns every status tag that applies to this period as of `today` — a
// period can carry more than one simultaneously (e.g. "current" AND
// "overdue": still working, past the expected finish, no actual finish
// recorded yet). Pure function of its string inputs, unit-testable with no
// database.
export function computePeriodStatuses(p: EmploymentPeriodDates, today: string): EmploymentPeriodStatus[] {
  const statuses: EmploymentPeriodStatus[] = [];

  if (p.startDate > today) {
    statuses.push("future");
    if (p.startDate <= addDaysToDateStr(today, STARTING_SOON_WINDOW_DAYS)) statuses.push("startingSoon");
    return statuses; // hasn't started yet: no other status applies
  }

  const stillOpen = p.actualFinishDate === null || p.actualFinishDate >= today;
  if (stillOpen) {
    statuses.push("current");
    if (p.expectedFinishDate && p.actualFinishDate === null) {
      if (p.expectedFinishDate < today) statuses.push("overdue");
      else if (p.expectedFinishDate <= addDaysToDateStr(today, FINISHING_SOON_WINDOW_DAYS)) statuses.push("finishingSoon");
    }
  }

  if (p.actualFinishDate !== null && p.actualFinishDate <= today) statuses.push("completed");

  return statuses;
}

export type EmploymentPeriodChangeType = "created" | "updated" | "deleted";

// Shared audit-write helper — called from every mutation route (create,
// update, delete), same "one shared function so history can never drift
// between entry points" pattern as workPermits.ts's recordWorkPermitHistory.
// oldValue/newValue are full row snapshots (or null), stored as jsonb — a
// single edit can touch several columns at once (e.g. "record an actual
// finish" may set actual_finish_date and notes together), unlike
// time_entry_corrections' single old_value/new_value text pair.
export async function recordEmploymentPeriodHistory(
  client: Pool | PoolClient,
  params: {
    employmentPeriodId: string | null;
    employeeId: string;
    changeType: EmploymentPeriodChangeType;
    oldValue: Record<string, unknown> | null;
    newValue: Record<string, unknown> | null;
    changedByEmployeeId: string;
    reason: string | null;
  }
): Promise<void> {
  await client.query(
    `insert into employee_employment_period_history
       (employment_period_id, employee_id, change_type, old_value, new_value, changed_by_employee_id, reason)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.employmentPeriodId,
      params.employeeId,
      params.changeType,
      params.oldValue ? JSON.stringify(params.oldValue) : null,
      params.newValue ? JSON.stringify(params.newValue) : null,
      params.changedByEmployeeId,
      params.reason,
    ]
  );
}

// Postgres exclusion_violation — raised by excl_employment_periods_no_overlap
// (050_employment_timeline.sql) when an insert/update would overlap another
// period for the same employee. The one place that DB constraint surfaces
// to the API layer as a clean, friendly error rather than a raw 500.
export const OVERLAP_VIOLATION_CODE = "23P01";

export function isOverlapViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === OVERLAP_VIOLATION_CODE;
}
