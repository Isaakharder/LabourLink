export interface BreakProfileItem {
  id: string;
  name: string | null;
  startTime: string; // "HH:MM:SS"
  endTime: string; // "HH:MM:SS"
  isPaid: boolean;
  fixedBreak: boolean;
  autoAdd: boolean;
  fixedStartWindowMinutes: number;
  fixedEndWindowMinutes: number;
  sortOrder: number;
  durationSeconds: number;
}

export type WorkStartRoundingDirection = "clockwise" | "counter_clockwise";

export interface BreakProfile {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  workStartRoundingEnabled: boolean;
  workStartRoundingDirection: WorkStartRoundingDirection;
  workStartRoundingIntervalMinutes: number;
  items: BreakProfileItem[];
  itemCount: number;
  assignedEmployeeCount: number;
  createdAt: string;
  updatedAt: string;
}

// A scheduled break row being edited client-side.
export interface BreakProfileItemDraft {
  // For a row loaded from an existing profile, this is the real server id.
  // For a newly-added row (blankItem in BreakProfileEditor), it's a fresh
  // client-generated uuid — used both as the React list key and, on save,
  // as the row's id so the server inserts it under that same id rather
  // than minting its own (see upsertItems in breakProfiles.ts).
  id: string;
  name: string;
  startTime: string; // "HH:MM" (input value) or "" when unset
  endTime: string;
  isPaid: boolean;
  fixedBreak: boolean;
  autoAdd: boolean;
  fixedStartWindowMinutes: number;
  fixedEndWindowMinutes: number;
}
