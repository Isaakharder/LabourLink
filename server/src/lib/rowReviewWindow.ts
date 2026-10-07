// The "Row review window (calendar days)" org setting —
// org_settings.row_review_window_days (057_row_review_window.sql). Same
// org_settings singleton pattern as longOpenShiftAlerts.ts's getOrgSettings
// and employmentTimelineSettings.ts: exactly one row by construction, read
// fresh on every call (no caching), so a saved change takes effect on the
// very next Inputs / Reports / Dashboard / mobile Stats / Productive TV
// request — every one of them groups visits through
// rowCompletionCandidates.ts's getUnresolvedRunsForRows, which reads this.
import { pool } from "../db";

// The fixed boundary this setting replaced; also what the migration
// defaults every existing deployment to.
export const DEFAULT_ROW_REVIEW_WINDOW_DAYS = 7;
export const MIN_ROW_REVIEW_WINDOW_DAYS = 1;
// Matches the column's check constraint. A cycle wider than a year would
// lump unrelated passes over a row into one review, which is exactly what
// cycles exist to prevent.
export const MAX_ROW_REVIEW_WINDOW_DAYS = 365;

export function isValidRowReviewWindowDays(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_ROW_REVIEW_WINDOW_DAYS &&
    v <= MAX_ROW_REVIEW_WINDOW_DAYS
  );
}

export async function getRowReviewWindowDays(): Promise<number> {
  const { rows } = await pool.query<{ row_review_window_days: number }>(
    `select row_review_window_days from org_settings where id = true`
  );
  return rows[0]?.row_review_window_days ?? DEFAULT_ROW_REVIEW_WINDOW_DAYS;
}

export async function setRowReviewWindowDays(days: number, updatedByEmployeeId: string): Promise<void> {
  await pool.query(
    `update org_settings set row_review_window_days = $1, updated_at = now(), updated_by_employee_id = $2
     where id = true`,
    [days, updatedByEmployeeId]
  );
}
