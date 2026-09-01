// Integration test for GET /api/inputs/employees — the Inputs page's
// employee-list panel. Reproduces the reported bug: the panel used to list
// every is_active=true employee regardless of whether they had any work
// that day (and hid a deactivated employee's real history), rather than
// reflecting who actually has a time-entry log for the selected date. Same
// real-HTTP-against-real-database convention used throughout this repo
// (see inputs.badgeReviewConsistency.test.ts).
//
// Run with: npm run test:inputs-employees-list
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
// The selected date under test, and a second, distinct date used only to
// prove an entry on a DIFFERENT day never leaks into DATE's list.
const DATE = "2019-07-14";
const OTHER_DATE = "2019-07-15";

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

  async function call(method: string, path: string, opts: { token?: string } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Employees List Admin ${RUN_ID}`, `qa-employees-list-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function insertEmployee(label: string, isActive: boolean): Promise<{ id: string; firstName: string; lastName: string }> {
      const lastName = `EmployeesList-${label}-${RUN_ID}`;
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, $6) returning id, first_name, last_name`,
        [lastName, `qa-employees-list-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash, isActive]
      );
      employeeIds.push(rows[0].id);
      return { id: rows[0].id, firstName: rows[0].first_name, lastName: rows[0].last_name };
    }

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Employees List Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    // started_at/ended_at as UTC instants of a wall-clock time on the given
    // calendar date — ended: null leaves the entry open (currently
    // working/on break), matching how a real in-progress shift is stored.
    async function insertWork(
      employeeId: string,
      dateStr: string,
      startHour: number,
      endHour: number | null
    ): Promise<string> {
      const [y, m, d] = dateStr.split("-").map(Number);
      const startedAt = zonedWallTimeToUtc(y, m, d, startHour, 0, 0);
      const endedAt = endHour === null ? null : zonedWallTimeToUtc(y, m, d, endHour, 0, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual') returning id`,
        [employeeId, activityId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, dateStr: string, startHour: number, endHour: number | null): Promise<string> {
      const [y, m, d] = dateStr.split("-").map(Number);
      const startedAt = zonedWallTimeToUtc(y, m, d, startHour, 0, 0);
      const endedAt = endHour === null ? null : zonedWallTimeToUtc(y, m, d, endHour, 0, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
        [employeeId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    // ---------------------------------------------------------------
    // Fixtures, one per scenario the required behavior calls out.
    // ---------------------------------------------------------------
    const currentlyWorking = await insertEmployee("Working", true);
    await insertWork(currentlyWorking.id, DATE, 8, null);

    const onBreak = await insertEmployee("OnBreak", true);
    await insertWork(onBreak.id, DATE, 8, 10);
    await insertBreak(onBreak.id, DATE, 10, null);

    const clockedOut = await insertEmployee("ClockedOut", true);
    await insertWork(clockedOut.id, DATE, 8, 16);

    // Active, but genuinely never worked DATE — the exact case the fix
    // excludes that the old is_active-only query used to include.
    const activeNoLogs = await insertEmployee("ActiveNoLogs", true);

    // Deactivated, but has a real log on DATE — must stay visible; status
    // must never hide real history.
    const deactivatedWithLogs = await insertEmployee("DeactivatedWithLogs", false);
    await insertWork(deactivatedWithLogs.id, DATE, 9, 17);

    // Only log on DATE was soft-deleted — a deleted log doesn't count.
    const deletedLogOnly = await insertEmployee("DeletedLogOnly", true);
    const deletedEntryId = await insertWork(deletedLogOnly.id, DATE, 8, 12);
    await pool.query(
      `update time_entries set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = 'QA fixture cleanup test' where id = $2`,
      [adminId, deletedEntryId]
    );

    // Worked OTHER_DATE only — must not leak into DATE's list, and must
    // appear when OTHER_DATE itself is queried.
    const differentDateOnly = await insertEmployee("DifferentDateOnly", true);
    await insertWork(differentDateOnly.id, OTHER_DATE, 8, 12);

    // ---------------------------------------------------------------
    // 1) Missing date is rejected, same convention as GET /daily.
    // ---------------------------------------------------------------
    {
      const res = await call("GET", `/api/inputs/employees`, { token: adminToken });
      check(res.status === 400, "1) missing date is rejected with 400", res);
    }

    // ---------------------------------------------------------------
    // 2) DATE's list contains exactly the three employees with real,
    //    non-deleted logs that day (working/on break/clocked out) and
    //    the deactivated employee with a real log — and excludes the
    //    active-no-logs and deleted-log-only employees.
    // ---------------------------------------------------------------
    {
      const res = await call("GET", `/api/inputs/employees?date=${DATE}`, { token: adminToken });
      const ids = new Set((res.body?.employees ?? []).map((e: any) => e.id));
      check(res.status === 200, "2) 200 OK", res);
      check(ids.has(currentlyWorking.id), "2) currently-working employee (open work entry) is included", [...ids]);
      check(ids.has(onBreak.id), "2) currently-on-break employee (open break entry) is included", [...ids]);
      check(ids.has(clockedOut.id), "2) clocked-out employee (closed work entry) is included", [...ids]);
      check(ids.has(deactivatedWithLogs.id), "2) deactivated employee WITH a log on this date stays visible", [...ids]);
      check(!ids.has(activeNoLogs.id), "2) active employee with NO logs this date is excluded", [...ids]);
      check(!ids.has(deletedLogOnly.id), "2) employee whose only log this date was soft-deleted is excluded", [...ids]);
      check(!ids.has(differentDateOnly.id), "2) employee who only worked a different date is excluded from DATE", [...ids]);
    }

    // ---------------------------------------------------------------
    // 3) The same employee DOES appear when their actual date is queried
    //    — proves this is real date-scoping, not a fixture ordering fluke.
    // ---------------------------------------------------------------
    {
      const res = await call("GET", `/api/inputs/employees?date=${OTHER_DATE}`, { token: adminToken });
      const ids = new Set((res.body?.employees ?? []).map((e: any) => e.id));
      check(ids.has(differentDateOnly.id), "3) that employee IS included when their real date is queried", [...ids]);
      check(!ids.has(currentlyWorking.id), "3) DATE-only employees are excluded when querying OTHER_DATE", [...ids]);
    }

    // ---------------------------------------------------------------
    // 4) Search narrows the date-scoped list rather than replacing it —
    //    still no is_active filtering, still date-scoped.
    // ---------------------------------------------------------------
    {
      const res = await call(
        "GET",
        `/api/inputs/employees?date=${DATE}&search=${encodeURIComponent(clockedOut.lastName)}`,
        { token: adminToken }
      );
      const ids = new Set((res.body?.employees ?? []).map((e: any) => e.id));
      check(ids.has(clockedOut.id), "4) search matches the intended employee within the date-scoped list", [...ids]);
      check(!ids.has(currentlyWorking.id), "4) search excludes a same-date employee whose name doesn't match", [...ids]);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
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
