// DTOs for the Inputs bulk speed review — server/src/lib/speedReviewGroups.ts
// (GET /api/row-completions/review-groups) and POST
// /api/row-completions/bulk-review.

export type SpeedReviewAction = "merge" | "separate";
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
  // All of this employee's pending visits to this row in this 7-day cycle,
  // on any day — what an action applies to.
  visits: SpeedReviewVisit[];
  // Other employees' visits in the same 7-day row cycle: shown for context
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
}

export interface BulkReviewResult {
  groupId: string;
  ok: boolean;
  error?: string;
  completionIds?: string[];
}
