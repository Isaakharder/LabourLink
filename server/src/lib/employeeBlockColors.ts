// Fixed preset palette for Employee Block colour-coding on the greenhouse
// live map (see migration 041_employee_block_color.sql). Deliberately NOT
// an open colour picker — a client can only ever submit one of these eight
// keys, validated here; the actual soft/muted shades this maps to live in
// web/src/lib/employeeBlockColors.ts (mirrored — keep both lists in sync if
// either changes, same convention as reportTypes.ts's ACTIVITY_METRICS/
// PAYROLL_METRICS mirroring their server-side counterparts).
export const EMPLOYEE_BLOCK_COLOR_KEYS = [
  "slate",
  "dustyPurple",
  "softMauve",
  "warmTaupe",
  "mutedTerracotta",
  "softPlum",
  "blueGrey",
  "mutedAmber",
] as const;

export type EmployeeBlockColorKey = (typeof EMPLOYEE_BLOCK_COLOR_KEYS)[number];

export function isEmployeeBlockColorKey(v: unknown): v is EmployeeBlockColorKey {
  return typeof v === "string" && (EMPLOYEE_BLOCK_COLOR_KEYS as readonly string[]).includes(v);
}
