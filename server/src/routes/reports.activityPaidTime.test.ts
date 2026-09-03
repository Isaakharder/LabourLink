// Verifies the data the new Activity Report "Total Paid Time" column reads
// from (ActivityEmployeeTotal.workSeconds/paidBreakSeconds, via
// getActivityReportData in reportQueries.ts) is correct at the source —
// the client-side column (web/src/lib/reportPivot.ts) only ever formats
// these already-computed numbers with the report's own existing Paid time
// formula (pivotCellValue's "paidTime" case: workSeconds + paidBreakSeconds),
// so proving THIS data is right is what the new column's correctness
// actually rests on. No dedicated server-side test of getActivityReportData
// existed before this file.
//
// Run with: npm run test:reports-activity-paid-time
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import reportsRouter from "./reports";

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
  app.use("/api/reports", reportsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const timeEntryIds: string[] = [];
  const reportIds: string[] = [];
  const activityIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ReportPaidTime Admin ${RUN_ID}`, `qa-report-paidtime-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    async function makeEmployee(label: string): Promise<string> {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [`ReportPaidTime ${label} ${RUN_ID}`, `qa-report-paidtime-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
        )
      ).rows[0].id;
      employeeIds.push(id);
      return id;
    }

    const deviceId = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        randomUUID(),
        `QA ReportPaidTime Device ${RUN_ID}`,
      ])
    ).rows[0].id;
    deviceIds.push(deviceId);

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA ReportPaidTime Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    async function makeWork(employeeId: string, start: string, end: string, opts?: { deleted?: boolean }): Promise<string> {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, deleted_at, deleted_by_employee_id, deletion_reason)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', $6, $7, $8) returning id`,
          [
            employeeId,
            deviceId,
            activityId,
            start,
            end,
            opts?.deleted ? new Date() : null,
            opts?.deleted ? adminId : null,
            opts?.deleted ? "QA deleted for test" : null,
          ]
        )
      ).rows[0].id;
      timeEntryIds.push(id);
      return id;
    }
    async function makeBreak(employeeId: string, start: string, end: string, isPaid: boolean): Promise<string> {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source, is_paid)
           values ($1, $2, 'break', gen_random_uuid(), $3, $4, 'manual', $5) returning id`,
          [employeeId, deviceId, start, end, isPaid]
        )
      ).rows[0].id;
      timeEntryIds.push(id);
      return id;
    }
    async function createActivityReport(name: string, mode: "all" | "selected", ids: string[]): Promise<string> {
      const res = await call("POST", "/api/reports", adminToken, {
        name: `QA ${name} ${RUN_ID}`,
        reportType: "activity",
        activityId,
        metrics: ["employee", "paidTime", "workTime"],
        employeeSelectionMode: mode,
        employeeIds: ids,
      });
      const id = res.body.id;
      reportIds.push(id);
      return id;
    }
    async function getEmployeeTotal(reportId: string, start: string, end: string, employeeId: string): Promise<any> {
      const res = await call("GET", `/api/reports/${reportId}/data?start=${start}&end=${end}`, adminToken);
      return (res.body?.data?.employeeTotals ?? []).find((t: any) => t.employeeId === employeeId) ?? null;
    }

    // -----------------------------------------------------------------
    // 1) Multiple days, multiple employees — each employee's total sums
    //    ONLY their own work seconds across every day in range, never
    //    another employee's, and never a day outside the range.
    // -----------------------------------------------------------------
    {
      const empA = await makeEmployee("MultiDayA");
      const empB = await makeEmployee("MultiDayB");
      await makeWork(empA, "2026-08-10T12:00:00Z", "2026-08-10T16:00:00Z"); // 4h
      await makeWork(empA, "2026-08-11T12:00:00Z", "2026-08-11T14:30:00Z"); // 2.5h
      await makeWork(empB, "2026-08-10T13:00:00Z", "2026-08-10T15:00:00Z"); // 2h

      const reportId = await createActivityReport("MultiDay", "all", []);
      const totalA = await getEmployeeTotal(reportId, "2026-08-10", "2026-08-11", empA);
      const totalB = await getEmployeeTotal(reportId, "2026-08-10", "2026-08-11", empB);
      check(totalA?.workSeconds === 6.5 * 3600, "1) employee A's total sums both days (4h + 2.5h = 6.5h)", totalA);
      check(totalB?.workSeconds === 2 * 3600, "1) employee B's total is independent of A's (2h only)", totalB);
    }

    // -----------------------------------------------------------------
    // 2) Paid vs unpaid breaks follow the existing paid-time rule: Paid
    //    time = workSeconds + paidBreakSeconds ONLY — an unpaid break
    //    contributes to breakSeconds/unpaidBreakSeconds but never to
    //    paidBreakSeconds (and therefore never to Total Paid Time).
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("PaidUnpaid");
      await makeWork(emp, "2026-08-12T12:00:00Z", "2026-08-12T14:00:00Z"); // 2h work
      await makeBreak(emp, "2026-08-12T14:00:00Z", "2026-08-12T14:15:00Z", true); // 15m PAID
      await makeWork(emp, "2026-08-12T14:15:00Z", "2026-08-12T17:00:00Z"); // 2h45m work
      await makeBreak(emp, "2026-08-12T17:00:00Z", "2026-08-12T17:30:00Z", false); // 30m UNPAID

      const reportId = await createActivityReport("PaidUnpaid", "all", []);
      const total = await getEmployeeTotal(reportId, "2026-08-12", "2026-08-12", emp);
      check(total?.workSeconds === (2 + 2.75) * 3600, "2) work seconds sum both work segments (4:45)", total);
      check(total?.paidBreakSeconds === 15 * 60, "2) paidBreakSeconds is exactly the 15-minute PAID break", total);
      check(total?.unpaidBreakSeconds === 30 * 60, "2) unpaidBreakSeconds is exactly the 30-minute UNPAID break, kept separate", total);
      // Total Paid Time = workSeconds + paidBreakSeconds, the report's own
      // existing formula (reportTypes.ts's pivotCellValue) — proven here
      // against the real server data: 4:45 work + 0:15 paid break = 5:00,
      // the 30-minute unpaid break correctly excluded entirely.
      const totalPaidTimeSeconds = total.workSeconds + total.paidBreakSeconds;
      check(totalPaidTimeSeconds === 5 * 3600, "2) Total Paid Time (workSeconds + paidBreakSeconds) is exactly 5:00, excluding the unpaid break", totalPaidTimeSeconds);
    }

    // -----------------------------------------------------------------
    // 3) Soft-deleted entries are excluded entirely — a deleted work
    //    segment contributes nothing to the employee's total.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("Deleted");
      await makeWork(emp, "2026-08-13T12:00:00Z", "2026-08-13T14:00:00Z"); // 2h, kept
      await makeWork(emp, "2026-08-13T15:00:00Z", "2026-08-13T19:00:00Z", { deleted: true }); // 4h, DELETED

      const reportId = await createActivityReport("Deleted", "all", []);
      const total = await getEmployeeTotal(reportId, "2026-08-13", "2026-08-13", emp);
      check(total?.workSeconds === 2 * 3600, "3) only the non-deleted 2h segment counts — the deleted 4h segment is excluded entirely", total);
    }

    // -----------------------------------------------------------------
    // 4) Grouped/split entries — a single visit recorded as TWO
    //    time_entries rows (e.g. split by an intervening break) sums both
    //    pieces exactly once each, never double-counted and never
    //    under-counted.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("SplitEntry");
      // Same visit, split by a break in the middle — two work rows.
      await makeWork(emp, "2026-08-14T12:00:00Z", "2026-08-14T13:30:00Z"); // 1.5h
      await makeBreak(emp, "2026-08-14T13:30:00Z", "2026-08-14T13:45:00Z", false);
      await makeWork(emp, "2026-08-14T13:45:00Z", "2026-08-14T16:15:00Z"); // 2.5h

      const reportId = await createActivityReport("SplitEntry", "all", []);
      const total = await getEmployeeTotal(reportId, "2026-08-14", "2026-08-14", emp);
      check(total?.workSeconds === 4 * 3600, "4) split visit sums both segments exactly once (1.5h + 2.5h = 4h), no double-counting", total);
    }

    // -----------------------------------------------------------------
    // 5) Filtered employees — a report saved with an explicit selection
    //    only returns totals for the selected employees.
    // -----------------------------------------------------------------
    {
      const empIn = await makeEmployee("FilterIn");
      const empOut = await makeEmployee("FilterOut");
      await makeWork(empIn, "2026-08-15T12:00:00Z", "2026-08-15T14:00:00Z");
      await makeWork(empOut, "2026-08-15T12:00:00Z", "2026-08-15T14:00:00Z");

      const reportId = await createActivityReport("Filter", "selected", [empIn]);
      const res = await call("GET", `/api/reports/${reportId}/data?start=2026-08-15&end=2026-08-15`, adminToken);
      const ids = new Set((res.body?.data?.employeeTotals ?? []).map((t: any) => t.employeeId));
      check(ids.has(empIn) && !ids.has(empOut), "5) employeeTotals contains only the selected employee, never the excluded one", res.body?.data?.employeeTotals);
    }

    // -----------------------------------------------------------------
    // 6) Partial date range — a query scoped to only PART of an
    //    employee's actual entries reflects only that part, not their
    //    whole history.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("PartialRange");
      await makeWork(emp, "2026-08-16T12:00:00Z", "2026-08-16T14:00:00Z"); // 2h, day 16
      await makeWork(emp, "2026-08-17T12:00:00Z", "2026-08-17T15:00:00Z"); // 3h, day 17
      await makeWork(emp, "2026-08-18T12:00:00Z", "2026-08-18T20:00:00Z"); // 8h, day 18 (outside the queried range)

      const reportId = await createActivityReport("PartialRange", "all", []);
      const total = await getEmployeeTotal(reportId, "2026-08-16", "2026-08-17", emp);
      check(total?.workSeconds === 5 * 3600, "6) partial range (16-17) sums only those two days (2h + 3h = 5h), excluding day 18 entirely", total);
    }
  } finally {
    for (const rid of reportIds) await pool.query("delete from saved_reports where id = $1", [rid]).catch(() => {});
    if (timeEntryIds.length) await pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]).catch(() => {});
    if (activityIds.length) await pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]).catch(() => {});
    if (deviceIds.length) await pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]).catch(() => {});
    if (employeeIds.length) await pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]).catch(() => {});
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
