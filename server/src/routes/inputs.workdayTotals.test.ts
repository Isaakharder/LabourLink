// Integration coverage for the Inputs workday-total/boundary-provenance
// fix: GET /api/inputs/daily's top "Worked" stat is no longer a sum of
// work-entry durations (which silently excluded any transition gap between
// two activities not covered by a recorded break) — it's now the
// authoritative span (corrected/rounded work-end minus corrected/rounded
// work-start) minus only the union of unpaid break time, via the shared
// computeWorkdayTotals (workdayTotals.ts, unit-tested directly in
// workdayTotals.test.ts). This file proves the ROUTE correctly wires real
// entries into that formula end to end, that Inputs and Payroll
// (getPayrollReportData) agree on the same employee-day's total, that the
// three provenance badges (Rounded/Corrected/Manually added) are correctly
// and distinctly surfaced, and that deletion/correction audit behavior is
// unchanged.
//
// Same real-HTTP-against-real-database convention as
// inputs.badgeReviewConsistency.test.ts — no mocking.
//
// Run with: npm run test:inputs-workday-totals
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc, getDayBoundsUtc } from "../lib/timezone";
import { getPayrollReportData } from "../lib/reportQueries";
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
const DATE = "2019-07-15"; // QA-only past date, distinct from every other test file's own dates

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
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];
  let groupId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Workday Totals Admin ${RUN_ID}`, `qa-workday-totals-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Workday Totals Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);
    // A second, distinct activity — used only to keep two adjacent work
    // entries from merging into one ActivityRun (groupIntoActivityRuns
    // merges two contiguous same-activity segments), the same "alternate
    // activities between adjacent entries" convention
    // inputs.activityRunDeletion.test.ts already documents.
    const activityId2 = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Workday Totals Activity Two ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId2);

    // POST /work-start requires the activity to be one this employee is
    // actually authorized to do (activitySelection.ts) — only scenario 3's
    // manually-added work start goes through that real endpoint, so only
    // its employee needs the assignment, added once that employee exists
    // below.
    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA Workday Totals Group ${RUN_ID}`])
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [groupId, activityId]);

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Workday Totals ${label} ${RUN_ID}`, `qa-workday-totals-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertWork(employeeId: string, startedAt: Date, endedAt: Date | null, useActivityId: string = activityId): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual') returning id`,
        [employeeId, useActivityId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBreak(employeeId: string, startedAt: Date, endedAt: Date, isPaid: boolean): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, is_paid)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual', $4) returning id`,
        [employeeId, startedAt, endedAt, isPaid]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    // -----------------------------------------------------------------
    // 1) The exact reported scenario: 6:45 AM - 7:00 PM, one 1:00:00
    //    unpaid lunch, and a transition gap between two activities that
    //    isn't covered by any break — Worked must be exactly 11:15:00, and
    //    Inputs/Payroll must report the SAME total for this employee-day
    //    (the "use the same shared calculation" requirement).
    // -----------------------------------------------------------------
    const empA = await insertEmployee("Reported Scenario");
    {
      await insertWork(empA, zonedWallTimeToUtc(2019, 7, 15, 6, 45, 0), zonedWallTimeToUtc(2019, 7, 15, 12, 0, 0));
      await insertBreak(empA, zonedWallTimeToUtc(2019, 7, 15, 12, 0, 0), zonedWallTimeToUtc(2019, 7, 15, 13, 0, 0), false);
      await insertWork(empA, zonedWallTimeToUtc(2019, 7, 15, 13, 0, 0), zonedWallTimeToUtc(2019, 7, 15, 17, 30, 0));
      // 68-second untracked transition gap — no break entry covers it,
      // exactly the shape of the real Reynaldo Aug 17 discrepancy.
      await insertWork(empA, zonedWallTimeToUtc(2019, 7, 15, 17, 31, 8), zonedWallTimeToUtc(2019, 7, 15, 19, 0, 0));

      const daily = await call("GET", `/api/inputs/daily?employeeId=${empA}&date=${DATE}`, { token: adminToken });
      check(daily.status === 200, "1) GET /daily succeeds", daily.body);
      check(
        daily.body?.totals?.workedSeconds === 11 * 3600 + 15 * 60,
        `1) Worked is exactly 11:15:00 (${daily.body?.totals?.workedSeconds}s) — the reported bug's own numbers`,
        daily.body?.totals
      );
      check(daily.body?.totals?.unpaidBreakSeconds === 3600, "1) unpaid break total is the recorded one hour", daily.body?.totals);

      const { start, end } = getDayBoundsUtc(DATE);
      const payroll = await getPayrollReportData(DATE, DATE, { employeeIds: [empA] });
      const payrollRow = payroll.rows.find((r) => r.employeeId === empA);
      check(payrollRow !== undefined, "1) Payroll has a row for this employee-day", payroll.rows);
      check(
        payrollRow?.workSeconds === daily.body.totals.workedSeconds,
        `1) Payroll's workSeconds (${payrollRow?.workSeconds}) exactly matches Inputs' workedSeconds (${daily.body.totals.workedSeconds}) — Inputs and Payroll can never disagree`,
        { payroll: payrollRow, inputs: daily.body.totals }
      );
      void start;
      void end;
    }

    // -----------------------------------------------------------------
    // 2) Paid breaks do not reduce Worked (route-level, not just the pure
    //    formula).
    // -----------------------------------------------------------------
    const empB = await insertEmployee("Paid Break");
    {
      await insertWork(empB, zonedWallTimeToUtc(2019, 7, 15, 8, 0, 0), zonedWallTimeToUtc(2019, 7, 15, 9, 0, 0));
      await insertBreak(empB, zonedWallTimeToUtc(2019, 7, 15, 9, 0, 0), zonedWallTimeToUtc(2019, 7, 15, 9, 15, 0), true);
      await insertWork(empB, zonedWallTimeToUtc(2019, 7, 15, 9, 15, 0), zonedWallTimeToUtc(2019, 7, 15, 12, 0, 0));

      const daily = await call("GET", `/api/inputs/daily?employeeId=${empB}&date=${DATE}`, { token: adminToken });
      check(
        daily.body?.totals?.workedSeconds === 4 * 3600,
        `2) Worked equals the FULL 8:00-12:00 span (${daily.body?.totals?.workedSeconds}s = 4h) — the paid 15-min break never subtracted`,
        daily.body?.totals
      );
    }

    // -----------------------------------------------------------------
    // 3) Provenance badges — Rounded, Corrected, and Manually added must
    //    all be independently and correctly surfaced, and mutually
    //    exclusive on any one field.
    // -----------------------------------------------------------------
    const empC = await insertEmployee("Provenance");
    {
      // A break rounding actually applied to (actual_started_at/
      // actual_ended_at set, differing from the effective values) — must
      // show "Rounded" (endedAtOriginalTime/startedAtOriginalTime), never
      // "Corrected".
      const roundedBreakId = await insertBreak(empC, zonedWallTimeToUtc(2019, 7, 15, 12, 0, 0), zonedWallTimeToUtc(2019, 7, 15, 12, 30, 0), false);
      await pool.query(`update time_entries set actual_started_at = $1, actual_ended_at = $2 where id = $3`, [
        zonedWallTimeToUtc(2019, 7, 15, 12, 1, 12),
        zonedWallTimeToUtc(2019, 7, 15, 12, 28, 40),
        roundedBreakId,
      ]);

      // A work run whose end time gets corrected via the REAL preview ->
      // apply flow (general Activity Time Correction workflow) — must show
      // "Corrected" (endedAtCorrectedFrom), never "Rounded", and the
      // correction must still land in time_entry_corrections exactly as
      // before this fix. Shortening (13:47:12 -> 13:45:00) trims the same
      // row in place, unlike an expansion (see inputs.activityRunCorrection.test.ts).
      const correctedRunId = await insertWork(empC, zonedWallTimeToUtc(2019, 7, 15, 13, 0, 0), zonedWallTimeToUtc(2019, 7, 15, 13, 47, 12));
      const correctionPreview = await call("POST", `/api/inputs/activity-runs/${correctedRunId}/correction-preview`, {
        token: adminToken,
        body: { endTime: zonedWallTimeToUtc(2019, 7, 15, 13, 45, 0).toISOString() },
      });
      const correctionRes = await call("PATCH", `/api/inputs/activity-runs/${correctedRunId}/correction`, {
        token: adminToken,
        body: { endTime: zonedWallTimeToUtc(2019, 7, 15, 13, 45, 0).toISOString(), fingerprint: correctionPreview.body.fingerprint },
      });
      check(correctionRes.status === 200, "3) the end-time correction succeeds", correctionRes.body);

      const daily = await call("GET", `/api/inputs/daily?employeeId=${empC}&date=${DATE}`, { token: adminToken });
      const breakRow = daily.body?.breaks?.find((b: any) => b.id === roundedBreakId);
      check(
        breakRow?.startedAtOriginalTime != null && breakRow?.endedAtOriginalTime != null,
        "3) the rounded break shows Rounded evidence (startedAtOriginalTime/endedAtOriginalTime)",
        breakRow
      );
      check(
        breakRow?.startedAtCorrectedFrom == null && breakRow?.endedAtCorrectedFrom == null,
        "3) the rounded break shows NO Corrected evidence — the two badges are mutually exclusive",
        breakRow
      );

      const correctedRun = daily.body?.runs?.find((r: any) => r.id === correctedRunId);
      check(
        correctedRun?.endedAtCorrectedFrom != null,
        "3) the administratively-corrected run shows Corrected evidence (endedAtCorrectedFrom)",
        correctedRun
      );
      check(
        new Date(correctedRun.endedAtCorrectedFrom).getTime() === zonedWallTimeToUtc(2019, 7, 15, 13, 47, 12).getTime(),
        "3) endedAtCorrectedFrom carries the exact pre-correction value (13:47:12), from the real time_entry_corrections audit row",
        correctedRun?.endedAtCorrectedFrom
      );
      check(
        correctedRun?.endedAtOriginalTime == null,
        "3) the corrected run shows NO Rounded evidence — a correction always clears actual_ended_at, and that's correctly reflected as 'no rounding', not falsely labeled",
        correctedRun
      );

    }

    // A brand-new work-start created directly from Inputs, for an employee
    // with no other entries that day — must show "Manually added"
    // (existing mechanism), and neither of the other two badges.
    const empE = await insertEmployee("Manually Added");
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [empE, groupId]);
    {
      const manualRes = await call("POST", "/api/inputs/work-start", {
        token: adminToken,
        body: {
          employeeId: empE,
          date: DATE,
          activityId,
          startTime: zonedWallTimeToUtc(2019, 7, 15, 6, 0, 0).toISOString(),
          reason: "QA: backfilled work start",
        },
      });
      check(manualRes.status === 201, "3) the manual work-start is created", manualRes.body);

      const dailyAfter = await call("GET", `/api/inputs/daily?employeeId=${empE}&date=${DATE}`, { token: adminToken });
      check(dailyAfter.body?.workStartManualEntry != null, "3) the manually-created work start shows Manually added evidence", dailyAfter.body?.workStartManualEntry);
      check(
        dailyAfter.body?.workStartCorrectedFrom == null && dailyAfter.body?.workStartOriginalTime == null,
        "3) the manually-created work start shows neither Rounded nor Corrected evidence",
        { corrected: dailyAfter.body?.workStartCorrectedFrom, rounded: dailyAfter.body?.workStartOriginalTime }
      );
    }

    // -----------------------------------------------------------------
    // 4) Deletion/correction audit behavior is unchanged, and the Worked
    //    total correctly reflects the result: deleting the FIRST of two
    //    activities extends the second one backward (existing behavior,
    //    see inputs.activityRunDeletion.test.ts) — Worked must still equal
    //    the full original span after the extension, proving the new
    //    formula and the old audit-preserving deletion logic compose
    //    correctly.
    // -----------------------------------------------------------------
    const empD = await insertEmployee("Deletion Audit");
    {
      // Different activities on the two entries — otherwise
      // groupIntoActivityRuns merges them into one contiguous run, and
      // there'd be no standalone "first entry" id left to target for
      // deletion (see activityId2's own comment above).
      const firstId = await insertWork(empD, zonedWallTimeToUtc(2019, 7, 15, 7, 0, 0), zonedWallTimeToUtc(2019, 7, 15, 7, 30, 0), activityId);
      const secondId = await insertWork(empD, zonedWallTimeToUtc(2019, 7, 15, 7, 30, 0), zonedWallTimeToUtc(2019, 7, 15, 9, 0, 0), activityId2);

      const deleteRes = await call("POST", `/api/inputs/activity-runs/${firstId}/delete`, { token: adminToken });
      check(deleteRes.status === 200, "4) the deletion succeeds", deleteRes.body);

      const deletedRow = await pool.query(`select deleted_at, deleted_by_employee_id from time_entries where id = $1`, [firstId]);
      check(
        deletedRow.rows[0].deleted_at !== null && deletedRow.rows[0].deleted_by_employee_id === adminId,
        "4) the deleted entry is soft-deleted with the admin recorded — audit behavior unchanged",
        deletedRow.rows[0]
      );
      const extendedRow = await pool.query(`select started_at from time_entries where id = $1`, [secondId]);
      check(
        new Date(extendedRow.rows[0].started_at).getTime() === zonedWallTimeToUtc(2019, 7, 15, 7, 0, 0).getTime(),
        "4) the following entry is extended backward to the deleted run's original start — audit behavior unchanged",
        extendedRow.rows[0]
      );
      const correctionRows = await pool.query(`select field_name, old_value, new_value from time_entry_corrections where time_entry_id = $1`, [secondId]);
      check(correctionRows.rows.length === 1 && correctionRows.rows[0].field_name === "started_at", "4) the extension is recorded in time_entry_corrections — audit behavior unchanged", correctionRows.rows);

      const daily = await call("GET", `/api/inputs/daily?employeeId=${empD}&date=${DATE}`, { token: adminToken });
      check(
        daily.body?.totals?.workedSeconds === 2 * 3600,
        `4) Worked is still the full original 7:00-9:00 span (${daily.body?.totals?.workedSeconds}s = 2h) after the deletion+extension`,
        daily.body?.totals
      );
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    // Broader than just timeEntryIds — some entries in this file are
    // created through the real POST /work-start / PATCH .../correction /
    // POST .../delete endpoints (never returning their own row id), not
    // only via this file's own direct insertWork/insertBreak helpers, so
    // cleanup is scoped by employee_id instead to reliably catch all of
    // them.
    if (employeeIds.length) {
      await tryDelete("time_entry_corrections", () =>
        pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entry_deletions", () =>
        pool.query(`delete from time_entry_deletions where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (groupId) {
      await tryDelete("employee_activity_group_assignments", () =>
        pool.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId])
      );
      await tryDelete("activity_group_activities", () => pool.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId]));
      await tryDelete("activity_groups", () => pool.query(`delete from activity_groups where id = $1`, [groupId]));
    }
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
