// Phase 0 report corrections: regression tests for the five fixes to the
// density (stems/plants per hour) report engine, plus one combined day that
// exercises row changes, a split row, a break, a manual entry and an
// unfinished entry together.
//
//  1. A deleted time entry linked to a completed row no longer counts: not
//     in the row's duration, and its employee no longer receives a share.
//  2. A report filtered to some employees credits only those employees, so
//     its quantity totals and overall speed are no longer inflated by
//     co-workers' shares (shared completions and sole visits).
//  3. A row shared by several employees is split by largest remainder, so
//     the shares add up to exactly the row's quantity.
//  4. The density audit counts a shared completion the same way the report
//     does (included, with the employee's time share).
//  5. Work overlapping the same employee's recorded break is not counted as
//     activity time, in Activity Hours or in any speed denominator. Payroll
//     is unchanged.
//
// Run with: npm run test:reports-phase0-corrections
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import reportsRouter from "./reports";
import { getActivityDensityAttribution, getPayrollReportData } from "../lib/reportQueries";
import { getRangeBoundsUtc } from "../lib/timezone";

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
const close = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-6;

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
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
  const rowIds: string[] = [];
  let landId: string | undefined;
  let phaseId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Phase0 Admin ${RUN_ID}`, `qa-phase0-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    async function makeEmployee(label: string): Promise<string> {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [`Phase0 ${label} ${RUN_ID}`, `qa-phase0-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
        )
      ).rows[0].id;
      employeeIds.push(id);
      return id;
    }

    const deviceId = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        randomUUID(),
        `QA Phase0 Device ${RUN_ID}`,
      ])
    ).rows[0].id;
    deviceIds.push(deviceId);

    const activityId = (
      await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA Phase0 Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(activityId);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [`QA Phase0 Land ${RUN_ID}`])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Phase0 Phase ${RUN_ID}`,
      ])
    ).rows[0].id;

    let nextRowNumber = 1;
    async function makeRow(): Promise<string> {
      const id = (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, 3, 2, 20, 'horizontal') returning id`,
          [phaseId, nextRowNumber++]
        )
      ).rows[0].id;
      rowIds.push(id);
      return id;
    }

    async function makeWork(employeeId: string, rowId: string, start: string, end: string | null, density: number, opts?: { manual?: boolean }): Promise<string> {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                      greenhouse_row_id, density_type, density_count_per_row, created_by_employee_id, creation_reason)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', $6, 'stems', $7, $8, $9) returning id`,
          [employeeId, deviceId, activityId, start, end, rowId, density, opts?.manual ? adminId : null, opts?.manual ? "QA manual entry" : null]
        )
      ).rows[0].id;
      timeEntryIds.push(id);
      return id;
    }

    async function makeBreak(employeeId: string, start: string, end: string, isPaid = false): Promise<string> {
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

    async function completeRow(segmentIds: string[], quantityPerRow: number, rowId: string): Promise<void> {
      const completionId = (
        await pool.query(
          `insert into row_completions (greenhouse_row_id, activity_id, density_type, quantity_per_row, confirmed_by_employee_id)
           values ($1, $2, 'stems', $3, $4) returning id`,
          [rowId, activityId, quantityPerRow, adminId]
        )
      ).rows[0].id;
      for (const segId of segmentIds) {
        await pool.query(`insert into row_completion_segments (time_entry_id, row_completion_id) values ($1, $2)`, [segId, completionId]);
      }
    }

    async function report(start: string, end: string, selected?: string[]): Promise<any> {
      const res = await call("POST", "/api/reports", adminToken, {
        name: `QA Phase0 ${RUN_ID} ${Math.random()}`,
        reportType: "activity",
        activityId,
        dailyMetric: "workTime",
        weeklyTotals: ["activityHours", "averageSpeed"],
        employeeSelectionMode: selected ? "selected" : "all",
        employeeIds: selected ?? [],
      });
      reportIds.push(res.body.id);
      return (await call("GET", `/api/reports/${res.body.id}/data?start=${start}&end=${end}`, adminToken)).body?.data;
    }
    const empTotal = (data: any, id: string) => (data?.employeeTotals ?? []).find((t: any) => t.employeeId === id) ?? null;
    const dayRow = (data: any, id: string, date: string) => (data?.rows ?? []).find((r: any) => r.employeeId === id && r.date === date) ?? null;
    async function attribution(start: string, end: string) {
      const { start: s, end: e } = getRangeBoundsUtc(start, end);
      return getActivityDensityAttribution(activityId, s, e);
    }

    // -----------------------------------------------------------------
    // 1) DELETED SEGMENT IN A COMPLETED ROW. X picked 12:00-13:00, Y's
    //    13:00-14:00 entry on the same completed row (600) was deleted.
    //    Before: Y's deleted hour still counted, so X got 300 and Y 300.
    //    Now: X gets all 600 over X's own 1 h.
    // -----------------------------------------------------------------
    {
      const x = await makeEmployee("DeletedX");
      const y = await makeEmployee("DeletedY");
      const row = await makeRow();
      const keep = await makeWork(x, row, "2026-08-03T12:00:00Z", "2026-08-03T13:00:00Z", 600);
      const gone = await makeWork(y, row, "2026-08-03T13:00:00Z", "2026-08-03T14:00:00Z", 600);
      await completeRow([keep, gone], 600, row);
      await pool.query(
        `update time_entries set deleted_at = now(), deleted_by_employee_id = $2, deletion_reason = 'QA deleted run' where id = $1`,
        [gone, adminId]
      );

      const data = await report("2026-08-03", "2026-08-03");
      check(empTotal(data, x)?.quantityWorked === 600, "1) the remaining employee gets the whole row (600), not a share diluted by deleted time", empTotal(data, x));
      check(empTotal(data, y) === null, "1) the employee whose entry was deleted gets nothing", empTotal(data, y));
      check(data?.totals?.quantityWorked === 600 && close(data?.totals?.averageSpeed, 600), "1) total 600 stems over 1 h = 600/h", data?.totals);
      const attr = await attribution("2026-08-03", "2026-08-03");
      check(attr.byEmployee.get(x)?.durationSeconds === 3600, "1) the attributed duration (TV/Dashboard denominator) excludes the deleted hour", attr.byEmployee.get(x));
      check(!attr.byEmployee.has(y), "1) no attribution for the deleted entry's employee");
    }

    // -----------------------------------------------------------------
    // 2a) FILTERED REPORT, SHARED COMPLETION. X 2 h + Y 1 h on one completed
    //     row of 900. A report for X alone must total X's 600, not 900.
    // -----------------------------------------------------------------
    {
      const x = await makeEmployee("FilterX");
      const y = await makeEmployee("FilterY");
      const row = await makeRow();
      const a = await makeWork(x, row, "2026-08-04T12:00:00Z", "2026-08-04T14:00:00Z", 900);
      const b = await makeWork(y, row, "2026-08-04T14:00:00Z", "2026-08-04T15:00:00Z", 900);
      await completeRow([a, b], 900, row);

      const onlyX = await report("2026-08-04", "2026-08-04", [x]);
      check(onlyX?.totals?.quantityWorked === 600, "2a) report for X alone totals X's 600, not the whole row's 900", onlyX?.totals);
      check(close(onlyX?.totals?.averageSpeed, 300), "2a) overall speed 600 / 2 h = 300/h, not 900 / 2 h = 450/h", onlyX?.totals);
      check(onlyX?.totals?.rowsCompleted === 1, "2a) X (largest share) is credited the completed row", onlyX?.totals);
      const dateTotal = (onlyX?.dateTotals ?? []).find((d: any) => d.date === "2026-08-04");
      check(dateTotal?.quantityWorked === 600, "2a) the date total is X's 600 too", dateTotal);

      const onlyY = await report("2026-08-04", "2026-08-04", [y]);
      check(onlyY?.totals?.quantityWorked === 300 && onlyY?.totals?.rowsCompleted === 0, "2a) report for Y alone: 300 stems, no completed row", onlyY?.totals);

      const both = await report("2026-08-04", "2026-08-04");
      check(both?.totals?.quantityWorked === 900, "2a) unfiltered report still totals the whole row (900)", both?.totals);
    }

    // -----------------------------------------------------------------
    // 2b) FILTERED REPORT, SOLE VISITS. Y visited a row on Sep 1, X the
    //     same row on Sep 20 (different review cycles, so each visit is
    //     sole). A September report for X alone must not include Y's 500.
    // -----------------------------------------------------------------
    {
      const x = await makeEmployee("SoleX");
      const y = await makeEmployee("SoleY");
      const row = await makeRow();
      await makeWork(y, row, "2026-09-01T12:00:00Z", "2026-09-01T13:00:00Z", 500);
      await makeWork(x, row, "2026-09-20T12:00:00Z", "2026-09-20T13:00:00Z", 500);

      const onlyX = await report("2026-09-01", "2026-09-30", [x]);
      check(onlyX?.totals?.quantityWorked === 500, "2b) report for X alone totals only X's visit (500), not 1000", onlyX?.totals);
      check(close(onlyX?.totals?.averageSpeed, 500), "2b) overall speed 500/h, not 1000/h", onlyX?.totals);
      const both = await report("2026-09-01", "2026-09-30");
      check(both?.totals?.quantityWorked === 1000, "2b) unfiltered report counts both visits (1000)", both?.totals);
    }

    // -----------------------------------------------------------------
    // 3) + 4) SPLIT ROUNDING AND AUDIT. 101 stems shared 1 h / 1 h. Shares
    //    must add up to 101 (51 + 50), never 51 + 51 = 102; the audit marks
    //    each employee's segment as included, like the report.
    // -----------------------------------------------------------------
    {
      const x = await makeEmployee("RoundX");
      const y = await makeEmployee("RoundY");
      const row = await makeRow();
      const a = await makeWork(x, row, "2026-08-05T12:00:00Z", "2026-08-05T13:00:00Z", 101);
      const b = await makeWork(y, row, "2026-08-05T13:00:00Z", "2026-08-05T14:00:00Z", 101);
      await completeRow([a, b], 101, row);

      const data = await report("2026-08-05", "2026-08-05");
      const qx = empTotal(data, x)?.quantityWorked;
      const qy = empTotal(data, y)?.quantityWorked;
      check(qx + qy === 101, "3) the two shares add up to exactly the row's 101 stems", { qx, qy });
      check(qx === 51 && qy === 50, "3) largest remainder gives the tie to the earlier employee: 51 + 50", { qx, qy });
      check(data?.totals?.quantityWorked === 101, "3) report total is 101, never 102", data?.totals);

      const audit = await call("GET", `/api/reports/audit/density-attribution?activityId=${activityId}&employeeId=${y}&start=2026-08-05&end=2026-08-05`, adminToken);
      const seg = audit.body?.segments?.[0];
      check(audit.status === 200 && seg?.includedInReport === true, "4) audit marks a shared completion's segment as included, like the report", seg);
      check(seg?.exclusionReason === null && close(seg?.attributedQuantity, 50.5), "4) audit shows the employee's time share of the row (50.5)", seg);
    }

    // -----------------------------------------------------------------
    // 5) WORK OVERLAPPING A BREAK. Row worked 12:00-14:00 (600, completed)
    //    with an unpaid break 13:00-13:30 recorded on top of it. Activity
    //    Hours 1.5 h (not 2 h), speed 400/h; payroll unchanged.
    // -----------------------------------------------------------------
    {
      const x = await makeEmployee("BreakOverlap");
      const row = await makeRow();
      const a = await makeWork(x, row, "2026-08-06T12:00:00Z", "2026-08-06T14:00:00Z", 600);
      await completeRow([a], 600, row);
      await makeBreak(x, "2026-08-06T13:00:00Z", "2026-08-06T13:30:00Z");

      const data = await report("2026-08-06", "2026-08-06");
      const r = dayRow(data, x, "2026-08-06");
      check(r?.workSeconds === 5400, "5) Activity Hours leave out the 30 min break overlap: 1.5 h", r);
      check(close(r?.averageSpeed, 400), "5) daily speed 600 / 1.5 h = 400/h (was 300/h)", r);
      check(r?.breakSeconds === 1800, "5) the break itself is still reported as 30 min of break", r);
      check(r?.employeePaidSeconds === 5400, "5) Employee Paid Time unchanged: 2 h span minus 30 min unpaid break", r);
      const attr = await attribution("2026-08-06", "2026-08-06");
      check(attr.byEmployee.get(x)?.durationSeconds === 5400, "5) attributed duration (TV/Dashboard) also leaves out the overlap", attr.byEmployee.get(x));
      check(attr.byEmployee.get(x)?.quantity === 600, "5) the row's quantity is unchanged", attr.byEmployee.get(x));

      const payroll = await getPayrollReportData("2026-08-06", "2026-08-06", { employeeIds: [x] });
      const p = payroll.rows.find((row) => row.employeeId === x);
      check(p?.workSeconds === 5400 && p?.unpaidBreakSeconds === 1800, "5) payroll worked time is unchanged (2 h span - 30 min unpaid break)", p);

      // A paid break overlapping work is not activity time either, but
      // payroll still counts it as paid.
      const y = await makeEmployee("PaidBreakOverlap");
      const row2 = await makeRow();
      const c = await makeWork(y, row2, "2026-08-06T12:00:00Z", "2026-08-06T13:00:00Z", 300);
      await completeRow([c], 300, row2);
      await makeBreak(y, "2026-08-06T12:45:00Z", "2026-08-06T13:00:00Z", true);
      const data2 = await report("2026-08-06", "2026-08-06", [y]);
      const r2 = dayRow(data2, y, "2026-08-06");
      check(r2?.workSeconds === 2700 && close(r2?.averageSpeed, 400), "5) paid break overlap: 45 min of activity, 300 / 0.75 h = 400/h", r2);
      check(r2?.employeePaidSeconds === 3600, "5) paid break still counts in Employee Paid Time (1 h)", r2);

      // A break the employee never ended, closed by the midnight cut-off
      // (ends exactly at local midnight, 04:00Z in August), is not evidence
      // of a break: the work it overlaps keeps counting.
      const z = await makeEmployee("StuckBreak");
      const row3 = await makeRow();
      const d = await makeWork(z, row3, "2026-08-06T12:00:00Z", "2026-08-06T14:00:00Z", 600);
      await completeRow([d], 600, row3);
      await makeBreak(z, "2026-08-06T13:00:00Z", "2026-08-07T04:00:00Z");
      const data3 = await report("2026-08-06", "2026-08-06", [z]);
      const r3 = dayRow(data3, z, "2026-08-06");
      check(r3?.workSeconds === 7200 && close(r3?.averageSpeed, 300), "5) a break closed by the midnight cut-off is not subtracted: 2 h, 300/h", r3);
      const attr3 = await attribution("2026-08-06", "2026-08-06");
      check(attr3.byEmployee.get(z)?.durationSeconds === 7200, "5) nor from the attributed duration", attr3.byEmployee.get(z));

      // Same for the 3-day backstop's 23:59:59 close (auto_closed_at set).
      const v = await makeEmployee("AutoClosedBreak");
      const row4 = await makeRow();
      const f = await makeWork(v, row4, "2026-08-06T12:00:00Z", "2026-08-06T14:00:00Z", 600);
      await completeRow([f], 600, row4);
      const autoBreak = await makeBreak(v, "2026-08-06T13:00:00Z", "2026-08-07T03:59:59Z");
      await pool.query(`update time_entries set auto_closed_at = ended_at where id = $1`, [autoBreak]);
      const data4 = await report("2026-08-06", "2026-08-06", [v]);
      check(dayRow(data4, v, "2026-08-06")?.workSeconds === 7200, "5) a break closed by the 3-day backstop is not subtracted either", dayRow(data4, v, "2026-08-06"));

      // A sole row visit lying ENTIRELY inside a break keeps its recorded
      // time and its quantity (never silently dropped; left for review).
      const u = await makeEmployee("VisitInsideBreak");
      const row5 = await makeRow();
      await makeWork(u, row5, "2026-08-06T16:04:00Z", "2026-08-06T16:05:00Z", 996);
      await makeBreak(u, "2026-08-06T16:00:00Z", "2026-08-06T16:17:00Z");
      const attr5 = await attribution("2026-08-06", "2026-08-06");
      check(
        attr5.byEmployee.get(u)?.quantity === 996 && attr5.byEmployee.get(u)?.durationSeconds === 60,
        "5) a visit entirely inside a break keeps its 996 stems and its recorded 1 min (not dropped)",
        attr5.byEmployee.get(u)
      );
    }

    // -----------------------------------------------------------------
    // 6) COMBINED DAY (no overlaps): a row change, a split row around a
    //    break, a manual correction entry and an unfinished entry.
    //    Row A 12:00-13:00 (600). Row B 13:00-13:30, break 13:30-14:00,
    //    Row B 14:00-14:30, one completion (400). Manual Row C
    //    14:30-15:30 (300). Row D started 15:30, still open (200).
    //    Expected: 3 h, 1300 stems, 433.3/h, 3 rows completed; the open
    //    entry adds no time and no quantity. Same figures as before Phase 0.
    // -----------------------------------------------------------------
    {
      const x = await makeEmployee("CombinedDay");
      const [ra, rb, rc, rd] = [await makeRow(), await makeRow(), await makeRow(), await makeRow()];
      const a = await makeWork(x, ra, "2026-08-07T12:00:00Z", "2026-08-07T13:00:00Z", 600);
      const b1 = await makeWork(x, rb, "2026-08-07T13:00:00Z", "2026-08-07T13:30:00Z", 400);
      await makeBreak(x, "2026-08-07T13:30:00Z", "2026-08-07T14:00:00Z");
      const b2 = await makeWork(x, rb, "2026-08-07T14:00:00Z", "2026-08-07T14:30:00Z", 400);
      const c = await makeWork(x, rc, "2026-08-07T14:30:00Z", "2026-08-07T15:30:00Z", 300, { manual: true });
      await makeWork(x, rd, "2026-08-07T15:30:00Z", null, 200);
      await completeRow([a], 600, ra);
      await completeRow([b1, b2], 400, rb);
      await completeRow([c], 300, rc);

      const data = await report("2026-08-07", "2026-08-07");
      const r = dayRow(data, x, "2026-08-07");
      check(r?.workSeconds === 3 * 3600, "6) Activity Hours 3 h: rows A, B (both parts) and the manual entry; the open entry adds nothing", r);
      check(r?.quantityWorked === 1300 && r?.rowsCompleted === 3, "6) 600 + 400 + 300 = 1300 stems, 3 rows completed; open row D not invented", r);
      check(close(r?.averageSpeed, 1300 / 3), "6) speed 1300 / 3 h = 433.3/h", r);
      check(r?.breakSeconds === 1800, "6) the 30 min break is reported as break", r);
      check(r?.rowsTouched === 3, "6) three rows touched on the day row (the day row counts finished entries only, as before)", r);
    }
  } finally {
    for (const rid of reportIds) await pool.query("delete from saved_reports where id = $1", [rid]).catch(() => {});
    await pool.query(`delete from row_completions where activity_id = any($1::uuid[])`, [activityIds]).catch(() => {});
    if (timeEntryIds.length) await pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]).catch(() => {});
    if (activityIds.length) await pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]).catch(() => {});
    if (deviceIds.length) await pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]).catch(() => {});
    if (employeeIds.length) await pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]).catch(() => {});
    if (rowIds.length) await pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]).catch(() => {});
    if (phaseId) await pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]).catch(() => {});
    if (landId) await pool.query(`delete from greenhouse_lands where id = $1`, [landId]).catch(() => {});
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
