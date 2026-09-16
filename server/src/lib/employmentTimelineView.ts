// Employment Timeline redesign: the ONE place that decides, for a given
// employee + their employment periods, (a) whether they belong on the
// timeline at all and (b) how far each bar should be drawn and what it
// should be labeled. GET /api/employment-periods (employmentPeriods.ts)
// calls this once per request and ships the result straight to the client
// — the Graph, Table, CSV, PDF and Print views all read these same
// server-computed fields, so none of them can independently decide a
// different employee is "expired" or draw a bar to a different date.
//
// Source-of-truth fields, matched to what the Directory itself displays
// (see DirectoryTab.tsx): active/deactivated is employees.is_active alone
// (the Directory's status pill has no other input); "Work Start Date" is
// employees.start_date; work-permit expiry is employees.work_permit_expiry_date,
// checked with a bare `expiryDate < today` comparison — same as
// WorkPermitStatus.tsx's own client-side check — deliberately NOT
// getActiveWorkPermitAlerts()/its severity, which is gated by notification
// windows and acknowledge/cancel snoozing and therefore is NOT a reliable
// "is this actually expired" signal (an expired-but-acknowledged permit
// produces zero alerts). Expected/actual finish live only on
// employee_employment_periods (migration 050) — there is no employee-level
// equivalent.
//
// There is no dedicated "still working despite expiry" field anywhere in
// the schema. The explicit choice IS employees.is_active remaining true —
// confirmed by employmentPeriods.ts's PATCH route, which documents that
// recording an actual/expected finish deliberately never touches is_active;
// deactivation is a fully separate, explicit admin action. That gives the
// precedence this module encodes: is_active is the sole inclusion gate, and
// a recorded actual_finish_date is always absolute (never re-extended into
// "still working," regardless of is_active — an active employee whose only
// period already has a real actual_finish_date in the past just renders as
// a normal Completed bar, per product decision).

export type TimelineBarLabel = "completed" | "ongoing" | "employed" | "expiredStillWorking";

export const TIMELINE_BAR_LABEL_TEXT: Record<TimelineBarLabel, string> = {
  completed: "Completed",
  ongoing: "Ongoing",
  employed: "Employed",
  expiredStillWorking: "Expired — still working",
};

export interface TimelineBarInfo {
  // Always a concrete YYYY-MM-DD — never null. For "ongoing"/
  // "expiredStillWorking" this is `today`; callers that render bars extend
  // those two labels visually to the graph's actual right edge (which is
  // always >= today by construction — see computeFittedRange), rather than
  // stopping exactly at this value.
  effectiveEndDate: string;
  label: TimelineBarLabel;
}

// A confirmed actual_finish_date is absolute: it ends the bar there and
// labels it Completed, full stop — never overridden by expected_finish_date,
// work permit expiry, or is_active (see header comment). Otherwise, the
// applicable deadline is whichever of {expected_finish_date, work-permit
// expiry} is EARLIER (a permit expiring before the period's own expected
// finish caps real ability to work regardless of paperwork, and vice
// versa) — a period with neither set is genuinely open-ended.
export function computeTimelineBar(
  period: { startDate: string; expectedFinishDate: string | null; actualFinishDate: string | null },
  workPermitExpiryDate: string | null,
  today: string
): TimelineBarInfo {
  if (period.actualFinishDate !== null) {
    return { effectiveEndDate: period.actualFinishDate, label: "completed" };
  }

  const candidates = [period.expectedFinishDate, workPermitExpiryDate].filter((d): d is string => d !== null);
  const effectiveDeadline = candidates.length > 0 ? candidates.reduce((a, b) => (a < b ? a : b)) : null;

  if (effectiveDeadline === null) {
    return { effectiveEndDate: today, label: "ongoing" };
  }
  if (effectiveDeadline > today) {
    return { effectiveEndDate: effectiveDeadline, label: "employed" };
  }
  // effectiveDeadline <= today, no actual finish ever recorded: the
  // employee's own is_active is what this function's caller already
  // guarded on (only active employees ever reach here) — is_active
  // remaining true past this deadline IS the explicit "still working" choice.
  return { effectiveEndDate: today, label: "expiredStillWorking" };
}

export interface TimelinePeriodInput {
  id: string;
  startDate: string;
  expectedFinishDate: string | null;
  actualFinishDate: string | null;
  employmentType: string | null;
  workGroup: string | null;
  workGroupOtherDescription: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedTimelinePeriod extends TimelinePeriodInput {
  timelineEffectiveEndDate: string;
  timelineLabel: TimelineBarLabel;
  // True only for the one virtual period synthesized below (an employee
  // with zero employment_periods rows but a usable employees.start_date) —
  // there is no real employment_periods row behind it, so callers must not
  // let it be edited/deleted as if it were a real period.
  synthesized: boolean;
}

export interface TimelineEmployeeInput {
  id: string;
  isActive: boolean;
  startDate: string | null;
  workPermitExpiryDate: string | null;
}

export interface ResolvedTimelineEmployee {
  // False only for is_active === false — deactivated employees are
  // completely excluded from the graph/table/totals/exports, no exceptions.
  included: boolean;
  // False only when the employee is included but has neither a usable
  // employees.start_date NOR any employment_periods row — there is
  // genuinely nothing to draw a bar from (distinct from "expired" or
  // "deactivated"). Callers render a flagged placeholder row instead of a
  // bar for these, rather than silently dropping the employee.
  hasUsableDates: boolean;
  periods: ResolvedTimelinePeriod[];
}

// The one function that decides inclusion + how far every bar should be
// drawn + what it's labeled, for one employee. See header comment for the
// precedence this encodes.
export function resolveEmployeeTimeline(
  employee: TimelineEmployeeInput,
  periods: TimelinePeriodInput[],
  today: string
): ResolvedTimelineEmployee {
  if (!employee.isActive) {
    return { included: false, hasUsableDates: false, periods: [] };
  }

  if (periods.length === 0) {
    if (employee.startDate === null) {
      return { included: true, hasUsableDates: false, periods: [] };
    }
    const synthetic: TimelinePeriodInput = {
      id: `synthetic-${employee.id}`,
      startDate: employee.startDate,
      expectedFinishDate: null,
      actualFinishDate: null,
      employmentType: null,
      workGroup: null,
      workGroupOtherDescription: null,
      notes: null,
      createdAt: "",
      updatedAt: "",
    };
    const bar = computeTimelineBar(synthetic, employee.workPermitExpiryDate, today);
    return {
      included: true,
      hasUsableDates: true,
      periods: [{ ...synthetic, timelineEffectiveEndDate: bar.effectiveEndDate, timelineLabel: bar.label, synthesized: true }],
    };
  }

  const resolved = periods.map((p) => {
    const bar = computeTimelineBar(p, employee.workPermitExpiryDate, today);
    return { ...p, timelineEffectiveEndDate: bar.effectiveEndDate, timelineLabel: bar.label, synthesized: false };
  });
  return { included: true, hasUsableDates: true, periods: resolved };
}
