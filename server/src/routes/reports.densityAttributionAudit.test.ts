// Covers GET /api/reports/audit/density-attribution — the read-only
// production audit that shows, per raw work segment, exactly why the
// Activity Report's density attribution does or doesn't count its
// quantity. Reproduces the reported Byron-style scenario (multiple
// completed rows in one day, a stale cross-cycle candidate, a cross-date
// completion) and proves the audit's own verdicts agree with
// getActivityReportData's actual output for the same data — the audit is a
// VIEW of the real decision, never a second, differently-computed one.
//
// Run with: npm run test:reports-density-attribution-audit
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

  async function call(method: string, path: string, token: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { Cookie: `labourlink_session=${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const timeEntryIds: string[] = [];
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
        [`ReportDensityAudit Admin ${RUN_ID}`, `qa-report-density-audit-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    const empId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ReportDensityAudit Byron ${RUN_ID}`, `qa-report-density-audit-byron-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(empId);

    const deviceId = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        randomUUID(),
        `QA ReportDensityAudit Device ${RUN_ID}`,
      ])
    ).rows[0].id;
    deviceIds.push(deviceId);

    const activityId = (
      await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA ReportDensityAudit Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(activityId);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA ReportDensityAudit Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA ReportDensityAudit Phase ${RUN_ID}`,
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

    async function makeWork(rowId: string | null, start: string, end: string, densityCountPerRow?: number): Promise<string> {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                      greenhouse_row_id, density_type, density_count_per_row)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', $6, $7, $8) returning id`,
          [empId, deviceId, activityId, start, end, rowId, rowId && densityCountPerRow != null ? "stems" : null, densityCountPerRow ?? null]
        )
      ).rows[0].id;
      timeEntryIds.push(id);
      return id;
    }

    async function completeRow(segmentIds: string[], quantityPerRow: number, rowId: string): Promise<string> {
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
      return completionId;
    }

    // -----------------------------------------------------------------
    // Setup mirrors the reported Byron scenario:
    //   - Row A, Row B: two cleanly-completed rows the same day (600, 300).
    //   - Row C: a stale, unrelated candidate from 30 days earlier, plus
    //     this week's clean, unambiguous visit (636) — the exact bug.
    //   - Row D: genuinely ambiguous (a second employee also touches it).
    // -----------------------------------------------------------------
    const rowA = await makeRow();
    const rowB = await makeRow();
    const rowC = await makeRow();
    const rowD = await makeRow();
    const otherEmp = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ReportDensityAudit Other ${RUN_ID}`, `qa-report-density-audit-other-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(otherEmp);

    const segA = await makeWork(rowA, "2026-08-20T12:00:00Z", "2026-08-20T14:00:00Z", 600); // 2h
    const segB = await makeWork(rowB, "2026-08-20T14:00:00Z", "2026-08-20T15:00:00Z", 300); // 1h
    await completeRow([segA], 600, rowA);
    await completeRow([segB], 300, rowB);

    await makeWork(rowC, "2026-07-21T12:00:00Z", "2026-07-21T13:00:00Z", 999); // stale, 30 days earlier, never completed
    const segCThisWeek = await makeWork(rowC, "2026-08-20T15:00:00Z", "2026-08-20T17:00:00Z", 636); // this week's clean 2h visit

    const segDMine = await makeWork(rowD, "2026-08-20T17:00:00Z", "2026-08-20T18:00:00Z", 500); // 1h
    const segDOther = (
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', $6, 'stems', $7) returning id`,
        [otherEmp, deviceId, activityId, "2026-08-21T12:00:00Z", "2026-08-21T13:00:00Z", rowD, 500]
      )
    ).rows[0].id;
    timeEntryIds.push(segDOther);

    const auditRes = await call(
      "GET",
      `/api/reports/audit/density-attribution?activityId=${activityId}&employeeId=${empId}&start=2026-08-20&end=2026-08-21`,
      adminToken
    );
    check(auditRes.status === 200, "audit endpoint responds 200", auditRes.body);
    const segments: any[] = auditRes.body?.segments ?? [];
    check(segments.length === 4, "audit lists exactly this employee's 4 segments in range", segments.map((s) => s.segmentId));

    const rowASeg = segments.find((s) => s.segmentId === segA);
    check(rowASeg?.completionGrouping?.kind === "completed", "Row A segment is grouped as 'completed'", rowASeg);
    check(rowASeg?.includedInReport === true, "Row A segment is marked included", rowASeg);
    check(rowASeg?.attributedQuantity === 600, "Row A segment's attributed quantity is its full 600 (single segment, whole completion)", rowASeg);

    const rowBSeg = segments.find((s) => s.segmentId === segB);
    check(rowBSeg?.includedInReport === true && rowBSeg?.attributedQuantity === 300, "Row B segment is included with attributed quantity 300", rowBSeg);

    const rowCSeg = segments.find((s) => s.segmentId === segCThisWeek);
    check(rowCSeg?.completionGrouping?.kind === "unresolved", "Row C's this-week segment is grouped as 'unresolved' (not yet admin-confirmed)", rowCSeg);
    check(rowCSeg?.completionGrouping?.ambiguous === false, "Row C's this-week segment is NOT flagged ambiguous — the stale old-cycle touch must not pollute it", rowCSeg);
    check(rowCSeg?.includedInReport === true, "Row C's this-week segment is included in the report", rowCSeg);
    check(rowCSeg?.attributedQuantity === 636, "Row C's this-week segment attributes its own full 636", rowCSeg);

    const rowDSeg = segments.find((s) => s.segmentId === segDMine);
    check(rowDSeg?.completionGrouping?.kind === "unresolved", "Row D's segment is grouped as 'unresolved'", rowDSeg);
    check(rowDSeg?.completionGrouping?.ambiguous === true, "Row D's segment IS flagged ambiguous — a second employee genuinely also touched it", rowDSeg);
    check(rowDSeg?.includedInReport === false, "Row D's segment is correctly excluded (ambiguous)", rowDSeg);
    check(typeof rowDSeg?.exclusionReason === "string" && rowDSeg.exclusionReason.length > 0, "Row D's segment carries a human-readable exclusion reason", rowDSeg);

    // Cross-check against the real report: the day's total quantity must be
    // exactly the sum of the audit's own INCLUDED segments' attributed
    // quantities (600 + 300 + 636 = 1536), proving the audit's verdicts
    // agree with getActivityReportData's actual output for this same data.
    const createResRaw = await fetch(`${BASE}/api/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${adminToken}` },
      body: JSON.stringify({
        name: `QA DensityAudit CrossCheck ${RUN_ID}`,
        reportType: "activity",
        activityId,
        dailyMetric: "quantityWorked",
        weeklyTotals: ["activityHours"],
      }),
    });
    const createRes = (await createResRaw.json()) as { id: string };
    const reportId = createRes.id;
    try {
      const dataRes = await call("GET", `/api/reports/${reportId}/data?start=2026-08-20&end=2026-08-20`, adminToken);
      const dayRow = (dataRes.body?.data?.rows ?? []).find((r: any) => r.employeeId === empId && r.date === "2026-08-20");
      check(
        dayRow?.quantityWorked === 600 + 300 + 636,
        "the real report's Aug 20 quantityWorked (600+300+636=1536) matches exactly the sum of the audit's own included segments — the audit is a faithful view of the report's real decision",
        dayRow
      );
    } finally {
      await pool.query("delete from saved_reports where id = $1", [reportId]).catch(() => {});
    }
  } finally {
    // row_completions FIRST — see reports.densityMultiRowAttribution.test.ts's
    // identical comment: row_completion_segments has no ON DELETE CASCADE
    // from time_entries, so deleting time_entries first silently fails its
    // FK check and orphans every completed segment.
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
