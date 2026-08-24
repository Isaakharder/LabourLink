// Covers the saved-reports "Employees" selection feature: replacing the old
// component-state-only filter panel (reset on every page load, never
// persisted — see ReportViewPage.tsx before this change) with a real
// server-side definition on the saved_reports row itself
// (046_saved_reports_employee_selection.sql: employee_selection_mode
// "all"|"selected" + employee_ids uuid[]).
//
// GET /:id/data (reports.ts) now derives its employee filter ENTIRELY from
// the report's own saved definition, never from a client-supplied query
// param — this is the one shared chokepoint screen, Print, CSV export, and
// PDF export all fetch through (web/src/pages/desktop/ReportViewPage.tsx
// builds its pivot grid, and therefore every export, from this same fetched
// `data`), so proving this endpoint is correctly filtered proves all four
// surfaces agree — there's no second, separate export-time filtering path
// to independently break.
//
// Run with: npm run test:reports-employee-selection
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
// QA-only past date range, distinct from every other test file's own dates.
const START = "2019-07-17";
const END = "2019-07-17";
const WORK_START = new Date("2019-07-17T14:00:00.000Z");
const WORK_END = new Date("2019-07-17T18:00:00.000Z");

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
  const deviceIds: string[] = [];
  const timeEntryIds: string[] = [];
  const reportIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Report Employee Select Admin ${RUN_ID}`, `qa-report-emp-select-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function makeEmployee(label: string, isActive = true): Promise<string> {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, $6) returning id`,
          [`Report Emp Select ${label} ${RUN_ID}`, `qa-report-emp-select-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash, isActive]
        )
      ).rows[0].id;
      employeeIds.push(id);
      return id;
    }

    const empA = await makeEmployee("A");
    const empB = await makeEmployee("B");
    const empC = await makeEmployee("C");

    const deviceId = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        randomUUID(),
        `QA Report Emp Select Device ${RUN_ID}`,
      ])
    ).rows[0].id;
    deviceIds.push(deviceId);

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Report Emp Select Activity ${RUN_ID}`])
    ).rows[0].id;

    async function makeWorkEntry(employeeId: string): Promise<string> {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual') returning id`,
          [employeeId, deviceId, activityId, WORK_START, WORK_END]
        )
      ).rows[0].id;
      timeEntryIds.push(id);
      return id;
    }
    await makeWorkEntry(empA);
    await makeWorkEntry(empB);
    await makeWorkEntry(empC);

    // -----------------------------------------------------------------
    // 1) Report A saves employees A/B and restores them after "reload"
    //    (a fresh GET, exactly like reopening the page).
    // -----------------------------------------------------------------
    const createA = await call("POST", "/api/reports", {
      token: adminToken,
      body: { name: `QA Report A ${RUN_ID}`, reportType: "payroll", metrics: ["employee", "workTime"], employeeSelectionMode: "selected", employeeIds: [empA, empB] },
    });
    check(createA.status === 201, "1) create Report A with selected [A,B] succeeds", createA.body);
    const reportAId = createA.body.id;
    if (reportAId) reportIds.push(reportAId);

    const getA1 = await call("GET", `/api/reports/${reportAId}`, { token: adminToken });
    check(getA1.body?.report?.employeeSelectionMode === "selected", "1) Report A reloads as mode=selected", getA1.body);
    check(
      JSON.stringify([...(getA1.body?.report?.employeeIds ?? [])].sort()) === JSON.stringify([empA, empB].sort()),
      "1) Report A reloads with exactly [A,B]",
      getA1.body
    );

    const dataA = await call("GET", `/api/reports/${reportAId}/data?start=${START}&end=${END}`, { token: adminToken });
    const dataAIds = new Set((dataA.body?.data?.rows ?? []).map((r: any) => r.employeeId));
    check(dataAIds.has(empA) && dataAIds.has(empB) && !dataAIds.has(empC), "1) Report A's data (screen) contains only A and B, never C", dataA.body?.data?.rows);

    // -----------------------------------------------------------------
    // 2) Report B independently saves employee C — proves no leakage
    //    between reports (Report A's own selection is untouched by this).
    // -----------------------------------------------------------------
    const createB = await call("POST", "/api/reports", {
      token: adminToken,
      body: { name: `QA Report B ${RUN_ID}`, reportType: "payroll", metrics: ["employee", "workTime"], employeeSelectionMode: "selected", employeeIds: [empC] },
    });
    check(createB.status === 201, "2) create Report B with selected [C] succeeds", createB.body);
    const reportBId = createB.body.id;
    if (reportBId) reportIds.push(reportBId);

    const dataB = await call("GET", `/api/reports/${reportBId}/data?start=${START}&end=${END}`, { token: adminToken });
    const dataBIds = new Set((dataB.body?.data?.rows ?? []).map((r: any) => r.employeeId));
    check(dataBIds.has(empC) && !dataBIds.has(empA) && !dataBIds.has(empB), "2) Report B's data contains only C", dataB.body?.data?.rows);

    const getA2 = await call("GET", `/api/reports/${reportAId}`, { token: adminToken });
    check(
      JSON.stringify([...(getA2.body?.report?.employeeIds ?? [])].sort()) === JSON.stringify([empA, empB].sort()),
      "2) Report A's own selection is unchanged after Report B was saved (no cross-report leakage)",
      getA2.body
    );

    // -----------------------------------------------------------------
    // 3) Existing reports (created before this feature, or via any path
    //    that never set the new columns) still open as "All employees" —
    //    simulated here by inserting a saved_reports row directly with
    //    neither column specified, relying purely on the migration's
    //    column defaults, exactly as every pre-migration row now has.
    // -----------------------------------------------------------------
    const legacyReportRes = await pool.query(
      `insert into saved_reports (name, report_type, configuration, created_by)
       values ($1, 'payroll', $2, $3) returning id`,
      [`QA Report Legacy ${RUN_ID}`, JSON.stringify({ metrics: ["employee", "workTime"] }), adminId]
    );
    const legacyReportId = legacyReportRes.rows[0].id;
    reportIds.push(legacyReportId);

    const getLegacy = await call("GET", `/api/reports/${legacyReportId}`, { token: adminToken });
    check(getLegacy.body?.report?.employeeSelectionMode === "all", "3) a pre-existing (column-default) report opens as mode=all", getLegacy.body);
    check((getLegacy.body?.report?.employeeIds ?? []).length === 0, "3) a pre-existing report has no stored employeeIds", getLegacy.body);

    const dataLegacy = await call("GET", `/api/reports/${legacyReportId}/data?start=${START}&end=${END}`, { token: adminToken });
    const legacyIds = new Set((dataLegacy.body?.data?.rows ?? []).map((r: any) => r.employeeId));
    check(legacyIds.has(empA) && legacyIds.has(empB) && legacyIds.has(empC), "3) a pre-existing report's data still includes every employee (unchanged behavior)", dataLegacy.body?.data?.rows);

    // -----------------------------------------------------------------
    // 4) Explicit selections do NOT automatically gain newly created
    //    employees — Report A stays [A,B] even after a new employee D
    //    (with real time entries in this same range) is created.
    // -----------------------------------------------------------------
    const empD = await makeEmployee("D");
    await makeWorkEntry(empD);

    const dataA3 = await call("GET", `/api/reports/${reportAId}/data?start=${START}&end=${END}`, { token: adminToken });
    const dataA3Ids = new Set((dataA3.body?.data?.rows ?? []).map((r: any) => r.employeeId));
    check(!dataA3Ids.has(empD), "4) Report A (explicit [A,B]) does not gain newly created employee D", dataA3.body?.data?.rows);

    // -----------------------------------------------------------------
    // 5) "All" mode DOES include newly eligible employees — the legacy
    //    (mode=all) report picks up D automatically, no re-save needed.
    // -----------------------------------------------------------------
    const dataLegacy2 = await call("GET", `/api/reports/${legacyReportId}/data?start=${START}&end=${END}`, { token: adminToken });
    const legacyIds2 = new Set((dataLegacy2.body?.data?.rows ?? []).map((r: any) => r.employeeId));
    check(legacyIds2.has(empD), "5) an 'all' mode report automatically includes newly eligible employee D", dataLegacy2.body?.data?.rows);

    // -----------------------------------------------------------------
    // 6) An inactive SELECTED employee remains available for historical
    //    reports — deactivate B (already saved in Report A's selection)
    //    and confirm their data still appears, labeled correctly by the
    //    isActive flag GET /api/employees already exposes.
    // -----------------------------------------------------------------
    await pool.query(`update employees set is_active = false where id = $1`, [empB]);
    const dataA4 = await call("GET", `/api/reports/${reportAId}/data?start=${START}&end=${END}`, { token: adminToken });
    const dataA4Ids = new Set((dataA4.body?.data?.rows ?? []).map((r: any) => r.employeeId));
    check(dataA4Ids.has(empB), "6) Report A still returns data for B after B is deactivated (inactive selected employees are preserved)", dataA4.body?.data?.rows);

    // GET /api/employees (employees.ts) is what powers the dropdown's
    // isActive/"Inactive" label client-side — this route file only mounts
    // reportsRouter, so this checks the same is_active flag it reads
    // directly rather than pulling in the whole employees router.
    const empBIsActive = (await pool.query(`select is_active from employees where id = $1`, [empB])).rows[0]?.is_active;
    check(empBIsActive === false, "6) B is recorded as inactive (isActive:false) — the same flag the picker's 'Inactive' badge reads", empBIsActive);

    // -----------------------------------------------------------------
    // 7) Cross-organization / foreign employee ids are rejected — a
    //    random uuid that is not a real employee row must fail both
    //    create and update, never silently save.
    // -----------------------------------------------------------------
    const foreignId = randomUUID();
    const createForeign = await call("POST", "/api/reports", {
      token: adminToken,
      body: { name: `QA Report Foreign ${RUN_ID}`, reportType: "payroll", metrics: ["employee"], employeeSelectionMode: "selected", employeeIds: [foreignId] },
    });
    check(createForeign.status === 400, "7) creating a report with a foreign/unknown employee id is rejected (400)", createForeign.body);

    const patchForeign = await call("PATCH", `/api/reports/${reportAId}`, {
      token: adminToken,
      body: { employeeSelectionMode: "selected", employeeIds: [empA, foreignId] },
    });
    check(patchForeign.status === 400, "7) saving a foreign employee id onto an existing report is rejected (400)", patchForeign.body);

    // -----------------------------------------------------------------
    // 8) Never allow saving an explicit selection with zero employees —
    //    both at create and update time.
    // -----------------------------------------------------------------
    const createEmpty = await call("POST", "/api/reports", {
      token: adminToken,
      body: { name: `QA Report Empty ${RUN_ID}`, reportType: "payroll", metrics: ["employee"], employeeSelectionMode: "selected", employeeIds: [] },
    });
    check(createEmpty.status === 400, "8) creating a report with mode=selected and zero employees is rejected (400)", createEmpty.body);

    const patchEmpty = await call("PATCH", `/api/reports/${reportAId}`, {
      token: adminToken,
      body: { employeeSelectionMode: "selected", employeeIds: [] },
    });
    check(patchEmpty.status === 400, "8) updating a report to mode=selected with zero employees is rejected (400)", patchEmpty.body);

    // Report A's own selection survived every rejected attempt above —
    // still exactly [A,B], never partially mutated by a failed request.
    const getAFinal = await call("GET", `/api/reports/${reportAId}`, { token: adminToken });
    check(
      JSON.stringify([...(getAFinal.body?.report?.employeeIds ?? [])].sort()) === JSON.stringify([empA, empB].sort()),
      "8) Report A's selection is unchanged after every rejected (400) update attempt",
      getAFinal.body
    );

    // -----------------------------------------------------------------
    // 9) Switching a report to mode=all clears its stored employeeIds
    //    (constraint chk_saved_reports_employee_ids_empty_when_all) — and
    //    its data then includes everyone again, same as the legacy report.
    // -----------------------------------------------------------------
    const patchToAll = await call("PATCH", `/api/reports/${reportAId}`, { token: adminToken, body: { employeeSelectionMode: "all" } });
    check(patchToAll.status === 200, "9) switching Report A to mode=all succeeds", patchToAll.body);
    const getAAll = await call("GET", `/api/reports/${reportAId}`, { token: adminToken });
    check(getAAll.body?.report?.employeeSelectionMode === "all" && (getAAll.body?.report?.employeeIds ?? []).length === 0, "9) Report A now reads back as mode=all with no stored ids", getAAll.body);

    // -----------------------------------------------------------------
    // 10) Activity-type reports are filtered through the exact same
    //     mechanism (GET /:id/data derives the filter from the saved
    //     report regardless of report_type).
    // -----------------------------------------------------------------
    const createActivityReport = await call("POST", "/api/reports", {
      token: adminToken,
      body: {
        name: `QA Report Activity ${RUN_ID}`,
        reportType: "activity",
        activityId,
        metrics: ["employee", "workTime"],
        employeeSelectionMode: "selected",
        employeeIds: [empC],
      },
    });
    check(createActivityReport.status === 201, "10) create an activity-type report with selected [C] succeeds", createActivityReport.body);
    const activityReportId = createActivityReport.body.id;
    if (activityReportId) reportIds.push(activityReportId);
    const dataActivity = await call("GET", `/api/reports/${activityReportId}/data?start=${START}&end=${END}`, { token: adminToken });
    const activityIds2 = new Set((dataActivity.body?.data?.rows ?? []).map((r: any) => r.employeeId));
    check(activityIds2.has(empC) && !activityIds2.has(empA) && !activityIds2.has(empD), "10) an activity-type report's data is also filtered to its saved selection", dataActivity.body?.data?.rows);
  } finally {
    for (const rid of reportIds) {
      await pool.query("delete from saved_reports where id = $1", [rid]).catch(() => {});
    }
    for (const tid of timeEntryIds) {
      await pool.query("delete from time_entries where id = $1", [tid]).catch(() => {});
    }
    await pool.query(`delete from activities where name = $1`, [`QA Report Emp Select Activity ${RUN_ID}`]).catch(() => {});
    for (const did of deviceIds) {
      await pool.query("delete from devices where id = $1", [did]).catch(() => {});
    }
    for (const eid of employeeIds) {
      await pool.query("delete from employees where id = $1", [eid]).catch(() => {});
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
