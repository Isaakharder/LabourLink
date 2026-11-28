// GET /api/inputs/daily never writes (2026-11-28): opening Inputs for a day
// creates and changes nothing — automatic breaks are added only by the
// auto-breaks worker (server/src/lib/autoBreakWorker.ts), and only for
// employees with Auto breaks on. This replaced the earlier behaviour, where
// loading a day ran break reconciliation and split work around profile items
// marked auto_add. Runs the real router over real HTTP against the real
// database, same convention as inputs.manualEntries.test.ts.
//
// Run with: npm run test:inputs-performance
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
import inputsRouter from "./inputs";

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
// A past date so reconcileEmployeeBreaks is actually eligible to run (GET
// /daily skips it entirely for a future date) but recent enough that
// "today" in any timezone this test could run in is still after it.
const TEST_DATE = "2019-06-04";

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/inputs", inputsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, token: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  let adminActor!: { id: string; first_name: string; last_name: string };
  let target!: { id: string };
  let breakProfile!: { id: string };
  let activity!: { id: string };

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    adminActor = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id, first_name, last_name`,
        [
          "QA",
          `Perf Admin ${RUN_ID}`,
          `qa-inputs-perf-admin-${RUN_ID}@test.local`,
          await roleId("Administrator"),
          teamRoleId,
          fakePinHash,
        ]
      )
    ).rows[0];
    const adminToken = signSession({
      id: adminActor.id,
      firstName: adminActor.first_name,
      lastName: adminActor.last_name,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });

    breakProfile = (
      await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
        `QA Inputs Perf Profile ${RUN_ID}`,
      ])
    ).rows[0];
    await pool.query(
      `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
       values ($1, 'QA Auto Break', '10:00:00', '10:15:00', false, true, 1)`,
      [breakProfile!.id]
    );

    activity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA Inputs Perf Activity ${RUN_ID}`,
      ])
    ).rows[0];

    target = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id,
                                auto_breaks_enabled, auto_breaks_effective_from)
         values ($1, $2, $3, $4, $5, $6, true, $7, true, '2000-01-01') returning id`,
        [
          "QA",
          `Inputs Perf Target ${RUN_ID}`,
          `qa-inputs-perf-target-${RUN_ID}@test.local`,
          await roleId("Employee"),
          teamRoleId,
          fakePinHash,
          breakProfile!.id,
        ]
      )
    ).rows[0];

    // A work entry fully covering the 10:00-10:15 window of an item still
    // marked auto_add, for an employee with Auto breaks on — the old
    // Inputs-load reconciliation would have split it.
    await pool.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
       values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')`,
      [
        target!.id,
        activity!.id,
        zonedWallTimeToUtc(2019, 6, 4, 9, 0, 0).toISOString(),
        zonedWallTimeToUtc(2019, 6, 4, 11, 0, 0).toISOString(),
      ]
    );

    const res = await call(
      "GET",
      `/api/inputs/daily?employeeId=${target!.id}&date=${TEST_DATE}`,
      adminToken
    );
    check(res.status === 200, "GET /daily succeeds", res.body);

    const before = (await pool.query(`select count(*)::int as n from time_entries where employee_id = $1`, [target!.id])).rows[0].n;
    check((res.body?.breaks ?? []).length === 0, "opening Inputs adds no break", res.body?.breaks);
    check(
      (res.body?.runs ?? []).length === 1 && (res.body?.runs?.[0]?.segmentIds ?? []).length === 1,
      "the day still shows the one unsplit work entry",
      res.body?.runs
    );
    check(before === 1, "nothing was written to the database", before);
    const { rows: occ } = await pool.query(`select count(*)::int as n from break_occurrences where employee_id = $1`, [target!.id]);
    check(occ[0].n === 0, "no break occurrence was recorded by reading", occ[0]);

    // A second call must be idempotent — reconciliation runs again (it's
    // not conditioned on the first call), but must not double the break or
    // re-split further.
    const res2 = await call(
      "GET",
      `/api/inputs/daily?employeeId=${target!.id}&date=${TEST_DATE}`,
      adminToken
    );
    check(
      (res2.body?.breaks ?? []).length === (res.body?.breaks ?? []).length &&
        (res2.body?.runs ?? []).length === (res.body?.runs ?? []).length,
      "a repeated GET /daily call is idempotent — same shape, nothing duplicated",
      { first: { runs: res.body?.runs?.length, breaks: res.body?.breaks?.length }, second: { runs: res2.body?.runs?.length, breaks: res2.body?.breaks?.length } }
    );
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-inputs-perf-%-${RUN_ID}@test.local`,
      ])
    );
    for (const employee of [target, adminActor]) {
      if (employee) await tryDelete("employees", () => pool.query("delete from employees where id = $1", [employee.id]));
    }
    if (activity) await tryDelete("activities", () => pool.query("delete from activities where id = $1", [activity!.id]));
    if (breakProfile) {
      await tryDelete("break_profile_items", () =>
        pool.query("delete from break_profile_items where break_profile_id = $1", [breakProfile!.id])
      );
      await tryDelete("break_profiles", () => pool.query("delete from break_profiles where id = $1", [breakProfile!.id]));
    }
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
