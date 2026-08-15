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
// Generic alias — the same two directions apply identically to work-end
// rounding (see BreakProfile.workEndRoundingDirection below); this is the
// clearer name to reach for at a call site that isn't specifically about
// work-start, matching the server's own RoundingDirection naming
// (server/src/lib/workStartRounding.ts).
export type RoundingDirection = WorkStartRoundingDirection;

export interface BreakProfile {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  workStartRoundingEnabled: boolean;
  workStartRoundingDirection: WorkStartRoundingDirection;
  workStartRoundingIntervalMinutes: number;
  // Independent of the work-start settings above — its own enabled/
  // direction/interval, never coupled (see BreakProfileEditor).
  workEndRoundingEnabled: boolean;
  workEndRoundingDirection: RoundingDirection;
  workEndRoundingIntervalMinutes: number;
  // Independent of both work-start and work-end rounding above — a single
  // group of settings applied to BOTH the start and end of a break, unlike
  // work-start/work-end which are two separate settings for two separate
  // moments (see BreakProfileEditor).
  breakRoundingEnabled: boolean;
  breakRoundingDirection: RoundingDirection;
  breakRoundingIntervalMinutes: number;
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
