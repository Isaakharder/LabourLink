// DTOs for /api/row-completions — server/src/routes/rowCompletions.ts.

export interface RowCompletionCandidateRun {
  runId: string;
  segmentIds: string[];
  employeeId: string;
  employeeName: string;
  activityId: string;
  activityName: string;
  greenhouseRowId: string;
  rowLabel: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
}

export interface RowCompletionSummary {
  id: string;
  greenhouseRowId: string;
  activityId: string;
  densityType: "plants" | "stems";
  quantityPerRow: number;
  completedAt: string;
  segmentCount: number;
}
