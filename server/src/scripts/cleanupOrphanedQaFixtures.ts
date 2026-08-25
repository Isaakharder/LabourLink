// Safety net for QA test fixtures a test process failed to clean up itself.
//
// Root cause of the real leak this addresses (QA Delete Perf Land.../QA
// Scenarios Land... visible on the phone's row picker, investigated 2026):
// every affected test file's own try/finally cleanup block was already
// correctly written and correctly ordered (children before parents,
// individual delete failures caught per-step) — the leaked fixtures'
// entire trees (land + phase + rows, employees, activities, devices) were
// found FULLY intact with zero partial cleanup, which only happens if the
// finally block never ran AT ALL. That points to the test PROCESS being
// killed externally (a tool/CI timeout on a slow test, e.g. the "known-
// slow" mobileTime.syncEvents.scenarios.test.ts, or a manual interrupt)
// before it could reach its own cleanup — not a bug in any cleanup logic.
// No amount of correctly-ordered try/finally inside a test can protect
// against the process itself being killed mid-run, so this is a separate,
// independent safety net: a sweep that can find and remove anything
// matching this codebase's own established QA-fixture-naming convention
// (first_name = 'QA' employees; 'QA ...'-prefixed activities/lands/break
// profiles/devices — see any *.test.ts file in this repo for the
// convention itself), run on demand (or periodically) regardless of
// whether any particular test run finished cleanly.
//
// Safety, independent of the naming match:
//  - Age-gated (default 60 minutes) — never touches a fixture young enough
//    to belong to a test that might still be running concurrently.
//  - A device is swept only if EVERY employee ever assigned to it is
//    itself a swept QA employee — a real employee who happens to have
//    named their own device "QA <something>" (this happened for real: a
//    real Administrator's "QA Settings Screen Check" device was found
//    during this investigation and correctly excluded) is never touched.
//  - Dry-run by default; only --confirm actually deletes.
//
// Run with: npm run qa:cleanup            (report only)
//           npm run qa:cleanup -- --confirm (actually delete)
import "dotenv/config";
import { Pool } from "pg";
import { pool as sharedPool } from "../db";

export interface QaFixtureScope {
  employeeIds: string[];
  activityIds: string[];
  landIds: string[];
  phaseIds: string[];
  rowIds: string[];
  breakProfileIds: string[];
  deviceIds: string[];
}

export async function findOrphanedQaFixtures(pool: Pool, olderThanMinutes = 60): Promise<QaFixtureScope> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const employeeIds = (
    await pool.query(`select id from employees where first_name = 'QA' and created_at < $1`, [cutoff])
  ).rows.map((r) => r.id);

  const activityIds = (
    await pool.query(`select id from activities where name ilike 'QA %' and updated_at < $1`, [cutoff])
  ).rows.map((r) => r.id);

  const landIds = (
    await pool.query(`select id from greenhouse_lands where name ilike 'QA %' and created_at < $1`, [cutoff])
  ).rows.map((r) => r.id);
  const phaseIds = landIds.length
    ? (await pool.query(`select id from greenhouse_phases where land_id = any($1::uuid[])`, [landIds])).rows.map((r) => r.id)
    : [];
  const rowIds = phaseIds.length
    ? (await pool.query(`select id from greenhouse_rows where phase_id = any($1::uuid[])`, [phaseIds])).rows.map((r) => r.id)
    : [];

  const breakProfileIds = (
    await pool.query(`select id from break_profiles where name ilike 'QA %' and created_at < $1`, [cutoff])
  ).rows.map((r) => r.id);

  // A device is only ever in scope if it's old enough AND every assignment
  // it has ever had belongs to a QA employee old enough to also be swept —
  // this is what protects a real employee's own QA-prefixed device name.
  const deviceIds = (
    await pool.query(
      `select d.id
       from devices d
       left join device_assignments da on da.device_id = d.id
       left join employees e on e.id = da.employee_id
       where d.device_name ilike 'QA %' and d.created_at < $1
       group by d.id
       having count(*) filter (where e.id is null or e.first_name <> 'QA' or e.created_at >= $1) = 0`,
      [cutoff]
    )
  ).rows.map((r) => r.id);

  return { employeeIds, activityIds, landIds, phaseIds, rowIds, breakProfileIds, deviceIds };
}

export async function deleteOrphanedQaFixtures(pool: Pool, scope: QaFixtureScope): Promise<Record<string, number>> {
  const client = await pool.connect();
  const deleted: Record<string, number> = {};
  try {
    await client.query("begin");

    async function del(label: string, sql: string, params: unknown[]) {
      const res = await client.query(sql, params);
      deleted[label] = res.rowCount ?? 0;
    }

    await del("activity_group_activities", `delete from activity_group_activities where activity_id = any($1::uuid[])`, [scope.activityIds]);
    await del("activity_questions", `delete from activity_questions where activity_id = any($1::uuid[])`, [scope.activityIds]);
    await del(
      "employee_activity_group_assignments",
      `delete from employee_activity_group_assignments where employee_id = any($1::uuid[]) or assigned_by_employee_id = any($1::uuid[])`,
      [scope.employeeIds]
    );
    await del("mobile_time_events", `delete from mobile_time_events where device_id = any($1::uuid[])`, [scope.deviceIds]);
    await del("device_sync_state", `delete from device_sync_state where device_id = any($1::uuid[])`, [scope.deviceIds]);
    await del("device_assignments", `delete from device_assignments where device_id = any($1::uuid[])`, [scope.deviceIds]);
    await del(
      "time_entry_corrections",
      `delete from time_entry_corrections where time_entry_id in (select id from time_entries where employee_id = any($1::uuid[]))`,
      [scope.employeeIds]
    );
    await del(
      "time_entry_deletions",
      `delete from time_entry_deletions where affected_time_entry_ids && (select array_agg(id) from time_entries where employee_id = any($1::uuid[]))`,
      [scope.employeeIds]
    );
    await del("row_completions", `delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [scope.rowIds]);
    await del("time_entries", `delete from time_entries where employee_id = any($1::uuid[])`, [scope.employeeIds]);
    await del("devices", `delete from devices where id = any($1::uuid[])`, [scope.deviceIds]);
    await del("greenhouse_rows", `delete from greenhouse_rows where id = any($1::uuid[])`, [scope.rowIds]);
    await del("greenhouse_phases", `delete from greenhouse_phases where id = any($1::uuid[])`, [scope.phaseIds]);
    await del("greenhouse_lands", `delete from greenhouse_lands where id = any($1::uuid[])`, [scope.landIds]);
    await del("activities", `delete from activities where id = any($1::uuid[])`, [scope.activityIds]);
    await del("employees", `delete from employees where id = any($1::uuid[])`, [scope.employeeIds]);
    await del("break_profile_items", `delete from break_profile_items where break_profile_id = any($1::uuid[])`, [scope.breakProfileIds]);
    await del("break_profiles", `delete from break_profiles where id = any($1::uuid[])`, [scope.breakProfileIds]);

    await client.query("commit");
    return deleted;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function runCli() {
  const confirm = process.argv.includes("--confirm");
  const scope = await findOrphanedQaFixtures(sharedPool);
  const total = Object.values(scope).reduce((sum, ids) => sum + ids.length, 0);

  console.log("Orphaned QA fixture scope (older than 60 minutes):");
  for (const [key, ids] of Object.entries(scope)) console.log(`  ${key}: ${ids.length}`);

  if (total === 0) {
    console.log("Nothing to clean up.");
    await sharedPool.end();
    return;
  }

  if (!confirm) {
    console.log("\nDry run only — re-run with --confirm to actually delete.");
    await sharedPool.end();
    return;
  }

  const deleted = await deleteOrphanedQaFixtures(sharedPool, scope);
  console.log("\nDeleted:");
  for (const [table, count] of Object.entries(deleted)) console.log(`  ${table}: ${count}`);
  await sharedPool.end();
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
