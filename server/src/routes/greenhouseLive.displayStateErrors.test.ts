// Regression test for the 2026-10-10 production API outage: the TV endpoint
// GET /api/greenhouse/display/:key/state used the async requireDisplayKey
// middleware without asyncHandler, so when its lookup query failed (PR #6
// deployed before migration 063 added greenhouse_displays.map_phase_ids)
// every TV poll became an unhandled promise rejection that crashed the whole
// API process. A failing lookup must answer that request with a 500 and
// leave the server running.
//
// Simulates the missing column by renaming it for the duration of the test
// (throwaway test database only), then restores it.
//
// Run with: npm run test:greenhouse-display-state-errors
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { hashDisplayKey } from "../lib/displayToken";
import greenhouseLiveRouter from "./greenhouseLive";

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
const RENAMED = `map_phase_ids_qa_${RUN_ID}`;

async function main() {
  // Without the fix the rejection escapes to here and Node exits non-zero.
  process.on("unhandledRejection", (err) => {
    console.error("FAIL: unhandled rejection — this is the crash that took production down:", err);
    process.exit(2);
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/greenhouse", greenhouseLiveRouter);
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const res = await fetch(`${BASE}${path}`);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  let landId: string | undefined;
  let displayId: string | undefined;
  let renamed = false;
  try {
    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [`QA State Errors ${RUN_ID}`])).rows[0].id;
    const token = randomUUID();
    displayId = (
      await pool.query(
        `insert into greenhouse_displays (name, display_key_hash, land_id, date_start, date_end) values ($1, $2, $3, current_date, current_date) returning id`,
        [`QA State Errors ${RUN_ID}`, hashDisplayKey(token), landId]
      )
    ).rows[0].id;

    const ok = await get(`/api/greenhouse/display/${token}/state`);
    check(ok.status === 200, "baseline: the TV state endpoint works", ok);

    // The production condition: the lookup query references a missing column.
    await pool.query(`alter table greenhouse_displays rename column map_phase_ids to ${RENAMED}`);
    renamed = true;
    for (const key of [token, "not-a-real-key"]) {
      const r = await get(`/api/greenhouse/display/${key}/state`);
      check(r.status === 500 && r.body?.error === "Internal server error", `a failing display lookup answers 500 (${key === token ? "real" : "bogus"} key)`, r);
    }
    const slides = await get(`/api/greenhouse/display/${token}/slides`);
    check(slides.status === 500, "the slides endpoint (already wrapped) also answers 500", slides.status);
    const health = await get("/api/health");
    check(health.status === 200, "the server is still running after the failures", health);
  } finally {
    if (renamed) await pool.query(`alter table greenhouse_displays rename column ${RENAMED} to map_phase_ids`).catch((e) => console.error("restore failed", e));
    server.close();
    if (displayId) await pool.query(`delete from greenhouse_displays where id = $1`, [displayId]);
    if (landId) await pool.query(`delete from greenhouse_lands where id = $1`, [landId]);
    const col = await pool.query(`select 1 from information_schema.columns where table_name = 'greenhouse_displays' and column_name = 'map_phase_ids'`);
    check(col.rows.length === 1, "column restored");
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
