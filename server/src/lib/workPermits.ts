// Work-permit expiry tracking: pure date/severity math, plus the read/write
// functions server/src/routes/employees.ts, workPermits.ts (routes), and
// dashboard.ts share. See 047_work_permit_tracking.sql for the schema and
// design rationale (alerts are computed on every read, never a stored
// "status" — only acknowledgements/cancellations/history are persisted).
//
// Every date here is a plain YYYY-MM-DD string, matching
// work_permit_expiry_date's own `date` column type — never a Date object,
// never a timezone conversion. "Today" is always the caller's own
// calendarDateInAppTimezone(new Date()) reading, passed in rather than
// computed inside these functions, so every function here is a pure,
// directly testable function of its string inputs.
import { Pool, PoolClient } from "pg";
import { addDaysToDateStr } from "./timezone";

export type WorkPermitAlertSeverity = "amber" | "orange" | "red" | "expired";

export const WORK_PERMIT_LEAD_MONTH_OPTIONS = [1, 2, 3, 6, 12] as const;
export type WorkPermitLeadMonths = (typeof WORK_PERMIT_LEAD_MONTH_OPTIONS)[number];

export const DEFAULT_WORK_PERMIT_LEAD_MONTHS: WorkPermitLeadMonths = 6;

export const MIN_WORK_PERMIT_LEAD_DAYS = 1;
export const MAX_WORK_PERMIT_LEAD_DAYS = 3650;

export function isValidWorkPermitLeadMonths(v: unknown): v is WorkPermitLeadMonths {
  return typeof v === "number" && (WORK_PERMIT_LEAD_MONTH_OPTIONS as readonly number[]).includes(v);
}
export function isValidWorkPermitLeadDays(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_WORK_PERMIT_LEAD_DAYS &&
    v <= MAX_WORK_PERMIT_LEAD_DAYS
  );
}

// The acknowledge snooze period — "return automatically every seven days
// until renewed, cancelled, or the expiry date changes."
export const ACKNOWLEDGE_SNOOZE_DAYS = 7;

// Subtracts `months` CALENDAR months from a YYYY-MM-DD string — "1 month
// before Feb 25" means Jan 25, not "30 days before," so this does real
// calendar-month arithmetic (with end-of-month clamping, e.g. "1 month
// before Mar 31" -> Feb 28/29, the last real day of the shorter month),
// not a fixed-day approximation. Pure UTC-arithmetic-space calendar math,
// the same "never a real timezone conversion" pattern addDaysToDateStr
// (timezone.ts) and roundToInterval's day-rollover (workStartRounding.ts)
// already use — there is no wall-clock/offset reasoning here at all, just
// Y/M/D bookkeeping.
export function subtractCalendarMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const totalMonthsFromEpoch = y * 12 + (m - 1) - months;
  const ny = Math.floor(totalMonthsFromEpoch / 12);
  const nm = totalMonthsFromEpoch - ny * 12; // 0-11
  const lastDayOfTargetMonth = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDayOfTargetMonth);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

// The calendar-day difference (to - from), positive when `to` is later —
// e.g. daysBetweenDateStrs("2027-02-01", "2027-02-25") === 24. Pure
// UTC-arithmetic-space subtraction, same reasoning as subtractCalendarMonths.
export function daysBetweenDateStrs(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000));
}

export interface WorkPermitLead {
  months: number | null;
  days: number | null;
}

// The first date the notification window opens for a given expiry +
// lead setting — exactly one of months/days is ever set (enforced by
// chk_employees_work_permit_lead_set_with_expiry), matching
// resolveNotifyLead's own contract.
export function computeNotificationWindowStart(expiryDate: string, lead: WorkPermitLead): string {
  if (lead.months != null) return subtractCalendarMonths(expiryDate, lead.months);
  if (lead.days != null) return addDaysToDateStr(expiryDate, -lead.days);
  throw new Error("work permit lead requires either months or days");
}

// Server-side default — "the server, not only the client, must default
// the notification lead time to six months whenever an expiry date is
// first added without an explicit lead time." Called wherever an expiry
// date is being newly set (employees.ts's PATCH, and the create route)
// with whatever lead fields the client did or didn't send.
export function resolveNotifyLead(rawMonths: unknown, rawDays: unknown): WorkPermitLead {
  if (isValidWorkPermitLeadDays(rawDays)) return { months: null, days: rawDays };
  if (isValidWorkPermitLeadMonths(rawMonths)) return { months: rawMonths, days: null };
  return { months: DEFAULT_WORK_PERMIT_LEAD_MONTHS, days: null };
}

export function computeSeverity(remainingDays: number): WorkPermitAlertSeverity {
  if (remainingDays < 0) return "expired";
  if (remainingDays < 30) return "red";
  if (remainingDays <= 90) return "orange";
  return "amber";
}

export interface WorkPermitAlert {
  employeeId: string;
  firstName: string;
  lastName: string;
  expiryDate: string;
  remainingDays: number;
  severity: WorkPermitAlertSeverity;
  leadMonths: number | null;
  leadDays: number | null;
}

interface EmployeePermitRow {
  id: string;
  first_name: string;
  last_name: string;
  profile_photo_path: string | null;
  work_permit_expiry_date: string;
  work_permit_notify_lead_months: number | null;
  work_permit_notify_lead_days: number | null;
}

// Every active employee with a tracked expiry date whose notification
// window has opened, isn't cancelled (for this exact expiry_date), and
// isn't currently snoozed by a recent-enough acknowledgement (for this
// exact expiry_date) — see 047_work_permit_tracking.sql's header comment
// for why "changing the expiry date starts a new cycle automatically"
// falls out for free from scoping both by the CURRENT expiry_date value
// rather than tracking a separate mutable cycle/status. Batched (not one
// query per employee) the same "never N+1" convention this codebase's
// other set-based read paths already follow (see reportQueries.ts's
// header comment).
export async function getActiveWorkPermitAlerts(pool: Pool, today: string): Promise<WorkPermitAlert[]> {
  const { rows } = await pool.query<EmployeePermitRow>(
    `select id, first_name, last_name, profile_photo_path,
            to_char(work_permit_expiry_date, 'YYYY-MM-DD') as work_permit_expiry_date,
            work_permit_notify_lead_months, work_permit_notify_lead_days
     from employees
     where is_active = true and work_permit_expiry_date is not null`
  );

  const candidates = rows.filter((r) => {
    const windowStart = computeNotificationWindowStart(r.work_permit_expiry_date, {
      months: r.work_permit_notify_lead_months,
      days: r.work_permit_notify_lead_days,
    });
    return today >= windowStart;
  });
  if (candidates.length === 0) return [];

  const employeeIds = candidates.map((c) => c.id);
  const [cancellationsRes, acksRes] = await Promise.all([
    pool.query<{ employee_id: string; expiry_date: string }>(
      `select employee_id, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date
       from work_permit_alert_cancellations where employee_id = any($1::uuid[])`,
      [employeeIds]
    ),
    pool.query<{ employee_id: string; expiry_date: string; acknowledged_at: string }>(
      `select distinct on (employee_id, expiry_date) employee_id, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date, acknowledged_at
       from work_permit_alert_acknowledgements
       where employee_id = any($1::uuid[])
       order by employee_id, expiry_date, acknowledged_at desc`,
      [employeeIds]
    ),
  ]);
  const cancelledKeys = new Set(cancellationsRes.rows.map((r) => `${r.employee_id}:${r.expiry_date}`));
  const latestAckByKey = new Map(acksRes.rows.map((r) => [`${r.employee_id}:${r.expiry_date}`, r.acknowledged_at]));

  const now = Date.now();
  const alerts: WorkPermitAlert[] = [];
  for (const c of candidates) {
    const key = `${c.id}:${c.work_permit_expiry_date}`;
    if (cancelledKeys.has(key)) continue;
    const lastAck = latestAckByKey.get(key);
    if (lastAck && now < new Date(lastAck).getTime() + ACKNOWLEDGE_SNOOZE_DAYS * 24 * 60 * 60 * 1000) continue;

    const remainingDays = daysBetweenDateStrs(today, c.work_permit_expiry_date);
    alerts.push({
      employeeId: c.id,
      firstName: c.first_name,
      lastName: c.last_name,
      expiryDate: c.work_permit_expiry_date,
      remainingDays,
      severity: computeSeverity(remainingDays),
      leadMonths: c.work_permit_notify_lead_months,
      leadDays: c.work_permit_notify_lead_days,
    });
  }

  alerts.sort((a, b) => a.remainingDays - b.remainingDays);
  return alerts;
}

// Idempotent acknowledge — "if an acknowledgement already exists inside
// the current seven-day snooze period, return it instead of inserting a
// duplicate audit row." A double-click or two racing tabs both land here;
// the second one finds the first's still-fresh row and returns it as-is,
// so the audit trail records one real acknowledgement per snooze period,
// not one per click.
export async function acknowledgeWorkPermitAlert(
  pool: Pool,
  employeeId: string,
  expiryDate: string,
  acknowledgedByEmployeeId: string
): Promise<{ id: string; acknowledgedAt: string; acknowledgedBy: string }> {
  const existing = await pool.query<{ id: string; acknowledged_at: string; acknowledged_by_employee_id: string }>(
    `select id, acknowledged_at, acknowledged_by_employee_id
     from work_permit_alert_acknowledgements
     where employee_id = $1 and expiry_date = $2
       and acknowledged_at > now() - interval '${ACKNOWLEDGE_SNOOZE_DAYS} days'
     order by acknowledged_at desc limit 1`,
    [employeeId, expiryDate]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return { id: row.id, acknowledgedAt: row.acknowledged_at, acknowledgedBy: row.acknowledged_by_employee_id };
  }

  const { rows } = await pool.query<{ id: string; acknowledged_at: string }>(
    `insert into work_permit_alert_acknowledgements (employee_id, expiry_date, acknowledged_by_employee_id)
     values ($1, $2, $3) returning id, acknowledged_at`,
    [employeeId, expiryDate, acknowledgedByEmployeeId]
  );
  return { id: rows[0].id, acknowledgedAt: rows[0].acknowledged_at, acknowledgedBy: acknowledgedByEmployeeId };
}

// One-time (not repeatable) — a second cancel on the same expiry-date
// version is a genuine no-op, same idempotency intent as acknowledge but
// via the unique(employee_id, expiry_date) constraint instead of a time
// window (cancellation has no "expires after N days" concept).
export async function cancelWorkPermitAlert(
  pool: Pool,
  employeeId: string,
  expiryDate: string,
  cancelledByEmployeeId: string,
  reason: string | null
): Promise<void> {
  await pool.query(
    `insert into work_permit_alert_cancellations (employee_id, expiry_date, cancelled_by_employee_id, reason)
     values ($1, $2, $3, $4)
     on conflict (employee_id, expiry_date) do nothing`,
    [employeeId, expiryDate, cancelledByEmployeeId, reason]
  );
}

export interface WorkPermitStatus {
  expiryDate: string | null;
  isCancelled: boolean;
  // ISO timestamp the current acknowledge-snooze runs until, or null if
  // there is no expiry, no acknowledgement for the current expiry_date, or
  // the 7-day window has already lapsed — i.e. null means "not currently
  // snoozed," not "never acknowledged." Feeds the employee profile's
  // compact "Alert acknowledged until…" status line.
  acknowledgedUntil: string | null;
}

export async function getWorkPermitStatus(pool: Pool, employeeId: string): Promise<WorkPermitStatus> {
  const empRes = await pool.query<{ expiry_date: string | null }>(
    `select to_char(work_permit_expiry_date, 'YYYY-MM-DD') as expiry_date from employees where id = $1`,
    [employeeId]
  );
  const expiryDate = empRes.rows[0]?.expiry_date ?? null;
  if (!expiryDate) return { expiryDate: null, isCancelled: false, acknowledgedUntil: null };

  const [cancelRes, ackRes] = await Promise.all([
    pool.query(`select 1 from work_permit_alert_cancellations where employee_id = $1 and expiry_date = $2`, [employeeId, expiryDate]),
    pool.query<{ acknowledged_at: string }>(
      `select acknowledged_at from work_permit_alert_acknowledgements
       where employee_id = $1 and expiry_date = $2 order by acknowledged_at desc limit 1`,
      [employeeId, expiryDate]
    ),
  ]);

  let acknowledgedUntil: string | null = null;
  if (ackRes.rows[0]) {
    const untilMs = new Date(ackRes.rows[0].acknowledged_at).getTime() + ACKNOWLEDGE_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() < untilMs) acknowledgedUntil = new Date(untilMs).toISOString();
  }

  return { expiryDate, isCancelled: cancelRes.rows.length > 0, acknowledgedUntil };
}

// Writes one audit row for an expiry-date change — shared by ordinary
// profile editing (employees.ts's PATCH) and the dedicated Renewed action
// (workPermits.ts routes), so history is complete regardless of which
// door was used. oldExpiryDate/newExpiryDate are read as plain strings by
// the caller (already to_char'd) to keep this function itself free of any
// date-object handling.
export async function recordWorkPermitHistory(
  client: Pool | PoolClient,
  employeeId: string,
  oldExpiryDate: string | null,
  newExpiryDate: string | null,
  changedByEmployeeId: string,
  reason: string | null
): Promise<void> {
  await client.query(
    `insert into employee_work_permit_history (employee_id, old_expiry_date, new_expiry_date, changed_by_employee_id, reason)
     values ($1, $2, $3, $4, $5)`,
    [employeeId, oldExpiryDate, newExpiryDate, changedByEmployeeId, reason]
  );
}
