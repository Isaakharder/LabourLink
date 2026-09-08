// Admin-facing recovery tooling for a runaway shift chain the safety cutoff
// (runawayShiftAutoCutoff.ts / midnightRollover.ts) has already stopped and
// flagged for review. Two halves, deliberately asymmetric:
//
//   - getPendingRunawayChains / previewRunawayChainRecovery are pure reads —
//     no lock, no mutation, safe to call as often as an admin screen wants.
//   - applyRunawayChainRecovery is the ONLY writer, and only ever acts on an
//     explicit, per-entry action list an administrator picked after seeing
//     the preview. It never runs on its own and never "applies everything."
//
// Deliberately conservative: applying a "delete" action soft-deletes the row
// (same convention every other deletion in this codebase uses) but does NOT
// attempt to automatically reconnect the surrounding real segments — doing
// that safely requires the same care Inputs' own trim/reconnect logic
// already has for manual corrections, and guessing at it here risks
// fabricating a boundary nobody actually confirmed. An administrator uses
// the ordinary Inputs correction tools afterward for that, with the
// deleted rows' audit trail (this file's own correction rows) as the record
// of what was removed and why.
import { PoolClient } from "pg";
import { pool } from "../db";
import { lockEmployeeForManualEntry } from "./manualTimeEntries";
import { ShiftChainEntry, walkShiftChain } from "./longOpenShiftAlerts";
import { getPendingChainAnchorsForEmployees, isSyntheticSource, SYSTEM_CORRECTION_REASONS } from "./runawayShiftAutoCutoff";

export const RUNAWAY_CHAIN_RECOVERY_REASON = "runaway_chain_recovery";

export interface PendingRunawayChain {
  employeeId: string;
  employeeName: string;
  terminalEntryId: string;
  genuineAnchorAt: string;
  safetyCutoffAt: string;
  hoursSinceAnchor: number;
}

// The admin "needs review" queue — every employee currently sitting on an
// unresolved safety cutoff. Necessary precisely because a closed entry no
// longer shows up in the (open-entries-only) Long Open Shift Alerts list;
// without this, an employee the safety cutoff just stopped would otherwise
// vanish from view with no prompt to go confirm their real end time.
export async function getPendingRunawayChains(): Promise<PendingRunawayChain[]> {
  const { rows } = await pool.query<{
    employee_id: string;
    first_name: string;
    last_name: string;
    id: string;
    genuine_anchor_at: string;
    safety_cutoff_at: string;
  }>(
    `select te.employee_id, e.first_name, e.last_name, te.id, te.genuine_anchor_at, te.safety_cutoff_at
     from time_entries te
     join employees e on e.id = te.employee_id
     where te.safety_cutoff_at is not null and te.deleted_at is null
     order by te.safety_cutoff_at asc`
  );
  const now = Date.now();
  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: `${r.first_name} ${r.last_name}`,
    terminalEntryId: r.id,
    genuineAnchorAt: new Date(r.genuine_anchor_at).toISOString(),
    safetyCutoffAt: new Date(r.safety_cutoff_at).toISOString(),
    hoursSinceAnchor: Math.round(((now - new Date(r.genuine_anchor_at).getTime()) / (60 * 60 * 1000)) * 10) / 10,
  }));
}

export type ChainEntryClassification = "genuine" | "synthetic" | "ambiguous_manual_label";
export type SuggestedChainAction = "keep" | "remove" | "review";

export interface ChainRecoveryPreviewEntry {
  id: string;
  entryType: "work" | "break";
  source: string;
  startedAtIso: string;
  endedAtIso: string | null;
  classification: ChainEntryClassification;
  suggestedAction: SuggestedChainAction;
  // Present only when classification is "genuine" — which signal justified
  // it, for the admin screen to explain itself rather than assert it.
  genuineReason: "device_tap" | "admin_created" | "admin_correction" | null;
}

async function classifyChain(employeeId: string, chain: ShiftChainEntry[]): Promise<ChainRecoveryPreviewEntry[]> {
  const chainIds = chain.map((c) => c.id);
  const [deviceEventRows, correctionRows] = await Promise.all([
    pool.query<{ time_entry_id: string }>(
      `select distinct time_entry_id from mobile_time_events
       where employee_id = $1 and processing_status = 'accepted' and time_entry_id = any($2::uuid[])`,
      [employeeId, chainIds]
    ),
    pool.query<{ time_entry_id: string }>(
      `select distinct time_entry_id from time_entry_corrections
       where time_entry_id = any($1::uuid[])
         and changed_by_employee_id is not null
         and reason <> all($2::text[])`,
      [chainIds, SYSTEM_CORRECTION_REASONS]
    ),
  ]);
  const hasDeviceTap = new Set(deviceEventRows.rows.map((r) => r.time_entry_id));
  const hasAdminCorrection = new Set(correctionRows.rows.map((r) => r.time_entry_id));

  return chain.map((entry) => {
    let genuineReason: ChainRecoveryPreviewEntry["genuineReason"] = null;
    if (hasDeviceTap.has(entry.id)) genuineReason = "device_tap";
    else if (entry.createdByEmployeeId) genuineReason = "admin_created";
    else if (hasAdminCorrection.has(entry.id)) genuineReason = "admin_correction";

    const classification: ChainEntryClassification = genuineReason
      ? "genuine"
      : isSyntheticSource(entry.source)
        ? "synthetic"
        : "ambiguous_manual_label";

    const suggestedAction: SuggestedChainAction =
      classification === "genuine" ? "keep" : classification === "synthetic" ? "remove" : "review";

    return {
      id: entry.id,
      entryType: entry.entryType,
      source: entry.source,
      startedAtIso: entry.startedAt.toISOString(),
      endedAtIso: entry.endedAt ? entry.endedAt.toISOString() : null,
      classification,
      suggestedAction,
      genuineReason,
    };
  });
}

// Read-only. Walks the full chain ending at the employee's current pending
// safety-cutoff entry and classifies every row in it — never the entries of
// an unrelated later (or earlier) shift.
export async function previewRunawayChainRecovery(employeeId: string): Promise<ChainRecoveryPreviewEntry[]> {
  const anchors = await getPendingChainAnchorsForEmployees(pool, [employeeId]);
  if (anchors.length === 0) return [];

  // Walk from the terminal entry itself, not just its own row — need the
  // full chain, not the summary getPendingChainAnchorsForEmployees returns.
  const results: ChainRecoveryPreviewEntry[] = [];
  for (const anchor of anchors) {
    const { rows } = await pool.query<{
      id: string;
      entry_type: "work" | "break";
      source: string;
      created_by_employee_id: string | null;
      started_at: Date;
      ended_at: Date | null;
      created_at: Date;
    }>(
      `select id, entry_type, source, created_by_employee_id, started_at, ended_at, created_at
       from time_entries where id = $1`,
      [anchor.terminalEntryId]
    );
    const terminal = rows[0];
    if (!terminal) continue;
    const chain = await walkShiftChain(pool, employeeId, {
      id: terminal.id,
      entryType: terminal.entry_type,
      source: terminal.source,
      createdByEmployeeId: terminal.created_by_employee_id,
      startedAt: new Date(terminal.started_at),
      endedAt: terminal.ended_at ? new Date(terminal.ended_at) : null,
      createdAt: new Date(terminal.created_at),
    });
    results.push(...(await classifyChain(employeeId, chain)));
  }
  return results;
}

export interface ChainRecoveryAction {
  entryId: string;
  action: "delete" | "keep";
}

export class RunawayChainRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunawayChainRecoveryError";
  }
}

// The only writer in this file. Requires an explicit action for every entry
// the admin wants touched — there is no "apply the suggestions" shortcut, so
// a caller can never accidentally delete more than it explicitly listed.
// "keep" actions are accepted but are pure no-ops (recorded nowhere) —
// they exist only so a caller can send back the whole preview list
// unmodified for entries it reviewed and chose not to change.
export async function applyRunawayChainRecovery(
  employeeId: string,
  adminId: string,
  actions: ChainRecoveryAction[]
): Promise<{ deletedEntryIds: string[] }> {
  const toDelete = actions.filter((a) => a.action === "delete").map((a) => a.entryId);
  if (toDelete.length === 0) return { deletedEntryIds: [] };

  const client: PoolClient = await pool.connect();
  try {
    await client.query("begin");
    await lockEmployeeForManualEntry(client, employeeId);

    // Not filtered to deleted_at is null here — an entryId that genuinely
    // doesn't belong to this employee at all must still be rejected
    // (cross-employee safety), but one that's already deleted (a repeated
    // call with the same action list) must be a graceful no-op, not an
    // error — that's what makes this idempotent on retry.
    const { rows } = await client.query<{ id: string; deleted_at: string | null }>(
      `select id, deleted_at from time_entries where id = any($1::uuid[]) and employee_id = $2 for update`,
      [toDelete, employeeId]
    );
    const foundIds = new Set(rows.map((r) => r.id));
    const missing = toDelete.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      await client.query("rollback");
      throw new RunawayChainRecoveryError(`Entry not found (or does not belong to this employee): ${missing.join(", ")}`);
    }

    const alreadyDeleted = new Set(rows.filter((r) => r.deleted_at !== null).map((r) => r.id));
    const toActuallyDelete = toDelete.filter((id) => !alreadyDeleted.has(id));

    // Deletion's own audit trail is deleted_by_employee_id/deletion_reason
    // on the row itself — the same convention every deletion route in
    // inputs.ts already uses (time_entry_corrections' field_name check
    // constraint only permits 'ended_at'/'started_at', i.e. corrections to
    // a LIVE field; it was never meant for recording a deletion).
    if (toActuallyDelete.length > 0) {
      await client.query(
        `update time_entries
           set deleted_at = now(), deleted_by_employee_id = $2, deletion_reason = $3
         where id = any($1::uuid[])`,
        [toActuallyDelete, adminId, RUNAWAY_CHAIN_RECOVERY_REASON]
      );
    }

    await client.query("commit");
    return { deletedEntryIds: toActuallyDelete };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
