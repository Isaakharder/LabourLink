// Reproduces and locks in the fix for the reported bug: GET /api/inputs/
// daily was showing the SAME pooled speed on every unresolved density run
// for a given activity/day (computed from an activity-wide aggregate),
// instead of each physical row's own quantity/duration. Covers:
//   1) two distinct completed rows on the same activity/day show DISTINCT
//      speeds, each matching a hand-computed per-row ratio (never a pooled
//      activity-wide average).
//   2) an in-progress row (open segment, zero attributed duration) shows no
//      calculated speed at all — never a value copied from another row.
//   3) a break-split single-row visit combines only that row's own two
//      segments (excluding the break) into one speed.
//   4) a genuine mid-visit density-type change (same activity, same row,
//      contiguous boundary, but the activity's density_source was edited in
//      between) must NOT be merged into one run's raw segment list (they
//      stay two distinct time_entries-backed runs, see activityRuns.test —
//      no wait, see activityRuns.ts's splitByDensityChangeFromRunId), but
//      MUST be recognized as one physical visit for attribution: one
//      combined speed, from the ORIGINAL frozen type's quantity divided by
//      BOTH segments' summed duration, shown on both. See
//      inputs.densityVisitContinuity.test.ts for the full suite covering
//      this reconciliation rule and the mobileTime.ts break/end resume fix
//      that prevents it from happening in the first place.
//
// Run with: npm run test:inputs-density-speed-per-row
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
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
const DATE = "2019-06-22";

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

  async function call(method: string, path: string, opts: { token?: string } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
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
        [`Density Speed Admin ${RUN_ID}`, `qa-density-speed-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function insertEmployee(label: string): Promise<{ id: string }> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Density Speed ${label} ${RUN_ID}`, `qa-density-speed-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return { id: rows[0].id };
    }

    // speedUnit is deliberately set to 'plants/hour' even though the two
    // rows below alternate between plants and stems density types — proving
    // the fix derives calculatedSpeedPerHour's unit from each run's own
    // frozen densityType, never from this static activity config.
    async function insertActivity(label: string, densitySource: "plants" | "stems" | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into activities (name, is_active, density_source, speed_unit) values ($1, true, $2, 'plants/hour') returning id`,
        [`QA Density Speed ${label} ${RUN_ID}`, densitySource]
      );
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Density Speed Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Density Speed Phase ${RUN_ID}`,
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
      endHour: number | null,
      endMinute: number | null,
      densityType: "plants" | "stems",
      densityCountPerRow: number
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 22, startHour, startMinute, 0);
      const endedAt = endHour !== null && endMinute !== null ? zonedWallTimeToUtc(2019, 6, 22, endHour, endMinute, 0) : null;
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
      const startedAt = zonedWallTimeToUtc(2019, 6, 22, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 22, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
        [employeeId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    const activity = await insertActivity("Activity", "plants");

    // -----------------------------------------------------------------
    // 1) Two distinct completed rows, same activity, same day, same
    //    quantity but different durations — must show distinct speeds, not
    //    the pooled (200+200)/(1+2) = 133.33 activity-wide average.
    // -----------------------------------------------------------------
    const poolCheck = await insertEmployee("PoolCheck");
    const rowA = await insertRow(101);
    const rowB = await insertRow(102);
    {
      await insertWork(poolCheck.id, activity, rowA, 8, 0, 9, 0, "plants", 200); // 200 / 1h = 200/hr
      await insertWork(poolCheck.id, activity, rowB, 10, 0, 12, 0, "plants", 200); // 200 / 2h = 100/hr

      const daily = await call("GET", `/api/inputs/daily?employeeId=${poolCheck.id}&date=${DATE}`, { token: adminToken });
      const runA = daily.body?.runs?.find((r: any) => r.row?.id === rowA);
      const runB = daily.body?.runs?.find((r: any) => r.row?.id === rowB);

      check(Math.abs((runA?.calculatedSpeedPerHour?.value ?? 0) - 200) < 0.01, "1) row A shows its own 200/hr speed", runA?.calculatedSpeedPerHour);
      check(Math.abs((runB?.calculatedSpeedPerHour?.value ?? 0) - 100) < 0.01, "1) row B shows its own 100/hr speed", runB?.calculatedSpeedPerHour);
      check(
        runA?.calculatedSpeedPerHour?.value !== runB?.calculatedSpeedPerHour?.value,
        "1) row A and row B do NOT share an identical pooled speed",
        { a: runA?.calculatedSpeedPerHour, b: runB?.calculatedSpeedPerHour }
      );
    }

    // -----------------------------------------------------------------
    // 2) An in-progress row (open segment, zero attributed duration so far)
    //    must show no calculated speed — never a value silently copied from
    //    another row on the same activity/day.
    // -----------------------------------------------------------------
    const inProgressEmp = await insertEmployee("InProgress");
    const rowC = await insertRow(103);
    {
      // A finished row first, so a pooling bug would have a real number to
      // wrongly copy onto the in-progress row below.
      await insertWork(inProgressEmp.id, activity, await insertRow(104), 7, 0, 8, 0, "plants", 300);
      await insertWork(inProgressEmp.id, activity, rowC, 8, 0, null, null, "plants", 250); // still open

      const daily = await call("GET", `/api/inputs/daily?employeeId=${inProgressEmp.id}&date=${DATE}`, { token: adminToken });
      const runC = daily.body?.runs?.find((r: any) => r.row?.id === rowC);
      check(runC?.durationSeconds === 0, "2) the in-progress run's attributed duration is 0 (open segment excluded)", runC?.durationSeconds);
      check(runC?.calculatedSpeedPerHour === null, "2) the in-progress run shows NO calculated speed — not copied from the finished row", runC?.calculatedSpeedPerHour);
    }

    // -----------------------------------------------------------------
    // 3) A break-split single-row visit combines only that row's own two
    //    segments (excluding the break itself) into one speed.
    // -----------------------------------------------------------------
    const breakSplitEmp = await insertEmployee("BreakSplit");
    const rowD = await insertRow(105);
    {
      await insertWork(breakSplitEmp.id, activity, rowD, 8, 0, 8, 30, "plants", 300);
      await insertBreak(breakSplitEmp.id, 8, 30, 8, 45);
      await insertWork(breakSplitEmp.id, activity, rowD, 8, 45, 9, 15, "plants", 300);

      const daily = await call("GET", `/api/inputs/daily?employeeId=${breakSplitEmp.id}&date=${DATE}`, { token: adminToken });
      const runs = daily.body?.runs?.filter((r: any) => r.row?.id === rowD) ?? [];
      check(runs.length === 1, "3) the break-split visit is a single combined run, not two", runs.length);
      const run = runs[0];
      check(run?.segmentIds?.length === 2, "3) that one run is made of both work segments", run?.segmentIds);
      check(run?.durationSeconds === 3600, "3) duration is the sum of both segments (30min + 30min), break excluded", run?.durationSeconds);
      check(Math.abs((run?.calculatedSpeedPerHour?.value ?? 0) - 300) < 0.01, "3) speed is 300 (quantity) / 1h (combined duration) = 300/hr", run?.calculatedSpeedPerHour);
    }

    // -----------------------------------------------------------------
    // 4) A genuine mid-visit density-type change: same activity, same row,
    //    bit-identical contiguous boundary — but the first segment froze
    //    'plants' and the second froze 'stems' because the activity's
    //    density_source was edited in between (the exact row-107 scenario
    //    from the live investigation). The two underlying time_entries stay
    //    two distinct runs (never silently merged into one row's quantity
    //    counted twice — see activityRuns.ts), but attribution recognizes
    //    them as ONE physical visit: a single combined speed, from the
    //    ORIGINAL frozen type's quantity divided by both segments' summed
    //    duration, shown on both runs — never two absurd separate speeds.
    //    See inputs.densityVisitContinuity.test.ts for the full suite.
    // -----------------------------------------------------------------
    const splitTypeEmp = await insertEmployee("SplitType");
    const rowE = await insertRow(106);
    {
      await insertWork(splitTypeEmp.id, activity, rowE, 13, 0, 13, 30, "plants", 250); // original frozen type
      await insertWork(splitTypeEmp.id, activity, rowE, 13, 30, 14, 0, "stems", 500); // spurious post-config-change type

      const daily = await call("GET", `/api/inputs/daily?employeeId=${splitTypeEmp.id}&date=${DATE}`, { token: adminToken });
      const runs = daily.body?.runs?.filter((r: any) => r.row?.id === rowE) ?? [];
      check(runs.length === 2, "4) the two segments stay two distinct runs (not merged in the raw data)", runs.length);

      const plantsRun = runs.find((r: any) => r.densityType === "plants");
      const stemsRun = runs.find((r: any) => r.densityType === "stems");
      check(plantsRun?.segmentIds?.length === 1, "4) the plants segment is its own run", plantsRun?.segmentIds);
      check(stemsRun?.segmentIds?.length === 1, "4) the stems segment is its own run", stemsRun?.segmentIds);
      // 250 (original quantity, counted once) / (0.5h + 0.5h combined) = 250/hr
      check(
        Math.abs((plantsRun?.calculatedSpeedPerHour?.value ?? 0) - 250) < 0.01 && plantsRun?.calculatedSpeedPerHour?.unit === "plants/hour",
        "4) the plants (original) segment shows the ONE combined 250 plants/hour",
        plantsRun?.calculatedSpeedPerHour
      );
      check(
        Math.abs((stemsRun?.calculatedSpeedPerHour?.value ?? 0) - 250) < 0.01 && stemsRun?.calculatedSpeedPerHour?.unit === "plants/hour",
        "4) the stems (spurious) segment shows the SAME combined 250 plants/hour, unit from the ORIGINAL frozen type — never its own 1000 stems/hour",
        stemsRun?.calculatedSpeedPerHour
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
