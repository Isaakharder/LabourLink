// DTOs for the Inputs bulk speed review — server/src/lib/speedReviewGroups.ts
// (GET /api/row-completions/review-groups) and POST
// /api/row-completions/bulk-review.

export type SpeedReviewAction = "merge" | "separate";

// Fallback for a response without windowDays (the Row review window's
// default — Setup > Row Review).
export const DEFAULT_ROW_REVIEW_WINDOW_DAYS = 7;
export type SpeedReviewChoice = SpeedReviewAction | "skip";

export interface SpeedReviewVisit {
  visitId: string;
  segmentIds: string[];
  employeeId: string;
  employeeName: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  // Work time only — breaks are never part of a visit.
  durationSeconds: number;
  isOpen: boolean;
  carriers: string[];
  quantityPerRow: number | null;
}

export interface SpeedPreview {
  quantity: number;
  durationSeconds: number;
  speedPerHour: number | null;
}

export interface SpeedReviewGroup {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  activityId: string;
  activityName: string;
  greenhouseRowId: string;
  rowLabel: string;
  densityType: "plants" | "stems";
  unit: string;
  // Every date this card's visits touch; 2+ = the card spans days.
  spansDates: string[];
  reasons: string[];
  // All of this employee's pending visits to this row in this review cycle,
  // on any day — what an action applies to.
  visits: SpeedReviewVisit[];
  // Other employees' visits in the same review cycle: shown for context
  // only, never changed by this group's action.
  contextVisits: SpeedReviewVisit[];
  actions: {
    merge: { available: boolean; unavailableReason: string | null; preview: SpeedPreview | null };
    separate: {
      available: boolean;
      unavailableReason: string | null;
      previews: (SpeedPreview & { visitId: string })[] | null;
    };
  };
  suggestedAction: SpeedReviewAction | null;
}

export interface SpeedReviewGroupsResponse {
  date: string;
  groups: SpeedReviewGroup[];
  // The Row review window (calendar days) these groups were cut at.
  windowDays?: number;
}

export interface BulkReviewResult {
  groupId: string;
  ok: boolean;
  error?: string;
  completionIds?: string[];
  // Already completed exactly this way before this request (a retry).
  alreadySaved?: boolean;
  // Failure responses only: why this group blocked the batch.
  status?: "ready" | "alreadySaved" | "stale" | "invalid";
}

// POST /api/row-completions/bulk-review. All or nothing: `saved` says
// whether this request saved the batch. A refusal (409/400/500) carries the
// same shape in ApiError.body with saved: false.
export interface BulkReviewResponse {
  saved: boolean;
  results: BulkReviewResult[];
}
