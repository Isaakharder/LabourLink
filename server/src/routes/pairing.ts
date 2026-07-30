import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

function generatePairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// A phone with no credential yet calls this to start pairing. Public by
// necessity — there's nothing to authenticate before pairing exists.
router.post(
  "/request",
  asyncHandler(async (req, res) => {
    const { deviceIdentifier } = req.body as { deviceIdentifier?: string };
    if (!deviceIdentifier) {
      return res.status(400).json({ error: "deviceIdentifier is required" });
    }

    // Reopening the pairing screen (app restart, retry) should hand back the
    // same still-live request instead of piling up duplicates.
    const existing = await pool.query(
      `select id, pairing_code, expires_at from pairing_requests
       where device_identifier = $1 and status = 'pending' and expires_at > now()
       order by created_at desc limit 1`,
      [deviceIdentifier]
    );
    if (existing.rows[0]) {
      const r = existing.rows[0];
      return res.json({ requestId: r.id, pairingCode: r.pairing_code, expiresAt: r.expires_at });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        const { rows } = await pool.query(
          `insert into pairing_requests (pairing_code, device_identifier)
           values ($1, $2)
           returning id, pairing_code, expires_at`,
          [code, deviceIdentifier]
        );
        return res.json({
          requestId: rows[0].id,
          pairingCode: rows[0].pairing_code,
          expiresAt: rows[0].expires_at,
        });
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === "23505") {
          if (pgErr.constraint === "idx_pairing_requests_one_pending_per_device") {
            // Lost a race against a concurrent request for this same device
            // (e.g. an effect that mounted twice) — report whichever
            // request actually won instead of creating a second one.
            const winner = await pool.query(
              `select id, pairing_code, expires_at from pairing_requests
               where device_identifier = $1 and status = 'pending' and expires_at > now()
               limit 1`,
              [deviceIdentifier]
            );
            if (winner.rows[0]) {
              const r = winner.rows[0];
              return res.json({ requestId: r.id, pairingCode: r.pairing_code, expiresAt: r.expires_at });
            }
          }
          continue; // pairing_code collision — retry with a new code
        }
        throw err;
      }
    }
    res.status(503).json({ error: "Could not generate a pairing code, try again" });
  })
);

// Polled by the phone while waiting. Reports the latest request for this
// device rather than a specific requestId so the phone doesn't need to
// remember one across an app restart.
router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const deviceIdentifier = req.query.deviceIdentifier as string | undefined;
    if (!deviceIdentifier) {
      return res.status(400).json({ error: "deviceIdentifier is required" });
    }

    const { rows } = await pool.query(
      `select status, expires_at from pairing_requests
       where device_identifier = $1
       order by created_at desc limit 1`,
      [deviceIdentifier]
    );

    const row = rows[0];
    let status: string = row?.status ?? "none";
    if (status === "pending" && new Date(row.expires_at) < new Date()) {
      status = "expired";
    }
    res.json({ status });
  })
);

export default router;
