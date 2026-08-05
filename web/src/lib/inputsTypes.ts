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
  row: { id: string; label: string } | null;
  carrier: { id: string; name: string } | null;
  // Closed by the server-side daily-cutoff safety net (a forgotten End
  // Work carried past local midnight), not a real end-time — cleared once
  // a supervisor corrects it via the normal Inputs tools.
  autoClosed: boolean;
}

export interface BreakDto {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  name: string | null;
  isPaid: boolean | null;
  source: "manual" | "auto";
  breakProfileItemId: string | null;
  canEdit: boolean;
  // Same daily-cutoff meaning as ActivityRunDto.autoClosed above.
  autoClosed: boolean;
}

export interface DailyInputsResponse {
  employee: { id: string; firstName: string; lastName: string; photoUrl: string | null };
  date: string;
  workStartTime: string | null;
  runs: ActivityRunDto[];
  breaks: BreakDto[];
  totals: { workedSeconds: number; breakSeconds: number; paidBreakSeconds: number; unpaidBreakSeconds: number };
  canEdit: boolean;
}
