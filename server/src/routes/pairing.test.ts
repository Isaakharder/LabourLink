// Real production incident: every newly updated phone failed pairing with
// a 503 "Could not generate a pairing code, try again." Root cause: status
// is never persisted to 'expired' anywhere in this codebase (GET /status
// only COMPUTES it for display) — a device whose first pairing attempt
// ages past the 10-minute expires_at window without being approved is
// PERMANENTLY stuck on every future attempt, since the still-'pending'
// row keeps colliding with idx_pairing_requests_one_pending_per_device and
// a fresh random pairing_code can never resolve a device_identifier
// conflict. Confirmed against real production data (rows with
// status='pending' days past expires_at) before this fix, not guessed at.
//
// Run with: npm run test:pairing
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { pool } from "../db";
import pairingRouter from "./pairing";

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

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/pairing", pairingRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  const pairingRequestIds: string[] = [];

  try {
    // -----------------------------------------------------------------
    // The exact stuck scenario: a device's first pairing attempt aged
    // past expires_at without ever being approved — status is still the
    // literal string 'pending' in the row (nothing ever flips it).
    // -----------------------------------------------------------------
    const stuckDeviceId = `qa-pairing-stuck-${RUN_ID}`;
    const stuckRow = await pool.query(
      `insert into pairing_requests (pairing_code, device_identifier, created_at, expires_at)
       values ($1, $2, now() - interval '1 hour', now() - interval '50 minutes')
       returning id`,
      ["483920", stuckDeviceId]
    );
    pairingRequestIds.push(stuckRow.rows[0].id);

    const res1 = await fetch(`${BASE}/api/pairing/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceIdentifier: stuckDeviceId }),
    });
    const body1 = (await res1.json()) as any;
    check(res1.status === 200, "1) a device stuck behind its own time-expired-but-status-pending row can pair again", {
      status: res1.status,
      body: body1,
    });
    check(!!body1.pairingCode && body1.pairingCode !== "483920", "2) a genuinely new pairing code was issued, not the stale one", body1);
    if (body1.requestId) pairingRequestIds.push(body1.requestId);

    const oldRowNow = await pool.query(`select status from pairing_requests where id = $1`, [stuckRow.rows[0].id]);
    check(oldRowNow.rows[0]?.status === "expired", "3) the old stuck row was actually marked expired in the database, not just worked around", oldRowNow.rows[0]);

    // -----------------------------------------------------------------
    // A genuinely still-live pending request for the SAME device must
    // still be handed back as-is (idempotent reopen/retry), never
    // silently replaced with a second one.
    // -----------------------------------------------------------------
    const liveDeviceId = `qa-pairing-live-${RUN_ID}`;
    const res2 = await fetch(`${BASE}/api/pairing/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceIdentifier: liveDeviceId }),
    });
    const body2 = (await res2.json()) as any;
    pairingRequestIds.push(body2.requestId);
    const res3 = await fetch(`${BASE}/api/pairing/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceIdentifier: liveDeviceId }),
    });
    const body3 = (await res3.json()) as any;
    check(res3.status === 200 && body3.requestId === body2.requestId, "4) reopening pairing for a device with a genuinely live request reuses it, not a new one", {
      body2,
      body3,
    });

    // -----------------------------------------------------------------
    // A device with no history at all still pairs normally (the ordinary
    // path is unaffected by this fix).
    // -----------------------------------------------------------------
    const freshDeviceId = `qa-pairing-fresh-${RUN_ID}`;
    const res4 = await fetch(`${BASE}/api/pairing/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceIdentifier: freshDeviceId }),
    });
    const body4 = (await res4.json()) as any;
    pairingRequestIds.push(body4.requestId);
    check(res4.status === 200 && !!body4.pairingCode, "5) a brand-new device pairs normally", { status: res4.status, body: body4 });
  } finally {
    if (pairingRequestIds.length) {
      await pool.query(`delete from pairing_requests where id = any($1::uuid[])`, [pairingRequestIds]);
    }
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
