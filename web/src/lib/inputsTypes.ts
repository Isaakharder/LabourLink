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
  // Which row density this activity is configured to use (see
  // server/src/routes/activities.ts's densitySource) — null for activities
  // with no density source, in which case calculatedSpeedPerHour is always
  // null too and normalSpeedPerHour is what should be displayed, unchanged.
  activityDensitySource: "plants" | "stems" | null;
  // Combined speed for this employee+activity+date (quantity summed across
  // every density-eligible run that day, divided by their combined
  // duration) — the same value appears on every run row for that activity
  // today. Null when there's no density source, no run that day resolved a
  // density, total duration was zero, OR the row's completion status is
  // still unresolved (see isUnresolvedRowCompletion below) — a run that
  // hasn't been confirmed never silently counts.
  calculatedSpeedPerHour: { value: number; unit: string | null } | null;
  // True when this run's physical row has 2+ not-yet-completed runs
  // sharing the same greenhouse row + density type (see
  // 026_row_completions.sql) and needs an admin to review and combine them
  // via RowCompletionReviewModal before any speed can be shown for it.
  isUnresolvedRowCompletion: boolean;
  // Present once this run's segments have been confirmed as (part of) one
  // completed physical row — null while unresolved or while the row is a
  // simple unambiguous single-visit (auto-counted, no completion record
  // needed at all).
  rowCompletion: { id: string; quantityPerRow: number; segmentCount: number } | null;
  // Every underlying time_entries id this run is made of (a run can be
  // more than one raw segment, e.g. split by a reconciled scheduled break)
  // — sent so the review modal can pre-select today's own segment(s) when
  // opened from this run's warning.
  segmentIds: string[];
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
