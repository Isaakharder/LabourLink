// Proves the exact property the QA-fixture-leak investigation needed
// confirmed: a failed assertion inside a QA test never skips its own
// cleanup. Runs qaCleanupAfterFailure.fixture.ts (which deliberately fails
// one check()) as a real child process, then confirms both that it
// reported the expected failure (non-zero exit) AND that the employee it
// created is actually gone from the database afterward — proving cleanup
// ran to completion despite the failure, not just that the code READS as
// if it would.
//
// This is deliberately a real subprocess, not an in-process function call
// — the property under test is specifically "the process's own finally
// block runs before it exits," which an in-process call can't distinguish
// from "the function returned normally."
//
// Run with: npm run test:qa-cleanup-after-failure
import "dotenv/config";
import { exec } from "child_process";
import path from "path";
import { pool } from "../db";

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

function runFixture(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const fixturePath = path.join(__dirname, "qaCleanupAfterFailure.fixture.ts");
    exec(`npx ts-node "${fixturePath}"`, { cwd: path.join(__dirname, "..", "..") }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  try {
    const result = await runFixture();
    check(result.code !== 0, "1) the fixture's own deliberate assertion failure produces a non-zero exit code", result.code);

    const match = result.stdout.match(/FIXTURE_EMPLOYEE_ID=([0-9a-f-]+)/);
    check(!!match, "fixture reported the employee id it created", result.stdout);
    const employeeId = match?.[1];

    if (employeeId) {
      const { rows } = await pool.query(`select id from employees where id = $1`, [employeeId]);
      check(rows.length === 0, "2) despite the failed assertion, the fixture's own cleanup still removed its employee", rows);
    }
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
