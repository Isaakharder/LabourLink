// Integration tests for GET/POST /api/mobile-sync/conflicts — the admin
// review surface for mobile_time_events rows the sync ledger recorded as
// 'permanent_conflict'/'sequence_gap' (see mobileSyncConflicts.ts and
// mobileTime.ts's POST /sync/events). Real router over real HTTP against
// the real database, RUN_ID-suffixed disposable QA fixtures.
//
// Covers: role gating (Administrator/Manager only), listing only unresolved
// conflicts by default, includeResolved=true showing both, marking one
// resolved (with a note) actually persisting resolved_at/resolved_by/
// resolution_note and moving it out of the default (unresolved) list, and
// unresolve reverting that.
//
// Run with: npm run test:mobile-sync-conflicts
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import mobileSyncConflictsRouter from "./mobileSyncConflicts";

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
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile-sync", mobileSyncConflictsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const eventIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployeeWithRole(label: string, securityRoleId: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Sync Conflicts ${label} ${RUN_ID}`, `qa-sync-conflicts-${label.toLowerCase()}-${RUN_ID}@test.local`, securityRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    const adminId = await insertEmployeeWithRole("Admin", await roleId("Administrator"));
    const actorId = await insertEmployeeWithRole("Actor", await roleId("Employee"));
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });
    const employeeToken = signSession({ id: actorId, firstName: "QA", lastName: `Employee ${RUN_ID}`, securityRole: "Employee", teamRole: "Team Member" });

    const deviceIdentifier = randomUUID();
    const deviceRow = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        deviceIdentifier,
        `QA Sync Conflicts Device ${RUN_ID}`,
      ])
    ).rows[0];
    deviceIds.push(deviceRow.id);

    async function insertConflictEvent(status: "permanent_conflict" | "sequence_gap", reason: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into mobile_time_events
           (client_event_id, device_id, employee_id, device_seq, event_type, occurred_at_utc,
            local_tz_offset_minutes, payload, processing_status, conflict_reason)
         values ($1, $2, $3, $4, 'work_start', now(), 0, '{}'::jsonb, $5, $6)
         returning id`,
        [randomUUID(), deviceRow.id, actorId, eventIds.length + 1, status, reason]
      );
      eventIds.push(rows[0].id);
      return rows[0].id;
    }

    const conflictId = await insertConflictEvent("permanent_conflict", "missing or invalid activityId");
    const gapId = await insertConflictEvent("sequence_gap", "out of order device_seq");

    // -----------------------------------------------------------------
    // A) role gating — an Employee cannot view or resolve conflicts.
    // -----------------------------------------------------------------
    const listAsEmployee = await call("GET", "/api/mobile-sync/conflicts", { token: employeeToken });
    check(listAsEmployee.status === 403, "A) an Employee cannot list sync conflicts", listAsEmployee.body);

    const resolveAsEmployee = await call("POST", `/api/mobile-sync/conflicts/${conflictId}/resolve`, { token: employeeToken });
    check(resolveAsEmployee.status === 403, "A) an Employee cannot resolve a sync conflict", resolveAsEmployee.body);

    // -----------------------------------------------------------------
    // B) default list (no includeResolved) returns both unresolved
    //    conflicts, most recent first, with device/employee names joined.
    // -----------------------------------------------------------------
    const listDefault = await call("GET", "/api/mobile-sync/conflicts", { token: adminToken });
    check(listDefault.status === 200, "B) admin can list sync conflicts", listDefault.body);
    const ids = (listDefault.body.conflicts as any[]).map((c) => c.id);
    check(ids.includes(conflictId) && ids.includes(gapId), "B) both unresolved conflicts appear in the default list", listDefault.body);
    const conflictRow = (listDefault.body.conflicts as any[]).find((c) => c.id === conflictId);
    check(
      conflictRow?.deviceName === `QA Sync Conflicts Device ${RUN_ID}` && conflictRow?.employeeName === `QA Sync Conflicts Actor ${RUN_ID}`,
      "B) the row carries the joined device/employee names, not just raw ids",
      conflictRow
    );
    check(conflictRow?.conflictReason === "missing or invalid activityId", "B) conflictReason is included");
    check(conflictRow?.resolvedAt === null, "B) an unresolved row has resolvedAt: null");

    // -----------------------------------------------------------------
    // C) resolving one persists resolved_at/resolved_by/resolution_note
    //    and removes it from the default (unresolved-only) list.
    // -----------------------------------------------------------------
    const resolve = await call("POST", `/api/mobile-sync/conflicts/${conflictId}/resolve`, {
      token: adminToken,
      body: { note: "Fixed via a manual Inputs correction for this employee's shift." },
    });
    check(resolve.status === 200, "C) admin can resolve a conflict", resolve.body);
    check(resolve.body.conflict?.resolvedAt !== null, "C) resolvedAt is now set", resolve.body);
    check(resolve.body.conflict?.resolvedBy === `QA Sync Conflicts Admin ${RUN_ID}`, "C) resolvedBy is the acting admin's name", resolve.body);
    check(
      resolve.body.conflict?.resolutionNote === "Fixed via a manual Inputs correction for this employee's shift.",
      "C) resolutionNote is persisted verbatim",
      resolve.body
    );

    const listAfterResolve = await call("GET", "/api/mobile-sync/conflicts", { token: adminToken });
    const idsAfter = (listAfterResolve.body.conflicts as any[]).map((c) => c.id);
    check(!idsAfter.includes(conflictId), "C) the resolved conflict no longer appears in the default (unresolved) list");
    check(idsAfter.includes(gapId), "C) the still-unresolved sequence_gap still appears");

    // -----------------------------------------------------------------
    // D) includeResolved=true shows both again.
    // -----------------------------------------------------------------
    const listIncludeResolved = await call("GET", "/api/mobile-sync/conflicts?includeResolved=true", { token: adminToken });
    const idsIncl = (listIncludeResolved.body.conflicts as any[]).map((c) => c.id);
    check(idsIncl.includes(conflictId) && idsIncl.includes(gapId), "D) includeResolved=true shows the resolved conflict too", listIncludeResolved.body);

    // -----------------------------------------------------------------
    // E) unresolve reverts it back to the default list.
    // -----------------------------------------------------------------
    const unresolve = await call("POST", `/api/mobile-sync/conflicts/${conflictId}/unresolve`, { token: adminToken });
    check(unresolve.status === 200 && unresolve.body.conflict?.resolvedAt === null, "E) unresolve clears resolvedAt", unresolve.body);
    const listAfterUnresolve = await call("GET", "/api/mobile-sync/conflicts", { token: adminToken });
    const idsFinal = (listAfterUnresolve.body.conflicts as any[]).map((c) => c.id);
    check(idsFinal.includes(conflictId), "E) the un-resolved conflict is back in the default list");

    // -----------------------------------------------------------------
    // F) resolving a nonexistent id is a 404, not a silent success.
    // -----------------------------------------------------------------
    const resolveMissing = await call("POST", `/api/mobile-sync/conflicts/${randomUUID()}/resolve`, { token: adminToken });
    check(resolveMissing.status === 404, "F) resolving a nonexistent conflict id is a 404", resolveMissing.body);
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where id = any($1::uuid[])`, [eventIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }

    const leftover = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    check(Number(leftover.rows[0].count) === 0, "Z) all QA fixtures cleaned up, none left orphaned");

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
