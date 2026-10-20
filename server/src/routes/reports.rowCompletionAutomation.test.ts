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
// Also covers two follow-up cases verified against a real local Postgres
// and the ACTUAL report query (never just the row_completions table
// directly):
//   Case 1) Complete a row, then re-enter it and stay — WHILE that re-entry
//     is still open, Weekly Rows Completed / quantity attribution must
//     exclude it (the row isn't "finished" again until it's left once
//     more) — see rowCompletionAutomation.ts's markRowReopenedIfApplicable.
//   Case 2) After a completion exists, use the REAL Inputs correction
//     routes (POST .../correction-preview + PATCH .../correction) to
//     change/extend one of its segments — the completion's included
//     segments, duration, per-employee credit, and quantity must reflect
//     the correction, never stay frozen on the pre-correction data (see
//     ActivityCorrectionContinuation's own "originEntryId" comment in
//     inputs.ts for the stale-membership bug this fixes: a correction that
//     EXTENDS a segment creates a brand-new time_entries row that must be
//     relinked into the same row_completions record).
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

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/inputs", inputsRouter);
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
  async function admin(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/inputs${path}`, {
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

    // One extra report, reused by Case 1/2 below, so each sub-test can
    // compare its own before/after delta rather than depending on the
    // three-row baseline above (whose exact count is that OTHER test's own
    // concern, not this one's).
    async function createReport(weeklyTotals: string[]): Promise<string> {
      const res = await fetch(`${BASE}/api/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${adminToken}` },
        body: JSON.stringify({
          name: `QA ReportRowAuto Report2 ${RUN_ID}`,
          reportType: "activity",
          activityId,
          dailyMetric: "rowsCompleted",
          weeklyTotals,
        }),
      });
      const body = (await res.json()) as { id: string };
      reportIds.push(body.id);
      return body.id;
    }
    async function employeeTotalFor(reportId: string, empId: string): Promise<any> {
      const dataRes2 = await callReports("GET", `/${reportId}/data?start=${today}&end=${today}`, adminToken);
      return (dataRes2.body?.data?.employeeTotals ?? []).find((t: any) => t.employeeId === empId);
    }
    async function makeQaEmployee(label: string): Promise<{ employeeId: string; deviceIdentifier: string }> {
      const empIdRow = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [
            `ReportRowAuto ${label} ${RUN_ID}`,
            `qa-reportrowauto-${label.toLowerCase()}-${RUN_ID}@test.local`,
            employeeRoleId,
            teamRoleId,
            fakePinHash,
          ]
        )
      ).rows[0].id;
      employeeIds.push(empIdRow);
      const deviceIdentifier2 = randomUUID();
      const deviceRowId2 = (
        await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
          deviceIdentifier2,
          `QA ReportRowAuto ${label} Device ${RUN_ID}`,
        ])
      ).rows[0].id;
      deviceIds.push(deviceRowId2);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRowId2, empIdRow]);
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        empIdRow,
        groupId,
      ]);
      return { employeeId: empIdRow, deviceIdentifier: deviceIdentifier2 };
    }
    async function sync(deviceIdentifier2: string, events: unknown[]): Promise<{ status: number; body: any }> {
      return mobile("/sync/events", deviceIdentifier2, { events });
    }
    async function previewAndCorrect(
      runEntryId: string,
      correction: { startTime?: string; endTime?: string }
    ): Promise<{ status: number; body: any }> {
      const preview = await admin("POST", `/activity-runs/${runEntryId}/correction-preview`, adminToken, correction);
      check(preview.status === 200, "correction-preview succeeds", preview.body);
      const fingerprint = preview.body?.fingerprint;
      return admin("PATCH", `/activity-runs/${runEntryId}/correction`, adminToken, { ...correction, fingerprint });
    }

    // -----------------------------------------------------------------
    // Case 1: complete a row, then re-enter it and STAY — while that
    // re-entry is still open, the completion must be excluded from Weekly
    // Rows Completed / quantity attribution (it isn't "finished" again
    // until the worker leaves it once more). Leaving again must restore
    // the count via ONE combined completion, never two.
    // -----------------------------------------------------------------
    {
      const empK = await makeQaEmployee("CaseOneK");
      const rowK = await makeRow();
      const reportId = await createReport(["rowsCompleted", "quantityWorked"]);

      const baseline = await employeeTotalFor(reportId, empK.employeeId);
      check(baseline === undefined, "Case1) empK has no report row yet (no work done)", baseline);

      const enterK1 = await mobile("/time-entries/work", empK.deviceIdentifier, {
        activityId,
        idempotencyKey: randomUUID(),
        answers: answers(rowK),
        confirmSwitch: true,
      });
      check(enterK1.status === 200, "Case1) entering Row K succeeds", enterK1.body);
      const leaveK1 = await mobile("/time-entries/work", empK.deviceIdentifier, {
        activityId: otherActivityId,
        idempotencyKey: randomUUID(),
        confirmSwitch: true,
      });
      check(leaveK1.status === 200, "Case1) leaving Row K (visit 1) completes it", leaveK1.body);

      const afterVisit1 = await employeeTotalFor(reportId, empK.employeeId);
      check(afterVisit1?.rowsCompleted === 1, "Case1) report rowsCompleted is 1 right after Row K completes", afterVisit1);
      check(afterVisit1?.quantityWorked === 636, "Case1) report quantityWorked is 636 (one row's frozen density)", afterVisit1);

      // Re-enter Row K and DO NOT leave — this is the intermediate state
      // the user asked about.
      const reenterK = await mobile("/time-entries/work", empK.deviceIdentifier, {
        activityId,
        idempotencyKey: randomUUID(),
        answers: answers(rowK),
        confirmSwitch: true,
      });
      check(reenterK.status === 200, "Case1) re-entering Row K succeeds", reenterK.body);

      const statusRows = await pool.query(
        `select status from row_completions where greenhouse_row_id = $1 and activity_id = $2 order by created_at desc limit 1`,
        [rowK, activityId]
      );
      check(
        statusRows.rows[0]?.status === "reopened",
        "Case1) Row K's completion flips to 'reopened' the INSTANT re-entry is detected (entry time, not the next exit)",
        statusRows.rows
      );

      const whileOpen = await employeeTotalFor(reportId, empK.employeeId);
      check(
        (whileOpen?.rowsCompleted ?? 0) === 0,
        "Case1) WHILE Row K's re-entry is open, the REAL report's rowsCompleted drops back to 0 — Row K no longer counts as completed",
        whileOpen
      );
      check(
        (whileOpen?.quantityWorked ?? 0) === 0,
        "Case1) quantity attribution for Row K is excluded while the re-entry is open — never frozen on the pre-reopen total",
        whileOpen
      );

      // Leave again — recombines pre/post-reopen segments into ONE new
      // active completion, restoring the count (never double-counting).
      const leaveK2 = await mobile("/time-entries/work", empK.deviceIdentifier, {
        activityId: otherActivityId,
        idempotencyKey: randomUUID(),
        confirmSwitch: true,
      });
      check(leaveK2.status === 200, "Case1) leaving Row K again (visit 2) succeeds", leaveK2.body);

      const afterVisit2 = await employeeTotalFor(reportId, empK.employeeId);
      check(
        afterVisit2?.rowsCompleted === 1,
        "Case1) after finally leaving again, rowsCompleted is back to 1 — ONE combined completion, never two",
        afterVisit2
      );
      check(afterVisit2?.quantityWorked === 636, "Case1) quantityWorked is back to 636 (still one row's worth, never doubled)", afterVisit2);
    }

    // -----------------------------------------------------------------
    // Case 2a ("change"): a completed row's own segment is corrected via
    // the REAL Inputs correction routes (preview + PATCH
    // .../activity-runs/:id/correction) — a straightforward same-identity
    // time trim. Duration must reflect the corrected (shorter) span live;
    // quantity (frozen per-row density, duration-independent) must stay
    // exactly the same.
    // -----------------------------------------------------------------
    {
      const empH = await makeQaEmployee("CaseTwoChangeH");
      const rowN = await makeRow();
      const reportId = await createReport(["quantityWorked"]);

      // Backdated 20 minutes, safely in the past — a controlled, exact
      // 10-minute (600s) visit, entirely deterministic regardless of real
      // wall-clock test-execution speed.
      const t0 = new Date(Date.now() - 20 * 60 * 1000);
      const t = (secondsOffset: number) => new Date(t0.getTime() + secondsOffset * 1000).toISOString();
      const enterEvent = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: t(0),
        activityId,
        greenhouseRowId: rowN,
        answers: { [questionId]: { questionId, questionType: "greenhouse_row", greenhouseRowId: rowN } },
      };
      const leaveEvent = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "activity_switch",
        occurredAtUtc: t(600),
        activityId: otherActivityId,
        answers: null,
      };
      const syncRes = await sync(empH.deviceIdentifier, [enterEvent, leaveEvent]);
      check(
        syncRes.body?.results?.every((r: any) => r.status === "accepted"),
        "Case2a) the backdated 10-minute Row N visit is accepted",
        syncRes.body
      );

      const { rows: segRowsN } = await pool.query(
        `select te.id, rc.id as completion_id
         from time_entries te
         join row_completion_segments rcs on rcs.time_entry_id = te.id
         join row_completions rc on rc.id = rcs.row_completion_id
         where te.employee_id = $1 and te.greenhouse_row_id = $2 and rc.status = 'active'`,
        [empH.employeeId, rowN]
      );
      check(segRowsN.length === 1, "Case2a) Row N has exactly one linked segment before correction", segRowsN);
      const runIdN = segRowsN[0].id;
      const completionIdN = segRowsN[0].completion_id;

      const { rows: beforeDur } = await pool.query(
        `select sum(extract(epoch from (te.ended_at - te.started_at))) as duration_seconds
         from row_completion_segments rcs join time_entries te on te.id = rcs.time_entry_id
         where rcs.row_completion_id = $1`,
        [completionIdN]
      );
      check(Number(beforeDur[0].duration_seconds) === 600, "Case2a) the completion's live duration is exactly 600s before correction", beforeDur[0]);

      const quantityBefore = await employeeTotalFor(reportId, empH.employeeId);
      check(quantityBefore?.quantityWorked === 636, "Case2a) report quantityWorked is 636 before the correction", quantityBefore);

      // Shrink the visit down to 4 minutes (240s) via the REAL correction
      // route — a genuine same-identity trim, no row/activity reassignment.
      const corrected = await previewAndCorrect(runIdN, { endTime: t(240) });
      check(corrected.status === 200, "Case2a) the real PATCH .../correction succeeds", corrected.body);

      const { rows: afterDur } = await pool.query(
        `select count(*) as n, sum(extract(epoch from (te.ended_at - te.started_at))) as duration_seconds
         from row_completion_segments rcs join time_entries te on te.id = rcs.time_entry_id
         where rcs.row_completion_id = $1`,
        [completionIdN]
      );
      check(Number(afterDur[0].n) === 1, "Case2a) still exactly one linked segment after the trim (same id, never re-linked)", afterDur[0]);
      check(
        Number(afterDur[0].duration_seconds) === 240,
        "Case2a) the completion's live duration reflects the corrected (shorter) span — never frozen at 600s",
        afterDur[0]
      );

      const quantityAfter = await employeeTotalFor(reportId, empH.employeeId);
      check(
        quantityAfter?.quantityWorked === 636,
        "Case2a) report quantityWorked is UNCHANGED by the duration correction (frozen per-row density, duration-independent)",
        quantityAfter
      );
    }

    // -----------------------------------------------------------------
    // Case 2b ("move"/"extend" — the stale-membership bug): a combined,
    // two-employee completion exists (empF's visit, then empG's re-entry —
    // see Case 1's own reopen mechanism). A REAL correction EXTENDS empG's
    // own segment far past its recorded end. Before the fix, this created
    // a brand-new, entirely UNLINKED continuation row — invisible to the
    // completion's own duration/quantity/employee-credit attribution
    // forever after. Verifies the fix: the continuation is relinked, the
    // completion's total duration grows accordingly, and "Weekly Rows
    // Completed" credit (awarded to whichever employee holds the largest
    // duration share) correctly FLIPS from empF to empG.
    // -----------------------------------------------------------------
    {
      const empF = await makeQaEmployee("CaseTwoMoveF");
      const empG = await makeQaEmployee("CaseTwoMoveG");
      const rowP = await makeRow();
      const reportId = await createReport(["rowsCompleted", "quantityWorked"]);

      const enterF = await mobile("/time-entries/work", empF.deviceIdentifier, {
        activityId,
        idempotencyKey: randomUUID(),
        answers: answers(rowP),
        confirmSwitch: true,
      });
      check(enterF.status === 200, "Case2b) empF entering Row P succeeds", enterF.body);
      const leaveF = await mobile("/time-entries/work", empF.deviceIdentifier, {
        activityId: otherActivityId,
        idempotencyKey: randomUUID(),
        confirmSwitch: true,
      });
      check(leaveF.status === 200, "Case2b) empF leaving Row P completes it (visit 1)", leaveF.body);

      const enterG = await mobile("/time-entries/work", empG.deviceIdentifier, {
        activityId,
        idempotencyKey: randomUUID(),
        answers: answers(rowP),
        confirmSwitch: true,
      });
      check(enterG.status === 200, "Case2b) empG re-entering Row P succeeds (reopens empF's completion)", enterG.body);
      const leaveG = await mobile("/time-entries/work", empG.deviceIdentifier, {
        activityId: otherActivityId,
        idempotencyKey: randomUUID(),
        confirmSwitch: true,
      });
      check(leaveG.status === 200, "Case2b) empG leaving Row P combines both visits into one completion", leaveG.body);
      // Close empG's own subsequent otherActivityId entry too — the
      // correction endpoint refuses to run past an in-progress entry.
      const endDayG = await mobile("/time-entries/end-day", empG.deviceIdentifier, { idempotencyKey: randomUUID() });
      check(endDayG.status === 200, "Case2b) closing empG's day succeeds", endDayG.body);

      const { rows: combined } = await pool.query(
        `select id from row_completions where greenhouse_row_id = $1 and activity_id = $2 and status = 'active'`,
        [rowP, activityId]
      );
      check(combined.length === 1, "Case2b) Row P has exactly one combined active completion before correction", combined);
      const completionIdP = combined[0].id;

      const { rows: gSegRow } = await pool.query(
        `select id, started_at from time_entries where employee_id = $1 and greenhouse_row_id = $2 and activity_id = $3`,
        [empG.employeeId, rowP, activityId]
      );
      check(gSegRow.length === 1, "Case2b) empG's own row visit is exactly one segment", gSegRow);
      const gRunId = gSegRow[0].id;
      const gRealStart: Date = gSegRow[0].started_at;

      // Deterministic 20-minute span for empG's segment, fully overriding
      // its (tiny, real-time) original end — dwarfs empF's own real-time
      // duration by construction, so credit must flip to empG.
      const newEndIso = new Date(gRealStart.getTime() + 20 * 60 * 1000).toISOString();
      const correctedG = await previewAndCorrect(gRunId, { endTime: newEndIso });
      check(correctedG.status === 200, "Case2b) the real PATCH .../correction (extending empG's segment) succeeds", correctedG.body);

      const { rows: segsAfter } = await pool.query(
        `select count(*) as n from row_completion_segments where row_completion_id = $1`,
        [completionIdP]
      );
      check(
        Number(segsAfter[0].n) === 3,
        "Case2b) the completion now has THREE linked segments (empF's visit, empG's original visit, and the new continuation) — the continuation was relinked, not left orphaned",
        segsAfter[0]
      );

      const { rows: durAfter } = await pool.query(
        `select sum(extract(epoch from (te.ended_at - te.started_at))) as duration_seconds
         from row_completion_segments rcs join time_entries te on te.id = rcs.time_entry_id
         where rcs.row_completion_id = $1`,
        [completionIdP]
      );
      check(
        Number(durAfter[0].duration_seconds) >= 1195,
        "Case2b) the completion's total duration grew by (approximately) the full 20-minute extension — the extra time is not silently lost",
        durAfter[0]
      );

      const empFTotal = await employeeTotalFor(reportId, empF.employeeId);
      const empGTotal = await employeeTotalFor(reportId, empG.employeeId);
      check(
        (empFTotal?.rowsCompleted ?? 0) === 0 && empGTotal?.rowsCompleted === 1,
        "Case2b) 'Weekly Rows Completed' credit for Row P FLIPS from empF to empG once empG holds the majority duration share",
        { empFTotal, empGTotal }
      );
      check(
        (empGTotal?.quantityWorked ?? 0) >= 600 && (empFTotal?.quantityWorked ?? 0) <= 36,
        "Case2b) quantity attribution shifts to match the new duration split — empG's share is now the overwhelming majority",
        { empFTotal, empGTotal }
      );
    }
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
    // time_entry_corrections/time_entry_deletions have no cascade from
    // time_entries — Case 2a/2b's real PATCH .../correction calls write
    // both (trims -> time_entry_corrections), so these must clear before
    // the time_entries/employees they reference, same dependency-order
    // lesson as mobileTime.rowCompletionAutomation.test.ts's identical fix.
    for (const rid of employeeIds) {
      await pool.query(`delete from mobile_time_events where employee_id = $1`, [rid]).catch(() => {});
      await pool
        .query(`delete from time_entry_corrections where time_entry_id in (select id from time_entries where employee_id = $1)`, [rid])
        .catch(() => {});
      await pool.query(`delete from time_entries where employee_id = $1`, [rid]).catch(() => {});
    }
    await pool
      .query(`delete from time_entry_deletions where deleted_by_employee_id = any($1::uuid[]) or employee_id = any($1::uuid[])`, [
        employeeIds,
      ])
      .catch(() => {});
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
