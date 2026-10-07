// Configurable Row review window (Setup > Row Review;
// org_settings.row_review_window_days, 057_row_review_window.sql).
//
// Rule (rowCompletionCandidates.ts's assignCycleIndexes): for one row +
// activity + density type, consecutive unresolved visits whose work dates
// (organization timezone) are fewer than windowDays calendar dates apart —
// whoever worked them — share a review cycle; a gap of exactly windowDays
// dates or more starts a new cycle. Each gap is measured from the PRECEDING
// visit. A cycle with 2+ unresolved visits needs review and counts nothing;
// a sole finished visit counts normally; open visits stay excluded.
// Confirmed completions are never regrouped.
//
// Covers: default behaviour, custom windows, exactly-at-boundary separation
// (both times of day), the preceding-visit chain, same/different employees,
// different activities, carrier/break continuity, timezone + DST
// boundaries, saving the setting (validation and permissions), regrouping
// after a change while manual confirmations are preserved, and agreement
// across Inputs, the review endpoints, Reports, Productive TV and mobile
// Stats.
//
// Run with: npm run test:row-review-window
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import {
  addDaysToDateStr,
  getCurrentWeekBoundsUtc,
  getRangeBoundsUtc,
  zonedWallTimeToUtc,
} from "../lib/timezone";
import { generateIntegrationToken } from "../lib/integrationToken";
import { getActivityDensityAttribution, getActivityReportData } from "../lib/reportQueries";
import { getUnresolvedRunsForRow } from "../lib/rowCompletionCandidates";
import { aggregateDensitySpeed } from "../lib/densitySpeed";
import inputsRouter from "./inputs";
import rowCompletionsRouter from "./rowCompletions";
import integrationsRouter, { PICKING_ACTIVITY_NAME, PRUNING_ACTIVITY_NAME } from "./integrations";
import mobileStatsRouter from "./mobileStats";

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
  app.use("/api/inputs", inputsRouter);
  app.use("/api/row-completions", rowCompletionsRouter);
  app.use("/api/integrations", integrationsRouter);
  app.use("/api/mobile", mobileStatsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const emailLike = `qa-rrw-%-${RUN_ID}@test.local`;
  const rowIds: string[] = [];
  const activityIds: string[] = [];
  const carrierIds: string[] = [];
  const deviceIds: string[] = [];
  const tokenIds: string[] = [];
  let landId: string | null = null;
  let phaseId: string | null = null;
  const original = (await pool.query(`select row_review_window_days, updated_by_employee_id, updated_at from org_settings where id = true`)).rows[0];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function insertEmployee(label: string, role = "Employee") {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, 'x', true) returning id`,
        [`RRW ${label} ${RUN_ID}`, `qa-rrw-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId]
      );
      const id = rows[0].id as string;
      return { id, token: signSession({ id, firstName: "QA", lastName: label, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await insertEmployee("Admin", "Administrator");
    const manager = await insertEmployee("Manager", "Manager");
    const auth = { Cookie: `labourlink_session=${admin.token}` };
    const managerAuth = { Cookie: `labourlink_session=${manager.token}` };
    const { token: tvToken, tokenHash } = generateIntegrationToken();
    tokenIds.push((await pool.query(`insert into integration_tokens (name, token_hash) values ($1, $2) returning id`, [`QA RRW ${RUN_ID}`, tokenHash])).rows[0].id);
    const tv = { Authorization: `Bearer ${tvToken}` };

    const actA = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [`QA RRW A ${RUN_ID}`])).rows[0].id as string;
    const actB = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [`QA RRW B ${RUN_ID}`])).rows[0].id as string;
    activityIds.push(actA, actB);
    // The fixed-name activities Productive TV reads (test database only, same
    // convention as the Productive TV endpoint tests).
    for (const name of [PICKING_ACTIVITY_NAME, PRUNING_ACTIVITY_NAME]) {
      await pool.query(`delete from row_completion_segments where time_entry_id in (select id from time_entries where activity_id in (select id from activities where name = $1))`, [name]);
      await pool.query(`delete from time_entries where activity_id in (select id from activities where name = $1)`, [name]);
      await pool.query(`delete from row_completions where activity_id in (select id from activities where name = $1)`, [name]);
      await pool.query(`delete from activities where name = $1`, [name]);
    }
    const picking = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [PICKING_ACTIVITY_NAME])).rows[0].id as string;
    const pruning = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [PRUNING_ACTIVITY_NAME])).rows[0].id as string;
    activityIds.push(picking, pruning);

    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [`QA RRW ${RUN_ID}`])).rows[0].id;
    phaseId = (await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [landId, `QA RRW ${RUN_ID}`])).rows[0].id;
    let rowNumber = 0;
    async function insertRow() {
      rowNumber++;
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, rowNumber, rowNumber * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id as string;
    }
    async function insertCarrier(name: string) {
      const id = (await pool.query(`insert into carriers (name) values ($1) returning id`, [`${name} ${RUN_ID}`])).rows[0].id as string;
      carrierIds.push(id);
      return id;
    }
    const at = (date: string, h: number, m: number) => {
      const [y, mo, d] = date.split("-").map(Number);
      return zonedWallTimeToUtc(y, mo, d, h, m, 0);
    };
    type HM = [number, number];
    async function work(
      emp: string,
      activity: string,
      row: string,
      date: string,
      s: HM,
      e: HM | null,
      stems = 600,
      opts: { carrier?: string; endDate?: string } = {}
    ) {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, greenhouse_row_id, carrier_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, 'stems', $7) returning id`,
        [emp, activity, at(date, ...s), e ? at(opts.endDate ?? date, ...e) : null, row, opts.carrier ?? null, stems]
      );
      return rows[0].id as string;
    }
    async function brk(emp: string, date: string, s: HM, e: HM) {
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual')`,
        [emp, at(date, ...s), at(date, ...e)]
      );
    }
    const setWindow = async (days: number) => {
      const r = await call("PUT", "/api/row-completions/review-window", auth, { rowReviewWindowDays: days });
      check(r.status === 200 && r.body?.rowReviewWindowDays === days, `setting the window to ${days} succeeds`, r);
    };
    // Cycle index of each unresolved visit, in chronological order (setting read from the DB).
    const cycles = async (row: string, activity = actA) => (await getUnresolvedRunsForRow(row, activity, "stems")).map((c) => c.cycleIndex);
    const attr = async (activity: string, from: string, to: string, emp: string) => {
      const { start, end } = getRangeBoundsUtc(from, to);
      return (await getActivityDensityAttribution(activity, start, end)).byEmployee.get(emp) ?? { quantity: 0, durationSeconds: 0, completions: 0 };
    };
    const dailyRun = async (emp: string, date: string, row: string) =>
      ((await call("GET", `/api/inputs/daily?employeeId=${emp}&date=${date}`, auth)).body?.runs ?? []).find((r: any) => r.row?.id === row);

    // ===== Setting API: default, validation, permissions =====
    {
      await pool.query(`update org_settings set row_review_window_days = 7 where id = true`);
      const g = await call("GET", "/api/row-completions/review-window", auth);
      check(g.status === 200 && g.body?.rowReviewWindowDays === 7, "GET returns the default of 7", g);
      const col = (await pool.query(`select column_default from information_schema.columns where table_name = 'org_settings' and column_name = 'row_review_window_days'`)).rows[0];
      check(col?.column_default === "7", "the column defaults to 7 (existing behaviour)", col);
      for (const bad of [0, -1, 1.5, "7", null, 366, true]) {
        const r = await call("PUT", "/api/row-completions/review-window", auth, { rowReviewWindowDays: bad });
        check(r.status === 400 && /whole number of days/.test(r.body?.error ?? ""), `PUT rejects ${JSON.stringify(bad)}`, r);
      }
      check((await call("PUT", "/api/row-completions/review-window", auth, {})).status === 400, "PUT rejects a missing value");
      check((await getUnresolvedRunsForRow(rowIds[0] ?? "00000000-0000-0000-0000-000000000000", actA, "stems")).length === 0, "sanity: nothing pending yet");
      const m = await call("GET", "/api/row-completions/review-window", managerAuth);
      check(m.status === 200 && m.body?.rowReviewWindowDays === 7, "a Manager can view the setting (same as Setup)", m);
      const mp = await call("PUT", "/api/row-completions/review-window", managerAuth, { rowReviewWindowDays: 3 });
      check(mp.status === 403, "a Manager cannot change it (Administrator only)", mp);
      const emp = await insertEmployee("Plain");
      const e = await call("GET", "/api/row-completions/review-window", { Cookie: `labourlink_session=${emp.token}` });
      check(e.status === 403, "an Employee cannot view it", e);
      check((await call("GET", "/api/row-completions/review-window", {})).status === 401, "signed-out requests are refused");
      check((await pool.query(`select row_review_window_days from org_settings`)).rows[0].row_review_window_days === 7, "rejected writes changed nothing");
      let dbRejected = false;
      try {
        await pool.query(`update org_settings set row_review_window_days = 0 where id = true`);
      } catch {
        dbRejected = true;
      }
      check(dbRejected, "the database itself refuses a window below 1");
      await setWindow(1);
      await setWindow(365);
      const saved = (await pool.query(`select row_review_window_days, updated_by_employee_id from org_settings`)).rows[0];
      check(saved.row_review_window_days === 365 && saved.updated_by_employee_id === admin.id, "the saved value persists with who saved it", saved);
      await setWindow(7);
    }

    const ann = await insertEmployee("Ann");
    const ben = await insertEmployee("Ben");

    // ===== Default (7): 6 dates apart share a cycle, 7 apart don't =====
    const rSix = await insertRow();
    const rSeven = await insertRow();
    {
      await work(ann.id, actA, rSix, "2025-03-03", [8, 0], [9, 0]);
      await work(ben.id, actA, rSix, "2025-03-09", [8, 0], [9, 0]); // different employee, 6 dates later
      await work(ann.id, actA, rSeven, "2025-03-03", [8, 0], [9, 0]);
      await work(ann.id, actA, rSeven, "2025-03-10", [8, 0], [9, 0]); // same employee, exactly 7 dates later
      check(JSON.stringify(await cycles(rSix)) === "[0,0]", "default 7: visits 6 dates apart (different employees) share one cycle", await cycles(rSix));
      check(JSON.stringify(await cycles(rSeven)) === "[0,1]", "default 7: exactly 7 dates apart starts a new cycle (same employee)", await cycles(rSeven));
      const a = await attr(actA, "2025-03-03", "2025-03-10", ann.id);
      check(a.quantity === 1200 && a.completions === 2 && a.durationSeconds === 7200, "default 7: Ann counts only Row 7-apart's two sole visits; the shared cycle is excluded", a);
      const b = await attr(actA, "2025-03-03", "2025-03-10", ben.id);
      check(b.quantity === 0, "default 7: Ben's visit in the ambiguous cycle counts nothing", b);
      check((await dailyRun(ben.id, "2025-03-09", rSix))?.isUnresolvedRowCompletion === true, "default 7: Inputs shows Needs review on Ben's visit");
      check((await dailyRun(ann.id, "2025-03-03", rSix))?.isUnresolvedRowCompletion === true, "default 7: Inputs shows Needs review on Ann's visit too");
      check((await dailyRun(ann.id, "2025-03-10", rSeven))?.isUnresolvedRowCompletion === false, "default 7: no badge for a visit alone in its cycle");
    }

    // ===== Exactly at the boundary, either time of day =====
    {
      const late = await insertRow();
      await work(ann.id, actA, late, "2025-03-03", [23, 0], [23, 30]);
      await work(ann.id, actA, late, "2025-03-10", [6, 0], [6, 30]); // 7 dates apart, only ~6.3 days elapsed
      check(JSON.stringify(await cycles(late)) === "[0,1]", "7 dates apart separates even when under 7×24h have elapsed", await cycles(late));
      const early = await insertRow();
      await work(ann.id, actA, early, "2025-03-03", [6, 0], [6, 30]);
      await work(ann.id, actA, early, "2025-03-09", [23, 0], [23, 30]); // 6 dates apart, ~6.7 days elapsed
      check(JSON.stringify(await cycles(early)) === "[0,0]", "6 dates apart stays together whatever the times of day", await cycles(early));
    }

    // ===== Preceding-visit chain: each gap is measured from the previous visit =====
    const rChain = await insertRow();
    {
      await work(ann.id, actA, rChain, "2025-04-01", [8, 0], [9, 0]);
      await work(ben.id, actA, rChain, "2025-04-06", [8, 0], [9, 0]);
      await work(ann.id, actA, rChain, "2025-04-11", [8, 0], [9, 0]); // 10 dates after the first, 5 after the previous
      check(JSON.stringify(await cycles(rChain)) === "[0,0,0]", "the gap is measured from the preceding visit (chain stays one cycle)", await cycles(rChain));
    }

    // ===== Different activities never share a cycle =====
    {
      const rAct = await insertRow();
      await work(ann.id, actA, rAct, "2025-05-05", [8, 0], [9, 0]);
      await work(ann.id, actB, rAct, "2025-05-06", [8, 0], [9, 0]);
      check(JSON.stringify(await cycles(rAct, actA)) === "[0]" && JSON.stringify(await cycles(rAct, actB)) === "[0]", "different activities on one row are separate");
      const a = await attr(actA, "2025-05-05", "2025-05-06", ann.id);
      const b = await attr(actB, "2025-05-05", "2025-05-06", ann.id);
      check(a.quantity === 600 && b.quantity === 600, "each activity's sole visit counts normally", { a, b });
      check((await dailyRun(ann.id, "2025-05-06", rAct))?.isUnresolvedRowCompletion === false, "no Needs review across activities");
    }

    // ===== Carrier changes, contiguous segments and breaks stay one visit =====
    {
      const cX = await insertCarrier("Cart X");
      const cY = await insertCarrier("Cart Y");
      const rCar = await insertRow();
      await work(ann.id, actA, rCar, "2025-06-02", [8, 0], [9, 0], 600, { carrier: cX });
      await work(ann.id, actA, rCar, "2025-06-02", [9, 0], [9, 30], 600, { carrier: cY }); // contiguous, carrier changed
      await brk(ann.id, "2025-06-02", [9, 30], [9, 45]);
      await work(ann.id, actA, rCar, "2025-06-02", [9, 45], [10, 30], 600, { carrier: cY }); // after a break
      for (const days of [1, 7]) {
        await setWindow(days);
        const c = await getUnresolvedRunsForRow(rCar, actA, "stems");
        check(c.length === 1 && c[0].segmentIds.length === 3, `window ${days}: carrier change + break is still ONE visit`, c.map((x) => x.segmentIds.length));
        const a = await attr(actA, "2025-06-02", "2025-06-02", ann.id);
        check(a.quantity === 600 && a.durationSeconds === 8100 && a.completions === 1, `window ${days}: the sole visit counts once over 2h15m of work (break excluded)`, a);
      }
      await setWindow(7);
    }

    // ===== Open visits stay excluded =====
    {
      const rOpen = await insertRow();
      await work(ben.id, actA, rOpen, "2025-06-10", [8, 0], null);
      const b = await attr(actA, "2025-06-10", "2025-06-10", ben.id);
      check(b.quantity === 0 && b.completions === 0, "a sole open visit is not counted", b);
    }

    // ===== Timezone and DST =====
    {
      // Local date, not UTC: 21:30 on Mar 3 is already Mar 4 in UTC.
      const rTz = await insertRow();
      await work(ann.id, actA, rTz, "2025-03-03", [21, 30], [22, 0]);
      await work(ann.id, actA, rTz, "2025-03-10", [19, 0], [19, 30]); // local dates 7 apart (UTC dates only 6)
      check(JSON.stringify(await cycles(rTz)) === "[0,1]", "dates are the organization's local dates, not UTC", await cycles(rTz));
      // Spring forward (Mar 9 2025): 7 local dates apart but under 167h elapsed.
      const rSpring = await insertRow();
      await work(ann.id, actA, rSpring, "2025-03-05", [0, 30], [1, 0]);
      await work(ann.id, actA, rSpring, "2025-03-12", [0, 15], [0, 45]);
      check(JSON.stringify(await cycles(rSpring)) === "[0,1]", "DST spring-forward: 7 dates apart still separates", await cycles(rSpring));
      // Fall back (Nov 2 2025): 6 local dates apart but over 168h elapsed.
      const rFall = await insertRow();
      await work(ann.id, actA, rFall, "2025-10-28", [0, 10], [0, 40]);
      await work(ann.id, actA, rFall, "2025-11-03", [23, 50], [23, 59]);
      check(JSON.stringify(await cycles(rFall)) === "[0,0]", "DST fall-back: 6 dates apart stays together despite >168h", await cycles(rFall));
      // Same checks with a custom window across DST.
      await setWindow(3);
      const rSpring3 = await insertRow();
      await work(ann.id, actA, rSpring3, "2025-03-08", [0, 30], [1, 0]);
      await work(ann.id, actA, rSpring3, "2025-03-11", [0, 15], [0, 45]); // 3 dates, ~71h
      check(JSON.stringify(await cycles(rSpring3)) === "[0,1]", "window 3 across spring-forward: 3 dates apart separates", await cycles(rSpring3));
      await setWindow(7);
    }

    // ===== Custom windows: saved changes regroup unresolved visits =====
    {
      await setWindow(3);
      check(JSON.stringify(await cycles(rSix)) === "[0,1]", "window 3: the 6-apart visits are now separate cycles", await cycles(rSix));
      const b = await attr(actA, "2025-03-03", "2025-03-10", ben.id);
      check(b.quantity === 600 && b.completions === 1, "window 3: Ben's visit now counts normally", b);
      check((await dailyRun(ben.id, "2025-03-09", rSix))?.isUnresolvedRowCompletion === false, "window 3: Inputs badge clears on the next load");
      check(JSON.stringify(await cycles(rChain)) === "[0,1,2]", "window 3: the chain (5-date gaps) splits into three", await cycles(rChain));
      const rTwo = await insertRow();
      await work(ann.id, actA, rTwo, "2025-07-01", [8, 0], [9, 0]);
      await work(ann.id, actA, rTwo, "2025-07-03", [8, 0], [9, 0]);
      check(JSON.stringify(await cycles(rTwo)) === "[0,0]", "window 3: 2 dates apart share a cycle", await cycles(rTwo));

      await setWindow(14);
      check(JSON.stringify(await cycles(rSeven)) === "[0,0]", "window 14: the 7-apart visits now share a cycle", await cycles(rSeven));
      check((await dailyRun(ann.id, "2025-03-10", rSeven))?.isUnresolvedRowCompletion === true, "window 14: Inputs now shows Needs review");
      const a = await attr(actA, "2025-03-03", "2025-03-10", ann.id);
      check(a.quantity === 0, "window 14: neither Row 7-apart visit counts while it needs review", a);

      await setWindow(1);
      check(JSON.stringify(await cycles(rTwo)) === "[0,1]", "window 1: any different date is a new cycle", await cycles(rTwo));
      const sameDay = await insertRow();
      await work(ann.id, actA, sameDay, "2025-07-10", [8, 0], [9, 0]);
      await work(ben.id, actA, sameDay, "2025-07-10", [13, 0], [14, 0]);
      check(JSON.stringify(await cycles(sameDay)) === "[0,0]", "window 1: two employees on the same date still share a cycle", await cycles(sameDay));

      await setWindow(7);
      check(JSON.stringify(await cycles(rSix)) === "[0,0]" && JSON.stringify(await cycles(rSeven)) === "[0,1]", "back to 7: original grouping restored exactly");
    }

    // ===== Manual confirmations survive setting changes =====
    {
      const rKeep = await insertRow();
      const k1 = await work(ann.id, actA, rKeep, "2025-08-04", [8, 0], [9, 0]);
      const k2 = await work(ann.id, actA, rKeep, "2025-08-08", [8, 0], [8, 30]); // 4 dates apart: one cycle at 7
      const combine = await call("POST", "/api/row-completions", auth, { timeEntryIds: [k1, k2] });
      check(combine.status === 201 || combine.status === 200, "combine two visits 4 dates apart under window 7", combine);
      const completionId = combine.body?.rowCompletion?.id ?? combine.body?.id;
      const p1 = await work(ben.id, actA, rKeep, "2025-08-20", [8, 0], [9, 0]);
      const p2 = await work(ben.id, actA, rKeep, "2025-08-22", [8, 0], [9, 0]);
      check(JSON.stringify(await cycles(rKeep)) === "[0,0]", "window 7: Ben's two pending visits form one ambiguous cycle", await cycles(rKeep));
      const before = await attr(actA, "2025-08-01", "2025-08-31", ann.id);

      await setWindow(2);
      const comp = (await pool.query(`select id, quantity_per_row, (select count(*)::int from row_completion_segments where row_completion_id = rc.id) as segs from row_completions rc where greenhouse_row_id = $1`, [rKeep])).rows;
      check(comp.length === 1 && comp[0].id === completionId && comp[0].segs === 2, "window 2: the confirmed completion is unchanged (same record, both visits)", comp);
      const after = await attr(actA, "2025-08-01", "2025-08-31", ann.id);
      check(after.quantity === before.quantity && after.quantity === 600 && after.durationSeconds === 5400 && after.completions === 1, "window 2: Ann's confirmed row still counts once over both visits", { before, after });
      check(JSON.stringify(await cycles(rKeep)) === "[0,1]", "window 2: Ben's pending visits regroup into separate cycles", await cycles(rKeep));
      const b = await attr(actA, "2025-08-01", "2025-08-31", ben.id);
      check(b.quantity === 1200 && b.completions === 2, "window 2: each of Ben's visits now counts on its own", b);
      const refused = await call("POST", "/api/row-completions", auth, { timeEntryIds: [p1, p2] });
      check(refused.status === 400 && /2 or more calendar days apart/.test(refused.body?.error ?? ""), "window 2: combining across cycles is refused, naming the window", refused);
      await setWindow(7);
      const back = await attr(actA, "2025-08-01", "2025-08-31", ann.id);
      check(back.quantity === 600 && back.completions === 1, "back to 7: the confirmed completion is still counted exactly once", back);
    }

    // ===== Review endpoints follow the setting; stale groups are refused =====
    {
      const rRev = await insertRow();
      await work(ann.id, actA, rRev, "2025-09-01", [8, 0], [9, 0]);
      await work(ben.id, actA, rRev, "2025-09-02", [8, 0], [9, 0]);
      await work(ann.id, actA, rRev, "2025-09-05", [8, 0], [9, 0]); // 3 dates after Ben's visit
      const g7 = await call("GET", `/api/row-completions/review-groups?date=2025-09-05&employeeId=${ann.id}`, auth);
      const group = (g7.body?.groups ?? []).find((g: any) => g.greenhouseRowId === rRev);
      check(g7.body?.windowDays === 7 && group?.visits.length === 2 && group.actions.merge.available, "review-groups (window 7) offers a merge card and reports windowDays", g7.body?.windowDays);
      check(group?.contextVisits.length === 1 && group.contextVisits[0].employeeId === ben.id, "Ben's visit is context only on Ann's card", group?.contextVisits);
      check(group?.reasons.some((r: string) => /less than 7 days apart/.test(r)), "the card's reason names the 7-day window", group?.reasons);
      const cand = await call("GET", `/api/row-completions/candidates?greenhouseRowId=${rRev}&activityId=${actA}&densityType=stems`, auth);
      check(cand.body?.windowDays === 7 && cand.body?.candidates?.length === 3, "the individual review lists all three and reports windowDays", cand.body?.windowDays);
      await setWindow(10);
      const g10 = await call("GET", `/api/row-completions/review-groups?date=2025-09-05&employeeId=${ann.id}`, auth);
      const group10 = (g10.body?.groups ?? []).find((g: any) => g.greenhouseRowId === rRev);
      check(g10.body?.windowDays === 10 && group10?.reasons.some((r: string) => /less than 10 days apart/.test(r)), "window 10: the reason names the saved window", group10?.reasons);
      await setWindow(3);
      const g3 = await call("GET", `/api/row-completions/review-groups?date=2025-09-05&employeeId=${ann.id}`, auth);
      check(g3.body?.windowDays === 3 && !(g3.body?.groups ?? []).some((g: any) => g.greenhouseRowId === rRev), "review-groups (window 3): Ann's Sep 5 visit is alone — no card", g3.body);
      const cand3 = await call("GET", `/api/row-completions/candidates?greenhouseRowId=${rRev}&activityId=${actA}&densityType=stems&timeEntryId=${group.visits[0].segmentIds[0]}`, auth);
      check(cand3.body?.windowDays === 3 && cand3.body?.candidates?.length === 2, "window 3: the individual review from Sep 1 lists only Sep 1 + Sep 2", cand3.body);
      const stale = await call("POST", "/api/row-completions/bulk-review", auth, {
        date: "2025-09-05",
        groups: [{ groupId: group.id, action: "merge", visits: group.visits.map((v: any) => v.segmentIds) }],
      });
      const staleResult = stale.body?.results?.[0];
      check(staleResult?.ok === false, "a card loaded under the old window is refused after the change (never merged across the new boundary)", stale.body);
      check((await pool.query(`select count(*)::int as n from row_completions where greenhouse_row_id = $1`, [rRev])).rows[0].n === 0, "…and nothing was saved");
      await setWindow(7);
    }

    // ===== Consumers agree: Inputs, Reports, Productive TV, mobile Stats =====
    {
      // The previous Monday-start week, so mobile Stats (last 4 weeks, by the
      // real clock) includes it.
      const { weekStart: thisMonday } = await getCurrentWeekBoundsUtc();
      const mon = addDaysToDateStr(thisMonday, -7);
      const wed = addDaysToDateStr(mon, 2);
      const sun = addDaysToDateStr(mon, 6);
      const cara = await insertEmployee("Cara");
      const deviceIdentifier = `qa-rrw-device-${RUN_ID}`;
      const dev = (await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [deviceIdentifier, `QA RRW ${RUN_ID}`])).rows[0].id;
      deviceIds.push(dev);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [dev, cara.id]);

      const rTwice = await insertRow();
      const rOnce = await insertRow();
      await work(cara.id, picking, rTwice, mon, [8, 0], [9, 0], 600);
      await work(cara.id, picking, rTwice, wed, [8, 0], [8, 30], 600);
      await work(cara.id, picking, rOnce, wed, [9, 0], [9, 45], 450);

      for (const [days, wantQty, wantSecs, wantBadge] of [
        [7, 450, 2700, true],
        [2, 1650, 8100, false],
        [3, 450, 2700, true],
      ] as [number, number, number, boolean][]) {
        await setWindow(days);
        const a = await attr(picking, mon, sun, cara.id);
        check(a.quantity === wantQty && a.durationSeconds === wantSecs, `window ${days}: attribution = ${wantQty} stems over ${wantSecs}s`, a);
        const speed = aggregateDensitySpeed([{ quantityPerRow: a.quantity, durationSeconds: a.durationSeconds }]);

        const report = (await getActivityReportData(picking, mon, sun))!;
        const reportTotal = report.employeeTotals.find((t) => t.employeeId === cara.id);
        check((reportTotal?.quantityWorked ?? 0) === wantQty, `window ${days}: Reports' employee total shows the same stems`, { reportTotal, wantQty });
        const reportDaySum = report.rows.filter((r) => r.employeeId === cara.id).reduce((s, r) => s + (r.quantityWorked ?? 0), 0);
        check(reportDaySum === wantQty, `window ${days}: Reports' daily rows add up to the range total`, { reportDaySum, wantQty });

        const tvBody = (await call("GET", `/api/integrations/productive-tv/picking-speed?from=${mon}&to=${sun}`, tv)).body;
        const tvRow = (tvBody?.employees ?? []).find((e: any) => e.employeeId === cara.id);
        check(tvRow?.stemsCounted === wantQty && Math.abs(tvRow.stemsPerHour - Math.round(speed! * 100) / 100) < 0.01, `window ${days}: Productive TV shows the same stems and speed`, { tvRow, speed });

        const stats = (await call("GET", "/api/mobile/stats", { "X-Device-Id": deviceIdentifier })).body;
        const week = (stats?.weeks ?? []).find((w: any) => w.weekStart === mon);
        const act = week?.activities?.find((x: any) => x.activityId === picking);
        check(act?.totalQuantity === wantQty && act?.totalDurationSeconds === wantSecs && Math.abs(act.averageSpeed - speed!) < 0.01, `window ${days}: mobile Stats shows the same week figures`, act);

        const monRun = await dailyRun(cara.id, mon, rTwice);
        check(monRun?.isUnresolvedRowCompletion === wantBadge, `window ${days}: Inputs badge = ${wantBadge}`, monRun?.isUnresolvedRowCompletion);
        const groups = (await call("GET", `/api/row-completions/review-groups?date=${wed}&employeeId=${cara.id}`, auth)).body?.groups ?? [];
        check(groups.some((g: any) => g.greenhouseRowId === rTwice) === wantBadge, `window ${days}: speed review card present = ${wantBadge}`);
        if (!wantBadge) {
          // Each visit is its own cycle: Inputs' per-visit speed = its own stems / its own time.
          check(monRun?.calculatedSpeedPerHour?.value === 600, `window ${days}: Inputs shows Monday's visit at 600/h`, monRun?.calculatedSpeedPerHour);
        }
      }
      await setWindow(7);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }
    // Restore the org-wide setting (and who last saved it) before removing
    // the test employees it may now reference.
    await tryDelete("org_settings", () =>
      pool.query(`update org_settings set row_review_window_days = $1, updated_by_employee_id = $2, updated_at = $3 where id = true`, [
        original.row_review_window_days,
        original.updated_by_employee_id,
        original.updated_at,
      ])
    );
    if (rowIds.length) await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [emailLike]));
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
    if (rowIds.length) await tryDelete("rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("phase", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("land", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (tokenIds.length) await tryDelete("tokens", () => pool.query(`delete from integration_tokens where id = any($1::uuid[])`, [tokenIds]));
    await tryDelete("employees", () => pool.query(`delete from employees where email like $1`, [emailLike]));
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
