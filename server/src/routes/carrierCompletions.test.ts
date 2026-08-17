// Integration tests for the carrier (bin) completion endpoints — the
// carrier-scoped mirror of rowCompletions.ts. Same real-HTTP-against-real-
// database convention as greenhouseLayout.rowRestore.test.ts.
//
// Run with: npm run test:carrier-completions
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
import carrierCompletionsRouter from "./carrierCompletions";

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
  app.use("/api/carrier-completions", carrierCompletionsRouter);
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
  const carrierIds: string[] = [];
  const timeEntryIds: string[] = [];
  const completionIds: string[] = [];
  let activityId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployeeWithRole(label: string, securityRoleId: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Carrier Route ${label} ${RUN_ID}`, `qa-carrier-route-${label.toLowerCase()}-${RUN_ID}@test.local`, securityRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertEmployee(label: string): Promise<string> {
      return insertEmployeeWithRole(label, employeeRoleId);
    }

    // Real employees.employees rows (not just signed JWTs with a random id)
    // — carrier_completions.confirmed_by_employee_id is a real FK, so the
    // acting user in every one of these tests has to actually exist.
    const adminId = await insertEmployeeWithRole("Admin", await roleId("Administrator"));
    const managerId = await insertEmployeeWithRole("Manager", await roleId("Manager"));
    const employeeActorId = await insertEmployeeWithRole("Actor", employeeRoleId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });
    const managerToken = signSession({ id: managerId, firstName: "QA", lastName: `Manager ${RUN_ID}`, securityRole: "Manager", teamRole: "Team Member" });
    const employeeToken = signSession({ id: employeeActorId, firstName: "QA", lastName: `Employee ${RUN_ID}`, securityRole: "Employee", teamRole: "Team Member" });

    activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Carrier Route Activity ${RUN_ID}`])
    ).rows[0].id;

    async function insertCarrier(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [
        `QA Carrier Route ${label} ${RUN_ID}`,
      ]);
      carrierIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertWork(employeeId: string, carrierId: string, startHour: number, endHour: number | null): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 12, startHour, 0, 0);
      const endedAt = endHour !== null ? zonedWallTimeToUtc(2019, 6, 12, endHour, 0, 0) : null;
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, carrier_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, $3, gen_random_uuid(), $4, $5, 'manual') returning id`,
        [employeeId, activityId, carrierId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    const emp = await insertEmployee("Target");

    // -----------------------------------------------------------------
    // A) Candidates GET requires Administrator/Manager, not a plain Employee.
    // -----------------------------------------------------------------
    {
      const carrier = await insertCarrier("A");
      await insertWork(emp, carrier, 8, 9);

      const asEmployee = await call("GET", `/api/carrier-completions/candidates?carrierId=${carrier}`, { token: employeeToken });
      check(asEmployee.status === 403, "A) an Employee cannot browse candidates", asEmployee.body);

      const asManager = await call("GET", `/api/carrier-completions/candidates?carrierId=${carrier}`, { token: managerToken });
      check(
        asManager.status === 200 && asManager.body?.candidates?.length === 1,
        "A) a Manager can browse candidates and sees the pending run",
        asManager.body
      );
    }

    // -----------------------------------------------------------------
    // B) Confirming a single completed run succeeds (Administrator).
    // -----------------------------------------------------------------
    let confirmedEntryId!: string;
    {
      const carrier = await insertCarrier("B");
      confirmedEntryId = await insertWork(emp, carrier, 10, 11);

      const res = await call("POST", "/api/carrier-completions", { token: adminToken, body: { timeEntryIds: [confirmedEntryId] } });
      check(res.status === 201 && res.body?.carrierCompletion?.carrierId === carrier, "B) confirming a single completed run succeeds", res.body);
      if (res.body?.carrierCompletion?.id) completionIds.push(res.body.carrierCompletion.id);

      const { rows } = await pool.query(`select carrier_completion_id from carrier_completion_segments where time_entry_id = $1`, [confirmedEntryId]);
      check(rows.length === 1, "B) exactly one segment row links the confirmed entry to its completion", rows);
    }

    // -----------------------------------------------------------------
    // C) A Manager cannot confirm (Administrator-only), and confirming the
    //    same entry again is rejected (PK-as-FK dedup).
    // -----------------------------------------------------------------
    {
      const asManager = await call("POST", "/api/carrier-completions", { token: managerToken, body: { timeEntryIds: [confirmedEntryId] } });
      check(asManager.status === 403, "C) a Manager cannot confirm a bin completion", asManager.body);

      const again = await call("POST", "/api/carrier-completions", { token: adminToken, body: { timeEntryIds: [confirmedEntryId] } });
      check(again.status === 409, "C) confirming an already-completed entry again is rejected (dedup)", again.body);
    }

    // -----------------------------------------------------------------
    // D) An in-progress (not yet ended) entry cannot be confirmed.
    // -----------------------------------------------------------------
    {
      const carrier = await insertCarrier("D");
      const openEntry = await insertWork(emp, carrier, 12, null);

      const res = await call("POST", "/api/carrier-completions", { token: adminToken, body: { timeEntryIds: [openEntry] } });
      check(res.status === 400, "D) an in-progress entry cannot be combined into a completed bin", res.body);
    }

    // -----------------------------------------------------------------
    // E) Entries from different carriers cannot be combined into one
    //    completion.
    // -----------------------------------------------------------------
    {
      const carrierX = await insertCarrier("E-X");
      const carrierY = await insertCarrier("E-Y");
      const e1 = await insertWork(emp, carrierX, 13, 14);
      const e2 = await insertWork(emp, carrierY, 14, 15);

      const res = await call("POST", "/api/carrier-completions", { token: adminToken, body: { timeEntryIds: [e1, e2] } });
      check(res.status === 400, "E) entries from two different carriers cannot be combined", res.body);
    }

    // -----------------------------------------------------------------
    // F) GET /pending only returns carriers with genuinely unresolved
    //    segments for the given activity ids, and reflects a confirm
    //    immediately (a just-confirmed carrier drops off the list).
    // -----------------------------------------------------------------
    {
      const carrier = await insertCarrier("F");
      await insertWork(emp, carrier, 16, 17);

      const before = await call("GET", `/api/carrier-completions/pending?activityIds=${activityId}`, { token: adminToken });
      const foundBefore = before.body?.pending?.find((p: any) => p.carrierId === carrier);
      check(before.status === 200 && foundBefore?.pendingSegmentCount === 1, "F) a carrier with pending work appears in /pending", foundBefore);

      const { rows: candidateRows } = await pool.query(
        `select id from time_entries where carrier_id = $1 order by started_at asc limit 1`,
        [carrier]
      );
      const confirmRes = await call("POST", "/api/carrier-completions", { token: adminToken, body: { timeEntryIds: [candidateRows[0].id] } });
      if (confirmRes.body?.carrierCompletion?.id) completionIds.push(confirmRes.body.carrierCompletion.id);

      const after = await call("GET", `/api/carrier-completions/pending?activityIds=${activityId}`, { token: adminToken });
      const foundAfter = after.body?.pending?.find((p: any) => p.carrierId === carrier);
      check(!foundAfter, "F) a carrier drops off /pending once its only segment is confirmed", after.body?.pending);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (completionIds.length) {
      await tryDelete("carrier_completion_segments", () =>
        pool.query(`delete from carrier_completion_segments where carrier_completion_id = any($1::uuid[])`, [completionIds])
      );
      await tryDelete("carrier_completions", () => pool.query(`delete from carrier_completions where id = any($1::uuid[])`, [completionIds]));
    }
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
    if (activityId) await tryDelete("activities", () => pool.query(`delete from activities where id = $1`, [activityId]));
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
