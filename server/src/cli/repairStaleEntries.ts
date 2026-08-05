// One-time repair utility for open time entries that predate the
// daily-cutoff safety net (see server/src/lib/dailyCutoff.ts) — e.g. an
// entry that was accidentally left clocked in across several days before
// this feature existed. Runs the exact same lock-and-recheck logic a real
// cutoff run would, so the reported "would close" details can never drift
// from what actually applying it would do.
//
// Defaults to a dry run — reports every stale entry (id, employee,
// started-at, proposed cutoff, calculated duration) without changing
// anything. Pass --apply to actually perform the repair.
//
// Usage:
//   npm run cutoff:repair              (report only, no changes)
//   npm run cutoff:repair -- --apply   (actually close the stale entries)

import "dotenv/config";
import { pool } from "../db";
import { runDailyCutoff } from "../lib/dailyCutoff";

async function run() {
  const apply = process.argv.includes("--apply");
  const result = await runDailyCutoff({ dryRun: !apply });

  if (result.details.length === 0) {
    console.log(apply ? "No stale entries needed repair." : "No stale entries found — nothing to repair.");
  } else {
    console.log(
      `${apply ? "Repaired" : "Would repair"} ${result.details.length} stale ` +
        `entr${result.details.length === 1 ? "y" : "ies"}:\n`
    );
    for (const d of result.details) {
      const durationHours = (d.durationSeconds / 3600).toFixed(2);
      console.log(
        `  entry ${d.id} (${d.entryType})\n` +
          `    employee:        ${d.employeeName} (${d.employeeId})\n` +
          `    started:         ${d.startedAtIso}\n` +
          `    proposed cutoff: ${d.cutoffAtIso}\n` +
          `    duration:        ${d.durationSeconds}s (~${durationHours}h)\n`
      );
    }
  }

  if (!apply && result.details.length > 0) {
    console.log("Dry run only — nothing was changed. Re-run with --apply to actually close these entries.");
  }
  if (apply) {
    console.log(`Applied: closed=${result.closed} skipped=${result.skipped} failures=${result.failures}`);
  }

  await pool.end();
  process.exit(result.failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[repairStaleEntries] crashed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
