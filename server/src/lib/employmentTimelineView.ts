// Employment Timeline: the ONE place that decides, for an employee, whether
// they belong on the timeline and where their bar ends and what it's
// labeled. GET /api/employment-periods (routes/employmentPeriods.ts) calls
// this once per employee and ships the result to the client — the Graph,
// Table, CSV, PDF and Print views all read these same server-computed
// fields, so none of them can decide a different end date on its own.
//
// One source of truth: every date comes from the employee record the
// Employees Directory shows and edits (migration 068) —
//   Employment Start Date   = employees.start_date
//   Work Permit Expiry Date = employees.work_permit_expiry_date
//   End Different Date      = employees.employment_end_date (optional)
// The bar starts on the Employment Start Date and ends on the End Different
// Date when one is entered, otherwise on the Work Permit Expiry Date,
// otherwise it is ongoing (drawn through the visible range). End Different
// Date never changes the permit expiry.
//
// Inclusion is employees.is_active alone, as before: deactivated employees
// are left off the graph, table, totals and every export. Recording an End
// Different Date never deactivates anyone (a separate, explicit action).

export type TimelineBarLabel = "completed" | "ongoing" | "employed" | "permitExpired";

export const TIMELINE_BAR_LABEL_TEXT: Record<TimelineBarLabel, string> = {
  completed: "Finished",
  ongoing: "Ongoing",
  employed: "Employed",
  permitExpired: "Permit expired",
};

// Which date ended the bar: the explicit End Different Date, the permit
// expiry, or nothing (ongoing).
export type TimelineEndSource = "endDifferentDate" | "workPermitExpiry" | null;

export interface TimelineDates {
  startDate: string | null;
  workPermitExpiryDate: string | null;
  endDifferentDate: string | null;
}

export interface TimelineBarInfo {
  // The bar's last day (inclusive), or null for an ongoing bar, which the
  // client draws to the visible range's right edge.
  endDate: string | null;
  endSource: TimelineEndSource;
  label: TimelineBarLabel;
}

// End Different Date wins over the permit expiry; with neither the bar is
// ongoing. A finished bar is one whose End Different Date has arrived (the
// last day worked is today or earlier); a permit expiry in the past with no
// End Different Date is "Permit expired" — the bar still ends on the expiry.
export function computeTimelineBar(dates: Omit<TimelineDates, "startDate">, today: string): TimelineBarInfo {
  if (dates.endDifferentDate !== null) {
    return {
      endDate: dates.endDifferentDate,
      endSource: "endDifferentDate",
      label: dates.endDifferentDate <= today ? "completed" : "employed",
    };
  }
  if (dates.workPermitExpiryDate !== null) {
    return {
      endDate: dates.workPermitExpiryDate,
      endSource: "workPermitExpiry",
      label: dates.workPermitExpiryDate < today ? "permitExpired" : "employed",
    };
  }
  return { endDate: null, endSource: null, label: "ongoing" };
}

export interface ResolvedTimelineEmployee {
  // False only for is_active === false — deactivated employees are
  // completely excluded from the graph/table/totals/exports.
  included: boolean;
  // False when the employee is included but has no Employment Start Date —
  // nothing to draw a bar from. Callers render a flagged placeholder row
  // instead of silently dropping the employee.
  hasUsableDates: boolean;
  bar: TimelineBarInfo | null;
}

export function resolveEmployeeTimeline(employee: { isActive: boolean } & TimelineDates, today: string): ResolvedTimelineEmployee {
  if (!employee.isActive) return { included: false, hasUsableDates: false, bar: null };
  if (employee.startDate === null) return { included: true, hasUsableDates: false, bar: null };
  return { included: true, hasUsableDates: true, bar: computeTimelineBar(employee, today) };
}
