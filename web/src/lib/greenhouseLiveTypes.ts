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

export interface GreenhouseDisplayStateResponse {
  name: string;
  activityId: string | null;
  activityName: string | null;
  dateStart: string;
  dateEnd: string;
  rotationDegrees: RotationDegrees;
  configVersion: string;
  generatedAt: string;
  land: LiveLand;
}
