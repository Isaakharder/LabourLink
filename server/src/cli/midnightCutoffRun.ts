// The scheduled trigger for midnight cutoff (see
// server/src/lib/midnightCutoff.ts for the actual logic). Deployed as a
// Railway Cron Job pointing at this repo, with start command
// `node dist/cli/midnightCutoffRun.js` and a frequent schedule (e.g.
// hourly, matching the existing daily-cutoff job's cadence) — idempotent,
// so running it more often than strictly necessary only shrinks the window
// between real local midnight and an employee's open entry actually being
// closed server-side, never causes any duplicate effect. Also runnable
// manually via `npm run midnight-cutoff:run` for local testing or an
// ad-hoc catch-up sweep.
//
// Usage: npm run midnight-cutoff:run

import "dotenv/config";
import { pool } from "../db";
import { runMidnightCutoffSweep } from "../lib/midnightCutoff";

async function run() {
  console.log(`[midnight-cutoff] run started at ${new Date().toISOString()}`);

  const result = await runMidnightCutoffSweep();

  console.log(
    `[midnight-cutoff] run complete: candidateEmployees=${result.candidateEmployees} ` +
      `cutOff=${result.cutOff} skipped=${result.skipped} failures=${result.failures}`
  );

  await pool.end();
  process.exit(result.failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[midnight-cutoff] run crashed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
