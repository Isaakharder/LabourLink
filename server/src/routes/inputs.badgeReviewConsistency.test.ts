// Integration test reproducing the exact reported bug end-to-end: GET
// /api/inputs/daily's "Needs review" badge (isUnresolvedRowCompletion) and
// GET /api/row-completions/candidates (the review modal's data source) must
// always agree — same physical row, same density type, same verdict.
// Covers both directions: a break-split single visit must show NO badge at
// all (the reported false positive), and a genuinely ambiguous multi-
// employee visit must show a badge whose candidate count the modal can
// actually display. Same real-HTTP-against-real-database convention used
// throughout this repo.
//
// Run with: npm run test:inputs-badge-review-consistency
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
import inputsRouter from "./inputs";
import rowCompletionsRouter from "./rowCompletions";

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
const DATE = "2019-06-21";

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/inputs", inputsRouter);
  app.use("/api/row-completions", rowCompletionsRouter);
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
  const rowIds: string[] = [];
  const timeEntryIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Badge Review Admin ${RUN_ID}`, `qa-badge-review-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function insertEmployee(label: string): Promise<{ id: string; token: string }> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`Badge Review ${label} ${RUN_ID}`, `qa-badge-review-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      const token = signSession({ id: rows[0].id, firstName: rows[0].first_name, lastName: rows[0].last_name, securityRole: "Employee", teamRole: "Team Member" });
      return { id: rows[0].id, token };
    }

    async function insertActivity(label: string, densitySource: "plants" | "stems" | null): Promise<string> {
      const { rows } = await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, $2) returning id`, [
        `QA Badge Review ${label} ${RUN_ID}`,
        densitySource,
      ]);
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Badge Review Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Badge Review Phase ${RUN_ID}`,
      ])
    ).rows[0].id;

    async function insertRow(rowNumber: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, rowNumber, rowNumber * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertWork(
      employeeId: string,
      activityId: string,
      rowId: string,
      startHour: number,
      startMinute: number,
      endHour: number,
      endMinute: number,
      densityType: "plants" | "stems",
      densityCountPerRow: number
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 21, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 21, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7) returning id`,
        [employeeId, activityId, startedAt, endedAt, rowId, densityType, densityCountPerRow]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, startHour: number, startMinute: number, endHour: number, endMinute: number): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 21, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 21, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
        [employeeId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    const activity = await insertActivity("Activity", "stems");

    // -----------------------------------------------------------------
    // 2) The exact reported scenario: a break-split single visit must show
    //    NO "Needs review" badge on GET /daily at all.
    // -----------------------------------------------------------------
    const marcelinoLike = await insertEmployee("Marcelino");
    const rowSplit = await insertRow(92);
    {
      await insertWork(marcelinoLike.id, activity, rowSplit, 8, 0, 9, 0, "stems", 318);
      await insertBreak(marcelinoLike.id, 9, 0, 9, 15);
      await insertWork(marcelinoLike.id, activity, rowSplit, 9, 15, 10, 0, "stems", 318);

      const daily = await call("GET", `/api/inputs/daily?employeeId=${marcelinoLike.id}&date=${DATE}`, { token: adminToken });
      const run = daily.body?.runs?.find((r: any) => r.row?.id === rowSplit);
      check(run !== undefined && run.segmentIds.length === 2, "2) the break-split visit is a single run made of two segments", run);
      check(run?.isUnresolvedRowCompletion === false, "2) the break-split visit shows NO 'Needs review' badge — the reported false positive", run);
      check(run?.calculatedSpeedPerHour != null, "2) with no badge, a real calculated speed is shown instead", run?.calculatedSpeedPerHour);
    }

    // -----------------------------------------------------------------
    // 5) Genuine ambiguity: badge and modal must agree on both the row id
    //    AND the density type — the modal, queried with the run's OWN
    //    densityType (never activityDensitySource), must show exactly the
    //    candidates the badge's ambiguity count implies.
    // -----------------------------------------------------------------
    const empA = await insertEmployee("EmpA");
    const empB = await insertEmployee("EmpB");
    const rowAmbiguous = await insertRow(93);
    {
      await insertWork(empA.id, activity, rowAmbiguous, 8, 0, 9, 0, "stems", 300);
      await insertWork(empB.id, activity, rowAmbiguous, 11, 0, 12, 0, "stems", 300);

      const dailyA = await call("GET", `/api/inputs/daily?employeeId=${empA.id}&date=${DATE}`, { token: adminToken });
      const runA = dailyA.body?.runs?.find((r: any) => r.row?.id === rowAmbiguous);
      check(runA?.isUnresolvedRowCompletion === true, "5) employee A's run shows the 'Needs review' badge (genuine ambiguity)", runA);

      const dailyB = await call("GET", `/api/inputs/daily?employeeId=${empB.id}&date=${DATE}`, { token: adminToken });
      const runB = dailyB.body?.runs?.find((r: any) => r.row?.id === rowAmbiguous);
      check(runB?.isUnresolvedRowCompletion === true, "5) employee B's run ALSO shows the badge for the same ambiguity", runB);
      check(runA?.densityType === runB?.densityType && runA?.densityType === "stems", "5) both runs agree on the same frozen densityType", { a: runA?.densityType, b: runB?.densityType });

      // The modal must be opened with run.densityType, exactly reproducing
      // ActivityLogsCard.tsx's fixed openReview() call.
      const candidatesRes = await call("GET", `/api/row-completions/candidates?greenhouseRowId=${rowAmbiguous}&densityType=${runA.densityType}`, { token: adminToken });
      check(
        candidatesRes.status === 200 && candidatesRes.body?.candidates?.length === 2,
        "5) the modal (queried with the badge's own densityType) shows exactly the 2 candidates the badge's ambiguity implies",
        candidatesRes.body
      );
      const candidateEmployeeIds = new Set(candidatesRes.body.candidates.map((c: any) => c.employeeId));
      check(
        candidateEmployeeIds.has(empA.id) && candidateEmployeeIds.has(empB.id),
        "5) the modal's candidates are the exact same two employees the badge flagged",
        [...candidateEmployeeIds]
      );
    }

    // -----------------------------------------------------------------
    // The frontend density-type-mismatch bug, reproduced directly: after
    // an activity's density_source is changed, run.densityType (frozen)
    // and run.activityDensitySource (current) must both be present and
    // may legitimately differ — proving the DTO now exposes what the fix
    // actually needs.
    // -----------------------------------------------------------------
    const empC = await insertEmployee("EmpC");
    const rowChanged = await insertRow(94);
    {
      const changeableActivity = await insertActivity("Changeable", "plants");
      await insertWork(empC.id, changeableActivity, rowChanged, 8, 0, 9, 0, "plants", 250);
      await pool.query(`update activities set density_source = 'stems' where id = $1`, [changeableActivity]);

      const daily = await call("GET", `/api/inputs/daily?employeeId=${empC.id}&date=${DATE}`, { token: adminToken });
      const run = daily.body?.runs?.find((r: any) => r.row?.id === rowChanged);
      check(
        run?.densityType === "plants" && run?.activityDensitySource === "stems",
        "densityType (frozen at record time) and activityDensitySource (current activity config) correctly disagree after a density_source change — this is exactly the divergence the fix must use densityType to navigate",
        { densityType: run?.densityType, activityDensitySource: run?.activityDensitySource }
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

    if (rowIds.length) await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
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
