// Covers the QA-fixture safety-net sweep (cleanupOrphanedQaFixtures.ts),
// written after finding real leaked fixtures (QA Delete Perf Land...,
// QA Scenarios Land...) still fully intact in the live database — see that
// file's own header comment for the root-cause investigation. This proves
// the sweep finds a genuinely orphaned QA fixture tree, respects the age
// threshold (never touches something young enough to belong to a still-
// running test), and — the exact false positive this investigation
// actually found — never touches a real employee's device merely because
// its name happens to contain "QA".
//
// Run with: npm run test:qa-fixture-cleanup
import "dotenv/config";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { findOrphanedQaFixtures, deleteOrphanedQaFixtures } from "./cleanupOrphanedQaFixtures";

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
  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const landIds: string[] = [];
  const deviceIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const adminRoleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    // A genuinely orphaned QA fixture, "created" 2 hours ago (backdated —
    // simulates a real leak from a killed test process, without waiting
    // two real hours) — should be found and, once confirmed, deleted.
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const orphanEmployee = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, created_at)
         values ('QA', $1, $2, $3, $4, $5, true, $6) returning id`,
        [`Sweep Orphan ${RUN_ID}`, `qa-sweep-orphan-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash, oldTimestamp]
      )
    ).rows[0].id;
    employeeIds.push(orphanEmployee);

    const orphanActivity = (
      await pool.query(`insert into activities (name, is_active, updated_at) values ($1, true, $2) returning id`, [
        `QA Sweep Orphan Activity ${RUN_ID}`,
        oldTimestamp,
      ])
    ).rows[0].id;
    activityIds.push(orphanActivity);

    const orphanLand = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, created_at) values ($1, 300, 100, $2) returning id`,
        [`QA Sweep Orphan Land ${RUN_ID}`, oldTimestamp]
      )
    ).rows[0].id;
    landIds.push(orphanLand);

    const orphanDeviceIdentifier = randomUUID();
    const orphanDevice = (
      await pool.query(
        `insert into devices (device_identifier, device_name, is_active, created_at) values ($1, $2, true, $3) returning id`,
        [orphanDeviceIdentifier, `QA Sweep Orphan Device ${RUN_ID}`, oldTimestamp]
      )
    ).rows[0].id;
    deviceIds.push(orphanDevice);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [orphanDevice, orphanEmployee]);

    // A fresh (just-created) QA fixture — simulates a test that's still
    // actively running right now. Must NEVER be swept, regardless of
    // matching the naming convention, purely because it's too young.
    const freshEmployee = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Sweep Fresh ${RUN_ID}`, `qa-sweep-fresh-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(freshEmployee);

    // The exact false-positive this investigation found for real: a REAL
    // employee's device, backdated so it can't be excluded by age alone —
    // only the "every assignment must be a QA employee" guard protects it.
    const realAdmin = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        [`RealAdmin`, `Sweep ${RUN_ID}`, `real-admin-sweep-${RUN_ID}@test.local`, adminRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(realAdmin);
    const realDeviceIdentifier = randomUUID();
    const realNamedQaDevice = (
      await pool.query(
        `insert into devices (device_identifier, device_name, is_active, created_at) values ($1, $2, true, $3) returning id`,
        [realDeviceIdentifier, `QA Settings Screen Check ${RUN_ID}`, oldTimestamp]
      )
    ).rows[0].id;
    deviceIds.push(realNamedQaDevice);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [realNamedQaDevice, realAdmin]);

    // -----------------------------------------------------------------
    const scope = await findOrphanedQaFixtures(pool, 60);

    check(scope.employeeIds.includes(orphanEmployee), "1) an old orphaned QA employee is found", orphanEmployee);
    check(!scope.employeeIds.includes(freshEmployee), "2) a fresh (just-created) QA employee is NOT found — too young", freshEmployee);
    check(!scope.employeeIds.includes(realAdmin), "never sweeps a real (non-QA-named) employee", realAdmin);
    check(scope.activityIds.includes(orphanActivity), "3) an old orphaned QA activity is found", orphanActivity);
    check(scope.landIds.includes(orphanLand), "4) an old orphaned QA land is found", orphanLand);
    check(scope.deviceIds.includes(orphanDevice), "5) an old QA device with only QA assignments is found", orphanDevice);
    check(
      !scope.deviceIds.includes(realNamedQaDevice),
      "6) a real employee's device is NEVER swept, even though its name matches 'QA %' and it's old enough",
      realNamedQaDevice
    );

    // -----------------------------------------------------------------
    // Exercise deleteOrphanedQaFixtures with a scope built from ONLY this
    // test's own fixture ids — deliberately NOT the live `scope` object
    // above. Passing the real findOrphanedQaFixtures() result straight
    // into a real delete is exactly the mistake that turned an earlier
    // version of this test into an unintended live production sweep (any
    // real leftover fixture in the shared database older than the age
    // threshold — which is the normal, expected state right up until
    // someone runs the cleanup — would be swept up right along with this
    // test's own fixtures). A test must never invoke the real destructive
    // path against real unscoped data, however "safe" the function being
    // tested is believed to be.
    const deleted = await deleteOrphanedQaFixtures(pool, {
      employeeIds: [orphanEmployee],
      activityIds: [orphanActivity],
      landIds: [orphanLand],
      phaseIds: [],
      rowIds: [],
      breakProfileIds: [],
      deviceIds: [orphanDevice],
    });
    check(deleted.employees === 1, "7) delete pass removes exactly this test's own orphaned employee, nothing else", deleted);

    const orphanStillThere = await pool.query(`select id from employees where id = $1`, [orphanEmployee]);
    check(orphanStillThere.rows.length === 0, "8) the orphaned employee is actually gone after delete", orphanStillThere.rows);

    const realDeviceStillThere = await pool.query(`select id from devices where id = $1`, [realNamedQaDevice]);
    check(realDeviceStillThere.rows.length === 1, "9) the real employee's QA-named device survives the sweep untouched", realDeviceStillThere.rows);

    const realAdminStillThere = await pool.query(`select id from employees where id = $1`, [realAdmin]);
    check(realAdminStillThere.rows.length === 1, "9b) the real employee itself survives the sweep untouched", realAdminStillThere.rows);

    const freshEmployeeStillThere = await pool.query(`select id from employees where id = $1`, [freshEmployee]);
    check(freshEmployeeStillThere.rows.length === 1, "10) the fresh QA employee (too young) still survives — not swept", freshEmployeeStillThere.rows);

    // Cleaned up by delete pass — remove from our own tracked arrays so the
    // finally block below doesn't try (and fail) to delete them again.
    employeeIds.splice(employeeIds.indexOf(orphanEmployee), 1);
    activityIds.splice(activityIds.indexOf(orphanActivity), 1);
    landIds.splice(landIds.indexOf(orphanLand), 1);
    deviceIds.splice(deviceIds.indexOf(orphanDevice), 1);
  } finally {
    // Same retry-then-fail-visibly convention as midnightRollover.test.ts's
    // own tryDelete — a bare .catch(() => {}) here would silently hide a
    // real leftover fixture exactly the way the 2026-08-31 leak went
    // unnoticed.
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      const maxAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await fn();
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
      fail++;
      console.error(`FAIL: cleanup step "${label}" failed after ${maxAttempts} attempts:`, lastErr);
    }
    for (const id of deviceIds) await tryDelete(`device_assignments ${id}`, () => pool.query(`delete from device_assignments where device_id = $1`, [id]));
    for (const id of deviceIds) await tryDelete(`devices ${id}`, () => pool.query(`delete from devices where id = $1`, [id]));
    for (const id of landIds) await tryDelete(`greenhouse_lands ${id}`, () => pool.query(`delete from greenhouse_lands where id = $1`, [id]));
    for (const id of activityIds) await tryDelete(`activities ${id}`, () => pool.query(`delete from activities where id = $1`, [id]));
    for (const id of employeeIds) await tryDelete(`employees ${id}`, () => pool.query(`delete from employees where id = $1`, [id]));
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
