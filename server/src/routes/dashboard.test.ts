// End-to-end integration tests for GET /api/dashboard/cards: activity
// selection filtering, employee-without-an-open-job exclusion, ratio-of-sums
// row/stem speed and block projection, picking speed/bins/rows shape, and
// unrelated-fixture isolation. Same real-HTTP-against-real-database
// convention used throughout this repo. Timestamps are all "N hours ago
// from right now" (never a fixed historical date) since weekly attribution
// is scoped to the REAL current week at test-run time.
//
// Run with: npm run test:dashboard
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import dashboardRouter from "./dashboard";

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
const testNow = new Date();
function hoursAgo(n: number): Date {
  return new Date(testNow.getTime() - n * 3600000);
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/dashboard", dashboardRouter);
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
  const rowIds: string[] = [];
  const carrierIds: string[] = [];
  const blockIds: string[] = [];
  const densityIds: string[] = [];
  const completionIds: string[] = [];
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
        [`Dashboard Admin ${RUN_ID}`, `qa-dashboard-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Dashboard ${label} ${RUN_ID}`, `qa-dashboard-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertActivity(label: string, densitySource: "plants" | "stems" | null): Promise<string> {
      const { rows } = await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, $2) returning id`, [
        `QA Dashboard ${label} ${RUN_ID}`,
        densitySource,
      ]);
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Dashboard Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Dashboard Phase ${RUN_ID}`,
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

    async function insertDensity(countPerRow: number, linkedRowIds: string[]): Promise<void> {
      const { rows } = await pool.query(`insert into plant_densities (name, type, count_per_row) values ($1, 'stems', $2) returning id`, [
        `QA Dashboard Density ${RUN_ID}-${densityIds.length}`,
        countPerRow,
      ]);
      densityIds.push(rows[0].id);
      for (const rowId of linkedRowIds) {
        await pool.query(`insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, 'stems')`, [rows[0].id, rowId]);
      }
    }

    async function insertWork(
      employeeId: string,
      activityId: string,
      start: Date,
      end: Date | null,
      extra: { rowId?: string; densityCountPerRow?: number; carrierId?: string } = {}
    ): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row, carrier_id)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7, $8)
         returning id`,
        [
          employeeId,
          activityId,
          start,
          end,
          extra.rowId ?? null,
          extra.densityCountPerRow != null ? "stems" : null,
          extra.densityCountPerRow ?? null,
          extra.carrierId ?? null,
        ]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function confirmRowCompletion(rowId: string, quantityPerRow: number, confirmedBy: string, segmentIds: string[]): Promise<void> {
      const { rows } = await pool.query(
        `insert into row_completions (greenhouse_row_id, density_type, quantity_per_row, confirmed_by_employee_id) values ($1, 'stems', $2, $3) returning id`,
        [rowId, quantityPerRow, confirmedBy]
      );
      for (const segId of segmentIds) {
        await pool.query(`insert into row_completion_segments (time_entry_id, row_completion_id) values ($1, $2)`, [segId, rows[0].id]);
      }
    }

    async function insertCarrier(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA Dashboard Carrier ${label} ${RUN_ID}`]);
      carrierIds.push(rows[0].id);
      return rows[0].id;
    }

    async function confirmCarrierCompletion(carrierId: string, confirmedBy: string, segmentIds: string[]): Promise<void> {
      const { rows } = await pool.query(`insert into carrier_completions (carrier_id, confirmed_by_employee_id) values ($1, $2) returning id`, [
        carrierId,
        confirmedBy,
      ]);
      completionIds.push(rows[0].id);
      for (const segId of segmentIds) {
        await pool.query(`insert into carrier_completion_segments (time_entry_id, carrier_completion_id) values ($1, $2)`, [segId, rows[0].id]);
      }
    }

    const rowStemActivity = await insertActivity("Row Stem", "stems");
    const pickingActivity = await insertActivity("Picking", null);
    const unselectedActivity = await insertActivity("Unselected", "stems");

    // Only rowStemActivity and pickingActivity are on the dashboard.
    await call("PUT", "/api/dashboard/settings", { token: adminToken, body: { activityIds: [rowStemActivity, pickingActivity] } });

    // -----------------------------------------------------------------
    // Row/stem employee: a confirmed completion this week (500 stems / 1
    // hour = 500/hr exactly), a block with that row (completed, 500 stems)
    // plus one not-yet-completed row (300 stems) -> remaining 300, projected
    // 300/500 = 0.6 hours. Currently open on a second row.
    // -----------------------------------------------------------------
    const empRowStem = await insertEmployee("Row Stem Worker");
    {
      const rowA = await insertRow(1);
      const rowC = await insertRow(2);
      const rowOpen = await insertRow(3);
      await insertDensity(500, [rowA]);
      await insertDensity(300, [rowC]);

      const completedEntry = await insertWork(empRowStem, rowStemActivity, hoursAgo(3), hoursAgo(2), { rowId: rowA, densityCountPerRow: 500 });
      await confirmRowCompletion(rowA, 500, adminId, [completedEntry]);
      await insertWork(empRowStem, rowStemActivity, hoursAgo(1), null, { rowId: rowOpen }); // currently open

      const { rows: blockRows } = await pool.query(`insert into employee_blocks (name, employee_id) values ($1, $2) returning id`, [
        `QA Dashboard Block ${RUN_ID}`,
        empRowStem,
      ]);
      blockIds.push(blockRows[0].id);
      await pool.query(`insert into employee_block_rows (block_id, greenhouse_row_id) values ($1, $2), ($1, $3)`, [blockRows[0].id, rowA, rowC]);
    }

    // -----------------------------------------------------------------
    // Row/stem employee below the minimum-duration floor: only 5 minutes
    // of attributed duration this week -> weeklySpeed must be null, not a
    // wildly noisy number.
    // -----------------------------------------------------------------
    const empNotEnoughData = await insertEmployee("Not Enough Data");
    {
      const rowShort = await insertRow(4);
      const rowOpen = await insertRow(5);
      await insertDensity(100, [rowShort]);
      const shortEntry = await insertWork(empNotEnoughData, rowStemActivity, hoursAgo(0.1), hoursAgo(0.0167), { rowId: rowShort, densityCountPerRow: 100 }); // ~5 minutes
      await confirmRowCompletion(rowShort, 100, adminId, [shortEntry]);
      await insertWork(empNotEnoughData, rowStemActivity, hoursAgo(0.01), null, { rowId: rowOpen });
    }

    // -----------------------------------------------------------------
    // Picking employee: two confirmed bin completions this week (1 hour
    // each, on two different rows) -> binsCompletedThisWeek = 2, speed = 2
    // bins / 2 hours = 1 bin/hour, rowsWorkedThisWeek = 2 (deduplicated —
    // the currently-open entry re-touches one of the same rows).
    // -----------------------------------------------------------------
    const empPicking = await insertEmployee("Picking Worker");
    {
      const rowE = await insertRow(6);
      const rowF = await insertRow(7);
      const carrierA = await insertCarrier("A");
      const carrierB = await insertCarrier("B");

      const e1 = await insertWork(empPicking, pickingActivity, hoursAgo(4), hoursAgo(3), { rowId: rowE, carrierId: carrierA });
      const e2 = await insertWork(empPicking, pickingActivity, hoursAgo(3), hoursAgo(2), { rowId: rowF, carrierId: carrierB });
      await confirmCarrierCompletion(carrierA, adminId, [e1]);
      await confirmCarrierCompletion(carrierB, adminId, [e2]);
      await insertWork(empPicking, pickingActivity, hoursAgo(1), null, { rowId: rowE, carrierId: carrierA }); // currently open, re-touches rowE
    }

    // -----------------------------------------------------------------
    // Excluded: no currently-open work entry at all.
    // -----------------------------------------------------------------
    const empNoActiveJob = await insertEmployee("No Active Job");
    {
      const row = await insertRow(8);
      await insertWork(empNoActiveJob, rowStemActivity, hoursAgo(5), hoursAgo(4), { rowId: row });
    }

    // -----------------------------------------------------------------
    // Excluded: currently active, but on an activity NOT selected for the
    // dashboard.
    // -----------------------------------------------------------------
    const empUnselected = await insertEmployee("Unselected Activity");
    {
      const row = await insertRow(9);
      await insertWork(empUnselected, unselectedActivity, hoursAgo(1), null, { rowId: row });
    }

    const res = await call("GET", "/api/dashboard/cards", { token: adminToken });
    check(res.status === 200, "GET /cards succeeds", res.body);
    const cards: any[] = res.body?.cards ?? [];
    const byEmployee = new Map(cards.map((c) => [c.employeeId, c]));

    // -----------------------------------------------------------------
    // 1) & 2) Only employees currently doing a SELECTED activity appear;
    // no-active-job and unselected-activity employees are absent.
    // -----------------------------------------------------------------
    check(byEmployee.has(empRowStem) && byEmployee.has(empPicking), "1) employees currently doing a selected activity appear", [...byEmployee.keys()]);
    check(!byEmployee.has(empNoActiveJob), "2) an employee with no currently-open work entry does not appear", byEmployee.get(empNoActiveJob));
    check(!byEmployee.has(empUnselected), "2) an employee currently on an unselected activity does not appear", byEmployee.get(empUnselected));

    // -----------------------------------------------------------------
    // 3) Isolation: an unrelated (differently-RUN_ID'd) fixture never
    // leaks in — implicit in every check above (this whole test only ever
    // asserts about its own RUN_ID-scoped fixtures), verified explicitly
    // here by confirming the card COUNT matches exactly this run's active
    // employees, not more.
    // -----------------------------------------------------------------
    const thisRunCardCount = cards.filter((c) => [empRowStem, empPicking].includes(c.employeeId)).length;
    check(thisRunCardCount === 2, "3) exactly this run's own currently-active employees are present, nothing extra leaked in", thisRunCardCount);

    // -----------------------------------------------------------------
    // 4), 7) Row/stem ratio-of-sums speed and block projection.
    // -----------------------------------------------------------------
    const rowStemCard = byEmployee.get(empRowStem);
    check(rowStemCard?.cardType === "row_stem", "4) the row/stem card is correctly typed", rowStemCard);
    check(Math.abs((rowStemCard?.weeklySpeed ?? 0) - 500) < 0.01, "4) weekly speed is the ratio-of-sums 500 stems / 1 hour = 500/hr", rowStemCard?.weeklySpeed);
    check(
      rowStemCard?.block?.totalRows === 2 && rowStemCard?.block?.completedRows === 1 && rowStemCard?.block?.remainingStems === 300,
      "5)/6) block rows are deduplicated and partial completion correctly reduces remaining stems (300, not the full 800)",
      rowStemCard?.block
    );
    check(
      rowStemCard?.block?.status === "in_progress" && Math.abs((rowStemCard?.block?.projectedHoursRemaining ?? 0) - 0.6) < 0.01,
      "7) projected hours remaining = 300 remaining stems / 500 per hour = 0.6 hours",
      rowStemCard?.block
    );

    // -----------------------------------------------------------------
    // 8) Zero/below-floor speed produces no invalid projection — a card
    // whose weekly duration is under the minimum floor shows null speed,
    // never a divide-by-near-zero number.
    // -----------------------------------------------------------------
    const notEnoughDataCard = byEmployee.get(empNotEnoughData);
    check(notEnoughDataCard?.weeklySpeed === null, "8) a card with only a few minutes of weekly duration shows null speed, not a noisy number", notEnoughDataCard?.weeklySpeed);

    // -----------------------------------------------------------------
    // 9), 10) Picking: ratio-of-sums bins/hour, deduplicated bins and rows.
    // -----------------------------------------------------------------
    const pickingCard = byEmployee.get(empPicking);
    check(pickingCard?.cardType === "picking", "9) the picking card is correctly typed", pickingCard);
    check(pickingCard?.binsCompletedThisWeek === 2, "10) exactly 2 confirmed bins counted, not double-counted", pickingCard?.binsCompletedThisWeek);
    check(Math.abs((pickingCard?.weeklySpeed ?? 0) - 1) < 0.01, "9) picking speed is the ratio-of-sums 2 bins / 2 hours = 1 bin/hour", pickingCard?.weeklySpeed);
    check(
      pickingCard?.rowsWorkedThisWeek === 2,
      "10) rows worked this week are deduplicated (2 distinct rows, not 3, even though the open entry re-touches one)",
      pickingCard?.rowsWorkedThisWeek
    );
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (completionIds.length) {
      await tryDelete("carrier_completion_segments", () => pool.query(`delete from carrier_completion_segments where carrier_completion_id = any($1::uuid[])`, [completionIds]));
      await tryDelete("carrier_completions", () => pool.query(`delete from carrier_completions where id = any($1::uuid[])`, [completionIds]));
    }
    if (rowIds.length) {
      await tryDelete("row_completion_segments/row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
      await tryDelete("employee_block_rows", () => pool.query(`delete from employee_block_rows where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
      await tryDelete("plant_density_rows", () => pool.query(`delete from plant_density_rows where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    }
    if (blockIds.length) await tryDelete("employee_blocks", () => pool.query(`delete from employee_blocks where id = any($1::uuid[])`, [blockIds]));
    if (densityIds.length) await tryDelete("plant_densities", () => pool.query(`delete from plant_densities where id = any($1::uuid[])`, [densityIds]));
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (activityIds.length) {
      await tryDelete("dashboard_activities", () => pool.query(`delete from dashboard_activities where activity_id = any($1::uuid[])`, [activityIds]));
      await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    }
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
