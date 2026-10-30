// Employee vacation dates (069) through the real routers over real HTTP
// against the real database: one record shared by the Employment Timeline
// and the Employees Directory, every validation rule (both-or-neither, order,
// not before the Employment Start Date, not past End Different Date / Work
// Permit Expiry Date, ongoing employees free), clearing, the DB constraint,
// and that saving never deactivates anyone or touches time entries, breaks,
// payroll inputs or phone sync events.
//
// Run with: npm run test:employee-vacation
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
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
    async function makeEmployee(label: string, role: string, start: string | null, permit: string | null, endDifferent: string | null = null) {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, security_role_id, team_role_id, is_active, start_date, work_permit_expiry_date,
                                  work_permit_notify_lead_months, employment_end_date)
           values ($1, 'QA Vacation', $2, $3, true, $4, $5, case when $5::date is null then null else 6 end, $6) returning id`,
          [`${label} ${RUN_ID}`, await roleId(role), teamRoleId, start, permit, endDifferent]
        )
      ).rows[0].id as string;
      employeeIds.push(id);
      return id;
    }
    const adminId = await makeEmployee("Admin", "Administrator", "2020-01-01", null);
    const admin = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });
    const managerId = await makeEmployee("Manager", "Manager", "2020-01-01", null);
    const manager = signSession({ id: managerId, firstName: "QA", lastName: "Manager", securityRole: "Manager", teamRole: "Team Member" });

    const permitOnly = await makeEmployee("Permit", "Employee", "2026-01-05", "2026-12-31");
    const endDiff = await makeEmployee("EndDiff", "Employee", "2026-01-05", "2027-06-30", "2026-10-31");
    const ongoing = await makeEmployee("Ongoing", "Employee", "2026-01-05", null);

    const patch = (id: string, body: unknown, token = admin) => call("PATCH", `/api/employees/${id}`, token, body);
    const vacationOf = async (id: string) => {
      const r = (await pool.query(
        `select to_char(vacation_start_date, 'YYYY-MM-DD') as s, to_char(vacation_end_date, 'YYYY-MM-DD') as e from employees where id = $1`,
        [id]
      )).rows[0];
      return [r.s, r.e];
    };
    const timelineRow = async (id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((await call("GET", "/api/employment-periods", admin)).body.employees as any[]).find((e) => e.id === id);

    // ---------------------------------------------------------------
    // 1) Validation.
    // ---------------------------------------------------------------
    const cases: [string, string, Record<string, unknown>, string, RegExp][] = [
      ["only Start Vacation", permitOnly, { vacationStartDate: "2026-07-01" }, "vacationEndDate", /Enter both Start Vacation and End Vacation/],
      ["only End Vacation", permitOnly, { vacationEndDate: "2026-07-10" }, "vacationStartDate", /Enter both Start Vacation and End Vacation/],
      ["End before Start", permitOnly, { vacationStartDate: "2026-07-10", vacationEndDate: "2026-07-01" }, "vacationEndDate", /can't be before Start Vacation/],
      ["before the Employment Start Date", permitOnly, { vacationStartDate: "2026-01-04", vacationEndDate: "2026-01-10" }, "vacationStartDate", /before the Employment Start Date/],
      ["past the Work Permit Expiry Date", permitOnly, { vacationStartDate: "2026-12-20", vacationEndDate: "2027-01-02" }, "vacationEndDate", /after the Work Permit Expiry Date \(2026-12-31\)/],
      ["past the End Different Date (which wins over the later permit)", endDiff, { vacationStartDate: "2026-10-20", vacationEndDate: "2026-11-05" }, "vacationEndDate", /after the End Different Date \(2026-10-31\)/],
      ["a malformed date", permitOnly, { vacationStartDate: "2026-02-30", vacationEndDate: "2026-03-05" }, "vacationStartDate", /not a valid date/],
      // Previously a 500: Date.parse rolled 2026-02-30 over to March 2.
      ["an impossible Employment Start Date", permitOnly, { startDate: "2026-02-30" }, "startDate", /valid start date/],
    ];
    for (const [label, id, body, field, message] of cases) {
      const r = await patch(id, body);
      check(r.status === 400 && message.test(r.body?.errors?.[field] ?? ""), `1) rejects ${label}`, r.body);
    }
    check(JSON.stringify(await vacationOf(permitOnly)) === "[null,null]", "1) ...and nothing was saved");

    const okLast = await patch(permitOnly, { vacationStartDate: "2026-12-24", vacationEndDate: "2026-12-31" });
    check(okLast.status === 200, "1) a vacation ending exactly on the permit expiry is allowed", okLast.body);
    const okEndDiff = await patch(endDiff, { vacationStartDate: "2026-10-25", vacationEndDate: "2026-10-31" });
    check(okEndDiff.status === 200, "1) ending exactly on the End Different Date is allowed (even though the permit is later)");
    const okOngoing = await patch(ongoing, { vacationStartDate: "2031-07-01", vacationEndDate: "2031-07-21" });
    check(okOngoing.status === 200, "1) an ongoing employee may plan a vacation far in the future", okOngoing.body);
    const oneDay = await patch(ongoing, { vacationStartDate: "2026-02-02", vacationEndDate: "2026-02-02" });
    check(oneDay.status === 200, "1) a one-day vacation (Start = End) is allowed");

    // Later date edits are checked against the saved vacation.
    const shortenPermit = await patch(permitOnly, { workPermitExpiryDate: "2026-12-27" });
    check(shortenPermit.status === 400 && shortenPermit.body?.errors?.vacationEndDate, "1) moving the permit expiry before the saved End Vacation is rejected", shortenPermit.body);
    const moveStart = await patch(permitOnly, { startDate: "2026-12-26" });
    check(moveStart.status === 400 && moveStart.body?.errors?.vacationStartDate, "1) moving the start after the saved Start Vacation is rejected", moveStart.body);
    const setEndDiffEarly = await patch(permitOnly, { employmentEndDate: "2026-12-25" });
    check(setEndDiffEarly.status === 400 && /End Different Date/.test(setEndDiffEarly.body?.errors?.vacationEndDate ?? ""), "1) an End Different Date before the saved End Vacation is rejected", setEndDiffEarly.body);

    const createBad = await call("POST", "/api/employees", admin, {
      firstName: `Create ${RUN_ID}`, lastName: "QA Vacation", nationality: "Canadian", startDate: "2026-05-01",
      vacationStartDate: "2026-04-01", vacationEndDate: "2026-04-05",
    });
    check(createBad.status === 400 && createBad.body?.errors?.vacationStartDate, "1) creating with a vacation before the start is rejected");
    const createOk = await call("POST", "/api/employees", admin, {
      firstName: `Create ${RUN_ID}`, lastName: "QA Vacation", nationality: "Canadian", startDate: "2026-05-01",
      vacationStartDate: "2026-08-01", vacationEndDate: "2026-08-14",
    });
    check(createOk.status === 201 && createOk.body.employee.vacationStartDate === "2026-08-01", "1) creating with a valid vacation saves it");
    if (createOk.body?.employee?.id) employeeIds.push(createOk.body.employee.id);

    let constraintHeld = false;
    try {
      await pool.query(`update employees set vacation_start_date = '2026-08-01', vacation_end_date = null where id = $1`, [ongoing]);
    } catch (err) {
      constraintHeld = (err as { code?: string }).code === "23514";
    }
    check(constraintHeld, "1) the database itself refuses one vacation date without the other");

    // ---------------------------------------------------------------
    // 2) One record: Timeline <-> Directory.
    // ---------------------------------------------------------------
    await patch(permitOnly, { startDate: "2026-01-05", workPermitExpiryDate: "2026-12-31", employmentEndDate: null, vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-14" });
    const dir = (await call("GET", `/api/employees/${permitOnly}`, admin)).body.employee;
    check(dir.vacationStartDate === "2026-07-01" && dir.vacationEndDate === "2026-07-14", "2) a timeline save shows on the Employee page", dir);
    await patch(permitOnly, { vacationStartDate: "2026-08-03", vacationEndDate: "2026-08-07", notes: "edited from the Employee form" });
    const tl = await timelineRow(permitOnly);
    check(tl.vacationStartDate === "2026-08-03" && tl.vacationEndDate === "2026-08-07", "2) an Employee-page save shows on the timeline", tl);
    check((await call("GET", "/api/employment-periods", manager)).body.employees.some((e: { id: string; vacationStartDate: string }) => e.id === permitOnly && e.vacationStartDate === "2026-08-03"), "2) a Manager sees the vacation on the timeline");
    check((await patch(permitOnly, { vacationStartDate: null, vacationEndDate: null }, manager)).status === 403, "2) a Manager can't change it (unchanged permissions)");

    // ---------------------------------------------------------------
    // 3) Saving vacation dates changes nothing else.
    // ---------------------------------------------------------------
    activityId = (await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Vacation Job ${RUN_ID}`])).rows[0].id;
    await pool.query(
      `insert into time_entries (employee_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source) values
         ($1, 'work', $2, gen_random_uuid(), now() - interval '3 days', now() - interval '3 days' + interval '4 hours', 'manual'),
         ($1, 'break', null, gen_random_uuid(), now() - interval '3 days' + interval '2 hours', now() - interval '3 days' + interval '150 minutes', 'manual'),
         ($1, 'work', $2, gen_random_uuid(), now() - interval '1 hour', null, 'manual')`,
      [permitOnly, activityId]
    );
    const snapshot = async () =>
      JSON.stringify({
        entries: (await pool.query(`select id, entry_type, started_at, ended_at, activity_id, deleted_at from time_entries where employee_id = $1 order by started_at`, [permitOnly])).rows,
        corrections: (await pool.query(`select count(*)::int as n from time_entry_corrections c join time_entries t on t.id = c.time_entry_id where t.employee_id = $1`, [permitOnly])).rows[0].n,
        events: (await pool.query(`select count(*)::int as n from mobile_time_events where employee_id = $1`, [permitOnly])).rows[0].n,
        employee: (await pool.query(`select is_active, start_date, work_permit_expiry_date, employment_end_date, break_profile_id from employees where id = $1`, [permitOnly])).rows[0],
      });
    const before = await snapshot();
    const r3 = await patch(permitOnly, { vacationStartDate: "2026-09-01", vacationEndDate: "2026-09-12" });
    check(r3.status === 200 && r3.body.employee.isActive === true, "3) saving a vacation keeps the employee active");
    check((await snapshot()) === before, "3) ...and changes no time entry, break, correction, phone sync event or other employee date");

    // ---------------------------------------------------------------
    // 4) Clearing both removes the vacation.
    // ---------------------------------------------------------------
    const cleared = await patch(permitOnly, { vacationStartDate: null, vacationEndDate: null });
    check(cleared.status === 200 && JSON.stringify(await vacationOf(permitOnly)) === "[null,null]", "4) clearing both dates removes the vacation");
    const tl4 = await timelineRow(permitOnly);
    check(tl4.vacationStartDate === null && tl4.vacationEndDate === null, "4) ...and the timeline no longer has one");
    const clearedEmpty = await patch(permitOnly, { vacationStartDate: "", vacationEndDate: "" });
    check(clearedEmpty.status === 200, "4) empty strings clear too (the form's empty inputs)");
  } finally {
    server.close();
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await c.query(`delete from employee_work_permit_history where employee_id = any($1::uuid[]) or changed_by_employee_id = any($1::uuid[])`, [employeeIds]);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
