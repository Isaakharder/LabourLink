// Cross-day row completions: reporting rule + bulk speed review.
//
// A row started at the end of one day and finished the next morning is one
// completion spanning two days. Reporting rule (reportQueries.ts's
// contribute()), applied the same way by Reports, Productive TV, Dashboard
// and mobile Stats:
//   - its stems are split across its days in proportion to each day's work
//     time (largest-remainder rounding, so the shares add up exactly);
//   - each day inside the selected range counts its own share and its own
//     work time, even when the range excludes the other day;
//   - speed = allocated stems / allocated work time;
//   - its one completed row counts on the final visit's date;
//   - daily figures add up to range figures, with no double counting.
// The bulk review can now merge one employee's visits across days (same
// row/activity/cycle), shown as one card with the same id on each day.
//
// Covers Row 116's production shape, a completion spanning two weeks (an
// existing-style completion made through the individual review), mixed
// bulk actions in one submission, and overlapping submissions.
//
// Run with: npm run test:reports-cross-day-completion
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { getRangeBoundsUtc, zonedWallTimeToUtc } from "../lib/timezone";
import { generateIntegrationToken } from "../lib/integrationToken";
import { getActivityDensityAttribution, getActivityReportData } from "../lib/reportQueries";
import inputsRouter from "./inputs";
import rowCompletionsRouter from "./rowCompletions";
import integrationsRouter, { PICKING_ACTIVITY_NAME, PRUNING_ACTIVITY_NAME } from "./integrations";

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

  const emailLike = `qa-xday-%-${RUN_ID}@test.local`;
  const rowIds: string[] = [];
  const activityIds: string[] = [];
  const tokenIds: string[] = [];
  let landId: string | null = null;
  let phaseId: string | null = null;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function insertEmployee(label: string, role = "Employee") {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, 'x', true) returning id`,
        [`XDay ${label} ${RUN_ID}`, `qa-xday-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId]
      );
      const id = rows[0].id as string;
      return { id, token: signSession({ id, firstName: "QA", lastName: label, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await insertEmployee("Admin", "Administrator");
    const auth = { Cookie: `labourlink_session=${admin.token}` };
    const { token: tvToken, tokenHash } = generateIntegrationToken();
    tokenIds.push((await pool.query(`insert into integration_tokens (name, token_hash) values ($1, $2) returning id`, [`QA XDay ${RUN_ID}`, tokenHash])).rows[0].id);
    const tv = { Authorization: `Bearer ${tvToken}` };

    // The two fixed-name activities Productive TV reads (test database only,
    // same convention as the Productive TV endpoint tests).
    for (const name of [PICKING_ACTIVITY_NAME, PRUNING_ACTIVITY_NAME]) {
      await pool.query(`delete from row_completion_segments where time_entry_id in (select id from time_entries where activity_id in (select id from activities where name = $1))`, [name]);
      await pool.query(`delete from time_entries where activity_id in (select id from activities where name = $1)`, [name]);
      await pool.query(`delete from row_completions where activity_id in (select id from activities where name = $1)`, [name]);
      await pool.query(`delete from activities where name = $1`, [name]);
    }
    const picking = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [PICKING_ACTIVITY_NAME])).rows[0].id as string;
    const pruning = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [PRUNING_ACTIVITY_NAME])).rows[0].id as string;
    activityIds.push(picking, pruning);

    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [`QA XDay ${RUN_ID}`])).rows[0].id;
    phaseId = (await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [landId, `QA XDay ${RUN_ID}`])).rows[0].id;
    async function insertRow(n: number) {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, n, n * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id as string;
    }
    const at = (date: string, h: number, m: number) => {
      const [y, mo, d] = date.split("-").map(Number);
      return zonedWallTimeToUtc(y, mo, d, h, m, 0);
    };
    async function work(emp: string, activity: string, row: string, date: string, s: [number, number], e: [number, number], stems: number) {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', $6) returning id`,
        [emp, activity, at(date, ...s), at(date, ...e), row, stems]
      );
      return rows[0].id as string;
    }
    const attr = async (activity: string, from: string, to: string, emp: string) => {
      const { start, end } = getRangeBoundsUtc(from, to);
      return (await getActivityDensityAttribution(activity, start, end)).byEmployee.get(emp) ?? { quantity: 0, durationSeconds: 0, completions: 0 };
    };
    const tvRow = async (endpoint: string, from: string, to: string, emp: string) =>
      ((await call("GET", `/api/integrations/productive-tv/${endpoint}?from=${from}&to=${to}`, tv)).body?.employees ?? []).find((e: any) => e.employeeId === emp);
    const reviewGroups = async (date: string, emp?: string) =>
      (await call("GET", `/api/row-completions/review-groups?date=${date}${emp ? `&employeeId=${emp}` : ""}`, auth)).body?.groups ?? [];

    // ===== 1) Row 116: Oct 5 end of day + Oct 6 start of day, one employee =====
    const natt = await insertEmployee("Nattawat");
    const row116 = await insertRow(116);
    const v5 = await work(natt.id, picking, row116, "2026-10-05", [16, 50], [17, 0], 636); // 600 s
    const v6 = await work(natt.id, picking, row116, "2026-10-06", [7, 45], [8, 1], 636); // 960 s
    {
      const g5 = (await reviewGroups("2026-10-05", natt.id))[0];
      const g6 = (await reviewGroups("2026-10-06", natt.id))[0];
      check(g5 && g6 && g5.id === g6.id, "1) the same card (same id) on Oct 5's and Oct 6's review — never two actionable cards", { g5: g5?.id, g6: g6?.id });
      check(
        JSON.stringify(g5?.spansDates) === JSON.stringify(["2026-10-05", "2026-10-06"]) && g5?.visits.length === 2 && g5.contextVisits.length === 0,
        "1) the card holds both days' visits and says it spans Oct 5–6",
        g5
      );
      check(g5?.actions.merge.available === true && g5.suggestedAction === "merge", "1) Merge is available and suggested", g5?.actions.merge);
      check(
        g5?.actions.merge.preview.quantity === 636 && g5.actions.merge.preview.durationSeconds === 1560,
        "1) merge preview: 636 stems once over the combined 26 work minutes",
        g5?.actions.merge.preview
      );
      const before = (await pool.query(`select to_jsonb(te)::text as r from time_entries te where id = any($1::uuid[]) order by id`, [[v5, v6]])).rows.map((r) => r.r);
      const apply = await call("POST", "/api/row-completions/bulk-review", auth, {
        date: "2026-10-05",
        groups: [{ groupId: g5.id, action: "merge", visits: g5.visits.map((v: any) => v.segmentIds) }],
      });
      check(apply.body?.results?.[0]?.ok === true, "1) merged across days in one submission", apply.body);
      const after = (await pool.query(`select to_jsonb(te)::text as r from time_entries te where id = any($1::uuid[]) order by id`, [[v5, v6]])).rows.map((r) => r.r);
      check(JSON.stringify(after) === JSON.stringify(before), "1) original activity dates and times are untouched");
      check((await reviewGroups("2026-10-06", natt.id)).length === 0, "1) Oct 6's review no longer shows it (resolved once, for both days)");

      // 636 × 600/1560 = 244.6 → 245; 636 × 960/1560 = 391.4 → 391 (sum 636).
      const d5 = await attr(picking, "2026-10-05", "2026-10-05", natt.id);
      const d6 = await attr(picking, "2026-10-06", "2026-10-06", natt.id);
      const both = await attr(picking, "2026-10-05", "2026-10-06", natt.id);
      check(d5.quantity === 245 && d5.durationSeconds === 600 && d5.completions === 0, "1) Oct 5 alone: its 245-stem share over its 10 minutes, no completed row", d5);
      check(d6.quantity === 391 && d6.durationSeconds === 960 && d6.completions === 1, "1) Oct 6 alone: its 391-stem share, and the completed row (final visit's date)", d6);
      check(both.quantity === 636 && both.durationSeconds === 1560 && both.completions === 1, "1) Oct 5–6: 636 stems once, 1 completed row", both);
      check(d5.quantity + d6.quantity === both.quantity && d5.completions + d6.completions === both.completions, "1) daily figures add up to the range figures");

      const report = await getActivityReportData(picking, "2026-10-05", "2026-10-06");
      const rows = (report?.rows ?? []).filter((r) => r.employeeId === natt.id);
      const r5 = rows.find((r) => r.date === "2026-10-05");
      const r6 = rows.find((r) => r.date === "2026-10-06");
      const total = report?.employeeTotals.find((t) => t.employeeId === natt.id);
      check(r5?.quantityWorked === 245 && r5.rowsCompleted === 0 && r6?.quantityWorked === 391 && r6.rowsCompleted === 1, "1) Activity Report daily rows carry each day's share", { r5, r6 });
      check(total?.quantityWorked === 636 && total.rowsCompleted === 1, "1) Activity Report range total = sum of its days", total);
      const sumDates = (report?.dateTotals ?? []).reduce((s, d) => s + (d.quantityWorked ?? 0), 0);
      check(sumDates === report?.totals.quantityWorked, "1) report date totals add up to the overall total", { sumDates, total: report?.totals });
      const oct5Only = await getActivityReportData(picking, "2026-10-05", "2026-10-05");
      const o5 = oct5Only?.employeeTotals.find((t) => t.employeeId === natt.id);
      check(o5?.quantityWorked === 245 && o5.averageSpeed === 245 / (600 / 3600), "1) a one-day report counts that day's share at allocated stems / work time", o5);

      const tv5 = await tvRow("picking-speed", "2026-10-05", "2026-10-05", natt.id);
      const tv6 = await tvRow("picking-speed", "2026-10-06", "2026-10-06", natt.id);
      check(tv5?.stemsCounted === 245 && tv5.stemsPerHour === 1470, "1) Productive TV Oct 5: 245 stems / 10 min = 1470 stems/hour", tv5);
      check(tv6?.stemsCounted === 391 && tv6.stemsPerHour === 1466.25, "1) Productive TV Oct 6: 391 stems / 16 min", tv6);
    }

    // ===== 2) A completion spanning two weeks (Sun Oct 4 → Mon Oct 5) =====
    {
      const emp = await insertEmployee("Weekend");
      const row = await insertRow(201);
      const sun = await work(emp.id, pruning, row, "2026-10-04", [15, 0], [16, 0], 900); // 3600 s
      const mon = await work(emp.id, pruning, row, "2026-10-05", [7, 0], [7, 30], 900); // 1800 s
      // The existing individual review's cross-day combine (a completion of
      // the kind already in production).
      const made = await call("POST", "/api/row-completions", auth, { timeEntryIds: [sun, mon] });
      check(made.status === 201, "2) individual review combines Sunday + Monday into one completion", made.body);
      const wk1 = await attr(pruning, "2026-09-28", "2026-10-04", emp.id);
      const wk2 = await attr(pruning, "2026-10-05", "2026-10-11", emp.id);
      const two = await attr(pruning, "2026-09-28", "2026-10-11", emp.id);
      check(wk1.quantity === 600 && wk1.durationSeconds === 3600 && wk1.completions === 0, "2) week of Sep 28: Sunday's 600-stem share, no completed row", wk1);
      check(wk2.quantity === 300 && wk2.durationSeconds === 1800 && wk2.completions === 1, "2) week of Oct 5: Monday's 300-stem share + the completed row", wk2);
      check(two.quantity === 900 && two.completions === 1 && wk1.quantity + wk2.quantity === two.quantity, "2) both weeks: 900 once — weeks add up, nothing doubled", two);
      const p1 = await tvRow("pruning-speed", "2026-09-28", "2026-10-04", emp.id);
      const p2 = await tvRow("pruning-speed", "2026-10-05", "2026-10-11", emp.id);
      check(p1?.stemsCounted === 600 && p1.stemsPerHour === 600 && p2?.stemsCounted === 300 && p2.stemsPerHour === 600, "2) Productive TV pruning, each week: its own share, same 600 stems/hour", { p1, p2 });
      const weekReport = await getActivityReportData(pruning, "2026-09-28", "2026-10-04");
      check(
        weekReport?.employeeTotals.find((t) => t.employeeId === emp.id)?.quantityWorked === 600,
        "2) a weekly Activity Report includes the in-range day's share even though the other day is outside it"
      );
    }

    // ===== 3) Mixed bulk actions in one submission =====
    {
      const emp = await insertEmployee("Mixed");
      const other = await insertEmployee("Other");
      const rA = await insertRow(301);
      const rB = await insertRow(302);
      const rC = await insertRow(303);
      // A: cross-day, same employee → merge
      await work(emp.id, picking, rA, "2026-10-12", [16, 0], [16, 30], 500);
      await work(emp.id, picking, rA, "2026-10-13", [7, 0], [7, 30], 500);
      // B: this employee once, another employee 3 days earlier → keep separate
      await work(emp.id, picking, rB, "2026-10-12", [10, 0], [10, 30], 500);
      await work(other.id, picking, rB, "2026-10-09", [10, 0], [10, 30], 500);
      // C: two visits same day → skip
      await work(emp.id, picking, rC, "2026-10-12", [11, 0], [11, 20], 500);
      await work(emp.id, picking, rC, "2026-10-12", [12, 0], [12, 20], 500);
      const groups = await reviewGroups("2026-10-12", emp.id);
      const byRow = new Map(groups.map((g: any) => [g.greenhouseRowId, g]));
      check(groups.length === 3, "3) three cards for the employee", groups.map((g: any) => g.rowLabel));
      const gA: any = byRow.get(rA);
      const gB: any = byRow.get(rB);
      const gC: any = byRow.get(rC);
      check(gA?.spansDates.length === 2 && gB?.contextVisits.length === 1 && gB.visits.length === 1, "3) A spans two days; B shows the other employee only as context");
      const res = await call("POST", "/api/row-completions/bulk-review", auth, {
        date: "2026-10-12",
        groups: [
          { groupId: gA.id, action: "merge", visits: gA.visits.map((v: any) => v.segmentIds) },
          { groupId: gB.id, action: "separate", visits: gB.visits.map((v: any) => v.segmentIds) },
        ],
      });
      check((res.body?.results ?? []).every((r: any) => r.ok) && res.body.results.length === 2, "3) merge + keep separate saved in one submission", res.body);
      const left = await reviewGroups("2026-10-12", emp.id);
      check(left.length === 1 && left[0].id === gC.id, "3) only the skipped card is still pending; counts drop to 1", left.map((g: any) => g.rowLabel));
      check((await reviewGroups("2026-10-13", emp.id)).length === 0, "3) the next day's review has nothing left for the merged row");
      const day = await attr(picking, "2026-10-12", "2026-10-13", emp.id);
      check(day.quantity === 500 + 500 && day.completions === 2, "3) A counts once (500) + B counts on its own (500); C counts nothing yet", day);
      const daily = await call("GET", `/api/inputs/daily?employeeId=${emp.id}&date=2026-10-12`, auth);
      const aRun = (daily.body?.runs ?? []).find((r: any) => r.row?.id === rA);
      check(aRun?.calculatedSpeedPerHour?.value === 500 / (3600 / 3600) && !aRun.isUnresolvedRowCompletion, "3) Inputs speed for the merged row: 500 stems over its full 60 minutes", aRun?.calculatedSpeedPerHour);
    }

    // ===== 4) Overlapping submissions =====
    {
      const emp = await insertEmployee("Race");
      const row = await insertRow(401);
      await work(emp.id, picking, row, "2026-10-14", [16, 0], [16, 20], 400);
      await work(emp.id, picking, row, "2026-10-15", [7, 0], [7, 20], 400);
      const g = (await reviewGroups("2026-10-14", emp.id))[0];
      const body = { date: "2026-10-14", groups: [{ groupId: g.id, action: "merge", visits: g.visits.map((v: any) => v.segmentIds) }] };
      const body15 = { ...body, date: "2026-10-15" }; // the same card, reviewed from the other day
      const [a, b] = await Promise.all([
        call("POST", "/api/row-completions/bulk-review", auth, body),
        call("POST", "/api/row-completions/bulk-review", auth, body15),
      ]);
      const oks = [a, b].filter((r) => r.body?.results?.[0]?.ok).length;
      check(oks === 1, "4) two overlapping submissions of the same card: exactly one saves", { a: a.body, b: b.body });
      const loser = [a, b].find((r) => !r.body?.results?.[0]?.ok);
      check(!!loser && /resolved|no longer needs review|already belong/.test(loser.body.results[0].error), "4) the other is refused with a clear reason", loser?.body);
      const comps = await pool.query(
        `select count(distinct rc.id)::int as n from row_completions rc join row_completion_segments rcs on rcs.row_completion_id = rc.id where rc.greenhouse_row_id = $1`,
        [row]
      );
      check(comps.rows[0].n === 1, "4) exactly one completion exists — never saved twice", comps.rows[0]);

      // Bulk vs individual review racing on the same visits.
      const emp2 = await insertEmployee("Race2");
      const row2 = await insertRow(402);
      const e1 = await work(emp2.id, picking, row2, "2026-10-14", [16, 0], [16, 20], 400);
      const e2 = await work(emp2.id, picking, row2, "2026-10-15", [7, 0], [7, 20], 400);
      const g2 = (await reviewGroups("2026-10-14", emp2.id))[0];
      const [bulk, single] = await Promise.all([
        call("POST", "/api/row-completions/bulk-review", auth, {
          date: "2026-10-14",
          groups: [{ groupId: g2.id, action: "merge", visits: g2.visits.map((v: any) => v.segmentIds) }],
        }),
        call("POST", "/api/row-completions", auth, { timeEntryIds: [e1, e2] }),
      ]);
      const savedCount = (bulk.body?.results?.[0]?.ok ? 1 : 0) + (single.status === 201 ? 1 : 0);
      check(savedCount === 1, "4) bulk vs individual review on the same visits: exactly one saves", { bulk: bulk.body, single: single.status });
      check(single.status === 201 || single.status === 409, "4) a losing individual review gets a 409, not a server error", single);
      const comps2 = await pool.query(
        `select count(distinct rc.id)::int as n from row_completions rc join row_completion_segments rcs on rcs.row_completion_id = rc.id where rc.greenhouse_row_id = $1`,
        [row2]
      );
      check(comps2.rows[0].n === 1, "4) still exactly one completion", comps2.rows[0]);
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
    await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [emailLike]));
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
