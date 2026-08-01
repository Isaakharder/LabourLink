export interface InputsEmployee {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
}

export interface ActivityRunDto {
  id: string;
  activityId: string;
  activityName: string;
  normalSpeedPerHour: { value: number; unit: string | null } | null;
  durationSeconds: number;
  startedAt: string;
  currentSegmentStartedAt: string;
  endedAt: string | null;
  isOpen: boolean;
  canEdit: boolean;
}

export interface BreakDto {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
}

export interface DailyInputsResponse {
  employee: { id: string; firstName: string; lastName: string; photoUrl: string | null };
  date: string;
  workStartTime: string | null;
  runs: ActivityRunDto[];
  breaks: BreakDto[];
  totals: { workedSeconds: number; breakSeconds: number };
  canEdit: boolean;
}
