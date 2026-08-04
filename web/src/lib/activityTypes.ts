export interface ActivityQuestion {
  type: "greenhouse_row";
  label: string;
  isRequired: boolean;
}

export interface Activity {
  id: string;
  name: string;
  normalSpeed: number | null;
  speedUnit: string | null;
  minimumDurationMinutes: number;
  isActive: boolean;
  assignedGroupCount: number;
  updatedAt: string;
  question: ActivityQuestion | null;
}

// Only question type v1 supports — surfaced wherever a human-readable
// question-type name is shown (Activities table summary, question config
// modal). A second type, when it exists, gets its own label here too.
export const QUESTION_TYPE_LABELS: Record<ActivityQuestion["type"], string> = {
  greenhouse_row: "Greenhouse Row",
};

export interface ActivityGroupMember {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ActivityGroupEmployee {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ActivityGroup {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  activities: ActivityGroupMember[];
  activityCount: number;
  assignedEmployeeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityGroupDetail extends ActivityGroup {
  assignedEmployees: ActivityGroupEmployee[];
}

// Suggestions only — the field is free text so activities using a unit not
// listed here are still valid.
export const SPEED_UNIT_SUGGESTIONS = [
  "kg/hour",
  "rows/hour",
  "plants/hour",
  "boxes/hour",
  "units/hour",
] as const;
