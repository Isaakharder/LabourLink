import { NextFunction, Request, Response } from "express";
import { pool } from "../db";
import { hashIntegrationToken } from "../lib/integrationToken";

export interface AuthedIntegrationToken {
  id: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      integrationToken?: AuthedIntegrationToken;
    }
  }
}

const BEARER_PREFIX = "Bearer ";

// Machine-to-machine credential for a read-only external integration (see
// integration_tokens, 054_integration_tokens.sql) — deliberately NOT
// requireAuth's session cookie (a human login, 12h expiry, meant for a
// browser) and NOT a display token (embedded in a URL, meant for a
// bookmarked kiosk page). Sent as a standard Authorization: Bearer header
// so it never appears in a URL, a server access log, or browser history.
//
// The raw token is never logged anywhere in this function, on success or
// failure — only its sha256 hash (already computed for the DB lookup) is
// used, and only a short prefix of THAT ever reaches a log line, the same
// convention device.ts's fingerprintDeviceIdentifier uses for X-Device-Id.
// A bad/missing token always gets the same generic 401 body regardless of
// which check failed, so a prober can't distinguish "no such token" from
// "token exists but deactivated" from the response alone.
export async function requireIntegrationToken(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : null;
  if (!token) {
    console.warn("[integration-auth] rejected: missing or malformed Authorization header");
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const tokenHash = hashIntegrationToken(token);
  const { rows } = await pool.query(`select id, name from integration_tokens where token_hash = $1 and is_active = true`, [
    tokenHash,
  ]);

  const row = rows[0];
  if (!row) {
    console.warn(`[integration-auth] rejected: unknown or inactive token (hash ${tokenHash.slice(0, 12)}...)`);
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  // Best-effort audit trail (lets an admin notice a token that's stopped
  // being used, or confirm a new one is actually reaching the server) —
  // never blocks the request on failure.
  pool.query(`update integration_tokens set last_used_at = now() where id = $1`, [row.id]).catch((err) => {
    console.error("[integration-auth] failed to record last_used_at:", err);
  });

  req.integrationToken = { id: row.id, name: row.name };
  next();
}
