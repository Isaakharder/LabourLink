// Runaway-shift safety cutoff: the actual fix for the bug where an
// employee's open shift chain could stay open indefinitely because
// dailyCutoff.ts (see that file's own header) measures staleness from the
// currently-open row's own started_at, which midnight rollover
// (midnightRollover.ts) refreshes every local midnight. This file measures
// staleness from the last GENUINE employee/device or administrator action
// anywhere in the continuous chain instead — a value that synthetic rows
// (midnight_rollover, auto, break_reconciliation) can never move forward.
//
// Enforcement lives inside midnightRollover.ts's own per-hop loop (see that
// file), under the same per-employee advisory lock every rollover hop
// already takes — not a separate sweep — so a concurrent cron sweep,
// request-time reconcile, and dailyCutoff's own pass can never race past
// each other, and re-running after a cutoff has already happened is a true
// no-op (there's nothing left open to act on).
import { Pool, PoolClient } from "pg";
import { ShiftChainEntry, walkShiftChain } from "./longOpenShiftAlerts";
import { calendarDateInAppTimezone } from "./timezone";

export const RUNAWAY_SHIFT_AUTO_CUTOFF_REASON = "runaway_shift_auto_cutoff";

// Every correction `reason` this codebase writes for a SYSTEM-generated
// (never a genuine administrator) time_entries mutation. A correction with
// one of these reasons must never itself count as a "genuine action" when
// walking a chain for the last real signal — that would let the safety
// cutoff's own bookkeeping (or midnight rollover's, or dailyCutoff's)
// perpetually re-justify itself. Kept as a single source of truth here
// since findGenuineAnchor is the one place this distinction matters.
export const SYSTEM_CORRECTION_REASONS: readonly string[] = [
  "midnight_rollover",
  "Automatically closed at daily cutoff",
  RUNAWAY_SHIFT_AUTO_CUTOFF_REASON,
];

// Work continuation rows created by breakReconciliation.ts's automatic
// split are system-generated too, exactly like a midnight_rollover hop —
// see that file and migration 051's own comment on why this source value
// exists. Both this and 'auto' (the break entry itself) are excluded here
// so an automatic break, or the automatic split it causes, can never reset
// a chain's inactivity clock even after the mislabeling fix.
const SYNTHETIC_SOURCES: readonly string[] = ["midnight_rollover", "auto", "break_reconciliation"];

interface CurrentOpenEntry {
  id: string;
  entryType: "work" | "break";
  source: string;
  createdByEmployeeId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
}

export interface GenuineAnchorResult {
  anchorAt: Date;
  chain: ShiftChainEntry[];
}

// Requirement: "calculate inactivity from the most recent genuine
// employee/device or administrator action anywhere in the continuous shift
// chain. Use the true chain start only when no later genuine action exists."
//
// A genuine action is the latest of:
//   (a) a real device tap — mobile_time_events row, processing_status =
//       'accepted', whose time_entry_id lands on a chain entry — using the
//       tap's own occurred_at_utc, not the (possibly rounded) entry
//       started_at;
//   (b) a chain entry created directly by an administrator — created_by_
//       employee_id is not null — using that row's own created_at;
//   (c) a genuine administrator correction against a chain entry —
//       time_entry_corrections.changed_by_employee_id is not null and
//       reason is not one of SYSTEM_CORRECTION_REASONS — using changed_at.
// Falls back to the chain's own true start (earliest contiguous started_at,
// exactly what walkShiftStart already returns) only when none of the above
// produce a value.
export async function findGenuineAnchor(
  db: Pool | PoolClient,
  employeeId: string,
  currentOpenEntry: CurrentOpenEntry
): Promise<GenuineAnchorResult> {
  const chain = await walkShiftChain(db, employeeId, {
    id: currentOpenEntry.id,
    entryType: currentOpenEntry.entryType,
    source: currentOpenEntry.source,
    createdByEmployeeId: currentOpenEntry.createdByEmployeeId,
    startedAt: currentOpenEntry.startedAt,
    endedAt: currentOpenEntry.endedAt,
    createdAt: currentOpenEntry.createdAt,
  });
  const chainIds = chain.map((c) => c.id).filter((id) => id !== "");

  let anchorAt = chain[0].startedAt;

  if (chainIds.length > 0) {
    const [deviceEvents, adminCorrections] = await Promise.all([
      db.query<{ max_occurred: Date | null }>(
        `select max(occurred_at_utc) as max_occurred from mobile_time_events
         where employee_id = $1 and processing_status = 'accepted' and time_entry_id = any($2::uuid[])`,
        [employeeId, chainIds]
      ),
      db.query<{ max_changed: Date | null }>(
        `select max(changed_at) as max_changed from time_entry_corrections
         where time_entry_id = any($1::uuid[])
           and changed_by_employee_id is not null
           and reason <> all($2::text[])`,
        [chainIds, SYSTEM_CORRECTION_REASONS]
      ),
    ]);

    // (b) a chain entry the admin created directly — created_by_employee_id
    // is set — using its own created_at (when the admin ACTED), not its
    // started_at (whatever time they typed in, which could be an old
    // backdated shift entered just now — the point is measuring the last
    // time a human did something, not the last time attested work
    // happened).
    const adminCreatedMax = chain.reduce<Date | null>((latest, entry) => {
      if (!entry.createdByEmployeeId) return latest;
      return latest === null || entry.createdAt > latest ? entry.createdAt : latest;
    }, null);

    const candidates: Date[] = [anchorAt];
    const deviceMax = deviceEvents.rows[0]?.max_occurred;
    if (deviceMax) candidates.push(new Date(deviceMax));
    if (adminCreatedMax) candidates.push(adminCreatedMax);
    const correctionMax = adminCorrections.rows[0]?.max_changed;
    if (correctionMax) candidates.push(new Date(correctionMax));

    anchorAt = candidates.reduce((latest, d) => (d > latest ? d : latest), anchorAt);
  }

  return { anchorAt, chain };
}

// Pure timestamp math, exported for unit tests — same convention as
// computeRolloverBoundary (midnightRollover.ts) / computeCutoffAt
// (dailyCutoff.ts).
export function computeSafetyCutoffBoundary(genuineAnchorAt: Date, thresholdHours: number): Date {
  return new Date(genuineAnchorAt.getTime() + thresholdHours * 60 * 60 * 1000);
}

export interface PendingChainAnchor {
  employeeId: string;
  terminalEntryId: string;
  genuineAnchorAt: Date;
  // Every APP_TIMEZONE calendar date (YYYY-MM-DD) this chain's rows touch —
  // used by reportQueries.ts/inputs.ts to know exactly which employee-days
  // need unverifiedFrom applied, without flagging an unrelated later shift
  // that started fresh after this chain was cut off.
  affectedDates: string[];
}

// The admin "needs review" surface and the payroll-exclusion lookup both
// start here: every entry still marked safety_cutoff_at (i.e. not yet
// resolved via Dashboard End Work) for the given employees, with its full
// chain walked to know exactly which calendar days it touches. Expected to
// return a near-empty result in the ordinary case — this mechanism's whole
// point is to prevent this set from growing unbounded.
export async function getPendingChainAnchorsForEmployees(
  db: Pool | PoolClient,
  employeeIds: string[]
): Promise<PendingChainAnchor[]> {
  if (employeeIds.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    employee_id: string;
    entry_type: "work" | "break";
    source: string;
    created_by_employee_id: string | null;
    started_at: Date;
    ended_at: Date;
    created_at: Date;
    genuine_anchor_at: Date;
  }>(
    `select id, employee_id, entry_type, source, created_by_employee_id, started_at, ended_at, created_at, genuine_anchor_at
     from time_entries
     where employee_id = any($1::uuid[]) and safety_cutoff_at is not null and deleted_at is null`,
    [employeeIds]
  );

  const results: PendingChainAnchor[] = [];
  for (const row of rows) {
    const chain = await walkShiftChain(db, row.employee_id, {
      id: row.id,
      entryType: row.entry_type,
      source: row.source,
      createdByEmployeeId: row.created_by_employee_id,
      startedAt: new Date(row.started_at),
      endedAt: new Date(row.ended_at),
      createdAt: new Date(row.created_at),
    });
    const affectedDates = Array.from(new Set(chain.map((c) => calendarDateInAppTimezone(c.startedAt))));
    results.push({
      employeeId: row.employee_id,
      terminalEntryId: row.id,
      genuineAnchorAt: new Date(row.genuine_anchor_at),
      affectedDates,
    });
  }
  return results;
}

// True for a chain entry that could only have been produced by the system,
// never by a real tap or a genuine admin action — used by
// runawayChainRecovery.ts's preview to classify rows, and safe to treat as
// "never genuine" even though findGenuineAnchor already looks past these
// via the mobile_time_events/created_by_employee_id/corrections checks
// (a synthetic-sourced row could theoretically still carry a later genuine
// correction against it — findGenuineAnchor accounts for that; this helper
// is purely for display/classification, not the anchor computation itself).
export function isSyntheticSource(source: string): boolean {
  return SYNTHETIC_SOURCES.includes(source);
}
