// Integration test for row-work cycle partitioning: the same
// row+activity+densityType used to be one lifetime ambiguity/review group,
// so a visit from weeks ago and a genuinely unrelated later visit could get
// lumped into the same "Needs review" check, or even be combinable
// together via POST /api/row-completions. Fixed by partitioning a pair's
// unresolved candidates into chronological cycles (a new cycle starts once
// more than 7 calendar days have elapsed since the preceding segment — see
// rowCompletionCandidates.ts's CYCLE_GAP_DAYS/assignCycleIndexes) and
// scoping every ambiguity/combine decision to a single cycle. Same
// real-HTTP-against-real-database convention as
// rowCompletions.activityScoping.test.ts, which this file complements
// rather than duplicates (that file already covers the cross-ACTIVITY
// dimension; this one covers the cross-TIME dimension on the same
// row+activity+density pair).
//
// Run with: npm run test:row-completion-cycle-grouping
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
// Same fixed-year QA-only convention as rowCompletionCandidates.test.ts —
// September instead of June only because the accepted regression fixture
// for this feature is dated in September (Row 194: Sept 3 / Sept 10 x2 /
// Sept 23), never because a specific month matters to the logic itself.
const SEPT_3 = "2019-09-03";
const SEPT_10 = "2019-09-10";
const SEPT_23 = "2019-09-23";

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
        [`Row Cycle Grouping Admin ${RUN_ID}`, `qa-row-cycle-grouping-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function insertEmployee(label: string): Promise<{ id: string; token: string }> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`Row Cycle Grouping ${label} ${RUN_ID}`, `qa-row-cycle-grouping-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      const token = signSession({ id: rows[0].id, firstName: rows[0].first_name, lastName: rows[0].last_name, securityRole: "Employee", teamRole: "Team Member" });
      return { id: rows[0].id, token };
    }

    async function insertActivity(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA Row Cycle Grouping ${label} ${RUN_ID}`,
      ]);
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Row Cycle Grouping Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Row Cycle Grouping Phase ${RUN_ID}`,
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
      dateStr: string,
      startHour: number,
      startMinute: number,
      endHour: number,
      endMinute: number
    ): Promise<string> {
      const [y, m, d] = dateStr.split("-").map(Number);
      const startedAt = zonedWallTimeToUtc(y, m, d, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(y, m, d, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', 500) returning id`,
        [employeeId, activityId, startedAt, endedAt, rowId]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    // Row 194 — the accepted regression fixture: Sept 3 alone (cycle 1),
    // both Sept 10 segments together (cycle 2, genuinely ambiguous), Sept 23
    // alone (cycle 3). More than 7 calendar days separate each cycle from
    // its neighbor.
    const activity = await insertActivity("Activity");
    const emp1 = await insertEmployee("Emp1");
    const emp2 = await insertEmployee("Emp2");
    const row194 = await insertRow(194);

    const sept3Entry = await insertWork(emp1.id, activity, row194, SEPT_3, 8, 0, 9, 0);
    const sept10EntryA = await insertWork(emp1.id, activity, row194, SEPT_10, 8, 0, 9, 0);
    const sept10EntryB = await insertWork(emp2.id, activity, row194, SEPT_10, 10, 0, 11, 0);
    const sept23Entry = await insertWork(emp1.id, activity, row194, SEPT_23, 8, 0, 9, 0);

    // -----------------------------------------------------------------
    // 1) Sept 3's lone visit shows NO "Needs review" badge and gets a real
    //    calculated speed, even though two OTHER unresolved candidates
    //    exist for this exact row+activity+density on Sept 10 — they are a
    //    different, later cycle and must never make Sept 3 ambiguous.
    // -----------------------------------------------------------------
    {
      const daily = await call("GET", `/api/inputs/daily?employeeId=${emp1.id}&date=${SEPT_3}`, { token: adminToken });
      const run = daily.body?.runs?.find((r: any) => r.row?.id === row194);
      check(run !== undefined, "1) Sept 3's run for row 194 is present", daily.body?.runs);
      check(run?.isUnresolvedRowCompletion === false, "1) Sept 3 shows NO 'Needs review' badge despite Sept 10's later, unrelated cycle", run);
      check(run?.calculatedSpeedPerHour != null, "1) Sept 3 gets a real calculated speed, unblocked by a later cycle's own ambiguity", run?.calculatedSpeedPerHour);
    }

    // -----------------------------------------------------------------
    // 2) Sept 23's lone visit is likewise unambiguous on its own, unaffected
    //    by either Sept 3 or Sept 10's cycles.
    // -----------------------------------------------------------------
    {
      const daily = await call("GET", `/api/inputs/daily?employeeId=${emp1.id}&date=${SEPT_23}`, { token: adminToken });
      const run = daily.body?.runs?.find((r: any) => r.row?.id === row194);
      check(run !== undefined, "2) Sept 23's run for row 194 is present", daily.body?.runs);
      check(run?.isUnresolvedRowCompletion === false, "2) Sept 23 shows NO 'Needs review' badge either", run);
      check(run?.calculatedSpeedPerHour != null, "2) Sept 23 gets a real calculated speed", run?.calculatedSpeedPerHour);
    }

    // -----------------------------------------------------------------
    // 3) Sept 10's own genuine same-cycle ambiguity (two segments, same
    //    day, no bridging) still triggers "Needs review" on both — the fix
    //    only stops CROSS-cycle false ambiguity, never masks a real one.
    // -----------------------------------------------------------------
    {
      const dailyA = await call("GET", `/api/inputs/daily?employeeId=${emp1.id}&date=${SEPT_10}`, { token: adminToken });
      const runA = dailyA.body?.runs?.find((r: any) => r.row?.id === row194);
      check(runA?.isUnresolvedRowCompletion === true, "3) Sept 10's first employee's segment shows 'Needs review'", runA);

      const dailyB = await call("GET", `/api/inputs/daily?employeeId=${emp2.id}&date=${SEPT_10}`, { token: adminToken });
      const runB = dailyB.body?.runs?.find((r: any) => r.row?.id === row194);
      check(runB?.isUnresolvedRowCompletion === true, "3) Sept 10's second employee's segment shows 'Needs review' too", runB);
    }

    // -----------------------------------------------------------------
    // 4) GET /candidates for this row+activity+density returns all four
    //    still-unresolved segments (nothing wrongly auto-merged or
    //    hidden), each carrying a cycleIndex, with Sept 3/Sept 10/Sept 23
    //    in three distinct cycles and both Sept 10 segments sharing one.
    // -----------------------------------------------------------------
    let sept3Cycle: number, sept10Cycle: number, sept23Cycle: number;
    {
      const res = await call(
        "GET",
        `/api/row-completions/candidates?greenhouseRowId=${row194}&activityId=${activity}&densityType=stems`,
        { token: adminToken }
      );
      check(res.status === 200 && res.body?.candidates?.length === 4, "4) all four segments are still pending candidates", res.body);

      const byFirstSegmentId = new Map<string, any>(res.body.candidates.map((c: any) => [c.segmentIds[0], c]));
      const cSept3 = byFirstSegmentId.get(sept3Entry);
      const cSept10a = byFirstSegmentId.get(sept10EntryA);
      const cSept10b = byFirstSegmentId.get(sept10EntryB);
      const cSept23 = byFirstSegmentId.get(sept23Entry);
      check(!!cSept3 && !!cSept10a && !!cSept10b && !!cSept23, "4) every inserted segment surfaces as its own candidate", res.body.candidates);

      sept3Cycle = cSept3.cycleIndex;
      sept10Cycle = cSept10a.cycleIndex;
      sept23Cycle = cSept23.cycleIndex;
      check(cSept10a.cycleIndex === cSept10b.cycleIndex, "4) both Sept 10 segments share one cycleIndex", { cSept10a, cSept10b });
      check(sept3Cycle !== sept10Cycle && sept10Cycle !== sept23Cycle && sept3Cycle !== sept23Cycle, "4) Sept 3 / Sept 10 / Sept 23 are three distinct cycles", {
        sept3Cycle,
        sept10Cycle,
        sept23Cycle,
      });
    }

    // -----------------------------------------------------------------
    // Rejecting a cross-cycle combine attempt directly: even if an admin
    // tried to POST segments spanning two different cycles (e.g. a stale
    // client, or picking the wrong rows in the modal), the server must
    // refuse — the same way it already refuses a cross-activity combine.
    // -----------------------------------------------------------------
    {
      const crossCycleAttempt = await call("POST", "/api/row-completions", {
        token: adminToken,
        body: { timeEntryIds: [sept3Entry, sept10EntryA] },
      });
      check(crossCycleAttempt.status === 400, "POST /row-completions rejects combining segments from two different cycles (400)", crossCycleAttempt.body);

      const threeWayAttempt = await call("POST", "/api/row-completions", {
        token: adminToken,
        body: { timeEntryIds: [sept3Entry, sept10EntryA, sept23Entry] },
      });
      check(threeWayAttempt.status === 400, "POST /row-completions rejects a three-cycle combine attempt too (400)", threeWayAttempt.body);
    }

    // -----------------------------------------------------------------
    // 5) Combining the two SAME-cycle Sept 10 segments together succeeds —
    //    the fix only blocks cross-cycle combines, never legitimate
    //    same-cycle ones — and afterward Sept 3/Sept 23 remain completely
    //    untouched, still their own lone, unambiguous cycles.
    // -----------------------------------------------------------------
    {
      const combine = await call("POST", "/api/row-completions", {
        token: adminToken,
        body: { timeEntryIds: [sept10EntryA, sept10EntryB] },
      });
      check(
        combine.status === 201 && combine.body?.rowCompletion?.segmentCount === 2,
        "5) combining both Sept 10 segments (same cycle) succeeds and links both",
        combine.body
      );

      const sept3After = await call("GET", `/api/inputs/daily?employeeId=${emp1.id}&date=${SEPT_3}`, { token: adminToken });
      const sept3RunAfter = sept3After.body?.runs?.find((r: any) => r.row?.id === row194);
      check(
        sept3RunAfter?.isUnresolvedRowCompletion === false && sept3RunAfter?.calculatedSpeedPerHour != null,
        "5) Sept 3 is completely untouched by resolving Sept 10's unrelated (later-cycle) completion",
        sept3RunAfter
      );

      const sept23After = await call("GET", `/api/inputs/daily?employeeId=${emp1.id}&date=${SEPT_23}`, { token: adminToken });
      const sept23RunAfter = sept23After.body?.runs?.find((r: any) => r.row?.id === row194);
      check(
        sept23RunAfter?.isUnresolvedRowCompletion === false && sept23RunAfter?.calculatedSpeedPerHour != null,
        "5) Sept 23 is likewise completely untouched",
        sept23RunAfter
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
