export type QuestionType = "greenhouse_row" | "carrier";

// Every question type this app currently supports, in the order offered to
// an admin adding a new question — not hardcoded to one entry; a third type
// added later just needs an entry here plus in the two label maps below.
export const QUESTION_TYPES: QuestionType[] = ["greenhouse_row", "carrier"];

// Human-readable type name — surfaced in the question type <select> and
// wherever a question's type needs a label distinct from its own
// (admin-editable) display label.
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  greenhouse_row: "Greenhouse Row",
  carrier: "Carrier",
};

// Seeded into a question's label the moment its type is chosen (on Add, or
// on switching an existing row's type) — still a plain editable text field
// after that, never locked to this value.
export const QUESTION_TYPE_DEFAULT_LABEL: Record<QuestionType, string> = {
  greenhouse_row: "Where?",
  carrier: "Which Carrier?",
};

export interface ActivityQuestion {
  id: string;
  questionType: QuestionType;
  label: string;
  isRequired: boolean;
  sortOrder: number;
}

// Client-side editing shape used by QuestionsEditor — `key` is a stable
// React key that survives reordering (id is null for a not-yet-saved
// question, so it can't serve as the key on its own); `id`/questionType/
// label/isRequired map 1:1 to ActivityQuestion and to the server's
// QuestionInput shape (server/src/routes/activities.ts).
export interface ActivityQuestionDraft {
  key: string;
  id: string | null;
  questionType: QuestionType;
  label: string;
  isRequired: boolean;
}

export type DensitySource = "plants" | "stems";

// Every density source this app currently supports, in the order offered in
// the Density source <select> — "None" (empty value) is handled separately
// by the form, not listed here.
export const DENSITY_SOURCES: DensitySource[] = ["plants", "stems"];

export const DENSITY_SOURCE_LABELS: Record<DensitySource, string> = {
  plants: "Plants",
  stems: "Stems",
};

// A density-driven activity's speed unit is always derived from its density
// source — never independently editable — so the two fields can never
// disagree (mirrors server/src/routes/activities.ts's DENSITY_SPEED_UNIT,
// which enforces the same mapping server-side).
export const DENSITY_SOURCE_SPEED_UNIT: Record<DensitySource, string> = {
  plants: "plants/hour",
  stems: "stems/hour",
};

export interface Activity {
  id: string;
  name: string;
  normalSpeed: number | null;
  speedUnit: string | null;
  minimumDurationMinutes: number;
  isActive: boolean;
  // Which row density (see plantDensityTypes.ts) this activity's calculated
  // speed on Inputs is driven by — null means no calculated speed, only the
  // configured normalSpeed above.
  densitySource: DensitySource | null;
  assignedGroupCount: number;
  updatedAt: string;
  // Ordered by sortOrder — zero, one, or many. Replaces v1's single
  // `question: ActivityQuestion | null` field.
  questions: ActivityQuestion[];
}

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
