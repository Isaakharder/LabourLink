// Regression test for the Productive TV slowdown (2026-10-02): the number of
// database round trips getActivityReportData (and the attribution behind
// it) makes must not grow with how much history a touched row has, or with
// how many visits fall in the range.
//
// Before the fix, attribution fetched every employee-day in each candidate
// row's ENTIRE unresolved history with one query per employee-day, plus two
// queries per accepted visit. A 1-day Productive TV request made 350+
// queries. At production DB latency that took 15-25s, and the burst
// exhausted the 10-connection pool ("timeout exceeded when trying to
// connect" -> intermittent 500s). This counts pool.query calls for the same
// 1-day range before and after adding lots more history and in-range
// visits, and requires the count to stay identical and small.
//
// Uses a QA-named activity (never the fixed "Winding & Pruning" / "Picking
// Peppers" names the Productive TV endpoint tests own). Everything created
// here is deleted in the `finally` cleanup.
//
// Run with: npm run test:reports-query-count
import "dotenv/config";
import { pool } from "../db";
import { zonedWallTimeToUtc } from "./timezone";
import { getActivityReportData } from "./reportQueries";

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
const RANGE_DATE = "2019-06-03";
// Any reasonable implementation needs well under this; the old one needed
// one query per employee-day of history.
const MAX_QUERIES = 20;

async function main() {
  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const rowIds: string[] = [];
  const timeEntryIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Query Count ${label} ${RUN_ID}`, `qa-query-count-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Query Count Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Query Count Phase ${RUN_ID}`,
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

    const activityId = (
      await pool.query(`insert into activities (name, is_active, density_source, sort_order) values ($1, true, 'stems', 0) returning id`, [
        `QA Query Count Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(activityId);

    // One unresolved 08:00-09:00 visit on `rowId` on 2019-MM-DD.
    async function insertVisit(employeeId: string, rowId: string, month: number, day: number): Promise<void> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', 500) returning id`,
        [employeeId, activityId, zonedWallTimeToUtc(2019, month, day, 8, 0, 0), zonedWallTimeToUtc(2019, month, day, 9, 0, 0), rowId]
      );
      timeEntryIds.push(rows[0].id);
    }

    async function countQueries<T>(fn: () => Promise<T>): Promise<{ count: number; result: T }> {
      const original = pool.query;
      let count = 0;
      (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
        count++;
        return (original as (...a: unknown[]) => unknown).apply(pool, args);
      };
      try {
        const result = await fn();
        return { count, result };
      } finally {
        (pool as unknown as { query: unknown }).query = original;
      }
    }

    const empA = await insertEmployee("A");
    const empB = await insertEmployee("B");
    const rows = [await insertRow(1), await insertRow(2), await insertRow(3), await insertRow(4)];

    // Phase 1: one in-range visit per employee, and a short May history on
    // the same rows. History ends more than CYCLE_GAP_DAYS before June 3, so
    // the June visits are their own unambiguous cycles and do count.
    await insertVisit(empA, rows[0], 6, 3);
    await insertVisit(empB, rows[1], 6, 3);
    for (let day = 1; day <= 3; day++) {
      await insertVisit(empA, rows[0], 5, day);
      await insertVisit(empB, rows[1], 5, day);
    }
    const before = await countQueries(() => getActivityReportData(activityId, RANGE_DATE, RANGE_DATE));
    check(before.count <= MAX_QUERIES, `small range makes at most ${MAX_QUERIES} queries`, before.count);
    const quantityA = before.result?.employeeTotals.find((t) => t.employeeId === empA)?.quantityWorked;
    check(quantityA === 500, "an unambiguous in-range visit still counts its frozen quantity", quantityA);

    // Phase 2: many more history days on every row, and more in-range
    // visits. The old code made one query per history employee-day and two
    // per in-range visit; the count must now stay exactly the same.
    await insertVisit(empA, rows[2], 6, 3);
    await insertVisit(empB, rows[3], 6, 3);
    for (let day = 4; day <= 24; day++) {
      for (const [emp, row] of [
        [empA, rows[0]],
        [empB, rows[1]],
        [empA, rows[2]],
        [empB, rows[3]],
      ] as const) {
        await insertVisit(emp, row, 5, day);
      }
    }
    const after = await countQueries(() => getActivityReportData(activityId, RANGE_DATE, RANGE_DATE));
    check(
      after.count === before.count,
      "query count does not grow with row history or with the number of in-range visits",
      { before: before.count, after: after.count }
    );
    const quantityAAfter = after.result?.employeeTotals.find((t) => t.employeeId === empA)?.quantityWorked;
    check(quantityAAfter === 1000, "both of employee A's in-range visits count", quantityAAfter);
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
