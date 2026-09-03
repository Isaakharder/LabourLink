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
