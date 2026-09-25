// Regression coverage for a real production bug: an Activity Report's daily
// and weekly Average Speed silently undercounted quantity whenever an
// employee completed more than one greenhouse row in a day. Root cause
// (see reportQueries.ts's getActivityDensityAttribution and
// computeAmbiguousCycleKeys): Rule 2 ("not-yet-completed row auto-counts
// when unambiguous") checked a row's TOTAL candidate count over its whole
// lifetime, instead of scoping ambiguity to one 7-day "row-work cycle" the
// way server/src/routes/inputs.ts's own canonical per-run speed display
// (ambiguousCycleKeys) already does — so a genuinely unrelated, abandoned
// visit from months ago made THIS week's otherwise-clean, unambiguous visit
// look "ambiguous" too, silently dropping its entire quantity. Separately,
// a completion/run whose segments spanned more than one calendar day was
// simply omitted from every day's view (not dropped from the week total,
// but blank on each day it touched) rather than allocated proportionally.
//
// Concrete real-world case this reproduces: Byron Estuardo Ana Escober,
// Winding & Pruning, Sept 21 2026 — Inputs showed four completed rows
// (~636 stems each, ~275 st/hr combined) but the Activity Report showed
// only 68.8 st/hr (one row's ~636 stems divided by the WHOLE day's ~9:15 of
// Activity Hours) — because three of the four rows' candidates collided
// with unrelated stale history and were wrongly excluded.
//
// Run with: npm run test:reports-density-multi-row
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
        [`ReportDensityMultiRow Admin ${RUN_ID}`, `qa-report-density-multirow-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    async function makeEmployee(label: string): Promise<string> {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [`ReportDensityMultiRow ${label} ${RUN_ID}`, `qa-report-density-multirow-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
        )
      ).rows[0].id;
      employeeIds.push(id);
      return id;
    }

    const deviceId = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        randomUUID(),
        `QA ReportDensityMultiRow Device ${RUN_ID}`,
      ])
    ).rows[0].id;
    deviceIds.push(deviceId);

    const activityId = (
      await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA ReportDensityMultiRow Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(activityId);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA ReportDensityMultiRow Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA ReportDensityMultiRow Phase ${RUN_ID}`,
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

    async function makeWork(
      employeeId: string,
      rowId: string | null,
      start: string,
      end: string,
      opts?: { densityCountPerRow?: number; manual?: boolean }
    ): Promise<string> {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                      greenhouse_row_id, density_type, density_count_per_row, created_by_employee_id, creation_reason)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [
            employeeId,
            deviceId,
            activityId,
            start,
            end,
            opts?.manual ? "manual" : "manual",
            rowId,
            rowId && opts?.densityCountPerRow != null ? "stems" : null,
            opts?.densityCountPerRow ?? null,
            opts?.manual ? adminId : null,
            opts?.manual ? "QA manual entry for test" : null,
          ]
        )
      ).rows[0].id;
      timeEntryIds.push(id);
      return id;
    }

    // An OPEN (no ended_at) work entry — the "in progress" case. Not
    // included in timeEntryIds cleanup's ended-entry assumptions, but
    // deleted the same way in `finally` below regardless.
    async function makeOpenWork(employeeId: string, rowId: string, start: string, densityCountPerRow: number): Promise<string> {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source,
                                      greenhouse_row_id, density_type, density_count_per_row)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, 'manual', $5, 'stems', $6) returning id`,
          [employeeId, deviceId, activityId, start, rowId, densityCountPerRow]
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

    async function createActivityReport(mode: "all" | "selected" = "all", ids: string[] = []): Promise<string> {
      const res = await call("POST", "/api/reports", adminToken, {
        name: `QA DensityMultiRow ${RUN_ID} ${Math.random()}`,
        reportType: "activity",
        activityId,
        dailyMetric: "workTime",
        weeklyTotals: ["activityHours", "averageSpeed"],
        employeeSelectionMode: mode,
        employeeIds: ids,
      });
      const id = res.body.id;
      reportIds.push(id);
      return id;
    }
    async function getData(reportId: string, start: string, end: string): Promise<any> {
      const res = await call("GET", `/api/reports/${reportId}/data?start=${start}&end=${end}`, adminToken);
      return res.body?.data;
    }
    function findEmployeeTotal(data: any, employeeId: string): any {
      return (data?.employeeTotals ?? []).find((t: any) => t.employeeId === employeeId) ?? null;
    }
    function findRow(data: any, employeeId: string, date: string): any {
      return (data?.rows ?? []).find((r: any) => r.employeeId === employeeId && r.date === date) ?? null;
    }

    // -----------------------------------------------------------------
    // 1) MULTIPLE COMPLETED ROWS, SAME DAY: all of them must contribute —
    //    this is the exact shape of the reported bug (four rows completed
    //    in one day, only one counted).
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("MultiRowSameDay");
      const rowA = await makeRow();
      const rowB = await makeRow();
      const rowC = await makeRow();
      const segA = await makeWork(emp, rowA, "2026-08-10T12:00:00Z", "2026-08-10T14:00:00Z", { densityCountPerRow: 600 }); // 2h, 600
      const segB = await makeWork(emp, rowB, "2026-08-10T14:00:00Z", "2026-08-10T15:00:00Z", { densityCountPerRow: 400 }); // 1h, 400
      const segC = await makeWork(emp, rowC, "2026-08-10T15:00:00Z", "2026-08-10T16:00:00Z", { densityCountPerRow: 200 }); // 1h, 200
      await completeRow([segA], 600, rowA);
      await completeRow([segB], 400, rowB);
      await completeRow([segC], 200, rowC);

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-10", "2026-08-10");
      const row = findRow(data, emp, "2026-08-10");
      check(row?.workSeconds === 4 * 3600, "1) Activity Hours sum all three rows' work (2h+1h+1h=4h)", row);
      check(row?.quantityWorked === 1200, "1) quantityWorked sums ALL THREE completed rows (600+400+200=1200), never just one", row);
      check(row?.averageSpeed === 300, "1) daily Average Speed is 1200 / 4h = 300/hour", row);
    }

    // -----------------------------------------------------------------
    // 2) SPLIT SAME ROW, SAME DAY (Row 333 pattern): two segments of the
    //    SAME physical row, broken by a gap, linked to ONE completion —
    //    must count once, using the COMBINED duration, never twice.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("SplitRowSameDay");
      const row = await makeRow();
      const seg1 = await makeWork(emp, row, "2026-08-11T12:00:00Z", "2026-08-11T13:00:00Z", { densityCountPerRow: 600 }); // 1h
      const seg2 = await makeWork(emp, row, "2026-08-11T14:00:00Z", "2026-08-11T15:00:00Z", { densityCountPerRow: 600 }); // 1h (1h break between)
      await completeRow([seg1, seg2], 600, row);

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-11", "2026-08-11");
      const dayRow = findRow(data, emp, "2026-08-11");
      check(dayRow?.workSeconds === 2 * 3600, "2) Activity Hours sums both segments (1h+1h=2h)", dayRow);
      check(dayRow?.quantityWorked === 600, "2) the split row's quantity counts exactly ONCE (600), never 600+600=1200", dayRow);
      check(dayRow?.averageSpeed === 300, "2) Average Speed uses the COMBINED 2h duration: 600/2h=300/hour, not 600/1h=600/hour", dayRow);
    }

    // -----------------------------------------------------------------
    // 3) ROW SPANNING TWO DATES (Row 338 pattern): one completion's
    //    segments fall on two different calendar days — its quantity must
    //    be allocated proportionally by each day's own duration share,
    //    never dropped from either day and never double-counted.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("CrossDateRow");
      const row = await makeRow();
      // Day 1: 2h. Day 2: 1h. Total 3h, quantity 900 -> overall 300/hour.
      // Proportional split: Day1 gets 2/3 of 900 = 600 (600/2h=300/hr); Day2
      // gets 1/3 of 900 = 300 (300/1h=300/hr) — every day this row touches
      // reads the SAME 300/hour the completion's own combined speed is,
      // exactly matching what Inputs shows on every day/run belonging to
      // one completion.
      const seg1 = await makeWork(emp, row, "2026-08-12T20:00:00Z", "2026-08-12T22:00:00Z", { densityCountPerRow: 900 }); // Aug 12, 2h
      const seg2 = await makeWork(emp, row, "2026-08-13T12:00:00Z", "2026-08-13T13:00:00Z", { densityCountPerRow: 900 }); // Aug 13, 1h
      await completeRow([seg1, seg2], 900, row);

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-12", "2026-08-13");
      const day1 = findRow(data, emp, "2026-08-12");
      const day2 = findRow(data, emp, "2026-08-13");
      check(day1?.workSeconds === 2 * 3600, "3) Day 1 Activity Hours is exactly its own 2h segment", day1);
      check(day2?.workSeconds === 3600, "3) Day 2 Activity Hours is exactly its own 1h segment", day2);
      check(day1?.quantityWorked === 600, "3) Day 1 gets 2/3 of the completion's quantity (600 of 900) — never blank, never the full 900", day1);
      check(day2?.quantityWorked === 300, "3) Day 2 gets 1/3 of the completion's quantity (300 of 900) — never blank, never the full 900", day2);
      check(day1?.averageSpeed === 300, "3) Day 1's allocated speed matches the completion's own overall speed (300/hour)", day1);
      check(day2?.averageSpeed === 300, "3) Day 2's allocated speed matches the completion's own overall speed (300/hour)", day2);
      const total = findEmployeeTotal(data, emp);
      check(total?.quantityWorked === 900, "3) the week total is the completion's real 900 — never 0 (dropped) and never 1800 (double-counted)", total);
      check(total?.averageSpeed === 300, "3) the week total speed is 900 / 3h = 300/hour", total);
    }

    // -----------------------------------------------------------------
    // 4) MANUAL SEGMENT counts when it belongs to a valid resolved row
    //    completion — a manually-added time_entries row (created_by_
    //    employee_id/creation_reason set) linked into the same completion
    //    as a phone-originated segment must contribute exactly like any
    //    other segment, never silently excluded for being manual.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("ManualSegment");
      const row = await makeRow();
      const phoneSeg = await makeWork(emp, row, "2026-08-14T12:00:00Z", "2026-08-14T13:00:00Z", { densityCountPerRow: 500 }); // 1h, phone
      const manualSeg = await makeWork(emp, row, "2026-08-14T13:00:00Z", "2026-08-14T14:00:00Z", { densityCountPerRow: 500, manual: true }); // 1h, MANUAL
      await completeRow([phoneSeg, manualSeg], 500, row);

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-14", "2026-08-14");
      const dayRow = findRow(data, emp, "2026-08-14");
      check(dayRow?.workSeconds === 2 * 3600, "4) Activity Hours includes the manually-added segment's own hour", dayRow);
      check(dayRow?.quantityWorked === 500, "4) the completion's quantity counts fully even though one of its two segments is manual", dayRow);
      check(dayRow?.averageSpeed === 250, "4) Average Speed uses the combined 2h (phone+manual): 500/2h=250/hour", dayRow);
    }

    // -----------------------------------------------------------------
    // 5) UNRESOLVED (genuinely ambiguous) row contributes Activity Hours
    //    but never an invented quantity — a second, cleanly-resolved row
    //    the SAME day still contributes its own quantity independently.
    // -----------------------------------------------------------------
    {
      const empX = await makeEmployee("AmbiguousX");
      const empY = await makeEmployee("AmbiguousY");
      const ambiguousRow = await makeRow();
      const cleanRow = await makeRow();
      // Two different employees each touch the SAME physical row on the
      // same day, neither confirmed — genuinely ambiguous (2 candidates,
      // same cycle) per rowCompletionCandidates.ts; per Inputs' own rule,
      // this is exactly what should stay excluded (not this bug's fix).
      await makeWork(empX, ambiguousRow, "2026-08-15T12:00:00Z", "2026-08-15T13:00:00Z", { densityCountPerRow: 700 }); // 1h
      await makeWork(empY, ambiguousRow, "2026-08-15T13:00:00Z", "2026-08-15T14:00:00Z", { densityCountPerRow: 700 }); // 1h
      // empX also cleanly finishes an unrelated row the same day — the sole
      // candidate for ITS OWN row+type, unaffected by the other row's
      // ambiguity.
      await makeWork(empX, cleanRow, "2026-08-15T14:00:00Z", "2026-08-15T15:00:00Z", { densityCountPerRow: 300 }); // 1h

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-15", "2026-08-15");
      const rowX = findRow(data, empX, "2026-08-15");
      check(rowX?.workSeconds === 2 * 3600, "5) empX's Activity Hours includes BOTH the ambiguous row's hour and the clean row's hour", rowX);
      check(rowX?.quantityWorked === 300, "5) empX's quantity is only the CLEAN row's 300 — the ambiguous row contributes nothing invented", rowX);
      check(rowX?.averageSpeed === 150, "5) empX's Average Speed divides the clean-only 300 by the FULL 2h Activity Hours (150/hour), not just the clean row's own 1h", rowX);
    }

    // -----------------------------------------------------------------
    // 6) THE CORE BUG: a stale, unrelated candidate from an OLDER (>7-day)
    //    row-work cycle must NOT make a genuinely clean, unambiguous visit
    //    in THIS report's range look ambiguous. This is the exact defect
    //    reported for Byron's Sept 21 rows.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("StaleOldCycle");
      const row = await makeRow();
      // An abandoned, never-completed touch from 30 days before the report
      // range — a different, much older row-work cycle (CYCLE_GAP_DAYS=7).
      await makeWork(emp, row, "2026-07-12T12:00:00Z", "2026-07-12T13:00:00Z", { densityCountPerRow: 999 });
      // This week's genuine, sole visit — its OWN cycle has exactly one
      // candidate and must auto-count on its own.
      const thisWeekSeg = await makeWork(emp, row, "2026-08-16T12:00:00Z", "2026-08-16T14:00:00Z", { densityCountPerRow: 636 }); // 2h

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-16", "2026-08-16");
      const dayRow = findRow(data, emp, "2026-08-16");
      check(dayRow?.workSeconds === 2 * 3600, "6) Activity Hours is this week's own 2h, unrelated to the old touch", dayRow);
      check(
        dayRow?.quantityWorked === 636,
        "6) THE BUG: this week's clean, unambiguous-within-its-own-cycle visit must still count its 636 — a stale, unrelated candidate from a different cycle must never zero it out",
        dayRow
      );
      check(dayRow?.averageSpeed === 318, "6) Average Speed is 636 / 2h = 318/hour, not null/zero", dayRow);
      void thisWeekSeg;
    }

    // -----------------------------------------------------------------
    // 7) WEEKLY AVERAGE SPEED is total quantity / total matching Activity
    //    Hours — a true ratio-of-sums — never an average of the daily
    //    speed values (which would give a materially different, wrong
    //    number whenever the days have unequal durations).
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("WeeklyRatio");
      const rowA = await makeRow();
      const rowB = await makeRow();
      const segA = await makeWork(emp, rowA, "2026-08-17T12:00:00Z", "2026-08-17T13:00:00Z", { densityCountPerRow: 100 }); // 1h, 100 -> 100/hr
      const segB = await makeWork(emp, rowB, "2026-08-18T12:00:00Z", "2026-08-18T16:00:00Z", { densityCountPerRow: 800 }); // 4h, 800 -> 200/hr
      await completeRow([segA], 100, rowA);
      await completeRow([segB], 800, rowB);

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-17", "2026-08-18");
      const total = findEmployeeTotal(data, emp);
      check(total?.workSeconds === 5 * 3600, "7) total Activity Hours is 1h+4h=5h", total);
      check(total?.quantityWorked === 900, "7) total quantity is 100+800=900", total);
      check(
        total?.averageSpeed === 180,
        "7) Weekly Average Speed is 900/5h=180/hour (ratio-of-sums) — NOT the wrong (100+200)/2=150/hour average-of-dailies",
        total
      );
    }

    // -----------------------------------------------------------------
    // 8) IN-PROGRESS row (no ended_at yet): contributes nothing to Activity
    //    Hours or quantity until it closes — never an invented in-flight
    //    quantity, and never a crash reading a null end time.
    // -----------------------------------------------------------------
    {
      const emp = await makeEmployee("InProgress");
      const row = await makeRow();
      const finishedRow = await makeRow();
      await makeOpenWork(emp, row, "2026-08-19T18:00:00Z", 500); // still open — no ended_at
      const finishedSeg = await makeWork(emp, finishedRow, "2026-08-19T12:00:00Z", "2026-08-19T13:00:00Z", { densityCountPerRow: 250 }); // 1h, finished
      await completeRow([finishedSeg], 250, finishedRow);

      const reportId = await createActivityReport();
      const data = await getData(reportId, "2026-08-19", "2026-08-19");
      const dayRow = findRow(data, emp, "2026-08-19");
      check(dayRow?.workSeconds === 3600, "8) Activity Hours reflects only the FINISHED 1h segment — the open one contributes nothing yet", dayRow);
      check(dayRow?.quantityWorked === 250, "8) quantityWorked is only the finished row's 250 — no invented in-progress quantity", dayRow);
      check(dayRow?.averageSpeed === 250, "8) Average Speed is 250/1h=250/hour", dayRow);
    }
  } finally {
    for (const rid of reportIds) await pool.query("delete from saved_reports where id = $1", [rid]).catch(() => {});
    // row_completions FIRST — row_completion_segments.time_entry_id has no
    // ON DELETE CASCADE from time_entries (026_row_completions.sql), so
    // deleting time_entries first would fail its FK check (silently
    // swallowed by .catch below) and leave every completed segment
    // orphaned. Deleting row_completions cascades row_completion_segments,
    // clearing the way for time_entries to delete cleanly next.
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
