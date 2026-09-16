// Employment Timeline's "Timeline starts" org-level setting — the
// Administrator-configurable display cutoff for the Fit-all graph. Same
// org_settings singleton pattern as getOrgSettings/setLongOpenShiftAlertThresholdHours
// in longOpenShiftAlerts.ts (049_midnight_rollover.sql: `id boolean primary
// key default true`, exactly one row by construction, read fresh on every
// call — no caching). Kept in its own module rather than folded into
// longOpenShiftAlerts.ts's OrgSettings type: unrelated concern, own file.
//
// This is a DISPLAY-ONLY value (053_employment_timeline_display_start.sql).
// It is never read by, and never affects, computeTimelineBar/
// resolveEmployeeTimeline (employmentTimelineView.ts) — inclusion and each
// bar's true dates are computed exactly as before. The client alone decides
// how much of that data to actually show, clipping a bar that starts before
// this date with a continuation indicator rather than hiding it.
import { pool } from "../db";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDisplayStartDate(v: unknown): v is string | null {
  if (v === null) return true; // null = clear the override, fall back to earliest employee start
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// Null means "no saved cutoff" — the caller (GET /api/employment-periods)
// falls back to the earliest real employee start date, computed live, same
// as before this setting existed.
export async function getEmploymentTimelineDisplayStart(): Promise<string | null> {
  const { rows } = await pool.query<{ employment_timeline_display_start: string | null }>(
    `select to_char(employment_timeline_display_start, 'YYYY-MM-DD') as employment_timeline_display_start
     from org_settings where id = true`
  );
  return rows[0]?.employment_timeline_display_start ?? null;
}

export async function setEmploymentTimelineDisplayStart(displayStart: string | null, updatedByEmployeeId: string): Promise<void> {
  await pool.query(
    `update org_settings set employment_timeline_display_start = $1, updated_at = now(), updated_by_employee_id = $2
     where id = true`,
    [displayStart, updatedByEmployeeId]
  );
}
