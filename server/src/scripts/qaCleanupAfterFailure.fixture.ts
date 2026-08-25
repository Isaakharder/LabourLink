// Throwaway fixture script for qaCleanupAfterFailure.test.ts — NOT itself a
// counted test. Creates one QA employee, deliberately fails an assertion
// (proving a failed check() never skips cleanup — check() only increments a
// counter, it never throws, so the finally block below always runs
// regardless of pass/fail, exactly like every real *.test.ts file in this
// repo), then cleans that employee up in `finally` and exits non-zero
// (reflecting the real failure) — printing the employee id first so the
// parent test can verify it in the database.
import "dotenv/config";
import { pool } from "../db";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string) {
  if (condition) pass++;
  else fail++;
}

const RUN_ID = Date.now();

async function main() {
  const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
  const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

  const employeeId = (
    await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
       values ('QA', $1, $2, $3, $4, $5, true) returning id`,
      [`Cleanup After Failure ${RUN_ID}`, `qa-cleanup-after-failure-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
    )
  ).rows[0].id;

  console.log(`FIXTURE_EMPLOYEE_ID=${employeeId}`);

  try {
    // Deliberate failure — proves cleanup below still runs.
    check(false, "deliberately failing assertion");
  } finally {
    await pool.query(`delete from employees where id = $1`, [employeeId]);
    await pool.end();
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
