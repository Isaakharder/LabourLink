// Regression test for the row-visit review rule, built around the production
// case that exposed two defects (Phase 1 · Row 338, Picking Peppers):
//
//   Sep 14  Felimar   one visit: segment, break, segment, then a carrier
//                     change mid-row (contiguous) — NOT two visits
//   Sep 21  Nattawat
//   Sep 28  Nattawat
//   Oct 1   Larry
//
// Expected: Sep 14 alone, Sep 21 alone, Sep 28 + Oct 1 need review together.
//
// Defect 1: row-completion candidates were grouped with
// groupIntoActivityRuns, which ends a run on any carrier change, so Felimar's
// one visit became two candidates in the same cycle and Sep 14 was falsely
// flagged "Needs review" (and its stems dropped from every report).
// Defect 2: the review modal listed every pending visit the row had ever had
// instead of only the opened visit's cycle.
//
// The rule checked here:
//   - same row + same activity; visits less than 7 local calendar days apart
//     need review (same or different employees); 7+ calendar days starts a
//     new cycle, by APP_TIMEZONE date, never elapsed hours
//   - different activities never make each other ambiguous
//   - break splits and contiguous segments (incl. a carrier change) are one
//     visit
//   - a sole finished unambiguous visit = one completed row for its
//     employee, stems counted once, speed over that visit's own duration
//   - an open visit never counts as completed
//
// Inputs (badge + speed), the review endpoints, and the shared attribution
// behind Reports / Dashboard / mobile Stats / Productive TV are all checked
// against the same data so they can't disagree.
//
// Run with: npm run test:row-completion-visit-cycles
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { getRangeBoundsUtc, zonedWallTimeToUtc } from "../lib/timezone";
import { aggregateDensitySpeed } from "../lib/densitySpeed";
import { getActivityDensityAttribution, getActivityReportData } from "../lib/reportQueries";
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
const STEMS = 500;
// Fixed past year, QA-only (same convention as the other row-completion
// tests); production's own dates, a different year.
const SEP_14 = "2019-09-14";
const SEP_21 = "2019-09-21";
const SEP_28 = "2019-09-28";
const OCT_1 = "2019-10-01";

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
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const rowIds: string[] = [];
  const carrierIds: string[] = [];
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
        [`Visit Cycles Admin ${RUN_ID}`, `qa-visit-cycles-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Visit Cycles ${label} ${RUN_ID}`, `qa-visit-cycles-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertActivity(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA Visit Cycles ${label} ${RUN_ID}`,
      ]);
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertCarrier(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA Visit Cycles ${label} ${RUN_ID}`]);
      carrierIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Visit Cycles Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Visit Cycles Phase ${RUN_ID}`,
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

    const at = (dateStr: string, hour: number, minute: number) => {
      const [y, m, d] = dateStr.split("-").map(Number);
      return zonedWallTimeToUtc(y, m, d, hour, minute, 0);
    };

    // end === null inserts an open (in-progress) segment.
    async function insertWork(
      employeeId: string,
      activityId: string,
      rowId: string,
      dateStr: string,
      start: [number, number],
      end: [number, number] | null,
      carrierId: string | null = null
    ): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, carrier_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, 'stems', $7) returning id`,
        [employeeId, activityId, at(dateStr, ...start), end ? at(dateStr, ...end) : null, rowId, carrierId, STEMS]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, dateStr: string, start: [number, number], end: [number, number]): Promise<void> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source, is_paid)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual', false) returning id`,
        [employeeId, at(dateStr, ...start), at(dateStr, ...end)]
      );
      timeEntryIds.push(rows[0].id);
    }

    const speedFor = (minutes: number) => aggregateDensitySpeed([{ quantityPerRow: STEMS, durationSeconds: minutes * 60 }]);

    async function candidates(rowId: string, activityId: string, timeEntryId?: string): Promise<{ status: number; list: any[] }> {
      const anchor = timeEntryId ? `&timeEntryId=${timeEntryId}` : "";
      const res = await call("GET", `/api/row-completions/candidates?greenhouseRowId=${rowId}&activityId=${activityId}&densityType=stems${anchor}`, {
        token: adminToken,
      });
      return { status: res.status, list: res.body?.candidates ?? [] };
    }

    async function runsOn(employeeId: string, date: string, rowId: string, activityId: string): Promise<any[]> {
      const daily = await call("GET", `/api/inputs/daily?employeeId=${employeeId}&date=${date}`, { token: adminToken });
      return (daily.body?.runs ?? []).filter((r: any) => r.row?.id === rowId && r.activityId === activityId);
    }

    const picking = await insertActivity("Picking Peppers");
    const pruning = await insertActivity("Winding & Pruning");
    const felimar = await insertEmployee("Felimar");
    const nattawat = await insertEmployee("Nattawat");
    const larry = await insertEmployee("Larry");
    const reynaldo = await insertEmployee("Reynaldo");
    const row338 = await insertRow(338);
    const carrierA = await insertCarrier("Carrier A");
    const carrierB = await insertCarrier("Carrier B");

    // ---- The production example, Row 338 · Picking Peppers ----------
    // Felimar Sep 14: 14:40-15:03, break 15:03-15:25, 15:25-15:27, then a
    // carrier change at 15:27 continuing to 15:55. One visit, 53 minutes.
    const sep14a = await insertWork(felimar, picking, row338, SEP_14, [14, 40], [15, 3], carrierA);
    await insertBreak(felimar, SEP_14, [15, 3], [15, 25]);
    const sep14b = await insertWork(felimar, picking, row338, SEP_14, [15, 25], [15, 27], carrierA);
    const sep14c = await insertWork(felimar, picking, row338, SEP_14, [15, 27], [15, 55], carrierB);
    const sep21 = await insertWork(nattawat, picking, row338, SEP_21, [14, 52], [15, 32]);
    const sep28 = await insertWork(nattawat, picking, row338, SEP_28, [13, 28], [13, 49]);
    const oct1 = await insertWork(larry, picking, row338, OCT_1, [11, 21], [11, 30]);
    // A DIFFERENT activity on the same row, inside Sep 14's and Sep 28's
    // windows. Must never make any Picking Peppers visit ambiguous.
    const pruningSep15 = await insertWork(reynaldo, pruning, row338, "2019-09-15", [9, 0], [10, 0]);
    await insertWork(reynaldo, pruning, row338, "2019-10-05", [9, 0], [10, 0]);

    // 1) Grouping: Sep 14 alone, Sep 21 alone, Sep 28 + Oct 1 together.
    {
      const { list } = await candidates(row338, picking);
      check(list.length === 4, "1) four Picking Peppers visits on Row 338 (Sep 14 is ONE visit, not two)", list.map((c) => c.date));
      const byDate = new Map(list.map((c) => [c.date, c]));
      const c14 = byDate.get(SEP_14);
      check(
        c14?.segmentIds.length === 3 && [sep14a, sep14b, sep14c].every((id) => c14.segmentIds.includes(id)),
        "1) Sep 14's visit holds all three segments — the break split and the carrier change are one visit",
        c14?.segmentIds
      );
      check(c14?.durationSeconds === 53 * 60, "1) Sep 14's visit duration is its 53 work minutes (break excluded)", c14?.durationSeconds);
      const cycle = (d: string) => byDate.get(d)?.cycleIndex;
      check(cycle(SEP_14) !== cycle(SEP_21), "1) Sep 14 and Sep 21 (exactly 7 days apart) are separate cycles");
      check(cycle(SEP_21) !== cycle(SEP_28), "1) Sep 21 and Sep 28 (exactly 7 days apart, same employee) are separate cycles");
      check(cycle(SEP_28) === cycle(OCT_1), "1) Sep 28 and Oct 1 (3 days apart, different employees) share a cycle");
      check(!list.some((c) => c.segmentIds.includes(pruningSep15)), "1) the other activity's visits are never candidates here");
    }

    // 2) The modal's list is scoped to the opened visit's cycle.
    {
      const fromSep14 = await candidates(row338, picking, sep14c);
      check(fromSep14.list.length === 1 && fromSep14.list[0].date === SEP_14, "2) opened from Sep 14: only Sep 14 is listed", fromSep14.list);
      const fromSep21 = await candidates(row338, picking, sep21);
      check(fromSep21.list.length === 1 && fromSep21.list[0].date === SEP_21, "2) opened from Sep 21: only Sep 21 is listed", fromSep21.list);
      for (const [label, anchor] of [
        ["Sep 28", sep28],
        ["Oct 1", oct1],
      ] as const) {
        const scoped = await candidates(row338, picking, anchor);
        check(
          scoped.list.map((c) => c.date).sort().join(",") === `${SEP_28},${OCT_1}`,
          `2) opened from ${label}: exactly Sep 28 + Oct 1 are listed`,
          scoped.list.map((c) => c.date)
        );
      }
      const otherActivity = await candidates(row338, picking, pruningSep15);
      check(otherActivity.list.length === 0, "2) a segment from another activity scopes to nothing (stale badge path)", otherActivity.list);
      const bad = await candidates(row338, picking, "not-a-uuid");
      check(bad.status === 400, "2) a malformed timeEntryId is rejected", bad);
    }

    // 3) Inputs badges and speeds.
    {
      const felimarRuns = await runsOn(felimar, SEP_14, row338, picking);
      check(felimarRuns.length === 2, "3) Inputs still DISPLAYS Sep 14 as two runs (carrier change) — display is unchanged", felimarRuns.length);
      check(felimarRuns.every((r) => r.isUnresolvedRowCompletion === false), "3) Sep 14: no 'Needs review' badge on either run", felimarRuns);
      check(
        felimarRuns.every((r) => r.calculatedSpeedPerHour?.value === speedFor(53)),
        "3) Sep 14: both runs show the ONE visit speed — 500 stems over 53 minutes, stems counted once",
        { got: felimarRuns.map((r) => r.calculatedSpeedPerHour?.value), expected: speedFor(53) }
      );

      const [n21] = await runsOn(nattawat, SEP_21, row338, picking);
      check(n21?.isUnresolvedRowCompletion === false, "3) Sep 21: no badge", n21);
      check(n21?.calculatedSpeedPerHour?.value === speedFor(40), "3) Sep 21: speed over its own 40 minutes", n21?.calculatedSpeedPerHour);

      const [n28] = await runsOn(nattawat, SEP_28, row338, picking);
      const [l1] = await runsOn(larry, OCT_1, row338, picking);
      check(n28?.isUnresolvedRowCompletion === true, "3) Sep 28 (Nattawat) needs review", n28);
      check(l1?.isUnresolvedRowCompletion === true, "3) Oct 1 (Larry) needs review", l1);
      check(n28?.calculatedSpeedPerHour == null && l1?.calculatedSpeedPerHour == null, "3) needs-review visits show no speed");

      const [r15] = await runsOn(reynaldo, "2019-09-15", row338, pruning);
      check(r15?.isUnresolvedRowCompletion === false, "3) the other activity's lone visit is not ambiguous either", r15);
    }

    // 4) Shared attribution (Reports / Dashboard / mobile Stats / Productive
    //    TV all read this) agrees with Inputs.
    {
      const { start, end } = getRangeBoundsUtc(SEP_14, OCT_1);
      const attribution = await getActivityDensityAttribution(picking, start, end);
      const f = attribution.byEmployee.get(felimar);
      check(
        f?.quantity === STEMS && f?.durationSeconds === 53 * 60 && f?.completions === 1,
        "4) Felimar: one completed row, 500 stems once, over the 53-minute visit",
        f
      );
      const n = attribution.byEmployee.get(nattawat);
      check(
        n?.quantity === STEMS && n?.durationSeconds === 40 * 60 && n?.completions === 1,
        "4) Nattawat: only Sep 21 counts (Sep 28 needs review)",
        n
      );
      check(!attribution.byEmployee.has(larry), "4) Larry: nothing counts while Oct 1 needs review", attribution.byEmployee.get(larry));

      const report = await getActivityReportData(picking, SEP_14, SEP_14);
      const fTotal = report?.employeeTotals.find((t) => t.employeeId === felimar);
      check(fTotal?.quantityWorked === STEMS && fTotal?.rowsCompleted === 1, "4) Activity Report: Felimar 500 stems, 1 row completed", fTotal);
    }

    // 5) Combining is refused across cycles and for part of a visit, and
    //    allowed within one cycle.
    {
      const crossCycle = await call("POST", "/api/row-completions", { token: adminToken, body: { timeEntryIds: [sep21, sep28] } });
      check(crossCycle.status === 400 && /cycle/.test(crossCycle.body?.error ?? ""), "5) Sep 21 + Sep 28 (different cycles) is refused", crossCycle);
      const crossCycle2 = await call("POST", "/api/row-completions", { token: adminToken, body: { timeEntryIds: [sep14a, sep14b, sep14c, sep21] } });
      check(crossCycle2.status === 400, "5) Sep 14 + Sep 21 (exactly 7 days apart) is refused", crossCycle2);
      const partial = await call("POST", "/api/row-completions", { token: adminToken, body: { timeEntryIds: [sep14c] } });
      check(partial.status === 400 && /part of a visit/.test(partial.body?.error ?? ""), "5) completing only part of Sep 14's visit is refused", partial);
      const ok = await call("POST", "/api/row-completions", { token: adminToken, body: { timeEntryIds: [sep28, oct1] } });
      check(ok.status === 201, "5) Sep 28 + Oct 1 (same cycle) combine into one completed row", ok);

      const [n28] = await runsOn(nattawat, SEP_28, row338, picking);
      check(n28?.isUnresolvedRowCompletion === false && n28?.rowCompletion != null, "5) after combining, Sep 28 no longer needs review", n28);
    }

    // ---- Same employee, less than 7 days apart -----------------------
    {
      const row = await insertRow(401);
      const emp = await insertEmployee("SameEmp");
      await insertWork(emp, picking, row, "2019-09-02", [8, 0], [9, 0]);
      await insertWork(emp, picking, row, "2019-09-08", [8, 0], [9, 0]);
      const a = await runsOn(emp, "2019-09-02", row, picking);
      const b = await runsOn(emp, "2019-09-08", row, picking);
      check(
        a[0]?.isUnresolvedRowCompletion === true && b[0]?.isUnresolvedRowCompletion === true,
        "6) same employee, 6 days apart: both visits need review",
        { a: a[0]?.isUnresolvedRowCompletion, b: b[0]?.isUnresolvedRowCompletion }
      );
    }

    // ---- Seven-day boundary is calendar days, not elapsed hours -------
    {
      // 22:00 on Sep 21 to 06:00 on Sep 28 is only 6 days 8 hours elapsed,
      // but 7 calendar days — separate cycles, no review.
      const row = await insertRow(402);
      const empA = await insertEmployee("BoundaryA");
      const empB = await insertEmployee("BoundaryB");
      await insertWork(empA, picking, row, SEP_21, [22, 0], [23, 0]);
      await insertWork(empB, picking, row, SEP_28, [6, 0], [7, 0]);
      const a = await runsOn(empA, SEP_21, row, picking);
      const b = await runsOn(empB, SEP_28, row, picking);
      check(
        a[0]?.isUnresolvedRowCompletion === false && b[0]?.isUnresolvedRowCompletion === false,
        "7) 7 calendar days apart (< 168 elapsed hours): separate cycles, no review",
        { a: a[0]?.isUnresolvedRowCompletion, b: b[0]?.isUnresolvedRowCompletion }
      );
      // And 6 calendar days apart even when > 6*24 elapsed hours.
      const row2 = await insertRow(403);
      await insertWork(empA, picking, row2, "2019-09-02", [6, 0], [7, 0]);
      await insertWork(empB, picking, row2, "2019-09-08", [22, 0], [23, 0]);
      const c = await runsOn(empA, "2019-09-02", row2, picking);
      check(c[0]?.isUnresolvedRowCompletion === true, "7) 6 calendar days apart (> 144 elapsed hours): same cycle, needs review", c[0]);
    }

    // ---- Break split alone, no carrier change -------------------------
    {
      const row = await insertRow(404);
      const emp = await insertEmployee("BreakSplit");
      await insertWork(emp, picking, row, "2019-08-05", [8, 0], [9, 0]);
      await insertBreak(emp, "2019-08-05", [9, 0], [9, 15]);
      await insertWork(emp, picking, row, "2019-08-05", [9, 15], [10, 0]);
      const runs = await runsOn(emp, "2019-08-05", row, picking);
      check(
        runs.length === 1 && runs[0].isUnresolvedRowCompletion === false && runs[0].calculatedSpeedPerHour?.value === speedFor(105),
        "8) a break-split visit is one visit: no review, speed over 105 work minutes",
        runs
      );
    }

    // ---- Open visit never counts as completed -------------------------
    {
      const row = await insertRow(405);
      const emp = await insertEmployee("OpenVisit");
      await insertWork(emp, picking, row, "2019-08-12", [8, 0], null);
      const { start, end } = getRangeBoundsUtc("2019-08-12", "2019-08-12");
      const attribution = await getActivityDensityAttribution(picking, start, end);
      check(!attribution.byEmployee.has(emp), "9) an open visit contributes no stems and no completed row", attribution.byEmployee.get(emp));
      const report = await getActivityReportData(picking, "2019-08-12", "2019-08-12");
      const total = report?.employeeTotals.find((t) => t.employeeId === emp);
      // The Activity Report only reads finished entries, so an employee whose
      // only visit is still open has no report row at all — either way it
      // must never show a completed row or stems.
      check(
        total === undefined || (total.rowsCompleted === 0 && total.quantityWorked == null),
        "9) Activity Report: an open visit shows no completed row and no stems",
        total
      );
      const runs = await runsOn(emp, "2019-08-12", row, picking);
      check(runs[0]?.calculatedSpeedPerHour == null, "9) Inputs shows no speed for an open visit", runs[0]);
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
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
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
