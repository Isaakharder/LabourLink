// DTOs for GET /api/mobile/employees/live — server/src/routes/mobileEmployees.ts.

export type LiveEmployeeStatus = "working" | "on_break";
export type LiveEmployeeLocationType = "row" | "carrier" | "none";
export type LiveEmployeeSpeedState = "ok" | "no_metric" | "not_enough_data";

export interface LiveEmployeeCard {
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  photoUrl: string | null;
  status: LiveEmployeeStatus;
  statusSince: string; // ISO — run start (working) or break start (on_break)

  // Working only — null when status is "on_break".
  activityId: string | null;
  activityName: string | null;
  locationType: LiveEmployeeLocationType;
  rowLabel: string | null;
  carrierName: string | null;
  speedValue: number | null;
  speedUnit: string | null;
  speedState: LiveEmployeeSpeedState;

  // Break only — null when status is "working".
  breakType: string | null;
  resumingActivityName: string | null;
}

export interface LiveEmployeesResponse {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  employees: LiveEmployeeCard[];
}
