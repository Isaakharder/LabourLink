// Real-HTTP-against-real-database coverage for the simplified Employment
// Timeline: GET /api/employment-periods draws every bar from the employee
// record (one source of truth with the Employees Directory), the timeline
// editor's save path (PATCH /api/employees/:id) and its date validation,
// that saving never deactivates/clocks out/touches time entries,
// permissions, the stale-page 410s on the old period endpoints, filters,
// and migration 068's backfill of End Different Date.
//
// Run with: npm run test:employment-periods
import "dotenv/config";
import fs from "fs";
import path from "path";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { calendarDateInAppTimezone, addDaysToDateStr } from "../lib/timezone";
import employeesRouter from "./employees";
import employmentPeriodsRouter from "./employmentPeriods";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const RUN_ID = Date.now();
const TODAY = calendarDateInAppTimezone(new Date());
const d = (n: number) => addDaysToDateStr(TODAY, n);

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", employeesRouter);
  app.use("/api/employment-periods", employmentPeriodsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(method: string, p: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Cookie: `labourlink_session=${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  let activityId: string | null = null;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    async function makeEmployee(label: string, role: string, extra: { startDate?: string | null; isActive?: boolean; permit?: string | null; nationality?: string } = {}) {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, security_role_id, team_role_id, is_active, nationality, start_date, work_permit_expiry_date,
                                  work_permit_notify_lead_months)
           values ($1, 'QA Timeline', $2, $3, $4, $5, $6, $7, case when $7::date is null then null else 6 end) returning id`,
          [
            `${label} ${RUN_ID}`,
            await roleId(role),
            teamRoleId,
            extra.isActive ?? true,
            extra.nationality ?? "Canadian",
            extra.startDate === undefined ? "2026-01-05" : extra.startDate,
            extra.permit ?? null,
          ]
        )
      ).rows[0].id as string;
      employeeIds.push(id);
      return id;
    }
    const token = (id: string, role: string) => signSession({ id, firstName: "QA", lastName: role, securityRole: role, teamRole: "Team Member" });

    const adminId = await makeEmployee("Admin", "Administrator");
    const admin = token(adminId, "Administrator");
    const managerId = await makeEmployee("Manager", "Manager");
    const manager = token(managerId, "Manager");
    const supervisor = token(await makeEmployee("Supervisor", "Supervisor"), "Supervisor");

    const worker = await makeEmployee("Worker", "Employee", { startDate: "2026-04-15", permit: d(120) });
    const noDates = await makeEmployee("NoStart", "Employee", { startDate: null });
    const gone = await makeEmployee("Deactivated", "Employee", { isActive: false });

    async function timelineRow(id: string, tok = admin) {
      const r = await call("GET", "/api/employment-periods", tok);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: r.status, row: (r.body?.employees ?? []).find((e: any) => e.id === id) };
    }

    // ---------------------------------------------------------------
    // 1) One source of truth: the bar comes from the employee record.
    // ---------------------------------------------------------------
    let t = await timelineRow(worker);
    check(t.row?.employmentStartDate === "2026-04-15", "1) bar starts on the Employment Start Date (employees.start_date)", t.row);
    check(t.row?.timelineEndDate === d(120) && t.row?.timelineEndSource === "workPermitExpiry" && t.row?.timelineLabel === "employed", "1) no End Different Date: ends on the permit expiry", t.row);
    check(Array.isArray(t.row?.periods) && t.row.periods.length === 0, "1) legacy `periods` is present and empty for stale pages");
    check((await timelineRow(gone)).row === undefined, "1) deactivated employees are excluded");
    const nd = (await timelineRow(noDates)).row;
    check(nd?.hasUsableDates === false && nd?.timelineLabel === null, "1) no Employment Start Date: flagged row, no bar", nd);

    // Timeline editor save (same PATCH the Employee form uses) -> Employee page.
    const endDifferent = d(30);
    const save = await call("PATCH", `/api/employees/${worker}`, admin, { startDate: "2026-04-10", workPermitExpiryDate: d(120), employmentEndDate: endDifferent });
    check(save.status === 200, "2) timeline save succeeds", save.body);
    const empPage = await call("GET", `/api/employees/${worker}`, admin);
    check(
      empPage.body.employee.startDate === "2026-04-10" && empPage.body.employee.employmentEndDate === endDifferent && empPage.body.employee.workPermitExpiryDate === d(120),
      "2) timeline edits are on the Employee page (same record)",
      empPage.body.employee
    );
    t = await timelineRow(worker);
    check(t.row?.timelineEndDate === endDifferent && t.row?.timelineEndSource === "endDifferentDate", "2) End Different Date overrides the bar end", t.row);
    check(t.row?.workPermitExpiryDate === d(120), "2) ...without changing the Work Permit Expiry Date");

    // Employee page edit -> timeline.
    await call("PATCH", `/api/employees/${worker}`, admin, { startDate: "2026-03-01", employmentEndDate: null, workPermitExpiryDate: d(200) });
    t = await timelineRow(worker);
    check(t.row?.employmentStartDate === "2026-03-01" && t.row?.timelineEndDate === d(200) && t.row?.endDifferentDate === null, "2) Employee-page edits show on the timeline", t.row);
    await call("PATCH", `/api/employees/${worker}`, admin, { workPermitExpiryDate: null });
    t = await timelineRow(worker);
    check(t.row?.timelineEndDate === null && t.row?.timelineLabel === "ongoing", "2) no ending dates: ongoing bar", t.row);

    // ---------------------------------------------------------------
    // 3) Validation.
    // ---------------------------------------------------------------
    const badEnd = await call("PATCH", `/api/employees/${worker}`, admin, { employmentEndDate: "2026-02-01" });
    check(badEnd.status === 400 && /earlier than the Employment Start Date/.test(badEnd.body?.errors?.employmentEndDate ?? ""), "3) End Different Date before the start is rejected (partial update checked against stored start)", badEnd.body);
    const badPermit = await call("PATCH", `/api/employees/${worker}`, admin, { workPermitExpiryDate: "2026-01-01" });
    check(badPermit.status === 400 && /earlier than the Employment Start Date/.test(badPermit.body?.errors?.workPermitExpiryDate ?? ""), "3) permit expiry before the start is rejected", badPermit.body);
    const badMove = await call("PATCH", `/api/employees/${worker}`, admin, { employmentEndDate: d(10) });
    check(badMove.status === 200, "3) a valid End Different Date saves");
    const moveStart = await call("PATCH", `/api/employees/${worker}`, admin, { startDate: d(20) });
    check(moveStart.status === 400 && moveStart.body?.errors?.employmentEndDate, "3) moving the start after the stored End Different Date is rejected", moveStart.body);
    const notDate = await call("PATCH", `/api/employees/${worker}`, admin, { employmentEndDate: "2026-13-40" });
    check(notDate.status === 400 && notDate.body?.errors?.employmentEndDate, "3) a malformed date is rejected");
    const createBad = await call("POST", "/api/employees", admin, { firstName: `Bad ${RUN_ID}`, lastName: "QA Timeline", nationality: "Canadian", startDate: "2026-05-01", employmentEndDate: "2026-04-01" });
    check(createBad.status === 400 && createBad.body?.errors?.employmentEndDate, "3) creating with an end before the start is rejected");
    const after = await call("GET", `/api/employees/${worker}`, admin);
    check(after.body.employee.startDate === "2026-03-01" && after.body.employee.employmentEndDate === d(10), "3) rejected saves changed nothing");

    // ---------------------------------------------------------------
    // 4) Saving End Different Date never deactivates, clocks out or touches
    //    time entries.
    // ---------------------------------------------------------------
    activityId = (await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Timeline Job ${RUN_ID}`])).rows[0].id;
    await pool.query(
      `insert into time_entries (employee_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
       values ($1, 'work', $2, gen_random_uuid(), now() - interval '2 days', now() - interval '2 days' + interval '3 hours', 'manual'),
              ($1, 'work', $2, gen_random_uuid(), now() - interval '1 hour', null, 'manual')`,
      [worker, activityId]
    );
    const entriesBefore = JSON.stringify((await pool.query(`select id, started_at, ended_at, activity_id, deleted_at from time_entries where employee_id = $1 order by started_at`, [worker])).rows);
    const endToday = await call("PATCH", `/api/employees/${worker}`, admin, { employmentEndDate: TODAY });
    check(endToday.status === 200 && endToday.body.employee.isActive === true, "4) saving an End Different Date (even today) keeps the employee active");
    const entriesAfter = JSON.stringify((await pool.query(`select id, started_at, ended_at, activity_id, deleted_at from time_entries where employee_id = $1 order by started_at`, [worker])).rows);
    check(entriesBefore === entriesAfter, "4) ...doesn't clock them out or change any time entry");
    t = await timelineRow(worker);
    check(t.row?.timelineLabel === "completed" && t.row?.statuses.includes("completed"), "4) an End Different Date of today shows as Finished", t.row);

    // ---------------------------------------------------------------
    // 5) Permissions (unchanged).
    // ---------------------------------------------------------------
    check((await timelineRow(worker, manager)).status === 200, "5) a Manager can view the timeline");
    check((await call("PATCH", `/api/employees/${worker}`, manager, { employmentEndDate: null })).status === 403, "5) a Manager can't edit dates");
    check((await call("GET", "/api/employment-periods", supervisor)).status === 403, "5) a Supervisor can't view the timeline");
    check((await call("GET", "/api/employment-periods")).status === 401, "5) signed out is refused");

    // ---------------------------------------------------------------
    // 6) Stale pages: old period endpoints answer 410 and change nothing.
    // ---------------------------------------------------------------
    const periodsBefore = (await pool.query(`select count(*)::int as n from employee_employment_periods`)).rows[0].n;
    for (const [method, p, body] of [
      ["POST", "/api/employment-periods", { employeeId: worker, startDate: "2026-01-01" }],
      ["PATCH", "/api/employment-periods/00000000-0000-0000-0000-000000000000", { actualFinishDate: TODAY }],
      ["DELETE", "/api/employment-periods/00000000-0000-0000-0000-000000000000", undefined],
    ] as [string, string, unknown][]) {
      const r = await call(method, p, admin, body);
      check(r.status === 410 && /Refresh LabourLink/.test(r.body?.error ?? ""), `6) stale ${method} on employment periods answers 410`, r);
    }
    check((await pool.query(`select count(*)::int as n from employee_employment_periods`)).rows[0].n === periodsBefore, "6) ...and changes nothing");
    check((await call("GET", `/api/employment-periods/${worker}/history`, admin)).status === 200, "6) period audit history is still readable");

    // ---------------------------------------------------------------
    // 7) Server-side filters follow the new dates.
    // ---------------------------------------------------------------
    const expired = await makeEmployee("Expired", "Employee", { startDate: "2025-01-01", permit: d(-5), nationality: "Mexican" });
    const r7 = await call("GET", "/api/employment-periods?status=permitExpired", admin);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids7 = r7.body.employees.map((e: any) => e.id);
    check(ids7.includes(expired) && !ids7.includes(worker), "7) status=permitExpired returns the expired-permit employee only", ids7);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exp = r7.body.employees.find((e: any) => e.id === expired);
    check(exp.timelineEndDate === d(-5) && exp.timelineLabel === "permitExpired", "7) an expired permit still ends the bar on the expiry date", exp);

    // ---------------------------------------------------------------
    // 8) Migration 068 backfill (verbatim statement, rolled back).
    // ---------------------------------------------------------------
    const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "068_employee_employment_end_date.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("update employees e"), sql.indexOf(";", sql.indexOf("update employees e")) + 1);
    const c = await pool.connect();
    try {
      await c.query("begin");
      const a = await makeEmployeeOn(c, "BF closed", "2026-01-01");
      const b = await makeEmployeeOn(c, "BF reopened", "2026-01-01");
      const z = await makeEmployeeOn(c, "BF open", "2026-01-01");
      const w = await makeEmployeeOn(c, "BF before start", "2026-06-01");
      await c.query(
        `insert into employee_employment_periods (employee_id, start_date, expected_finish_date, actual_finish_date) values
           ($1, '2026-01-01', '2026-05-01', '2026-04-20'),
           ($2, '2025-01-01', null, '2025-06-30'), ($2, '2026-01-01', null, null),
           ($3, '2026-01-01', '2026-12-01', null),
           ($4, '2026-01-01', null, '2026-03-01')`,
        [a, b, z, w]
      );
      await c.query(`update employees set employment_end_date = null where id = any($1::uuid[])`, [[a, b, z, w]]);
      await c.query(backfill);
      const got = Object.fromEntries(
        (await c.query(`select id, to_char(employment_end_date, 'YYYY-MM-DD') as e, to_char(start_date, 'YYYY-MM-DD') as s from employees where id = any($1::uuid[])`, [[a, b, z, w]])).rows.map((r) => [r.id, r])
      );
      check(got[a].e === "2026-04-20", "8) backfill: the actual finish becomes End Different Date", got[a]);
      check(got[b].e === null, "8) backfill: a later open period (re-employed) leaves no end date", got[b]);
      check(got[z].e === null, "8) backfill: an expected finish is NOT copied (no ending date was recorded)", got[z]);
      check(got[w].e === null && got[w].s === "2026-06-01", "8) backfill: an actual finish before the Directory start is skipped; start dates are never changed", got[w]);
    } finally {
      await c.query("rollback");
      c.release();
    }

    async function makeEmployeeOn(client: import("pg").PoolClient, label: string, start: string) {
      return (
        await client.query(
          `insert into employees (first_name, last_name, security_role_id, team_role_id, start_date) values ($1, 'QA Timeline', $2, $3, $4) returning id`,
          [`${label} ${RUN_ID}`, await roleId("Employee"), teamRoleId, start]
        )
      ).rows[0].id as string;
    }
  } finally {
    server.close();
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await c.query(`delete from employee_work_permit_history where employee_id = any($1::uuid[]) or changed_by_employee_id = any($1::uuid[])`, [employeeIds]);
      await c.query(`delete from employee_employment_periods where employee_id = any($1::uuid[])`, [employeeIds]);
      if (activityId) await c.query(`delete from activities where id = $1`, [activityId]);
      await c.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await c.query("commit");
    } catch (err) {
      await c.query("rollback");
      console.error("cleanup failed, nothing removed:", err);
      fail++;
    } finally {
      c.release();
    }
    const left = await pool.query(`select count(*)::int as n from employees where first_name like $1`, [`% ${RUN_ID}`]);
    check(left.rows[0].n === 0, "cleanup removed every fixture");
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
