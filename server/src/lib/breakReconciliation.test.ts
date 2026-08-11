// Tests reconcileEmployeeBreaks after the Inputs employee-switch
// performance refactor: the new optional `knownEmployee` fast path (no
// query/transaction at all when the caller already knows there's nothing
// to reconcile), the combined break-profile+auto-add-items query, and that
// the actual split behavior/idempotency are unchanged from before the
// refactor. Runs against the real database with disposable QA fixtures,
// torn down in a finally block — same convention as
// inputs.manualEntries.test.ts.
//
// Run with: npm run test:break-reconciliation
import "dotenv/config";
import { pool } from "../db";
import { reconcileEmployeeBreaks } from "./breakReconciliation";
import { zonedWallTimeToUtc } from "./timezone";

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
const TEST_DATE = "2019-06-03"; // past date, QA-only, never collides with real payroll data

async function main() {
  let target: { id: string } | undefined;
  let inactiveProfileEmployee: { id: string } | undefined;
  let breakProfile: { id: string } | undefined;
  let activity: { id: string } | undefined;
  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    breakProfile = (
      await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
        `QA Break Reconciliation Profile ${RUN_ID}`,
      ])
    ).rows[0];
    await pool.query(
      `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
       values ($1, 'QA Auto Break', '10:00:00', '10:15:00', false, true, 1)`,
      [breakProfile!.id]
    );

    activity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA Break Reconciliation Activity ${RUN_ID}`,
      ])
    ).rows[0];

    const targetRows = await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
       values ($1, $2, $3, $4, $5, $6, true, $7)
       returning id`,
      [
        "QA",
        `Break Recon Target ${RUN_ID}`,
        `qa-break-recon-target-${RUN_ID}@test.local`,
        employeeRoleId,
        teamRoleId,
        fakePinHash,
        breakProfile!.id,
      ]
    );
    target = targetRows.rows[0];

    // A work entry that fully covers the scheduled 10:00-10:15 window —
    // the exact shape reconciliation looks for to split.
    await pool.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
       values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')`,
      [
        target!.id,
        activity!.id,
        zonedWallTimeToUtc(2019, 6, 3, 9, 0, 0).toISOString(),
        zonedWallTimeToUtc(2019, 6, 3, 11, 0, 0).toISOString(),
      ]
    );

    // -----------------------------------------------------------------
    // Fast path: knownEmployee says there's nothing to do — no query, no
    // transaction, and (observably) nothing created, for an employee whose
    // real DB state actually WOULD have something to reconcile. Proves the
    // function trusts the passed-in info rather than re-checking it.
    // -----------------------------------------------------------------
    {
      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: true, breakProfileId: null });
      const { rows } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and entry_type = 'break'`,
        [target!.id]
      );
      check(
        Number(rows[0].count) === 0,
        "knownEmployee with breakProfileId=null skips reconciliation entirely, even though the employee's real row has one",
        rows[0]
      );

      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: false, breakProfileId: breakProfile!.id });
      const { rows: rows2 } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and entry_type = 'break'`,
        [target!.id]
      );
      check(
        Number(rows2[0].count) === 0,
        "knownEmployee with isActive=false skips reconciliation entirely",
        rows2[0]
      );
    }

    // -----------------------------------------------------------------
    // Real reconciliation, using the pre-fetched knownEmployee (the GET
    // /daily call shape) — the work entry must actually get split.
    // -----------------------------------------------------------------
    {
      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: true, breakProfileId: breakProfile!.id });

      const { rows } = await pool.query(
        `select entry_type, started_at, ended_at, source, is_paid
         from time_entries
         where employee_id = $1 and deleted_at is null
         order by started_at asc`,
        [target!.id]
      );
      check(rows.length === 3, "the covering work entry is split into exactly 3 rows (before/break/after)", rows);
      check(
        rows[0]?.entry_type === "work" &&
          rows[1]?.entry_type === "break" &&
          rows[1]?.source === "auto" &&
          rows[1]?.is_paid === false &&
          rows[2]?.entry_type === "work",
        "the split rows are work / auto unpaid break / work, in that order",
        rows
      );
    }

    // -----------------------------------------------------------------
    // Idempotency: reconciling the same employee/date again — whether via
    // the same knownEmployee shortcut or the no-argument fallback path
    // mobileTime.ts uses — must never double-add.
    // -----------------------------------------------------------------
    {
      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: true, breakProfileId: breakProfile!.id });
      await reconcileEmployeeBreaks(target!.id, TEST_DATE); // no third arg — fetches employee info itself

      const { rows } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and deleted_at is null`,
        [target!.id]
      );
      check(
        Number(rows[0].count) === 3,
        "reconciling again (with or without a pre-fetched knownEmployee) never creates duplicate rows",
        rows[0]
      );
    }

    // -----------------------------------------------------------------
    // The no-argument fallback path also correctly finds "nothing to do"
    // on its own for an employee with no break profile at all, exactly
    // like before this refactor.
    // -----------------------------------------------------------------
    {
      const unassignedRows = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true)
         returning id`,
        [
          "QA",
          `Break Recon Unassigned ${RUN_ID}`,
          `qa-break-recon-unassigned-${RUN_ID}@test.local`,
          employeeRoleId,
          teamRoleId,
          fakePinHash,
        ]
      );
      inactiveProfileEmployee = unassignedRows.rows[0];
      await reconcileEmployeeBreaks(inactiveProfileEmployee!.id, TEST_DATE);
      const { rows } = await pool.query(`select count(*) from time_entries where employee_id = $1`, [
        inactiveProfileEmployee!.id,
      ]);
      check(
        Number(rows[0].count) === 0,
        "the no-argument fallback path correctly no-ops for an employee with no break profile"
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

    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-break-recon-%-${RUN_ID}@test.local`,
      ])
    );
    for (const employee of [target, inactiveProfileEmployee]) {
      if (employee) {
        await tryDelete("employees", () => pool.query("delete from employees where id = $1", [employee.id]));
      }
    }
    if (activity) {
      await tryDelete("activities", () => pool.query("delete from activities where id = $1", [activity!.id]));
    }
    if (breakProfile) {
      await tryDelete("break_profile_items", () =>
        pool.query("delete from break_profile_items where break_profile_id = $1", [breakProfile!.id])
      );
      await tryDelete("break_profiles", () => pool.query("delete from break_profiles where id = $1", [breakProfile!.id]));
    }
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
