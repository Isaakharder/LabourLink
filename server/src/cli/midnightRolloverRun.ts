// The scheduled trigger for midnight rollover (see
// server/src/lib/midnightRollover.ts for the actual logic). Deployed as a
// Railway Cron Job pointing at this repo, with start command
// `node dist/cli/midnightRolloverRun.js` and a frequent schedule (e.g.
// hourly, matching the existing daily-cutoff job's cadence) — idempotent,
// so running it more often than strictly necessary only shrinks the window
// between a real local midnight and an employee's open entry actually
// rolling forward server-side, never causes any duplicate effect. Also
// runnable manually via `npm run rollover:run` for local testing or an
// ad-hoc catch-up sweep.
//
// Usage: npm run rollover:run

import "dotenv/config";
import { pool } from "../db";
import { runMidnightRolloverSweep } from "../lib/midnightRollover";

async function run() {
  console.log(`[midnight-rollover] run started at ${new Date().toISOString()}`);

  const result = await runMidnightRolloverSweep();

  console.log(
    `[midnight-rollover] run complete: candidateEmployees=${result.candidateEmployees} ` +
      `succeeded=${result.succeeded} failures=${result.failures}`
  );

  await pool.end();
  process.exit(result.failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[midnight-rollover] run crashed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
