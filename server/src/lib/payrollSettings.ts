// payroll_settings (migration 079): versioned payroll rules. Read by every
// caller of computeWorkdayTotals so Inputs, Payroll and the reports apply
// the same rule to the same day. One single-row primary-key lookup per
// request — deliberately not cached, so every request reads the same value
// a SQL edit of the setting just made, and query counts stay deterministic.
import { pool } from "../db";
import { WorkdayTotalsOptions } from "./workdayTotals";

export async function loadWorkdayTotalsOptions(): Promise<WorkdayTotalsOptions> {
  const { rows } = await pool.query(
    `select to_char(unpaid_break_span_clip_from, 'YYYY-MM-DD') as clip_from from payroll_settings where id = true`
  );
  return { unpaidBreakSpanClipFrom: rows[0]?.clip_from ?? null };
}
