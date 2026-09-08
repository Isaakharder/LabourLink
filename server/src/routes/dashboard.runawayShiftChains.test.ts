// Integration tests for the new Dashboard surface backing the runaway-shift
// safety cutoff (runawayShiftAutoCutoff.ts): GET/PATCH /api/dashboard/org-settings's
// new autoSafetyCutoffThresholdHours field (including its cross-validation
// against the review-only alert threshold), and the
// /api/dashboard/runaway-shift-chains list/preview/apply routes. Real
// router over real HTTP against the real database, RUN_ID-suffixed
// disposable QA fixtures.
//
// Run with: npx ts-node src/routes/dashboard.runawayShiftChains.test.ts
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import dashboardRouter from "./dashboard";

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
  app.use("/api/dashboard", dashboardRouter);
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
      headers: { "Content-Type": "application/json", ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const activityIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployeeWithRole(label: string, securityRoleId: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`RunawayChains ${label} ${RUN_ID}`, `qa-runaway-chains-${label.toLowerCase()}-${RUN_ID}@test.local`, securityRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    const adminId = await insertEmployeeWithRole("Admin", await roleId("Administrator"));
    const managerId = await insertEmployeeWithRole("Manager", await roleId("Manager"));
    const employeeActorId = await insertEmployeeWithRole("Actor", await roleId("Employee"));
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });
    const managerToken = signSession({ id: managerId, firstName: "QA", lastName: `Manager ${RUN_ID}`, securityRole: "Manager", teamRole: "Team Member" });
    const employeeToken = signSession({ id: employeeActorId, firstName: "QA", lastName: `Employee ${RUN_ID}`, securityRole: "Employee", teamRole: "Team Member" });

    // -----------------------------------------------------------------
    // A) GET/PATCH /org-settings role gating, unchanged from before this
    //    feature: GET is Administrator/Manager, PATCH is Administrator-only.
    // -----------------------------------------------------------------
    {
      const getAsEmployee = await call("GET", "/api/dashboard/org-settings", { token: employeeToken });
      check(getAsEmployee.status === 403, "A) an Employee cannot view org-settings", getAsEmployee.body);

      const getAsManager = await call("GET", "/api/dashboard/org-settings", { token: managerToken });
      check(
        getAsManager.status === 200 && typeof getAsManager.body?.autoSafetyCutoffThresholdHours === "number",
        "A) a Manager can view org-settings, including the new autoSafetyCutoffThresholdHours field",
        getAsManager.body
      );

      const patchAsManager = await call("PATCH", "/api/dashboard/org-settings", {
        token: managerToken,
        body: { autoSafetyCutoffThresholdHours: 96 },
      });
      check(patchAsManager.status === 403, "A) a Manager cannot change org-settings (Administrator-only)", patchAsManager.body);
    }

    // -----------------------------------------------------------------
    // B) The automatic cutoff threshold must stay strictly greater than
    //    the review-only alert threshold — validated across both the
    //    current stored value and whichever field a request updates.
    // -----------------------------------------------------------------
    {
      const before = await call("GET", "/api/dashboard/org-settings", { token: adminToken });
      const originalAlert = before.body.longOpenShiftAlertThresholdHours;
      const originalCutoff = before.body.autoSafetyCutoffThresholdHours;

      const tooLow = await call("PATCH", "/api/dashboard/org-settings", {
        token: adminToken,
        body: { autoSafetyCutoffThresholdHours: 24, longOpenShiftAlertThresholdHours: 100 },
      });
      check(
        tooLow.status === 400 && /must be greater than/i.test(tooLow.body?.error ?? ""),
        "B) rejects a cutoff threshold at-or-below the alert threshold, even when both are supplied together",
        tooLow.body
      );

      // Raising ONLY the alert threshold above the currently-stored cutoff
      // must also be rejected — the cross-check compares against the
      // OTHER field's current value, not just values in this one request.
      const raiseAlertPastStoredCutoff = await call("PATCH", "/api/dashboard/org-settings", {
        token: adminToken,
        body: { longOpenShiftAlertThresholdHours: originalCutoff + 10 },
      });
      check(
        raiseAlertPastStoredCutoff.status === 400,
        "B) raising the alert threshold above the currently-stored cutoff threshold alone is also rejected",
        raiseAlertPastStoredCutoff.body
      );

      const valid = await call("PATCH", "/api/dashboard/org-settings", {
        token: adminToken,
        body: { autoSafetyCutoffThresholdHours: 100 },
      });
      check(
        valid.status === 200 && valid.body.autoSafetyCutoffThresholdHours === 100,
        "B) a valid cutoff threshold (still above the alert threshold) is accepted",
        valid.body
      );

      const outOfBounds = await call("PATCH", "/api/dashboard/org-settings", {
        token: adminToken,
        body: { autoSafetyCutoffThresholdHours: 10 },
      });
      check(
        outOfBounds.status === 400 && /between 24 and 336/.test(outOfBounds.body?.error ?? ""),
        "B) rejects a cutoff threshold below the 24h floor, independent of the alert-threshold comparison",
        outOfBounds.body
      );

      // Restore defaults so this test never leaves shared org-wide config
      // mutated for other suites.
      await call("PATCH", "/api/dashboard/org-settings", {
        token: adminToken,
        body: { autoSafetyCutoffThresholdHours: originalCutoff, longOpenShiftAlertThresholdHours: originalAlert },
      });
    }

    // -----------------------------------------------------------------
    // C) /runaway-shift-chains: lists a manually-seeded pending chain,
    //    previews its classification, and enforces Administrator-only apply.
    // -----------------------------------------------------------------
    {
      const targetId = await insertEmployeeWithRole("Target", await roleId("Employee"));
      const deviceIdentifier = randomUUID();
      const { rows: deviceRows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [deviceIdentifier, `QA RunawayChains Device ${RUN_ID}`]
      );
      deviceIds.push(deviceRows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRows[0].id, targetId]);
      const { rows: activityRows } = await pool.query(
        `insert into activities (name, is_active) values ($1, true) returning id`,
        [`QA RunawayChains Activity ${RUN_ID}`]
      );
      activityIds.push(activityRows[0].id);

      const trueStart = new Date(Date.now() - 100 * 60 * 60 * 1000);
      const cutoffAt = new Date(trueStart.getTime() + 72 * 60 * 60 * 1000);
      const { rows: entryRows } = await pool.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
            safety_cutoff_at, genuine_anchor_at)
         values ($1, $2, 'work', $3, $4, $5, $6, 'manual', $6, $5) returning id`,
        [targetId, deviceRows[0].id, activityRows[0].id, randomUUID(), trueStart, cutoffAt]
      );
      const terminalId = entryRows[0].id;

      const listAsManager = await call("GET", "/api/dashboard/runaway-shift-chains", { token: managerToken });
      check(
        listAsManager.status === 200 && listAsManager.body?.chains?.some((c: any) => c.employeeId === targetId),
        "C) the seeded pending chain appears in the needs-review list",
        listAsManager.body
      );

      const previewAsManager = await call("GET", `/api/dashboard/runaway-shift-chains/${targetId}/preview`, { token: managerToken });
      check(
        previewAsManager.status === 200 && previewAsManager.body?.entries?.some((e: any) => e.id === terminalId),
        "C) preview includes the terminal entry",
        previewAsManager.body
      );

      const applyAsManager = await call("POST", `/api/dashboard/runaway-shift-chains/${targetId}/apply`, {
        token: managerToken,
        body: { actions: [{ entryId: terminalId, action: "keep" }] },
      });
      check(applyAsManager.status === 403, "C) a Manager cannot apply recovery actions — Administrator-only", applyAsManager.body);

      const applyEmptyActions = await call("POST", `/api/dashboard/runaway-shift-chains/${targetId}/apply`, {
        token: adminToken,
        body: { actions: [] },
      });
      check(applyEmptyActions.status === 400, "C) apply rejects an empty actions array rather than silently no-oping", applyEmptyActions.body);

      const applyKeep = await call("POST", `/api/dashboard/runaway-shift-chains/${targetId}/apply`, {
        token: adminToken,
        body: { actions: [{ entryId: terminalId, action: "keep" }] },
      });
      check(applyKeep.status === 200 && applyKeep.body?.deletedEntryIds?.length === 0, "C) an Administrator applying a 'keep' action succeeds and deletes nothing", applyKeep.body);
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
      await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
      await tryDelete("org_settings (clear updated_by)", () =>
        pool.query(`update org_settings set updated_by_employee_id = null where updated_by_employee_id = any($1::uuid[])`, [employeeIds])
      );
    }
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
