// One auto-breaks tick by hand (lib/autoBreakWorker.ts runs it every minute
// inside the API server). Safe to run while the server is running: the
// worker lock means only one tick runs at a time, and every write is
// idempotent. For local testing or an ad-hoc catch-up after an outage.
//
// Usage: npm run auto-breaks:run
import "dotenv/config";
import { pool } from "../db";
import { runAutoBreakTickOnce } from "../lib/autoBreakWorker";

runAutoBreakTickOnce()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error("[auto-breaks] run crashed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
