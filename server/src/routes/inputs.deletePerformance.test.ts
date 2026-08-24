// Regression coverage for the Inputs activity-log deletion delay
// investigation: pressing Delete took ~8-10s end to end on a real busy day.
// Root cause (confirmed via EXPLAIN (ANALYZE, BUFFERS) — every query itself
// runs in ~1ms; the cost was round-trip COUNT, not query plan): GET /api/
// inputs/daily's row-completion ambiguity check called getUnresolvedRunsForRow
// once per unresolved row+activity+density pair, and each call independently
// re-fetched that SAME employee's whole day from scratch — on a real
// production day (60 entries, 14 unresolved pairs, all one employee/day)
// that was 14 redundant whole-day fetches (measured: GET /daily ~5.65s).
// Fixed by rowCompletionCandidates.ts's getUnresolvedRunsForRows: one
// combined query finds every pair's unresolved touches at once, and each
// distinct employee+day is fetched (and its runs computed) at most ONCE no
// matter how many pairs touch it (measured after the fix: ~1.36s, the
// remainder being reconcileEmployeeBreaks and the base entryRows/photo-url
// work, unrelated to this bug — see this file's own timing assertions).
//
// This file proves two things a plain correctness test can't:
//  1) Structurally — the number of database round trips GET /daily makes
//     does NOT scale with the number of unresolved row+activity+density
//     pairs on the day (the actual regression: previously O(pairs), now a
//     small constant). Counting queries is deterministic, unlike wall-clock
//     timing, so this is the primary regression guard — it fails immediately
//     if the N+1 pattern is ever reintroduced, regardless of test-machine
//     speed.
//  2) Timing — wall-clock DELETE + GET /daily on a fixture reproducing the
//     real day's shape (one employee, 14 distinct unresolved row+activity+
//     density pairs sharing that one day) stays well within a generous
//     regression ceiling. Deliberately looser than this app's actual
//     production targets (delete <1s, refreshed display <1.5s) — those
//     assume production network locality this local/CI test environment
//     doesn't share; the ceiling here exists to catch a gross regression
//     (the N+1 coming back would blow through it by 3-4x), not to enforce
//     the production SLA itself.
//
// Same real-HTTP-against-real-database convention as
// inputs.activityRunDeletion.test.ts, which this file complements — that
// file already covers every deletion CORRECTNESS case (soft-delete, audit
// record, work-start preservation, next-run extension); this one adds
// timing/query-count coverage on top without duplicating it.
//
// Run with: npm run test:inputs-delete-performance
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { Client } from "pg";
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
const DATE = "2019-07-01"; // QA-only past date, distinct from every other test file's own dates
const ROW_COUNT = 14; // matches the real production day this bug was diagnosed against

// Counts every query made while `fn` runs, patched at the pg Client
// PROTOTYPE level (not on the `pool` object) — both pool.query() (a
// checkout-query-release convenience wrapper) and a transaction's own
// checked-out client.query() calls (pool.connect(), used by POST
// /activity-runs/:id/delete's begin/lock/update/insert/commit sequence,
// which never goes through pool.query directly) both ultimately call
// Client.prototype.query under the hood, so patching it once here catches
// every query through either path without needing two separate wrappers. A
// query-count-based regression guard is deterministic (unlike wall-clock
// timing, which is at the mercy of whatever else is happening on the test
// machine), so it's the primary signal here for "did an N+1 come back".
async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queryCount: number }> {
  const original = Client.prototype.query;
  let count = 0;
  // @ts-expect-error — intentionally patching the real prototype method for
  // the duration of one measured call, restored in `finally` below
  // regardless of how `fn` exits.
  Client.prototype.query = function (...args: unknown[]) {
    count++;
    return original.apply(this, args as never);
  };
  try {
    const result = await fn();
    return { result, queryCount: count };
  } finally {
    Client.prototype.query = original;
  }
}

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

  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; ms: number }> {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms: performance.now() - t0 };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const rowIds: string[] = [];
  const timeEntryIds: string[] = [];
  let landId!: string;
  let phaseId!: string;
  let breakProfileId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Delete Perf Admin ${RUN_ID}`, `qa-delete-perf-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    // A break profile with 2 auto-add items, assigned to the target
    // employee — matches the real production employee this bug was
    // diagnosed against (who has an assigned break profile), so
    // reconcileEmployeeBreaks' own pre-check cost is reflected in this
    // fixture's measured numbers too, not just the row-completion ambiguity
    // check. Both items are pre-satisfied (a matching break already exists
    // for each) — the common steady-state case: a day that's already been
    // viewed/reconciled once, which every GET /daily after the first hits.
    breakProfileId = (
      await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [`QA Delete Perf Break Profile ${RUN_ID}`])
    ).rows[0].id;
    const lunchItemId = (
      await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
         values ($1, 'QA Lunch', '12:00:00', '12:15:00', false, true, 1) returning id`,
        [breakProfileId]
      )
    ).rows[0].id;
    const coffeeItemId = (
      await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
         values ($1, 'QA Coffee', '15:00:00', '15:15:00', true, true, 2) returning id`,
        [breakProfileId]
      )
    ).rows[0].id;

    const targetId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ('QA', $1, $2, $3, $4, $5, true, $6) returning id`,
        [`Delete Perf Target ${RUN_ID}`, `qa-delete-perf-target-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash, breakProfileId]
      )
    ).rows[0].id;
    employeeIds.push(targetId);
    for (const itemId of [lunchItemId, coffeeItemId]) {
      const [h, m] = itemId === lunchItemId ? [12, 0] : [15, 0];
      const startedAt = zonedWallTimeToUtc(2019, 7, 1, h, m, 0);
      const endedAt = zonedWallTimeToUtc(2019, 7, 1, h, m + 15, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source,
                                    break_profile_item_id, scheduled_break_date, is_paid)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'auto', $4, $5, $6) returning id`,
        [targetId, startedAt, endedAt, itemId, DATE, itemId === coffeeItemId]
      );
      timeEntryIds.push(rows[0].id);
    }

    const activityId = (
      await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA Delete Perf Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(activityId);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Delete Perf Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Delete Perf Phase ${RUN_ID}`,
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
    async function insertWork(rowId: string, startHour: number, startMinute: number, endHour: number, endMinute: number): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 7, 1, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 7, 1, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', 636) returning id`,
        [targetId, activityId, startedAt, endedAt, rowId]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBreak(startHour: number, startMinute: number, endHour: number, endMinute: number): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 7, 1, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 7, 1, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
        [targetId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    // A busy day shaped like the real production day this bug was diagnosed
    // against: one employee, ROW_COUNT distinct rows, all touched by the
    // same activity/density type — ROW_COUNT distinct unresolved
    // row+activity+density pairs, none of them confirmed as a row
    // completion. Row 1's own run is deliberately two segments bridged by a
    // break (the run that gets deleted below), so the deletion itself still
    // exercises a real multi-segment run, not just the single-segment
    // common case.
    const rowIdsInOrder: string[] = [];
    for (let i = 1; i <= ROW_COUNT; i++) rowIdsInOrder.push(await insertRow(i));

    const row1SegA = await insertWork(rowIdsInOrder[0], 7, 0, 7, 30);
    await insertBreak(7, 30, 7, 45);
    const row1SegB = await insertWork(rowIdsInOrder[0], 7, 45, 8, 0);
    // The entry immediately after the deleted run — a different row (so it's
    // its own run, not merged into row 1's), which POST /delete must extend
    // backward to row 1's original 7:00 start once row 1's run is deleted.
    const row2Entry = await insertWork(rowIdsInOrder[1], 8, 0, 8, 15);
    let cursorHour = 8;
    let cursorMinute = 15;
    for (let i = 2; i < ROW_COUNT; i++) {
      const nextMinute = cursorMinute + 15;
      const endHour = cursorHour + Math.floor(nextMinute / 60);
      const endMinute = nextMinute % 60;
      await insertWork(rowIdsInOrder[i], cursorHour, cursorMinute, endHour, endMinute);
      cursorHour = endHour;
      cursorMinute = endMinute;
    }

    // -----------------------------------------------------------------
    // Structural regression guard: GET /daily's query count must not scale
    // with the number of unresolved row+activity+density pairs on the day.
    // Before the fix, each of the ROW_COUNT pairs cost its own touch-row +
    // row-label + employee-name + whole-day-fetch round trips (independent
    // of every other pair, even though every pair here shares the SAME
    // employee+day) — this fixture would have driven the query count well
    // past 4 x ROW_COUNT (56+ for ROW_COUNT=14). The fixed batched query
    // finds every pair's touches in one combined query and fetches this
    // one employee's one day exactly once no matter how many of the
    // ROW_COUNT pairs touch it.
    // -----------------------------------------------------------------
    const dailyBefore = await countQueries(() => call("GET", `/api/inputs/daily?employeeId=${targetId}&date=${DATE}`, { token: adminToken }));
    console.log(`[measured] GET /daily: ${dailyBefore.result.ms.toFixed(1)}ms, ${dailyBefore.queryCount} queries`);
    check(dailyBefore.result.status === 200, "GET /daily succeeds against the busy fixture", dailyBefore.result.body);
    const rowsInResponse = new Set((dailyBefore.result.body?.runs ?? []).map((r: any) => r.row?.id).filter(Boolean));
    check(rowsInResponse.size === ROW_COUNT, `GET /daily reports all ${ROW_COUNT} distinct rows as touched (sanity check the fixture itself is shaped right)`, [...rowsInResponse]);
    check(
      dailyBefore.queryCount < 30,
      `GET /daily's query count (${dailyBefore.queryCount}) stays well under a small constant regardless of ${ROW_COUNT} unresolved pairs — NOT O(pairs) (the N+1 this regression-guards against would need 4+ queries PER pair, i.e. 56+ here)`,
      { queryCount: dailyBefore.queryCount, rowCount: ROW_COUNT }
    );

    // -----------------------------------------------------------------
    // Timing — generous regression ceiling, not the production SLA itself
    // (see file header). 3000ms leaves ~2x headroom over the fixed,
    // measured local time (~1.4s) while still catching the N+1 pattern
    // outright (it measured ~5.6s on the real production day this fixture
    // mirrors).
    // -----------------------------------------------------------------
    check(dailyBefore.result.ms < 3000, `GET /daily completes in ${dailyBefore.result.ms.toFixed(0)}ms, under the 3000ms regression ceiling`, dailyBefore.result.ms);

    const row1Run = dailyBefore.result.body.runs.find((r: any) => r.row?.id === rowIdsInOrder[0]);
    check(row1Run !== undefined && row1Run.segmentIds?.length === 2, "row 1's run is the expected two-segment, break-bridged run", row1Run);

    // -----------------------------------------------------------------
    // DELETE timing + correctness together, on the SAME busy fixture — the
    // reported bug was specifically "8-10s from pressing Delete until the
    // row disappears", i.e. delete + refetch combined.
    // -----------------------------------------------------------------
    const deleteCounted = await countQueries(() => call("POST", `/api/inputs/activity-runs/${row1Run.id}/delete`, { token: adminToken }));
    const deleteRes = deleteCounted.result;
    console.log(`[measured] DELETE: ${deleteRes.ms.toFixed(1)}ms, ${deleteCounted.queryCount} queries`);
    check(deleteRes.status === 200, "DELETE succeeds", deleteRes.body);
    check(deleteRes.ms < 1500, `DELETE completes in ${deleteRes.ms.toFixed(0)}ms, under the 1500ms regression ceiling`, deleteRes.ms);

    // Correctness — unchanged from inputs.activityRunDeletion.test.ts's own
    // coverage, re-asserted here so a future perf change can't silently
    // trade correctness for speed.
    const seg1After = await pool.query(`select deleted_at, deleted_by_employee_id, deletion_reason from time_entries where id = $1`, [row1SegA]);
    check(
      seg1After.rows[0].deleted_at !== null && seg1After.rows[0].deleted_by_employee_id === adminId,
      "the deleted run's segments are soft-deleted with the admin recorded",
      seg1After.rows[0]
    );
    const row2After = await pool.query(`select started_at from time_entries where id = $1`, [row2Entry]);
    check(
      new Date(row2After.rows[0].started_at).getTime() === zonedWallTimeToUtc(2019, 7, 1, 7, 0, 0).getTime(),
      "the next entry (row 2) is extended backward to the deleted run's original 7:00 start",
      row2After.rows[0]
    );
    const correctionRows = await pool.query(`select id from time_entry_corrections where time_entry_id = $1`, [row2Entry]);
    check(correctionRows.rows.length === 1, "the extension is recorded in time_entry_corrections", correctionRows.rows);
    const deletionRows = await pool.query(`select id from time_entry_deletions where $1 = any(affected_time_entry_ids)`, [row1SegA]);
    check(deletionRows.rows.length === 1, "the deletion is recorded in time_entry_deletions", deletionRows.rows);

    // -----------------------------------------------------------------
    // Refetch after delete — the actual end-user-visible flow: this must
    // also stay fast (same query-count/timing guards), and must correctly
    // no longer show row 1 at all, while every other row (2-14) is
    // completely unaffected — same query-count ceiling as the pre-delete
    // load even though row 1's run is now resolved-away rather than
    // unresolved.
    // -----------------------------------------------------------------
    const dailyAfter = await countQueries(() => call("GET", `/api/inputs/daily?employeeId=${targetId}&date=${DATE}`, { token: adminToken }));
    console.log(`[measured] post-delete GET /daily: ${dailyAfter.result.ms.toFixed(1)}ms, ${dailyAfter.queryCount} queries`);
    console.log(`[measured] combined delete+refetch: ${(deleteRes.ms + dailyAfter.result.ms).toFixed(1)}ms`);
    check(dailyAfter.result.status === 200, "post-delete GET /daily succeeds", dailyAfter.result.body);
    check(dailyAfter.queryCount < 30, `post-delete GET /daily's query count (${dailyAfter.queryCount}) also stays well under the same small constant`, dailyAfter.queryCount);
    check(dailyAfter.result.ms < 3000, `post-delete GET /daily completes in ${dailyAfter.result.ms.toFixed(0)}ms, under the 3000ms regression ceiling`, dailyAfter.result.ms);
    const rowsAfter = new Set((dailyAfter.result.body?.runs ?? []).map((r: any) => r.row?.id).filter(Boolean));
    check(!rowsAfter.has(rowIdsInOrder[0]), "row 1 no longer appears at all after deletion", [...rowsAfter]);
    check(rowsAfter.size === ROW_COUNT - 1, "every other row (2 through 14) is still present and unaffected", [...rowsAfter]);

    // Total delete-press-to-refreshed-display time — the actual user-facing
    // number the reported bug was measured in.
    const totalMs = deleteRes.ms + dailyAfter.result.ms;
    check(totalMs < 4500, `combined delete+refetch completes in ${totalMs.toFixed(0)}ms, well under the reported 8000-10000ms bug`, totalMs);
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (timeEntryIds.length) await tryDelete("time_entry_corrections", () => pool.query(`delete from time_entry_corrections where time_entry_id = any($1::uuid[])`, [timeEntryIds]));
    if (timeEntryIds.length) await tryDelete("time_entry_deletions", () => pool.query(`delete from time_entry_deletions where affected_time_entry_ids && $1::uuid[]`, [timeEntryIds]));
    if (rowIds.length) await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    // Employees must go before their break_profile_id's own row below.
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    if (breakProfileId) {
      await tryDelete("break_profile_items", () => pool.query(`delete from break_profile_items where break_profile_id = $1`, [breakProfileId]));
      await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = $1`, [breakProfileId]));
    }
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
