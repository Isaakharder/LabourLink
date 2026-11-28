// The auto-breaks worker: runs runAutoBreakTick (scheduledBreaks.ts) inside
// the API server every AUTO_BREAKS_INTERVAL_MS, so automatic breaks and
// "work resumes at the scheduled end" never depend on someone opening a
// phone or the Inputs page.
//
// Timing: a window's occurrence is written within one interval of its start;
// an Auto break is added on the first tick at least one minute after its
// window ends AND once the employee's own activity after the window is known
// (their covering work ended, or a later phone event synced). Work resumes
// within one interval of a scheduled break's end.
//
// Reliability:
//   - Only one server process runs a tick at a time: a session advisory
//     lock, so two instances overlapping during a Railway deploy never
//     duplicate work (every write is also idempotent and per-employee
//     locked, so even a duplicate tick would add nothing).
//   - A failing employee or occurrence is logged and retried on the next
//     tick; one failure never stops the rest.
//   - After an outage, the first tick recovers everything from today and
//     yesterday (local). Pending occurrences older than that expire without
//     being added — no automatic break is ever created more than about a
//     day late.
//
// Disable with AUTO_BREAKS_WORKER=off (e.g. a one-off script process).
// `npm run auto-breaks:run` runs a single tick by hand.
import { pool } from "../db";
import { runAutoBreakTick } from "./scheduledBreaks";

export const AUTO_BREAKS_INTERVAL_MS = 60 * 1000;
// Arbitrary constant key for pg_try_advisory_lock (session level).
const WORKER_LOCK_KEY = 790_079_001;

let running = false;

export async function runAutoBreakTickOnce(): Promise<void> {
  if (running) return;
  running = true;
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query(`select pg_try_advisory_lock($1) as ok`, [WORKER_LOCK_KEY]);
    locked = rows[0]?.ok === true;
    if (!locked) return; // another instance is mid-tick
    const result = await runAutoBreakTick();
    if (result.added || result.resumed || result.failures || result.expired) {
      console.log(`[auto-breaks] ${JSON.stringify(result)}`);
    }
  } catch (err) {
    console.error("[auto-breaks] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    if (locked) await client.query(`select pg_advisory_unlock($1)`, [WORKER_LOCK_KEY]).catch(() => {});
    client.release();
    running = false;
  }
}

export function startAutoBreakWorker(): NodeJS.Timeout | null {
  if (process.env.AUTO_BREAKS_WORKER === "off") return null;
  const timer = setInterval(() => void runAutoBreakTickOnce(), AUTO_BREAKS_INTERVAL_MS);
  timer.unref();
  return timer;
}
