// The scheduled trigger for the daily-cutoff safety net (see
// server/src/lib/dailyCutoff.ts for the actual logic). Deployed as a
// Railway Cron Job service pointing at this repo, with start command
// `node dist/cli/dailyCutoffRun.js` and a frequent schedule (e.g. hourly)
// — idempotent, so running it more often than strictly necessary only
// shrinks the window a forgotten End Work stays open past local midnight,
// never causes any duplicate effect. Also runnable manually via
// `npm run cutoff:run` for local testing or an ad-hoc catch-up sweep.
//
// Usage: npm run cutoff:run

import "dotenv/config";
import { pool } from "../db";
import { runDailyCutoff } from "../lib/dailyCutoff";

async function run() {
  console.log(`[dailyCutoff] run started at ${new Date().toISOString()}`);

  const result = await runDailyCutoff();

  console.log(
    `[dailyCutoff] run complete: found=${result.found} closed=${result.closed} ` +
      `skipped=${result.skipped} failures=${result.failures}`
  );

  await pool.end();
  process.exit(result.failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[dailyCutoff] run crashed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
