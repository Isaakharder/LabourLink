// Reproduces and locks in the fix for the reported "row 107 shows a
// standalone 24-second, 94,917.5 stems/hour segment" bug. Root cause: POST
// /time-entries/break/end resumed the interrupted activity/row/carrier but
// re-resolved density_type/density_count_per_row fresh from the activity's
// CURRENT config (resolveDensitySnapshot), instead of inheriting the
// interrupted entry's own already-frozen values — so an admin editing an
// activity's density_source while an employee was on break silently
// re-froze the back half of one physical visit under the new type. Fixed by
// having break/end pass the interrupted entry's own density_type/
// density_count_per_row through as openEntry()'s densitySnapshot override
// (see mobileTime.ts), so a logical run's density type is frozen once, at
// genuine run start, never independently per underlying time_entries
// segment.
//
// Covers:
//   1) a density_source change while a run is open doesn't affect that
//      already-open segment (nothing new opened yet).
//   2) the run continues through a break after the change.
//   3) EVERY resumed segment (including a second, later resume) retains the
//      run's ORIGINAL frozen density type — never the new config.
//   4) a genuinely new activity run (different row, real switch) DOES pick
//      up the new density type — the fix only protects a resume of the SAME
//      interrupted visit, never a real new run.
//
// Run with: npm run test:mobile-time-density-resume
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import mobileTimeRouter from "./mobileTime";

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
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(path: string, deviceIdentifier: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const rowIds: string[] = [];
  const densityIds: string[] = [];
  const activityIds: string[] = [];
  let groupId!: string;
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    const employee = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Density Resume ${RUN_ID}`, `qa-density-resume-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(employee.id);

    const deviceIdentifier = randomUUID();
    const deviceRow = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        deviceIdentifier,
        `QA Density Resume Device ${RUN_ID}`,
      ])
    ).rows[0];
    deviceIds.push(deviceRow.id);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRow.id, employee.id]);

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA Density Resume Group ${RUN_ID}`,
      ])
    ).rows[0].id;

    const activityId = (
      await pool.query(
        `insert into activities (name, is_active, minimum_duration_minutes, density_source, speed_unit)
         values ($1, true, 0, 'plants', 'plants/hour') returning id`,
        [`QA Density Resume Activity ${RUN_ID}`]
      )
    ).rows[0].id;
    activityIds.push(activityId);
    const questionId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [activityId]
      )
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [groupId, activityId]);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
      employee.id,
      groupId,
    ]);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [
        `QA Density Resume Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`,
        [landId, `QA Density Resume Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    async function makeRow(n: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, $2, 0, 0, 4, 50, 'vertical') returning id`,
        [phaseId, n]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertDensity(rowId: string, type: "plants" | "stems", countPerRow: number): Promise<void> {
      const { rows } = await pool.query(
        `insert into plant_densities (name, type, count_per_row) values ($1, $2, $3) returning id`,
        [`QA Density Resume Density ${type} ${RUN_ID}-${densityIds.length}`, type, countPerRow]
      );
      densityIds.push(rows[0].id);
      await pool.query(`insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, $3)`, [
        rows[0].id,
        rowId,
        type,
      ]);
    }

    const rowVisited = await makeRow(1);
    await insertDensity(rowVisited, "plants", 318);
    await insertDensity(rowVisited, "stems", 636);
    const rowNext = await makeRow(2);
    await insertDensity(rowNext, "stems", 636);

    function answersFor(rowId: string) {
      return [{ questionId, greenhouseRowId: rowId }];
    }

    // -----------------------------------------------------------------
    // 1) Start work on rowVisited — the activity is currently 'plants'.
    // -----------------------------------------------------------------
    const start = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId,
      idempotencyKey: randomUUID(),
      answers: answersFor(rowVisited),
    });
    check(start.status === 200, "1) work start on rowVisited succeeds", start.body);
    {
      const { rows } = await pool.query(
        `select density_type, density_count_per_row from time_entries
         where employee_id = $1 and entry_type = 'work' and ended_at is null`,
        [employee.id]
      );
      check(rows[0]?.density_type === "plants" && Number(rows[0]?.density_count_per_row) === 318, "1) the open entry is frozen plants/318", rows[0]);
    }

    // -----------------------------------------------------------------
    // Admin edits the activity mid-run: plants -> stems. The already-open
    // segment above must be completely unaffected (nothing new opened).
    // -----------------------------------------------------------------
    await pool.query(`update activities set density_source = 'stems' where id = $1`, [activityId]);
    {
      const { rows } = await pool.query(
        `select density_type from time_entries where employee_id = $1 and entry_type = 'work' and ended_at is null`,
        [employee.id]
      );
      check(rows[0]?.density_type === "plants", "1b) the already-open segment is untouched by the config change", rows[0]);
    }

    // -----------------------------------------------------------------
    // 2) Start a break (interrupting the open run) — must succeed.
    // -----------------------------------------------------------------
    const breakStart = await call("/api/mobile/time-entries/break/start", deviceIdentifier, { idempotencyKey: randomUUID() });
    check(breakStart.status === 200, "2) break start succeeds", breakStart.body);

    // -----------------------------------------------------------------
    // 3) Resume (break/end) — the auto-resumed work segment must inherit
    //    the ORIGINAL frozen 'plants'/318, never the activity's now-current
    //    'stems' config. This is the exact bug: before the fix, this
    //    assertion failed (the resumed segment came back as stems/636).
    // -----------------------------------------------------------------
    const resume1 = await call("/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
    check(resume1.status === 200, "3) break end / resume succeeds", resume1.body);
    {
      const { rows } = await pool.query(
        `select id, density_type, density_count_per_row from time_entries
         where employee_id = $1 and entry_type = 'work' and ended_at is null`,
        [employee.id]
      );
      check(
        rows[0]?.density_type === "plants" && Number(rows[0]?.density_count_per_row) === 318,
        "3) the FIRST resumed segment retains the run's original frozen plants/318, NOT the new stems/636 config",
        rows[0]
      );
    }

    // -----------------------------------------------------------------
    // 3b) A second break + resume — the run must STILL retain 'plants',
    //     confirming this isn't a one-shot fix that only covers the first
    //     resume.
    // -----------------------------------------------------------------
    await call("/api/mobile/time-entries/break/start", deviceIdentifier, { idempotencyKey: randomUUID() });
    const resume2 = await call("/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
    check(resume2.status === 200, "3b) second break end / resume succeeds", resume2.body);
    {
      const { rows } = await pool.query(
        `select density_type, density_count_per_row from time_entries
         where employee_id = $1 and entry_type = 'work' and ended_at is null`,
        [employee.id]
      );
      check(
        rows[0]?.density_type === "plants" && Number(rows[0]?.density_count_per_row) === 318,
        "3b) the SECOND resumed segment also retains the run's original frozen plants/318",
        rows[0]
      );
    }

    // -----------------------------------------------------------------
    // 4) A genuinely new run — switching to a DIFFERENT row on the same
    //    activity — is a real new logical run, so it correctly picks up
    //    the activity's now-current 'stems' config. The fix must never
    //    freeze every future run to the visit's original type forever.
    // -----------------------------------------------------------------
    const realSwitch = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId,
      idempotencyKey: randomUUID(),
      answers: answersFor(rowNext),
      confirmSwitch: true,
    });
    check(realSwitch.status === 200, "4) switching to a new row succeeds", realSwitch.body);
    {
      const { rows } = await pool.query(
        `select density_type, density_count_per_row from time_entries
         where employee_id = $1 and entry_type = 'work' and greenhouse_row_id = $2 and ended_at is null`,
        [employee.id, rowNext]
      );
      check(
        rows[0]?.density_type === "stems" && Number(rows[0]?.density_count_per_row) === 636,
        "4) a genuinely new run on a different row DOES pick up the activity's current stems/636 config",
        rows[0]
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

    if (employeeIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    if (deviceIds.length) await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
    if (deviceIds.length) await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    if (rowIds.length) await tryDelete("plant_density_rows", () => pool.query(`delete from plant_density_rows where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    if (densityIds.length) await tryDelete("plant_densities", () => pool.query(`delete from plant_densities where id = any($1::uuid[])`, [densityIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (employeeIds.length) await tryDelete("employee_activity_group_assignments", () => pool.query(`delete from employee_activity_group_assignments where employee_id = any($1::uuid[])`, [employeeIds]));
    if (activityIds.length) await tryDelete("activity_group_activities", () => pool.query(`delete from activity_group_activities where activity_id = any($1::uuid[])`, [activityIds]));
    if (activityIds.length) await tryDelete("activity_questions", () => pool.query(`delete from activity_questions where activity_id = any($1::uuid[])`, [activityIds]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (groupId) await tryDelete("activity_groups", () => pool.query(`delete from activity_groups where id = $1`, [groupId]));
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
