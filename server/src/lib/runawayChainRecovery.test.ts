// Integration test for runawayChainRecovery.ts — the admin recovery
// preview/apply tooling for a chain the runaway-shift safety cutoff
// (runawayShiftAutoCutoff.ts) has already stopped. Real DB, RUN_ID-suffixed
// disposable QA fixtures, retry-then-fail cleanup (same convention as
// midnightRollover.test.ts).
//
// Covers: preview classifies entries correctly without writing anything;
// apply requires an explicit per-entry action list (never "apply
// everything"); apply never touches an entry belonging to a different
// employee, even if explicitly listed; apply is idempotent (re-applying
// the same delete list a second time is a no-op, not an error); and the
// audit trail for a delete.
//
// Run with: npx ts-node src/lib/runawayChainRecovery.test.ts
import "dotenv/config";
import { randomUUID } from "crypto";
import { pool } from "../db";
import {
  applyRunawayChainRecovery,
  getPendingRunawayChains,
  previewRunawayChainRecovery,
  RUNAWAY_CHAIN_RECOVERY_REASON,
  RunawayChainRecoveryError,
} from "./runawayChainRecovery";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const RUN_ID = Date.now();

async function main() {
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const activityIds: string[] = [];
  const adminId: string = await (async () => {
    const roleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
    const { rows } = await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
       values ('QA', $1, $2, $3, $4, $5, true) returning id`,
      [`RecoveryAdmin ${RUN_ID}`, `qa-recovery-admin-${RUN_ID}@test.local`, roleId, teamRoleId, fakePinHash]
    );
    employeeIds.push(rows[0].id);
    return rows[0].id;
  })();

  try {
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Recovery-${label}-${RUN_ID}`, `qa-recovery-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertDevice(employeeId: string, label: string): Promise<string> {
      const deviceIdentifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [deviceIdentifier, `QA Recovery Device ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return rows[0].id;
    }
    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Recovery Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    // Two employees, each with their own runaway chain: a true (ambiguous,
    // no corroborating signal) origin entry, one synthetic midnight_rollover
    // hop, and a terminal entry the safety cutoff has already closed.
    async function buildRunawayChain(label: string): Promise<{ employeeId: string; originId: string; hopId: string; terminalId: string }> {
      const employeeId = await insertEmployee(label);
      const deviceId = await insertDevice(employeeId, label);
      const trueStart = new Date(Date.now() - 100 * 60 * 60 * 1000);
      const { rows: originRows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, $2, 'work', $3, $4, $5, $6, 'manual') returning id`,
        [employeeId, deviceId, activityId, randomUUID(), trueStart, new Date(trueStart.getTime() + 12 * 60 * 60 * 1000)]
      );
      const originId = originRows[0].id;
      const hopStart = new Date(trueStart.getTime() + 12 * 60 * 60 * 1000);
      const cutoffAt = new Date(trueStart.getTime() + 72 * 60 * 60 * 1000);
      const { rows: hopRows } = await pool.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, rollover_of_entry_id,
            safety_cutoff_at, genuine_anchor_at)
         values ($1, $2, 'work', $3, $4, $5, $6, 'midnight_rollover', $7, $6, $8) returning id`,
        [employeeId, deviceId, activityId, randomUUID(), hopStart, cutoffAt, originId, trueStart]
      );
      const hopId = hopRows[0].id;
      await pool.query(
        `insert into time_entry_corrections
           (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, null, 'ended_at', 'null', $3, 'runaway_shift_auto_cutoff')`,
        [hopId, employeeId, cutoffAt.toISOString()]
      );
      // hopId IS the terminal entry here (the one with safety_cutoff_at set)
      // — kept as a separate return field for readability at call sites.
      return { employeeId, originId, hopId, terminalId: hopId };
    }

    // -----------------------------------------------------------------
    // 1) Preview is read-only and classifies correctly.
    // -----------------------------------------------------------------
    const chainA = await buildRunawayChain("PreviewA");
    {
      const preview = await previewRunawayChainRecovery(chainA.employeeId);
      check(preview.length === 2, "1) preview returns both chain entries", preview.length);
      const origin = preview.find((p) => p.id === chainA.originId);
      const hop = preview.find((p) => p.id === chainA.hopId);
      check(origin?.classification === "ambiguous_manual_label", "1) the manual-sourced origin with no corroborating signal is ambiguous", origin);
      check(hop?.classification === "synthetic" && hop?.suggestedAction === "remove", "1) the midnight_rollover hop is synthetic, suggested remove", hop);

      const stillThere = await pool.query(`select deleted_at from time_entries where id = any($1::uuid[])`, [
        [chainA.originId, chainA.hopId],
      ]);
      check(
        stillThere.rows.every((r) => r.deleted_at === null),
        "1) preview never deletes or otherwise mutates anything"
      );

      const pending = await getPendingRunawayChains();
      check(pending.some((p) => p.employeeId === chainA.employeeId), "1) the chain shows up in the needs-review queue");
    }

    // -----------------------------------------------------------------
    // 2) apply requires an explicit action list — an empty list is a no-op,
    //    not an error, and deletes only what was explicitly listed.
    // -----------------------------------------------------------------
    const chainB = await buildRunawayChain("ApplyB");
    {
      const emptyResult = await applyRunawayChainRecovery(chainB.employeeId, adminId, []);
      check(emptyResult.deletedEntryIds.length === 0, "2) an empty action list deletes nothing");

      const keepOnly = await applyRunawayChainRecovery(chainB.employeeId, adminId, [{ entryId: chainB.originId, action: "keep" }]);
      check(keepOnly.deletedEntryIds.length === 0, "2) a 'keep' action deletes nothing");
      const originStillThere = await pool.query(`select deleted_at from time_entries where id = $1`, [chainB.originId]);
      check(originStillThere.rows[0]?.deleted_at === null, "2) the kept entry is untouched");

      const result = await applyRunawayChainRecovery(chainB.employeeId, adminId, [{ entryId: chainB.hopId, action: "delete" }]);
      check(
        result.deletedEntryIds.length === 1 && result.deletedEntryIds[0] === chainB.hopId,
        "2) delete removes exactly the listed entry"
      );
      const { rows: afterDelete } = await pool.query(
        `select deleted_at, deleted_by_employee_id, deletion_reason from time_entries where id = $1`,
        [chainB.hopId]
      );
      check(afterDelete[0]?.deleted_at !== null, "2) the entry is soft-deleted (deleted_at set), not hard-removed");
      check(
        afterDelete[0]?.deleted_by_employee_id === adminId,
        "2) the deletion is attributed to the acting administrator, never null — this row's own audit trail"
      );
      check(afterDelete[0]?.deletion_reason === RUNAWAY_CHAIN_RECOVERY_REASON, "2) deletion_reason records why");
      const originAfter = await pool.query(`select deleted_at from time_entries where id = $1`, [chainB.originId]);
      check(originAfter.rows[0]?.deleted_at === null, "2) the origin entry (not listed) is untouched by deleting the hop");
    }

    // -----------------------------------------------------------------
    // 3) Idempotency — re-applying the same delete a second time is a
    //    clean no-op-shaped success, not an error or a second deletion.
    // -----------------------------------------------------------------
    {
      const firstDeletedAt = (await pool.query(`select deleted_at from time_entries where id = $1`, [chainB.hopId])).rows[0].deleted_at;
      const second = await applyRunawayChainRecovery(chainB.employeeId, adminId, [{ entryId: chainB.hopId, action: "delete" }]);
      check(second.deletedEntryIds.length === 0, "3) re-deleting an already-deleted entry deletes nothing new", second);
      const secondDeletedAt = (await pool.query(`select deleted_at from time_entries where id = $1`, [chainB.hopId])).rows[0].deleted_at;
      check(
        new Date(secondDeletedAt).getTime() === new Date(firstDeletedAt).getTime(),
        "3) deleted_at is unchanged by the second call — no re-deletion timestamp bump"
      );
    }

    // -----------------------------------------------------------------
    // 4) Cross-employee safety: an entryId belonging to a DIFFERENT
    //    employee than the one named is rejected outright, not silently
    //    scoped or ignored.
    // -----------------------------------------------------------------
    const chainC = await buildRunawayChain("CrossEmployeeC");
    {
      let threw: unknown = null;
      try {
        await applyRunawayChainRecovery(chainC.employeeId, adminId, [{ entryId: chainA.hopId, action: "delete" }]);
      } catch (err) {
        threw = err;
      }
      check(
        threw instanceof RunawayChainRecoveryError,
        "4) applying against another employee's entry id is rejected with a typed error, not silently accepted"
      );
      const { rows: chainAHopAfter } = await pool.query(`select deleted_at from time_entries where id = $1`, [chainA.hopId]);
      check(
        chainAHopAfter[0]?.deleted_at === null,
        "4) the other employee's (chain A's) entry is completely untouched by the rejected call"
      );
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      const maxAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await fn();
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
      fail++;
      console.error(`FAIL: cleanup step "${label}" failed after ${maxAttempts} attempts:`, lastErr);
    }

    if (employeeIds.length) {
      await tryDelete("time_entry_corrections", () =>
        pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
