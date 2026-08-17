// Reproduces and locks in the fix for the reported "Density source: Stems /
// Speed unit: plants/hour" invalid configuration: POST/PATCH /api/activities
// must never let speed_unit disagree with density_source. Whenever
// density_source is (or remains) non-null, speed_unit is derived server-side
// — plants -> plants/hour, stems -> stems/hour — regardless of what the
// client sends, including a PATCH that touches an unrelated field on an
// activity already saved with a mismatch from before this check existed
// (self-healing). Only a density_source of null leaves speed_unit as free
// text.
//
// Run with: npm run test:activities-density-speed-unit
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import activitiesRouter from "./activities";

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
  app.use("/api/activities", activitiesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
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

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Density Unit Admin ${RUN_ID}`, `qa-density-unit-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    // -----------------------------------------------------------------
    // 1) Create with a client-sent speedUnit that CONTRADICTS densitySource
    //    — the server must override it, never trust the client's value.
    // -----------------------------------------------------------------
    {
      const res = await call("POST", "/api/activities", {
        token: adminToken,
        body: { name: `QA Density Unit Stems ${RUN_ID}`, densitySource: "stems", speedUnit: "plants/hour", minimumDurationMinutes: 0 },
      });
      check(res.status === 201, "1) create succeeds", res.body);
      if (res.body?.activity?.id) activityIds.push(res.body.activity.id);
      check(res.body?.activity?.speedUnit === "stems/hour", "1) speedUnit is forced to stems/hour, ignoring the client's conflicting plants/hour", res.body?.activity);
    }

    // -----------------------------------------------------------------
    // 2) Create with densitySource 'plants' and no speedUnit sent at all.
    // -----------------------------------------------------------------
    {
      const res = await call("POST", "/api/activities", {
        token: adminToken,
        body: { name: `QA Density Unit Plants ${RUN_ID}`, densitySource: "plants", minimumDurationMinutes: 0 },
      });
      check(res.status === 201, "2) create succeeds", res.body);
      if (res.body?.activity?.id) activityIds.push(res.body.activity.id);
      check(res.body?.activity?.speedUnit === "plants/hour", "2) speedUnit is derived as plants/hour with none sent", res.body?.activity);
    }

    // -----------------------------------------------------------------
    // 3) Create with densitySource null — free-text speedUnit is stored
    //    exactly as sent, untouched by any derivation.
    // -----------------------------------------------------------------
    let freeTextActivityId!: string;
    {
      const res = await call("POST", "/api/activities", {
        token: adminToken,
        body: { name: `QA Density Unit Picking ${RUN_ID}`, densitySource: null, speedUnit: "kg/hour", minimumDurationMinutes: 0 },
      });
      check(res.status === 201, "3) create succeeds", res.body);
      freeTextActivityId = res.body?.activity?.id;
      if (freeTextActivityId) activityIds.push(freeTextActivityId);
      check(res.body?.activity?.speedUnit === "kg/hour", "3) speedUnit is left as free text when densitySource is null", res.body?.activity);
    }

    // -----------------------------------------------------------------
    // 4) PATCH: setting densitySource on a previously non-density activity,
    //    without sending speedUnit, still forces the derived unit.
    // -----------------------------------------------------------------
    {
      const res = await call("PATCH", `/api/activities/${freeTextActivityId}`, {
        token: adminToken,
        body: { densitySource: "stems" },
      });
      check(res.status === 200, "4) patch succeeds", res.body);
      check(res.body?.activity?.speedUnit === "stems/hour", "4) patch that only sets densitySource still forces speedUnit to stems/hour", res.body?.activity);
    }

    // -----------------------------------------------------------------
    // 5) Self-healing: an activity already saved with a mismatch (as if by
    //    a client predating this check, simulated via direct SQL) gets
    //    speedUnit corrected the next time it's patched at all — even for
    //    a completely unrelated field like normalSpeed.
    // -----------------------------------------------------------------
    let mismatchedActivityId!: string;
    {
      const { rows } = await pool.query(
        `insert into activities (name, is_active, density_source, speed_unit) values ($1, true, 'stems', 'plants/hour') returning id`,
        [`QA Density Unit Legacy Mismatch ${RUN_ID}`]
      );
      mismatchedActivityId = rows[0].id;
      activityIds.push(mismatchedActivityId);

      const res = await call("PATCH", `/api/activities/${mismatchedActivityId}`, {
        token: adminToken,
        body: { normalSpeed: 500 },
      });
      check(res.status === 200, "5) patch succeeds", res.body);
      check(res.body?.activity?.speedUnit === "stems/hour", "5) an unrelated field patch self-heals a pre-existing mismatch to stems/hour", res.body?.activity);
    }

    // -----------------------------------------------------------------
    // 6) PATCH: clearing densitySource back to null lets speedUnit be set
    //    as free text again.
    // -----------------------------------------------------------------
    {
      const res = await call("PATCH", `/api/activities/${mismatchedActivityId}`, {
        token: adminToken,
        body: { densitySource: null, speedUnit: "rows/hour" },
      });
      check(res.status === 200, "6) patch succeeds", res.body);
      check(res.body?.activity?.speedUnit === "rows/hour", "6) clearing densitySource allows a free-text speedUnit again", res.body?.activity);
      check(res.body?.activity?.densitySource === null, "6) densitySource is actually cleared", res.body?.activity);
    }

    // -----------------------------------------------------------------
    // 7) Invalid densitySource is still rejected with a 400, exactly as
    //    before — this fix doesn't relax that validation.
    // -----------------------------------------------------------------
    {
      const res = await call("POST", "/api/activities", {
        token: adminToken,
        body: { name: `QA Density Unit Invalid ${RUN_ID}`, densitySource: "kg", minimumDurationMinutes: 0 },
      });
      check(res.status === 400 && res.body?.errors?.densitySource, "7) an invalid densitySource is still rejected", res.body);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
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
