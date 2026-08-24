// Integration test for the Row Completion Review activity-scoping fix:
// ambiguity/candidates were previously grouped by greenhouse_row_id +
// density_type only, so two entirely independent activities sharing a
// physical row and density type (the real report — Reynaldo's Picking
// Peppers and Marcelino's Winding & Pruning, both 'stems' on row 82) got
// lumped into one review group. Fixed by scoping every consumer
// (getUnresolvedRunsForRow, GET /api/inputs/daily's badge, GET /api/
// row-completions/candidates, POST /api/row-completions) by greenhouse_row_id
// + activity_id + density_type (045_row_completion_activity_id.sql). Same
// real-HTTP-against-real-database convention as
// inputs.badgeReviewConsistency.test.ts, which this file complements rather
// than duplicates (that file already covers the break-split-must-not-flag
// and single-activity-ambiguity-must-flag cases in isolation; this file adds
// the cross-activity dimension on top).
//
// Run with: npm run test:row-completion-activity-scoping
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc, getDayBoundsUtc } from "../lib/timezone";
import { getActivityDensityAttribution } from "../lib/reportQueries";
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
const DATE = "2019-06-24";

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
        [`Row Activity Scoping Admin ${RUN_ID}`, `qa-row-activity-scoping-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function insertEmployee(label: string): Promise<{ id: string; token: string }> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`Row Activity Scoping ${label} ${RUN_ID}`, `qa-row-activity-scoping-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      const token = signSession({ id: rows[0].id, firstName: rows[0].first_name, lastName: rows[0].last_name, securityRole: "Employee", teamRole: "Team Member" });
      return { id: rows[0].id, token };
    }

    async function insertActivity(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA Row Activity Scoping ${label} ${RUN_ID}`,
      ]);
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Row Activity Scoping Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Row Activity Scoping Phase ${RUN_ID}`,
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
      endMinute: number
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 24, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 24, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', 636) returning id`,
        [employeeId, activityId, startedAt, endedAt, rowId]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, startHour: number, startMinute: number, endHour: number, endMinute: number): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 24, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 24, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
        [employeeId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    // The real row-82 shape: Picking Peppers (Reynaldo-like) with one clean
    // visit, Winding & Pruning (Marcelino-like) with a break-bridged visit
    // PLUS a genuinely separate second visit — same physical row, same
    // 'stems' density type, on the very same day.
    const pickingActivity = await insertActivity("Picking Peppers");
    const windingActivity = await insertActivity("Winding and Pruning");
    const reynaldoLike = await insertEmployee("Reynaldo");
    const marcelinoLike = await insertEmployee("Marcelino");
    const row82 = await insertRow(82);

    const pickingEntry = await insertWork(reynaldoLike.id, pickingActivity, row82, 8, 0, 9, 0);

    const windingEntry1 = await insertWork(marcelinoLike.id, windingActivity, row82, 8, 0, 9, 0);
    await insertBreak(marcelinoLike.id, 9, 0, 9, 15);
    const windingEntry2 = await insertWork(marcelinoLike.id, windingActivity, row82, 9, 15, 10, 0); // break-bridged with entry1 — ONE combined visit
    const windingEntry3 = await insertWork(marcelinoLike.id, windingActivity, row82, 12, 0, 13, 0); // genuinely separate second visit, no bridging

    // -----------------------------------------------------------------
    // 1) Picking plus Winding & Pruning in row 82 causes no cross-activity
    //    review: Picking Peppers' own run is the ONLY candidate for its
    //    row+activity+type and shows no "Needs review" badge, even though
    //    Winding & Pruning also has unresolved work on the very same
    //    row+density type.
    // -----------------------------------------------------------------
    {
      const daily = await call("GET", `/api/inputs/daily?employeeId=${reynaldoLike.id}&date=${DATE}`, { token: adminToken });
      const run = daily.body?.runs?.find((r: any) => r.row?.id === row82);
      check(run !== undefined, "1) Reynaldo-like's Picking Peppers run for row 82 is present", daily.body?.runs);
      check(
        run?.isUnresolvedRowCompletion === false,
        "1) Picking Peppers shows NO 'Needs review' badge despite Winding & Pruning also touching row 82 + stems",
        run
      );
      check(run?.calculatedSpeedPerHour != null, "1) Picking Peppers gets a real calculated speed instead of being blocked by Winding & Pruning's ambiguity", run?.calculatedSpeedPerHour);
    }

    // -----------------------------------------------------------------
    // 2) Two activities sharing the same density type ('stems') remain
    //    separate: Winding & Pruning's genuine two-visit ambiguity (break-
    //    bridged visit 1, separate visit 2 — same activity) still triggers
    //    its OWN review, independent of Picking Peppers' presence.
    // -----------------------------------------------------------------
    let windingRunIds: string[] = [];
    {
      const daily = await call("GET", `/api/inputs/daily?employeeId=${marcelinoLike.id}&date=${DATE}`, { token: adminToken });
      const windingRuns = daily.body?.runs?.filter((r: any) => r.row?.id === row82) ?? [];
      check(windingRuns.length === 2, "2) Winding & Pruning shows two runs for row 82 (the break-bridged visit + the separate second visit)", windingRuns);
      check(
        windingRuns.every((r: any) => r.isUnresolvedRowCompletion === true),
        "5) Winding & Pruning's genuine same-activity multi-visit ambiguity still triggers a 'Needs review' badge on both runs",
        windingRuns
      );
      windingRunIds = windingRuns.map((r: any) => r.id);
    }

    // -----------------------------------------------------------------
    // 3) The modal never displays another activity's candidates: querying
    //    GET /candidates with Picking Peppers' activityId returns only
    //    Reynaldo-like's own entry; querying with Winding & Pruning's
    //    activityId returns only Marcelino-like's two combined visits —
    //    Picking Peppers' entry never appears in Winding & Pruning's group,
    //    or vice versa.
    // -----------------------------------------------------------------
    {
      const pickingCandidates = await call(
        "GET",
        `/api/row-completions/candidates?greenhouseRowId=${row82}&activityId=${pickingActivity}&densityType=stems`,
        { token: adminToken }
      );
      check(pickingCandidates.status === 200 && pickingCandidates.body?.candidates?.length === 1, "3) Picking Peppers' review group has exactly one candidate", pickingCandidates.body);
      check(
        pickingCandidates.body.candidates[0].segmentIds[0] === pickingEntry && pickingCandidates.body.candidates[0].employeeId === reynaldoLike.id,
        "3) Picking Peppers' review group is exactly Reynaldo-like's own entry",
        pickingCandidates.body
      );

      const windingCandidates = await call(
        "GET",
        `/api/row-completions/candidates?greenhouseRowId=${row82}&activityId=${windingActivity}&densityType=stems`,
        { token: adminToken }
      );
      check(windingCandidates.status === 200 && windingCandidates.body?.candidates?.length === 2, "3) Winding & Pruning's review group has exactly two candidates", windingCandidates.body);
      const windingCandidateSegmentIds = new Set(windingCandidates.body.candidates.flatMap((c: any) => c.segmentIds));
      check(
        windingCandidateSegmentIds.has(windingEntry1) &&
          windingCandidateSegmentIds.has(windingEntry2) &&
          windingCandidateSegmentIds.has(windingEntry3) &&
          !windingCandidateSegmentIds.has(pickingEntry),
        "3) Winding & Pruning's review group is exactly Marcelino-like's own three segments — Reynaldo-like's Picking Peppers entry never appears in it",
        [...windingCandidateSegmentIds]
      );
      check(
        windingCandidates.body.candidates.every((c: any) => c.activityId === windingActivity && c.employeeId === marcelinoLike.id),
        "3) every candidate in Winding & Pruning's group is attributed to Winding & Pruning and Marcelino-like, never Picking Peppers or Reynaldo-like",
        windingCandidates.body.candidates
      );
    }

    // -----------------------------------------------------------------
    // Rejecting a cross-activity combine attempt directly: even if an
    // admin tried to POST segments spanning two different activities (e.g.
    // a stale/tampered client request), the server must refuse — the same
    // "same row, same density, same quantity" consistency check now also
    // requires the same activity.
    // -----------------------------------------------------------------
    {
      const crossActivityAttempt = await call("POST", "/api/row-completions", {
        token: adminToken,
        body: { timeEntryIds: [pickingEntry, windingEntry3] },
      });
      check(
        crossActivityAttempt.status === 400,
        "POST /row-completions rejects combining segments from two different activities (400)",
        crossActivityAttempt.body
      );
    }

    // -----------------------------------------------------------------
    // 4) Resolving one activity leaves the other untouched: confirming
    //    Picking Peppers' single candidate as a completed row must not
    //    change Winding & Pruning's own still-genuine ambiguity in any way.
    // -----------------------------------------------------------------
    {
      const combine = await call("POST", "/api/row-completions", { token: adminToken, body: { timeEntryIds: [pickingEntry] } });
      check(combine.status === 201 && combine.body?.rowCompletion?.activityId === pickingActivity, "4) Picking Peppers' completion is confirmed and correctly tagged with its own activityId", combine.body);

      const pickingAfter = await call("GET", `/api/inputs/daily?employeeId=${reynaldoLike.id}&date=${DATE}`, { token: adminToken });
      const pickingRunAfter = pickingAfter.body?.runs?.find((r: any) => r.row?.id === row82);
      check(pickingRunAfter?.isUnresolvedRowCompletion === false && pickingRunAfter?.calculatedSpeedPerHour != null, "4) Picking Peppers now shows a resolved, calculated speed", pickingRunAfter);

      const windingAfter = await call("GET", `/api/inputs/daily?employeeId=${marcelinoLike.id}&date=${DATE}`, { token: adminToken });
      const windingRunsAfter = windingAfter.body?.runs?.filter((r: any) => r.row?.id === row82) ?? [];
      check(
        windingRunsAfter.length === 2 && windingRunsAfter.every((r: any) => r.isUnresolvedRowCompletion === true),
        "4) Winding & Pruning's own ambiguity (both runs still 'Needs review') is completely untouched by resolving Picking Peppers' unrelated completion",
        windingRunsAfter
      );
      check(
        JSON.stringify(windingRunsAfter.map((r: any) => r.id).sort()) === JSON.stringify([...windingRunIds].sort()),
        "4) the same two Winding & Pruning runs are still present, unchanged, after Picking Peppers was resolved",
        { before: windingRunIds, after: windingRunsAfter.map((r: any) => r.id) }
      );
    }

    // -----------------------------------------------------------------
    // 6) Break-split visits remain automatic: Winding & Pruning's own
    //    break-bridged visit (entry1 + break + entry2) combines into ONE
    //    candidate on its own — never treated as a second, independent
    //    ambiguous visit on top of the genuinely separate third entry.
    // -----------------------------------------------------------------
    {
      const windingCandidates = await call(
        "GET",
        `/api/row-completions/candidates?greenhouseRowId=${row82}&activityId=${windingActivity}&densityType=stems`,
        { token: adminToken }
      );
      const bridgedCandidate = windingCandidates.body.candidates.find((c: any) => c.segmentIds.includes(windingEntry1));
      check(
        bridgedCandidate !== undefined && bridgedCandidate.segmentIds.includes(windingEntry2) && bridgedCandidate.segmentIds.length === 2,
        "6) the break-split visit (entry1 + break + entry2) is still auto-combined into one candidate, not counted as two",
        bridgedCandidate
      );
      const separateCandidate = windingCandidates.body.candidates.find((c: any) => c.segmentIds.includes(windingEntry3));
      check(
        separateCandidate !== undefined && separateCandidate.segmentIds.length === 1,
        "6) the genuinely separate third visit remains its own single-segment candidate",
        separateCandidate
      );
    }

    // -----------------------------------------------------------------
    // 7) Reports/Stats/Dashboard (getActivityDensityAttribution, the shared
    //    function behind all three) attribute row 82's quantity only to
    //    Picking Peppers, never to Winding & Pruning, and vice versa —
    //    Picking Peppers' now-confirmed 636 must not appear when querying
    //    Winding & Pruning's own attribution, and Winding & Pruning's still-
    //    ambiguous (and therefore excluded) work must not appear either.
    // -----------------------------------------------------------------
    {
      const { start, end } = getDayBoundsUtc(DATE);
      const pickingAttribution = await getActivityDensityAttribution(pickingActivity, start, end);
      const pickingTotals = pickingAttribution.byEmployee.get(reynaldoLike.id);
      check(pickingTotals?.quantity === 636, "7) Picking Peppers' attribution counts row 82's 636 quantity, attributed to Reynaldo-like", pickingTotals);
      check(!pickingAttribution.byEmployee.has(marcelinoLike.id), "7) Picking Peppers' attribution has no entry at all for Marcelino-like (Winding & Pruning's employee)", [...pickingAttribution.byEmployee.keys()]);

      const windingAttribution = await getActivityDensityAttribution(windingActivity, start, end);
      check(
        !windingAttribution.byEmployee.has(marcelinoLike.id) || windingAttribution.byEmployee.get(marcelinoLike.id)?.quantity !== 636,
        "7) Winding & Pruning's attribution never picks up Picking Peppers' confirmed 636 — its own work is still genuinely ambiguous and stays excluded, never wrongly credited",
        windingAttribution.byEmployee.get(marcelinoLike.id)
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
