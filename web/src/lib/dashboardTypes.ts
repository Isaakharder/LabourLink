// Mirrors server/src/routes/dashboard.ts's GET /cards and GET/PUT /settings
// response shapes exactly — see that file for how each figure is computed
// (ratio-of-sums via aggregateDensitySpeed, block progress via
// dashboardBlockProgress.ts, bin attribution via
// carrierCompletionAttribution.ts). The frontend never recomputes any of
// these numbers itself, only renders them.

export type DashboardCardType = "row_stem" | "picking";

export interface DashboardCardBase {
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  photoUrl: string | null;
  activityId: string;
  activityName: string;
  runStartedAt: string; // ISO — start of the current run, not just the open segment
}

export type BlockStatus = "in_progress" | "complete" | "no_rows_linked" | "missing_density" | "not_enough_data";

export interface DashboardBlockInfo {
  id: string;
  name: string;
  totalRows: number;
  completedRows: number;
  remainingStems: number | null;
  rowsMissingDensity: number;
  projectedHoursRemaining: number | null;
  status: BlockStatus;
}

export interface RowStemDashboardCard extends DashboardCardBase {
  cardType: "row_stem";
  densityType: "plants" | "stems";
  rowLabel: string | null;
  weeklySpeed: number | null; // null below the minimum-duration floor — "not enough data"
  block: DashboardBlockInfo | null; // null = no block assigned
}

export interface PickingDashboardCard extends DashboardCardBase {
  cardType: "picking";
  carrierName: string | null;
  weeklySpeed: number | null; // bins/hour
  binsCompletedThisWeek: number;
  rowsWorkedThisWeek: number; // distinct rows touched this week — NOT a formal completion, unrelated to binsCompletedThisWeek
}

export type DashboardCard = RowStemDashboardCard | PickingDashboardCard;

export interface GetDashboardCardsResponse {
  weekStart: string;
  weekEnd: string;
  cards: DashboardCard[];
}

export interface DashboardSettingsActivity {
  activityId: string;
  activityName: string;
  isActive: boolean;
  densitySource: "plants" | "stems" | null;
  cardType: DashboardCardType;
  selected: boolean;
}

export interface GetDashboardSettingsResponse {
  activities: DashboardSettingsActivity[];
}
