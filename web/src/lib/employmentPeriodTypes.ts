// Client mirror of server/src/lib/employmentPeriods.ts's enums/status logic
// — this app has no shared package between server/ and web/ (see
// timezone.ts's own header comment), so small duplication like this is the
// established convention.

export const EMPLOYMENT_TYPES = ["Permanent", "Temporary", "Seasonal", "Other"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_GROUPS = ["Greenhouse", "Warehouse", "Outdoor", "Maintenance", "Management", "Other"] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];

export type EmploymentPeriodStatus = "future" | "startingSoon" | "current" | "finishingSoon" | "overdue" | "completed";

export const STATUS_LABELS: Record<EmploymentPeriodStatus, string> = {
  future: "Future/planned",
  startingSoon: "Starting soon",
  current: "Currently employed",
  finishingSoon: "Finishing soon",
  overdue: "Expected finish overdue",
  completed: "Completed",
};

// Employment Timeline redesign — computed server-side once, in
// server/src/lib/employmentTimelineView.ts, and shipped on every period so
// the Graph, Table, CSV, PDF and Print views all read the same values
// rather than each re-deriving inclusion/labeling and risking disagreement.
export type TimelineBarLabel = "completed" | "ongoing" | "employed" | "expiredStillWorking";

export const TIMELINE_BAR_LABEL_TEXT: Record<TimelineBarLabel, string> = {
  completed: "Completed",
  ongoing: "Ongoing",
  employed: "Employed",
  expiredStillWorking: "Expired — still working",
};

export interface EmploymentPeriod {
  id: string;
  employeeId: string;
  startDate: string;
  expectedFinishDate: string | null;
  actualFinishDate: string | null;
  employmentType: EmploymentType | null;
  workGroup: WorkGroup | null;
  workGroupOtherDescription: string | null;
  notes: string | null;
  statuses: EmploymentPeriodStatus[];
  // Always a concrete YYYY-MM-DD (never null) — see computeTimelineBar's own
  // comment for exactly how it's derived. "ongoing"/"expiredStillWorking"
  // bars are drawn to the graph's actual right edge (always >= today), not
  // literally clipped at this value.
  timelineEffectiveEndDate: string;
  timelineLabel: TimelineBarLabel;
  // True only for the one virtual period the server synthesizes for an
  // employee with zero real employment_periods rows but a usable
  // employees.start_date — there is no real period behind it, so it must
  // not be offered for edit/delete the way a real period is.
  synthesized: boolean;
  createdAt: string;
  updatedAt: string;
}

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
  isActive: boolean;
  workPermit: EmploymentTimelineWorkPermit | null;
  // False only when the employee has neither a usable employees.start_date
  // nor any employment_periods row — nothing to draw a bar from. Renders as
  // a flagged placeholder row rather than being silently omitted.
  hasUsableDates: boolean;
  periods: EmploymentPeriod[];
}

export interface EmploymentPeriodHistoryEntry {
  id: string;
  employmentPeriodId: string | null;
  changeType: "created" | "updated" | "deleted";
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  changedAt: string;
  reason: string | null;
  changedBy: string;
}

export interface EmploymentTimelineFilterState {
  employeeIds: string[]; // empty = All
  nationalities: string[]; // empty = All
  workGroups: string[]; // empty = All; may include the literal "Unspecified"
  employmentTypes: string[]; // empty = All; may include the literal "Unspecified"
  statuses: EmploymentPeriodStatus[]; // empty = All
}

export const EMPTY_FILTER_STATE: EmploymentTimelineFilterState = {
  employeeIds: [],
  nationalities: [],
  workGroups: [],
  employmentTypes: [],
  statuses: [],
};
