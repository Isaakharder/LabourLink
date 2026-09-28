// Covers scenario 10 of the row-completion-automation feature: an Activity
// Report's "Weekly Rows Completed" (rowsCompleted) must match the actual
// number of ACTIVE row_completions records produced by automatic
// completion — the same data the read-only Production Audit and the
// Row Completion Review modal would show, never a separately-derived
// count. Real router (mobileTime + reports) over real HTTP against the
// real database, same RUN_ID-suffixed disposable-fixture convention as
// this feature's other tests (mobileTime.rowCompletionAutomation.test.ts).
//
// Also reproduces the exact reported "Picking Peppers report shows row
// work but Weekly Rows Completed = 0" symptom before this feature existed
// (no completion was ever created automatically) and proves it now
// resolves to a real, non-zero, correct count.
//
// Run with: npm run test:reports-row-completion-automation
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import mobileTimeRouter from "./mobileTime";
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
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/reports", reportsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function mobile(path: string, deviceIdentifier: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/mobile${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function callReports(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/reports${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const reportIds: string[] = [];
  let landId: string | undefined;
  let phaseId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ReportRowAuto Admin ${RUN_ID}`, `qa-reportrowauto-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    const employeeId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ReportRowAuto Picker ${RUN_ID}`, `qa-reportrowauto-picker-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(employeeId);

    const deviceIdentifier = randomUUID();
    const deviceRowId = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        deviceIdentifier,
        `QA ReportRowAuto Device ${RUN_ID}`,
      ])
    ).rows[0].id;
    deviceIds.push(deviceRowId);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRowId, employeeId]);

    const groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA ReportRowAuto Group ${RUN_ID}`,
      ])
    ).rows[0].id;

    // Named "Picking Peppers"-style — a real density-tracked, row-based
    // activity, matching the reported scenario exactly (RUN_ID-suffixed so
    // this stays a disposable, isolated fixture, never colliding with the
    // real demo "Picking Peppers" activity).
    const activityId = (
      await pool.query(
        `insert into activities (name, is_active, minimum_duration_minutes, density_source) values ($1, true, 0, 'stems') returning id`,
        [`QA ReportRowAuto Picking Peppers ${RUN_ID}`]
      )
    ).rows[0].id;
    const otherActivityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA ReportRowAuto Other ${RUN_ID}`,
      ])
    ).rows[0].id;
    const questionId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [activityId]
      )
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`, [
      groupId,
      activityId,
      otherActivityId,
    ]);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
      employeeId,
      groupId,
    ]);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 200, 100) returning id`, [
        `QA ReportRowAuto Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 200, 100) returning id`, [
        landId,
        `QA ReportRowAuto Phase ${RUN_ID}`,
      ])
    ).rows[0].id;
    const plantDensityId = (
      await pool.query(`insert into plant_densities (name, type, count_per_row) values ($1, 'stems', 636) returning id`, [
        `QA ReportRowAuto Density ${RUN_ID}`,
      ])
    ).rows[0].id;
    let nextRowNumber = 1;
    async function makeRow(): Promise<string> {
      const rowId = (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, 3, 2, 20, 'horizontal') returning id`,
          [phaseId, nextRowNumber++]
        )
      ).rows[0].id;
      await pool.query(`insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, 'stems')`, [
        plantDensityId,
        rowId,
      ]);
      return rowId;
    }

    function answers(rowId: string) {
      return [{ questionId, greenhouseRowId: rowId }];
    }
    async function enterRow(rowId: string) {
      return mobile("/time-entries/work", deviceIdentifier, {
        activityId,
        idempotencyKey: randomUUID(),
        answers: answers(rowId),
        confirmSwitch: true,
      });
    }
    async function switchToOther() {
      return mobile("/time-entries/work", deviceIdentifier, { activityId: otherActivityId, idempotencyKey: randomUUID(), confirmSwitch: true });
    }

    // Three distinct rows, each entered and left today — three automatic
    // completions, matching the "multiple completed rows in one day" shape
    // from the reported bug.
    const rowA = await makeRow();
    const rowB = await makeRow();
    const rowC = await makeRow();
    for (const row of [rowA, rowB, rowC]) {
      const enter = await enterRow(row);
      check(enter.status === 200, `entering row succeeds`, enter.body);
      const leave = await switchToOther();
      check(leave.status === 200, `leaving row succeeds`, leave.body);
    }

    const { rows: completionRows } = await pool.query(
      `select id from row_completions where activity_id = $1 and status = 'active'`,
      [activityId]
    );
    check(completionRows.length === 3, "exactly three active completions exist after three completed rows", completionRows);

    // Create the report and confirm Weekly Rows Completed matches.
    const createRes = await fetch(`${BASE}/api/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${adminToken}` },
      body: JSON.stringify({
        name: `QA ReportRowAuto Report ${RUN_ID}`,
        reportType: "activity",
        activityId,
        dailyMetric: "rowsCompleted",
        weeklyTotals: ["rowsCompleted", "rows"],
      }),
    });
    const created = (await createRes.json()) as { id: string };
    check(!!created.id, "report creation succeeds", created);
    reportIds.push(created.id);

    const today = new Date().toISOString().slice(0, 10);
    const dataRes = await callReports("GET", `/${created.id}/data?start=${today}&end=${today}`, adminToken);
    check(dataRes.status === 200, "report data endpoint responds 200", dataRes.body);

    const employeeTotal = (dataRes.body?.data?.employeeTotals ?? []).find((t: any) => t.employeeId === employeeId);
    check(
      employeeTotal?.rowsCompleted === 3,
      "the report's Weekly Rows Completed (rowsCompleted) matches the three ACTIVE completion records exactly — never 0, never double-counted",
      employeeTotal
    );

    const dayRow = (dataRes.body?.data?.rows ?? []).find((r: any) => r.employeeId === employeeId && r.date === today);
    check(dayRow?.rowsCompleted === 3, "the day-row's own rowsCompleted also matches (3)", dayRow);

    // Cross-check against the audit endpoint too — same underlying data,
    // same answer, never a second calculation.
    const auditRes = await callReports(
      "GET",
      `/audit/density-attribution?activityId=${activityId}&employeeId=${employeeId}&start=${today}&end=${today}`,
      adminToken
    );
    const includedCompletedSegments = (auditRes.body?.segments ?? []).filter(
      (s: any) => s.completionGrouping?.kind === "completed" && s.includedInReport
    );
    const distinctCompletionIds = new Set(includedCompletedSegments.map((s: any) => s.completionGrouping.completionId));
    check(
      distinctCompletionIds.size === 3,
      "the Production Audit independently shows the same three distinct completed rows",
      [...distinctCompletionIds]
    );
  } finally {
    for (const rid of reportIds) await pool.query("delete from saved_reports where id = $1", [rid]).catch(() => {});
    for (const rid of employeeIds) {
      await pool
        .query(`delete from row_completion_segments where time_entry_id in (select id from time_entries where employee_id = $1)`, [rid])
        .catch(() => {});
    }
    await pool
      .query(`delete from row_completions where activity_id in (select id from activities where name like 'QA ReportRowAuto%')`)
      .catch(() => {});
    for (const rid of employeeIds) {
      await pool.query(`delete from mobile_time_events where employee_id = $1`, [rid]).catch(() => {});
      await pool.query(`delete from time_entries where employee_id = $1`, [rid]).catch(() => {});
    }
    await pool
      .query(`delete from activity_questions where activity_id in (select id from activities where name like 'QA ReportRowAuto%')`)
      .catch(() => {});
    await pool.query(`delete from activities where name like 'QA ReportRowAuto%'`).catch(() => {});
    for (const did of deviceIds) {
      await pool.query(`delete from device_sync_state where device_id = $1`, [did]).catch(() => {});
      await pool.query(`delete from device_assignments where device_id = $1`, [did]).catch(() => {});
      await pool.query(`delete from devices where id = $1`, [did]).catch(() => {});
    }
    await pool.query(`delete from employee_activity_group_assignments where employee_id = any($1::uuid[])`, [employeeIds]).catch(() => {});
    await pool
      .query(`delete from activity_group_activities where activity_group_id in (select id from activity_groups where name like 'QA ReportRowAuto%')`)
      .catch(() => {});
    await pool.query(`delete from activity_groups where name like 'QA ReportRowAuto%'`).catch(() => {});
    for (const eid of employeeIds) {
      await pool.query(`delete from employees where id = $1`, [eid]).catch(() => {});
    }
    if (phaseId!) {
      await pool.query(`delete from greenhouse_rows where phase_id = $1`, [phaseId]).catch(() => {});
      await pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]).catch(() => {});
    }
    if (landId!) await pool.query(`delete from greenhouse_lands where id = $1`, [landId]).catch(() => {});
    await pool.query(`delete from plant_densities where name like 'QA ReportRowAuto%'`).catch(() => {});
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
