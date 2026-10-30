// Client mirror of the Employment Timeline's server-side enums and
// response shape (server/src/lib/employmentPeriods.ts and
// employmentTimelineView.ts) — this app has no shared package between
// server/ and web/ (see timezone.ts's own header comment), so small
// duplication like this is the established convention.

export const EMPLOYMENT_TYPES = ["Permanent", "Temporary", "Seasonal", "Other"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_GROUPS = ["Greenhouse", "Warehouse", "Outdoor", "Maintenance", "Management", "Other"] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];

export type EmploymentPeriodStatus = "future" | "startingSoon" | "current" | "finishingSoon" | "permitExpired" | "completed";

export const STATUS_LABELS: Record<EmploymentPeriodStatus, string> = {
  future: "Future/planned",
  startingSoon: "Starting soon",
  current: "Currently employed",
  finishingSoon: "Finishing soon",
  permitExpired: "Permit expired",
  completed: "Finished",
};

// The employment-date names used everywhere on the timeline (editor, graph
// tooltip, table, CSV, PDF, print) and on the Employee form.
export const DATE_FIELD_LABELS = {
  startDate: "Employment Start Date",
  workPermitExpiryDate: "Work Permit Expiry Date",
  endDifferentDate: "End Different Date",
  vacationStartDate: "Start Vacation",
  vacationEndDate: "End Vacation",
} as const;

// Computed server-side once (employmentTimelineView.ts) so the Graph,
// Table, CSV, PDF and Print views all read the same values.
export type TimelineBarLabel = "completed" | "ongoing" | "employed" | "permitExpired";

export const TIMELINE_BAR_LABEL_TEXT: Record<TimelineBarLabel, string> = {
  completed: "Finished",
  ongoing: "Ongoing",
  employed: "Employed",
  permitExpired: "Permit expired",
};

export type TimelineEndSource = "endDifferentDate" | "workPermitExpiry" | null;

export interface EmploymentTimelineWorkPermit {
  expiryDate: string;
  remainingDays: number | null;
  severity: string | null;
}

export interface EmploymentTimelineEmployee {
  id: string;
  firstName: string;
  lastName: string;
  nationality: string | null;
  jobGroup: string | null;
  // Employee Group (Employees > Employee Groups); null = Ungrouped.
  employeeGroup: { id: string; name: string } | null;
  isActive: boolean;
  // The three employment dates, straight from the employee record (one
  // source of truth with the Employees Directory).
  employmentStartDate: string | null;
  workPermitExpiryDate: string | null;
  endDifferentDate: string | null;
  // One planned vacation (both set or both null) — timeline planning only,
  // drawn as an orange overlay on the bar. Same employee record.
  vacationStartDate: string | null;
  vacationEndDate: string | null;
  workPermit: EmploymentTimelineWorkPermit | null;
  // From the employee's latest employment period — shown and filterable,
  // no longer edited from the timeline.
  employmentType: EmploymentType | null;
  workGroup: WorkGroup | null;
  // False when there's no Employment Start Date — rendered as a flagged
  // placeholder row rather than silently omitted.
  hasUsableDates: boolean;
  // The bar's last day (inclusive): End Different Date, else permit expiry;
  // null = ongoing (drawn to the visible range's right edge).
  timelineEndDate: string | null;
  timelineEndSource: TimelineEndSource;
  timelineLabel: TimelineBarLabel | null;
  statuses: EmploymentPeriodStatus[];
}

export interface EmploymentTimelineFilterState {
  employeeIds: string[]; // empty = All
  nationalities: string[]; // empty = All
  employeeGroupIds: string[]; // empty = All; may include the literal "Ungrouped"
  workGroups: string[]; // empty = All; may include the literal "Unspecified"
  employmentTypes: string[]; // empty = All; may include the literal "Unspecified"
  statuses: EmploymentPeriodStatus[]; // empty = All
}

export const EMPTY_FILTER_STATE: EmploymentTimelineFilterState = {
  employeeIds: [],
  nationalities: [],
  employeeGroupIds: [],
  workGroups: [],
  employmentTypes: [],
  statuses: [],
};
