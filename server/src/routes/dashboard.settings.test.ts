// Integration tests for GET/PUT /api/dashboard/settings — role gating,
// full-replace semantics, derived (never client-settable) card type,
// inactive-activity rejection, and persistence across reload. Same
// real-HTTP-against-real-database convention used throughout this repo.
//
// Run with: npm run test:dashboard-settings
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
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
  const activityIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployeeWithRole(label: string, securityRoleId: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Dashboard Settings ${label} ${RUN_ID}`, `qa-dashboard-settings-${label.toLowerCase()}-${RUN_ID}@test.local`, securityRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    const adminId = await insertEmployeeWithRole("Admin", await roleId("Administrator"));
    const employeeActorId = await insertEmployeeWithRole("Actor", await roleId("Employee"));
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });
    const employeeToken = signSession({ id: employeeActorId, firstName: "QA", lastName: `Employee ${RUN_ID}`, securityRole: "Employee", teamRole: "Team Member" });

    async function insertActivity(label: string, densitySource: "plants" | "stems" | null, isActive = true): Promise<string> {
      const { rows } = await pool.query(
        `insert into activities (name, is_active, density_source) values ($1, $2, $3) returning id`,
        [`QA Dashboard Settings ${label} ${RUN_ID}`, isActive, densitySource]
      );
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    const rowStemActivity = await insertActivity("RowStem", "stems");
    const pickingActivity = await insertActivity("Picking", null);
    const inactiveActivity = await insertActivity("Inactive", null, false);

    // -----------------------------------------------------------------
    // A) GET/PUT /settings require Administrator/Manager, not a plain Employee.
    // -----------------------------------------------------------------
    {
      const getAsEmployee = await call("GET", "/api/dashboard/settings", { token: employeeToken });
      check(getAsEmployee.status === 403, "A) an Employee cannot view dashboard settings", getAsEmployee.body);

      const putAsEmployee = await call("PUT", "/api/dashboard/settings", {
        token: employeeToken,
        body: { activityIds: [rowStemActivity] },
      });
      check(putAsEmployee.status === 403, "13) an Employee cannot change dashboard settings", putAsEmployee.body);
    }

    // -----------------------------------------------------------------
    // B) GET /settings lists activities with the correct DERIVED card type.
    // -----------------------------------------------------------------
    {
      const res = await call("GET", "/api/dashboard/settings", { token: adminToken });
      const rowStemEntry = res.body?.activities?.find((a: any) => a.activityId === rowStemActivity);
      const pickingEntry = res.body?.activities?.find((a: any) => a.activityId === pickingActivity);
      check(
        res.status === 200 && rowStemEntry?.cardType === "row_stem" && pickingEntry?.cardType === "picking",
        "B) card type is correctly derived from density_source (never a stored/selected value)",
        { rowStemEntry, pickingEntry }
      );
    }

    // -----------------------------------------------------------------
    // C) PUT /settings full-replace: selecting A+B then replacing with just
    //    B leaves ONLY B selected — not a merge/union.
    // -----------------------------------------------------------------
    {
      const first = await call("PUT", "/api/dashboard/settings", {
        token: adminToken,
        body: { activityIds: [rowStemActivity, pickingActivity] },
      });
      check(first.status === 200, "C) initial PUT with two activities succeeds", first.body);

      const second = await call("PUT", "/api/dashboard/settings", {
        token: adminToken,
        body: { activityIds: [pickingActivity] },
      });
      const selected = second.body?.activities?.filter((a: any) => a.selected).map((a: any) => a.activityId);
      check(
        second.status === 200 && selected?.length === 1 && selected[0] === pickingActivity,
        "C) a second PUT fully replaces the selection, not merges with the first",
        selected
      );
    }

    // -----------------------------------------------------------------
    // 12) Settings persist after "reload" — a fresh GET reflects the last
    //     saved PUT exactly.
    // -----------------------------------------------------------------
    {
      const reload = await call("GET", "/api/dashboard/settings", { token: adminToken });
      const selected = reload.body?.activities?.filter((a: any) => a.selected).map((a: any) => a.activityId);
      check(
        selected?.length === 1 && selected[0] === pickingActivity,
        "12) dashboard settings persist across a fresh GET (reload)",
        selected
      );
    }

    // -----------------------------------------------------------------
    // D) PUT rejects an inactive activity id — it can't be newly selected.
    // -----------------------------------------------------------------
    {
      const res = await call("PUT", "/api/dashboard/settings", {
        token: adminToken,
        body: { activityIds: [rowStemActivity, inactiveActivity] },
      });
      check(res.status === 400, "D) selecting an inactive activity is rejected", res.body);
    }

    // -----------------------------------------------------------------
    // E) PUT rejects an unknown/invalid activity id.
    // -----------------------------------------------------------------
    {
      const res = await call("PUT", "/api/dashboard/settings", {
        token: adminToken,
        body: { activityIds: ["00000000-0000-0000-0000-000000000000"] },
      });
      check(res.status === 400, "E) an unknown activity id is rejected", res.body);
    }

    // -----------------------------------------------------------------
    // F) An empty selection is valid (clears the dashboard entirely).
    // -----------------------------------------------------------------
    {
      const res = await call("PUT", "/api/dashboard/settings", { token: adminToken, body: { activityIds: [] } });
      const selected = res.body?.activities?.filter((a: any) => a.selected);
      check(res.status === 200 && selected?.length === 0, "F) an empty activityIds array clears the dashboard config", res.body);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (activityIds.length) {
      await tryDelete("dashboard_activities", () => pool.query(`delete from dashboard_activities where activity_id = any($1::uuid[])`, [activityIds]));
      await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    }
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
