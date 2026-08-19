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
            // Real production incident this branch is hardened against:
            // status is NEVER persisted to 'expired' anywhere in this
            // codebase — GET /status below only COMPUTES "expired" for
            // display, it never writes it back. idx_pairing_requests_
            // one_pending_per_device only checks status = 'pending', with
            // no regard for expires_at, so a device whose first attempt
            // ages out unapproved past the 10-minute window is
            // PERMANENTLY stuck on every future attempt: this same
            // conflict fires every time, retrying with a fresh
            // pairing_code can never fix a device_identifier conflict,
            // and 5 identical failures fall through to the 503 below.
            // Confirmed via production data: rows with status='pending'
            // and expires_at days in the past.
            const blocking = await pool.query(
              `select id, pairing_code, expires_at from pairing_requests
               where device_identifier = $1 and status = 'pending'
               order by created_at desc limit 1`,
              [deviceIdentifier]
            );
            const row = blocking.rows[0];
            if (row && new Date(row.expires_at) > new Date()) {
              // Still genuinely live — a real concurrent request for this
              // same device won the race; hand back its request instead
              // of creating a second one.
              return res.json({ requestId: row.id, pairingCode: row.pairing_code, expiresAt: row.expires_at });
            }
            if (row) {
              // Blocking row is only still 'pending' because nothing ever
              // flipped it — it's actually time-expired. Mark it expired
              // now so this (and any future) attempt for this device can
              // proceed, then retry the insert.
              await pool.query(`update pairing_requests set status = 'expired' where id = $1`, [row.id]);
            }
          }
          continue; // pairing_code collision (or the blocking row just got expired above) — retry with a new code
        }
        throw err;
      }
    }
    console.error(`[pairing] exhausted 5 attempts generating a pairing code for device=${deviceIdentifier}`);
    res.status(503).json({ error: "Could not generate a pairing code, try again", code: "PAIRING_CODE_GENERATION_EXHAUSTED" });
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
