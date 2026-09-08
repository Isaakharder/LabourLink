// Administrator/Manager review alert for a workday that has remained open
// (continuously — work and/or break, no idle gap) longer than a configurable
// threshold (org_settings.long_open_shift_alert_threshold_hours, default
// 16h). Modeled directly on workPermits.ts's getActiveWorkPermitAlerts:
// computed fresh on every read, nothing persisted as a stored "alert" row.
//
// Review-only — this NEVER closes, corrects, or otherwise touches an entry.
// The employee is never automatically clocked out at this threshold.
//
// Once midnight rollover exists (midnightRollover.ts), the CURRENT open
// entry's own started_at resets at every local midnight it crossed — a
// shift that's genuinely been open 20 hours could have a `started_at` only
// an hour or two old if it just rolled over. The threshold has to be
// measured against the true, continuous "on the clock" streak, not the
// current row alone — see walkShiftStart below.
import { Pool, PoolClient } from "pg";
import { pool } from "../db";

export interface LongOpenShiftAlert {
  employeeId: string;
  firstName: string;
  lastName: string;
  entryType: "work" | "break";
  shiftStartedAt: string;
  openHours: number;
}

interface OpenShiftCandidateRow {
  employee_id: string;
  entry_type: "work" | "break";
  started_at: Date;
  first_name: string;
  last_name: string;
}

// Bounded purely as a defensive cap against a data anomaly — a real
// continuous chain of activity/break switches over even several days is
// nowhere close to this many hops in practice.
export const MAX_SHIFT_CHAIN_WALK = 500;

export interface ShiftChainEntry {
  id: string;
  entryType: "work" | "break";
  source: string;
  createdByEmployeeId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
}

// Walks backward from `startEntry` through this employee's time_entries,
// following exact ended_at = cursor's own started_at boundaries — the same
// contiguity property openEntry() guarantees for a real tap-to-tap
// transition AND midnight rollover guarantees for its own boundary (see
// midnightRollover.ts) — with NO activity/row/carrier/entry_type/source
// restriction (unlike mobileTime.ts's accumulateChainSeconds, which is
// deliberately scoped to "still on this specific job"; this is answering
// "still on the clock at all"). Stops at the first real gap (no entry ends
// exactly there), which is the employee's last genuine idle point. Returned
// oldest-first (chain[0] is the true start).
//
// Exported for runawayShiftAutoCutoff.ts, which needs every hop's own
// source/created_by_employee_id (not just the earliest boundary) to find
// the most recent GENUINE action anywhere in the chain — synthetic hops
// (midnight_rollover, auto, break_reconciliation) must never count as one.
// walkShiftStart below is unchanged and still answers a different question
// ("how long has this employee been continuously on the clock at all,"
// used for the review-only alert threshold) — it's now just a thin wrapper
// over this.
export async function walkShiftChain(
  db: Pool | PoolClient,
  employeeId: string,
  startEntry: {
    id: string;
    entryType: "work" | "break";
    source: string;
    createdByEmployeeId: string | null;
    startedAt: Date;
    endedAt: Date | null;
    createdAt: Date;
  }
): Promise<ShiftChainEntry[]> {
  const chain: ShiftChainEntry[] = [
    {
      id: startEntry.id,
      entryType: startEntry.entryType,
      source: startEntry.source,
      createdByEmployeeId: startEntry.createdByEmployeeId,
      startedAt: startEntry.startedAt,
      endedAt: startEntry.endedAt,
      createdAt: startEntry.createdAt,
    },
  ];
  let cursor = startEntry.startedAt;
  let hops = 0;
  while (hops < MAX_SHIFT_CHAIN_WALK) {
    hops++;
    const { rows } = await db.query<{
      id: string;
      entry_type: "work" | "break";
      source: string;
      created_by_employee_id: string | null;
      started_at: Date;
      ended_at: Date | null;
      created_at: Date;
    }>(
      `select id, entry_type, source, created_by_employee_id, started_at, ended_at, created_at from time_entries
       where employee_id = $1 and deleted_at is null and ended_at = $2
       order by started_at asc limit 1`,
      [employeeId, cursor]
    );
    const prev = rows[0];
    if (!prev) break;
    chain.push({
      id: prev.id,
      entryType: prev.entry_type,
      source: prev.source,
      createdByEmployeeId: prev.created_by_employee_id,
      startedAt: new Date(prev.started_at),
      endedAt: prev.ended_at ? new Date(prev.ended_at) : null,
      createdAt: new Date(prev.created_at),
    });
    cursor = new Date(prev.started_at);
  }
  chain.reverse();
  return chain;
}

// Exported for longShiftAdminEnd.ts — the End Work admin action needs the
// exact same "true continuous streak" boundary this alert is computed
// against, both to show it in the confirmation modal and to reject a
// proposed end time that's before the shift genuinely started.
export async function walkShiftStart(db: Pool | PoolClient, employeeId: string, startedAt: Date): Promise<Date> {
  // Only startedAt/endedAt are load-bearing for this walk (id/entryType/
  // source/createdByEmployeeId/createdAt are unused by the caller here) —
  // the rest are placeholder values satisfying walkShiftChain's shape.
  const chain = await walkShiftChain(db, employeeId, {
    id: "",
    entryType: "work",
    source: "manual",
    createdByEmployeeId: null,
    startedAt,
    endedAt: null,
    createdAt: startedAt,
  });
  return chain[0].startedAt;
}

export async function getLongOpenShiftAlerts(
  db: Pool,
  thresholdHours: number,
  now: Date
): Promise<LongOpenShiftAlert[]> {
  const { rows: candidates } = await db.query<OpenShiftCandidateRow>(
    `select te.employee_id, te.entry_type, te.started_at, e.first_name, e.last_name
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.ended_at is null and te.deleted_at is null
     order by te.started_at asc`
  );
  if (candidates.length === 0) return [];

  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  const alerts: LongOpenShiftAlert[] = [];
  for (const c of candidates) {
    const shiftStart = await walkShiftStart(db, c.employee_id, new Date(c.started_at));
    const openMs = now.getTime() - shiftStart.getTime();
    if (openMs < thresholdMs) continue;
    alerts.push({
      employeeId: c.employee_id,
      firstName: c.first_name,
      lastName: c.last_name,
      entryType: c.entry_type,
      shiftStartedAt: shiftStart.toISOString(),
      openHours: Math.round((openMs / (60 * 60 * 1000)) * 10) / 10,
    });
  }

  alerts.sort((a, b) => b.openHours - a.openHours);
  return alerts;
}

export interface OrgSettings {
  longOpenShiftAlertThresholdHours: number;
  // The runaway-shift automatic safety-cutoff threshold (migration 051) —
  // see runawayShiftAutoCutoff.ts. Kept on this same OrgSettings/org_settings
  // read path (rather than a separate settings table) for the same reason
  // the alert threshold already lives here: one singleton row, one
  // "current org config" read.
  autoSafetyCutoffThresholdHours: number;
}

export const DEFAULT_LONG_OPEN_SHIFT_ALERT_THRESHOLD_HOURS = 16;
export const MIN_LONG_OPEN_SHIFT_ALERT_THRESHOLD_HOURS = 1;
export const MAX_LONG_OPEN_SHIFT_ALERT_THRESHOLD_HOURS = 168;

export function isValidLongOpenShiftAlertThresholdHours(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_LONG_OPEN_SHIFT_ALERT_THRESHOLD_HOURS &&
    v <= MAX_LONG_OPEN_SHIFT_ALERT_THRESHOLD_HOURS
  );
}

export const DEFAULT_AUTO_SAFETY_CUTOFF_THRESHOLD_HOURS = 72;
export const MIN_AUTO_SAFETY_CUTOFF_THRESHOLD_HOURS = 24;
export const MAX_AUTO_SAFETY_CUTOFF_THRESHOLD_HOURS = 336;

export function isValidAutoSafetyCutoffThresholdHours(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_AUTO_SAFETY_CUTOFF_THRESHOLD_HOURS &&
    v <= MAX_AUTO_SAFETY_CUTOFF_THRESHOLD_HOURS
  );
}

// Singleton row (org_settings, migration 049) — always exactly one row by
// construction (`id boolean primary key default true`), so this never
// needs an id parameter. Read fresh on every call, same "no caching, always
// current" convention every other settings lookup in this codebase follows.
export async function getOrgSettings(): Promise<OrgSettings> {
  const { rows } = await pool.query<{
    long_open_shift_alert_threshold_hours: number;
    auto_safety_cutoff_threshold_hours: number;
  }>(`select long_open_shift_alert_threshold_hours, auto_safety_cutoff_threshold_hours from org_settings where id = true`);
  return {
    longOpenShiftAlertThresholdHours:
      rows[0]?.long_open_shift_alert_threshold_hours ?? DEFAULT_LONG_OPEN_SHIFT_ALERT_THRESHOLD_HOURS,
    autoSafetyCutoffThresholdHours:
      rows[0]?.auto_safety_cutoff_threshold_hours ?? DEFAULT_AUTO_SAFETY_CUTOFF_THRESHOLD_HOURS,
  };
}

export async function setLongOpenShiftAlertThresholdHours(hours: number, updatedByEmployeeId: string): Promise<void> {
  await pool.query(
    `update org_settings set long_open_shift_alert_threshold_hours = $1, updated_at = now(), updated_by_employee_id = $2
     where id = true`,
    [hours, updatedByEmployeeId]
  );
}

export async function setAutoSafetyCutoffThresholdHours(hours: number, updatedByEmployeeId: string): Promise<void> {
  await pool.query(
    `update org_settings set auto_safety_cutoff_threshold_hours = $1, updated_at = now(), updated_by_employee_id = $2
     where id = true`,
    [hours, updatedByEmployeeId]
  );
}
