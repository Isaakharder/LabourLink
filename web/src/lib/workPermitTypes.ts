// Shared types for work-permit expiry tracking (employee profile fields)
// and Dashboard alerts — mirrors server/src/lib/workPermits.ts and
// server/src/routes/{employees,workPermits,dashboard}.ts exactly.

export const WORK_PERMIT_LEAD_MONTH_OPTIONS = [1, 2, 3, 6, 12] as const;
export type WorkPermitLeadMonths = (typeof WORK_PERMIT_LEAD_MONTH_OPTIONS)[number];
export const DEFAULT_WORK_PERMIT_LEAD_MONTHS: WorkPermitLeadMonths = 6;

export type WorkPermitAlertSeverity = "amber" | "orange" | "red" | "expired";

export interface WorkPermitAlert {
  employeeId: string;
  employeeName: string;
  photoUrl: string | null;
  expiryDate: string;
  remainingDays: number;
  severity: WorkPermitAlertSeverity;
  leadMonths: number | null;
  leadDays: number | null;
}

export interface WorkPermitHistoryEntry {
  id: string;
  oldExpiryDate: string | null;
  newExpiryDate: string | null;
  changedAt: string;
  reason: string | null;
  changedBy: string;
}

// "Renewed" — Feb 25, 2027". Same intent as the brief's own example
// wording, used both on the Dashboard alert and the profile's compact
// status line.
export function formatWorkPermitDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

// "6 months" / "45 days" — the configured lead time in the same words the
// employee picked it in, not a re-derived day count.
export function formatWorkPermitLead(leadMonths: number | null, leadDays: number | null): string {
  if (leadMonths != null) return `${leadMonths} month${leadMonths === 1 ? "" : "s"}`;
  if (leadDays != null) return `${leadDays} day${leadDays === 1 ? "" : "s"}`;
  return "—";
}

// "3 months, 2 days" / "18 days" / "Overdue by 5 days" — remaining time in
// months/days, per the brief's own alert example. Only ever called with a
// non-negative remainingDays; the "Overdue by X days"/"Expired" wording is
// handled separately (see WorkPermitAlertsSection) since it's a different
// sentence shape, not just a negative number of the same one.
export function formatRemainingTime(remainingDays: number): string {
  if (remainingDays === 0) return "today";
  const months = Math.floor(remainingDays / 30);
  const days = remainingDays % 30;
  if (months === 0) return `${days} day${days === 1 ? "" : "s"}`;
  if (days === 0) return `${months} month${months === 1 ? "" : "s"}`;
  return `${months} month${months === 1 ? "" : "s"}, ${days} day${days === 1 ? "" : "s"}`;
}
