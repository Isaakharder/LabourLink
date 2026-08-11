export interface InputsEmployee {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
}

// Present on a run/break/work-start when an administrator created it
// directly from the Inputs page (POST /work-start, /activities, /breaks)
// rather than it originating from the employee's own phone — surfaced so
// the UI can show a "Manually added" badge with who/when/why.
export interface ManualEntryMeta {
  createdByEmployeeId: string;
  createdByName: string;
  creationReason: string;
}

// GET /api/inputs/employee-activities — identical shape/rules to the
// mobile app's own activity picker (server/src/lib/activitySelection.ts),
// reused as-is for the Add work start / Add activity modals.
export interface ActivityQuestionOption {
  id: string;
  questionType: "greenhouse_row" | "carrier";
  label: string;
  isRequired: boolean;
}

export interface EmployeeActivityOption {
  id: string;
  name: string;
  normalSpeed: number | null;
  speedUnit: string | null;
  questions: ActivityQuestionOption[];
}

// GET /api/inputs/greenhouse-rows
export interface GreenhouseRowOption {
  id: string;
  name: string;
  phases: {
    id: string;
    name: string;
    rows: { id: string; rowNumber: number }[];
  }[];
}

// GET /api/inputs/carriers
export interface CarrierOption {
  id: string;
  name: string;
}

// GET /api/inputs/employee-break-items — the employee's own assigned break
// profile's active scheduled items, for the Add break modal's break-type
// dropdown. null breakProfile means the employee has no active assigned
// profile (only a Custom break is offered in that case).
export interface EmployeeBreakItemOption {
  id: string;
  name: string | null;
  startTime: string;
  endTime: string;
  isPaid: boolean;
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
  // Present only when work-end rounding actually applied to this run's
  // last segment (a genuine Finish Work tap, with rounding enabled on the
  // employee's break profile at the time) — the employee's original
  // button-press timestamp, kept alongside the possibly-rounded endedAt
  // for audit purposes. Same "still set even on an exact-boundary tap that
  // rounding left unchanged" convention as workStartOriginalTime; only
  // shown when it differs from endedAt (see ActivityLogsCard).
  endedAtOriginalTime: string | null;
  isOpen: boolean;
  canEdit: boolean;
  row: { id: string; label: string } | null;
  carrier: { id: string; name: string } | null;
  // Closed by the server-side daily-cutoff safety net (a forgotten End
  // Work carried past local midnight), not a real end-time — cleared once
  // a supervisor corrects it via the normal Inputs tools.
  autoClosed: boolean;
  // Keyed by this run's own id, which is its *last* underlying segment's id
  // (see server/src/routes/inputs.ts's manualEntryMeta comment) — a run
  // made of several segments (e.g. split by a reconciled scheduled break)
  // only ever surfaces this when that last segment was itself the one
  // manually created.
  manualEntry: ManualEntryMeta | null;
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
  // Always unambiguous for a break — unlike a run, a break is never made
  // of more than one segment.
  manualEntry: ManualEntryMeta | null;
}

export interface DailyInputsResponse {
  employee: { id: string; firstName: string; lastName: string; photoUrl: string | null };
  date: string;
  workStartTime: string | null;
  // The employee's original (pre-rounding) button-press timestamp — only
  // non-null when work-start rounding was active for this entry (see
  // server/src/lib/workStartRounding.ts). Equal to workStartTime when
  // rounding happened to land exactly on a boundary; the UI only shows an
  // adjustment indicator when the two differ (see WorkdayDetailsCard).
  workStartOriginalTime: string | null;
  // Present when the work-start entry itself (not necessarily any
  // activity run built from it) was created directly from the Inputs page
  // via Add work start, rather than a phone tap.
  workStartManualEntry: ManualEntryMeta | null;
  runs: ActivityRunDto[];
  breaks: BreakDto[];
  totals: { workedSeconds: number; breakSeconds: number; paidBreakSeconds: number; unpaidBreakSeconds: number };
  canEdit: boolean;
}
