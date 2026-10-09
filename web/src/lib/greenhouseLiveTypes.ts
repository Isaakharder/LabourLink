// DTOs for GET /api/greenhouse/live — server/src/routes/greenhouseLive.ts.
// Live row state is derived server-side from time_entries, never stored;
// see that route's LIVE_LAND_SELECT comment for the blue/green/neutral rules.

import { RotationDegrees } from "./canvasTransform";

export interface LiveEmployee {
  id: string;
  firstName: string;
  lastName: string;
  // Present when this employee is currently working the row (blue state).
  activityName?: string;
  startedAt?: string;
  // Signed Supabase Storage URL (short-lived), present only alongside the
  // blue/currently-working fields above — see attachEmployeePhotoUrls in
  // server/src/lib/greenhouseLiveState.ts. null/undefined uses Avatar's
  // existing initials fallback, same as everywhere else in the app.
  photoUrl?: string | null;
  // Present when this is the employee's most recent completed segment on
  // the row for the viewed date (green state).
  endedAt?: string;
  // Present when the activity's carrier question was answered for this segment.
  carrierName?: string;
}

export type LiveRowState = "blue" | "green" | "neutral";

export interface LiveRow {
  id: string;
  rowNumber: number;
  xFt: number;
  yFt: number;
  widthFt: number;
  lengthFt: number;
  orientation: "horizontal" | "vertical";
  state: LiveRowState;
  employees: LiveEmployee[];
  // The Employee Block this row is currently linked to, if any (at most
  // one — see server/src/lib/greenhouseLiveState.ts). Only ever applied as
  // a colour override when state is still "neutral" — GreenhouseLiveCanvas
  // never lets a block colour override blue/green.
  blockId: string | null;
}

// One entry per Employee Block with at least one currently-active row on
// the viewed land — server/src/lib/greenhouseLiveState.ts's
// getBlockSummariesForLand, fetched once per page load alongside the land
// itself (see LiveGreenhouseResponse.blocks / GreenhouseDisplayStateResponse.blocks
// below), never one request per block.
export interface LiveBlockSummary {
  id: string;
  name: string;
  employeeId: string | null;
  // Split rather than a single combined display string so the TV route's
  // server-side redaction (full name -> "First L.") is visible in the type
  // itself, same convention as LiveEmployee's firstName/lastName above.
  employeeFirstName: string | null;
  employeeLastName: string | null;
  colorKey: string;
  totalRows: number;
  completedRows: number;
}

export interface LivePhase {
  id: string;
  name: string;
  description: string | null;
  northSouthFeet: number;
  eastWestFeet: number;
  xFeetFromWest: number;
  yFeetFromNorth: number;
  isActive: boolean;
  sortOrder: number | null;
  rows: LiveRow[];
}

export interface LiveLand {
  id: string;
  name: string;
  northSouthFeet: number;
  eastWestFeet: number;
  isActive: boolean;
  phases: LivePhase[];
}

export interface LiveGreenhouseResponse {
  // Present only when dateStart === dateEnd — kept for minimal churn;
  // dateStart/dateEnd are always present and are what the office page
  // renders its range label from.
  date: string | null;
  dateStart: string;
  dateEnd: string;
  activityId: string | null;
  generatedAt: string;
  land: LiveLand;
  blocks: LiveBlockSummary[];
}

export interface AvailableActivity {
  id: string;
  name: string;
}

export interface GreenhouseDisplaySummary {
  id: string;
  name: string;
  landId: string;
  landName: string;
  activityId: string | null;
  activityName: string | null;
  dateStart: string;
  dateEnd: string;
  isActive: boolean;
  updatedAt: string;
  rotationDegrees: RotationDegrees;
  // Relative map date preset (server/migrations/059_display_slideshow.sql);
  // null = fixed dates. effectiveDate* is what the TV shows today.
  datePreset: MapDatePreset | null;
  effectiveDateStart: string;
  effectiveDateEnd: string;
  reportWeek: ReportWeek;
  reportIncludeToday: boolean;
  mapSlideSeconds: number;
  // The display's current raw TV token, or null when either (a) this
  // display predates the token being stored retrievably and hasn't been
  // regenerated since, or (b) the current user isn't an Administrator (the
  // server omits it entirely for anyone else — see serializeDisplay in
  // routes/greenhouseDisplays.ts). Build a full URL from this via
  // tvUrlFor(); never render/copy the bare token on its own.
  tvToken: string | null;
}

export interface GreenhouseDisplayCreateResponse {
  display: GreenhouseDisplaySummary;
  token: string;
}

export interface GreenhouseDisplayRegenerateResponse {
  token: string;
}

export const MAP_DATE_PRESETS = ["today", "yesterday", "thisWeek", "lastWeek", "last7", "thisMonth", "lastMonth"] as const;
export type MapDatePreset = (typeof MAP_DATE_PRESETS)[number];
export type ReportWeek = "this_week" | "last_week";

export function isMapDatePreset(v: unknown): v is MapDatePreset {
  return typeof v === "string" && (MAP_DATE_PRESETS as readonly string[]).includes(v);
}

export interface GreenhouseDisplayStateResponse {
  name: string;
  datePreset?: MapDatePreset | null;
  activityId: string | null;
  activityName: string | null;
  dateStart: string;
  dateEnd: string;
  rotationDegrees: RotationDegrees;
  configVersion: string;
  generatedAt: string;
  land: LiveLand;
  blocks: LiveBlockSummary[];
}

// --- TV slideshow (GET /api/greenhouse/display/:key/slides) -----------------

export type SlideStatus = "ok" | "no_speed" | "unavailable";
export type NoSpeedReason = "no_density" | "not_calculable" | "below_minimum" | null;

export interface RankedEmployee {
  // Full name for the ranking bar (server >= 060); older servers send only
  // firstName/lastInitial.
  displayName?: string;
  firstName: string;
  lastInitial: string;
  speed: number;
  activityHours: number;
  quantityCounted: number;
}

export interface ActivitySlide {
  activityId: string;
  activityName: string;
  speedUnit: string | null;
  target: number | null;
  minimumActivityHours: number;
  topN: number | null;
  slideSeconds: number;
  // Bar colours (server/migrations/061_display_slide_colours.sql).
  atTargetColor: string;
  belowTargetColor: string;
  status: SlideStatus;
  reason?: NoSpeedReason;
  notice: string | null;
  employees: RankedEmployee[];
  belowMinimumHours: number;
  employeesWithoutSpeed: number;
  computedAt: string;
}

export interface DisplaySlidesResponse {
  generatedAt: string;
  timezone: string;
  period: { week: ReportWeek; includeToday: boolean; dateStart: string; dateEnd: string; empty: boolean };
  mapSlideSeconds: number;
  slides: ActivitySlide[];
}

// --- Display > Setup (GET/PUT /api/greenhouse/displays/:id/slides-config) ----

export interface ActivitySlideSetting {
  activityId: string;
  name: string;
  speedUnit: string | null;
  densitySource: string | null;
  normalSpeed: number | null;
  sendToTv: boolean;
  targetOverride: number | null;
  minimumActivityHours: number;
  topN: number | null;
  slideSeconds: number;
  atTargetColor: string;
  belowTargetColor: string;
}

export interface DisplaySlidesConfig {
  reportWeek: ReportWeek;
  reportIncludeToday: boolean;
  mapSlideSeconds: number;
  period: { dateStart: string; dateEnd: string; empty: boolean };
  activities: ActivitySlideSetting[];
}
