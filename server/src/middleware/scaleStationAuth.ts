import { NextFunction, Request, Response } from "express";
import { pool } from "../db";
import { hashIntegrationToken } from "../lib/integrationToken";

export interface AuthedScaleStation {
  id: string;
  name: string;
  creditsEnabled: boolean;
}

declare global {
  namespace Express {
    interface Request {
      scaleStation?: AuthedScaleStation;
    }
  }
}

const BEARER_PREFIX = "Bearer ";

// A weighing station (scale_stations, 070_scale_weighings.sql) sends its own
// token as `Authorization: Bearer <token>`. Same scheme and logging rules as
// requireIntegrationToken: only the sha256 hash is looked up, the raw token
// is never logged, and every failure gets the same generic 401 so a prober
// can't tell an unknown token from a deactivated station.
export async function requireScaleStation(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : null;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid station token" });
  }

  const tokenHash = hashIntegrationToken(token);
  let row: { id: string; name: string; credits_enabled: boolean } | undefined;
  try {
    const { rows } = await pool.query(
      `select id, name, credits_enabled from scale_stations where token_hash = $1 and is_active = true`,
      [tokenHash]
    );
    row = rows[0];
  } catch (err) {
    return next(err);
  }
  if (!row) {
    console.warn(`[scale-auth] rejected: unknown or inactive station token (hash ${tokenHash.slice(0, 12)}...)`);
    return res.status(401).json({ error: "Missing or invalid station token" });
  }

  pool.query(`update scale_stations set last_seen_at = now() where id = $1`, [row.id]).catch((err) => {
    console.error("[scale-auth] failed to record last_seen_at:", err);
  });

  req.scaleStation = { id: row.id, name: row.name, creditsEnabled: row.credits_enabled };
  next();
}
