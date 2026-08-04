import { NextFunction, Request, Response } from "express";
import { pool } from "../db";
import { hashDisplayKey } from "../lib/displayToken";

export interface AuthedDisplay {
  id: string;
  landId: string;
  activityId: string | null;
  dateStart: string;
  dateEnd: string;
  name: string;
  updatedAt: string;
}

declare global {
  namespace Express {
    interface Request {
      display?: AuthedDisplay;
    }
  }
}

// A display token is a bare capability secret embedded in a URL, not a
// distinguishable "you're logged out" state the way a session cookie or
// X-Device-Id header is — so unlike requireAuth/requireDevice (401), a
// wrong or deactivated token here always 404s. Giving a prober the same
// response for "no such token" and "token exists but is deactivated" leaks
// nothing about whether the route/resource exists at all, the standard
// treatment for capability-URL schemes.
export async function requireDisplayKey(req: Request, res: Response, next: NextFunction) {
  const { displayKey } = req.params;
  if (!displayKey) {
    return res.status(404).json({ error: "Not found" });
  }

  const tokenHash = hashDisplayKey(displayKey);
  const { rows } = await pool.query(
    // date_start/date_end are `date` columns — node-postgres parses those
    // into JS Date objects by default, not the YYYY-MM-DD strings every
    // date-range helper in this app expects (see scheduled_break_date's
    // identical to_char cast in mobileTime.ts/breakReconciliation.ts).
    `select id, land_id, activity_id, to_char(date_start, 'YYYY-MM-DD') as date_start,
            to_char(date_end, 'YYYY-MM-DD') as date_end, name, updated_at
     from greenhouse_displays
     where display_key_hash = $1 and is_active = true`,
    [tokenHash]
  );

  const row = rows[0];
  if (!row) {
    return res.status(404).json({ error: "Not found" });
  }

  req.display = {
    id: row.id,
    landId: row.land_id,
    activityId: row.activity_id,
    dateStart: row.date_start,
    dateEnd: row.date_end,
    name: row.name,
    updatedAt: row.updated_at,
  };
  next();
}
