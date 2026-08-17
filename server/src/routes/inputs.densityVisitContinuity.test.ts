// Reproduces the exact row-107 scenario from the live investigation and
// locks in the fix: a physical visit whose underlying time_entries got
// split across a density_source config change (one segment frozen 'plants'/
// 318, the very next — after a break — frozen 'stems'/636, because the
// config changed while the employee was on break) must be attributed as ONE
// visit, not two. Covers:
//   5) one physical completion contributes its density quantity exactly
//      once — proven directly against getUnresolvedRunsForRow (the shared
//      candidate/ambiguity resolver used by both Inputs and Reports).
//   6) Row 107's real numbers (318 plants, 4620s + 24s = 4644s) produce ONE
//      ~246.5 plants/hour result on GET /daily.
//   7) no standalone 24-second/94,917.5 stems/hour result appears anywhere
//      in the response.
//   8) getActivityDensityAttribution (the shared function behind Weekly
//      Reports, mobile Stats, and the Dashboard) does not double-count the
//      row either — 318 total quantity for the range, never 318 + 636.
//
// This is a defensive/data-shape test: the row 107 data here is inserted
// directly via SQL (mirroring exactly what existed before the mobileTime.ts
// break/end resume fix), not produced by driving the mobile endpoints — see
// mobileTime.densityResume.test.ts for the fix at its actual source (the
// resume path no longer re-freezes density type, so this shape shouldn't
// recur going forward). This file proves the calculation layer is safe
// even if such a split still somehow occurs (legacy data, a manual entry,
// or any future code path this fix didn't anticipate).
//
// Run with: npm run test:inputs-density-visit-continuity
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc, getDayBoundsUtc } from "../lib/timezone";
import { getUnresolvedRunsForRow } from "../lib/rowCompletionCandidates";
import { getActivityDensityAttribution } from "../lib/reportQueries";
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
const DATE = "2019-06-23";

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
        [`Density Visit Admin ${RUN_ID}`, `qa-density-visit-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    const marcelinoLike = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Density Visit Employee ${RUN_ID}`, `qa-density-visit-employee-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(marcelinoLike);

    const activity = (
      await pool.query(
        `insert into activities (name, is_active, density_source, speed_unit) values ($1, true, 'stems', 'plants/hour') returning id`,
        [`QA Density Visit Activity ${RUN_ID}`]
      )
    ).rows[0].id;
    activityIds.push(activity);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Density Visit Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Density Visit Phase ${RUN_ID}`,
      ])
    ).rows[0].id;

    const row107 = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, 107, 0, 300, 2, 20, 'horizontal') returning id`,
        [phaseId]
      )
    ).rows[0].id;
    rowIds.push(row107);

    async function insertWork(
      startHour: number,
      startMinute: number,
      startSecond: number,
      endHour: number,
      endMinute: number,
      endSecond: number,
      densityType: "plants" | "stems",
      densityCountPerRow: number
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 23, startHour, startMinute, startSecond);
      const endedAt = zonedWallTimeToUtc(2019, 6, 23, endHour, endMinute, endSecond);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7) returning id`,
        [marcelinoLike, activity, startedAt, endedAt, row107, densityType, densityCountPerRow]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBreak(startHour: number, startMinute: number, endHour: number, endMinute: number): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 23, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 23, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
        [marcelinoLike, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    // Marcelino's real Aug-17 row-107 numbers: 14:58:00.160-16:15:00.000
    // (plants/318, 4619.84s ~ 4620s), a 45-minute break, then
    // 17:00:00.000-17:00:24.122 (stems/636, 24.122s ~ 24s) — the exact
    // scenario from the live investigation, reproduced with round numbers.
    await insertWork(9, 0, 0, 10, 17, 0, "plants", 318); // 4620s
    await insertBreak(10, 17, 11, 2); // 45-minute break
    await insertWork(11, 2, 0, 11, 2, 24, "stems", 636); // 24s, spurious post-config-change type

    // -----------------------------------------------------------------
    // 5) One physical completion contributes its density quantity exactly
    //    once — proven directly against the shared candidate resolver.
    //    Querying under the ORIGINAL type finds ONE candidate whose
    //    duration is the combined 4644s; querying under the spurious type
    //    finds NO candidate at all (it's not an independent visit).
    // -----------------------------------------------------------------
    const plantsCandidates = await getUnresolvedRunsForRow(row107, "plants");
    check(plantsCandidates.length === 1, "5) exactly one candidate for row107+plants (the combined visit)", plantsCandidates);
    check(plantsCandidates[0]?.durationSeconds === 4644, "5) that one candidate's duration is the combined 4620+24=4644s", plantsCandidates[0]);
    check(plantsCandidates[0]?.segmentIds?.length === 2, "5) that one candidate includes BOTH underlying time_entries segments", plantsCandidates[0]);

    const stemsCandidates = await getUnresolvedRunsForRow(row107, "stems");
    check(stemsCandidates.length === 0, "5) NO independent candidate for row107+stems — the 24s segment is not a separate stems visit", stemsCandidates);

    // -----------------------------------------------------------------
    // 6 & 7) GET /daily shows ONE ~246.5 plants/hour result for row 107 —
    //    never a standalone 24-second/94,917.5 stems/hour result.
    // -----------------------------------------------------------------
    const daily = await call("GET", `/api/inputs/daily?employeeId=${marcelinoLike}&date=${DATE}`, { token: adminToken });
    const row107Runs = daily.body?.runs?.filter((r: any) => r.row?.id === row107) ?? [];
    check(row107Runs.length === 2, "6) row 107 still shows as two distinct runs in the raw log (segments not silently merged)", row107Runs.length);

    const speeds = row107Runs.map((r: any) => r.calculatedSpeedPerHour);
    check(
      speeds.every((s: any) => s != null && Math.abs(s.value - 246.5) < 0.5 && s.unit === "plants/hour"),
      "6) BOTH row-107 runs show the SAME ~246.5 plants/hour combined speed (318 / (4644/3600))",
      speeds
    );
    check(
      !speeds.some((s: any) => Math.abs(s.value - 94917.5) < 1 || s.unit === "stems/hour"),
      "7) no standalone 94,917.5 stems/hour result appears anywhere for row 107",
      speeds
    );
    const noneAmbiguous = row107Runs.every((r: any) => r.isUnresolvedRowCompletion === false);
    check(noneAmbiguous, "6) row 107 is NOT flagged 'Needs review' — the split visit resolves unambiguously via its original frozen type", row107Runs);

    // -----------------------------------------------------------------
    // 8) getActivityDensityAttribution (Weekly Reports / mobile Stats /
    //    Dashboard's shared attribution function) does not double-count
    //    the row: total quantity for the range is 318, never 318 + 636.
    // -----------------------------------------------------------------
    const { start, end } = getDayBoundsUtc(DATE);
    const attribution = await getActivityDensityAttribution(activity, start, end);
    const totals = attribution.byEmployee.get(marcelinoLike);
    check(totals?.quantity === 318, "8) Reports/Stats/Dashboard attribution counts row 107's quantity exactly once (318), never 318+636=954", totals);
    check(totals?.durationSeconds === 4644, "8) Reports/Stats/Dashboard attribution uses the combined 4644s duration", totals);
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
