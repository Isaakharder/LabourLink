import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { pool } from "../db";

export interface AuthedDevice {
  id: string;
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  // 'English' | 'Spanish' | null (chk_employees_preferred_language,
  // 005_employee_profile_fields.sql) — the employee's own desktop-configured
  // preference, never inferred from nationality or anything else. Threaded
  // through to every /api/mobile/me-shaped response (see mobileTime.ts's
  // serializeStatus) so the mobile Home/Stats UI can pick a language; null
  // means "not set," which the client treats the same as English.
  employeePreferredLanguage: string | null;
}

declare global {
  namespace Express {
    interface Request {
      device?: AuthedDevice;
    }
  }
}

// Every permanent (never-retryable) reason a device can be rejected — the
// client only ever clears its local pairing state when it sees one of these
// exact codes (see web/src/lib/api.ts's PERMANENT_DEVICE_ERROR_CODES). A
// 401 with no code, any 5xx, or a network failure must never wipe pairing;
// see the pairing-persistence audit this middleware was rewritten for.
export type DeviceAuthErrorCode =
  | "INVALID_DEVICE_IDENTIFIER"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_INACTIVE"
  | "DEVICE_UNASSIGNED"
  | "EMPLOYEE_INACTIVE";

const DEVICE_AUTH_ERROR_MESSAGES: Record<DeviceAuthErrorCode, string> = {
  INVALID_DEVICE_IDENTIFIER: "This device is not identified. Please pair again.",
  DEVICE_NOT_FOUND: "This device is not recognized. Please pair again.",
  DEVICE_INACTIVE: "This device has been deactivated.",
  DEVICE_UNASSIGNED: "This device is no longer assigned to an employee.",
  EMPLOYEE_INACTIVE: "This employee account is no longer active.",
};

// Never logs the raw device_identifier (it's a bearer credential, same class
// of secret as the display tokens in displayToken.ts) — only a short,
// non-reversible fingerprint, enough to correlate log lines for the same
// device without exposing anything an attacker could replay.
export function fingerprintDeviceIdentifier(identifier: string): string {
  return crypto.createHash("sha256").update(identifier).digest("hex").slice(0, 12);
}

function rejectDevice(res: Response, code: DeviceAuthErrorCode, fingerprint: string | null): void {
  console.warn(`[device-auth] rejected device=${fingerprint ?? "(none)"} code=${code}`);
  res.status(401).json({ error: DEVICE_AUTH_ERROR_MESSAGES[code], code });
}

// Mobile requests carry no session cookie — the device_identifier itself
// (a persistent random value generated on the phone, never a secret typed
// by a human) is the credential. It's checked against the DB on every
// request rather than cached/trusted, so deactivating a device or ending
// its assignment takes effect immediately: no employee ID the client sends
// is ever trusted, it's always looked up fresh from the active assignment.
//
// Returns a distinct, stable `code` for every permanent rejection reason
// (see DeviceAuthErrorCode) instead of one generic 401 — the whole point is
// that the client can tell "this device/assignment is genuinely gone" apart
// from "the server had a bad moment," which a bare 401 can't express. A
// single left-joined query (rather than three separate lookups) keeps this
// to one round trip while still being able to say exactly which condition
// failed.
export async function requireDevice(req: Request, res: Response, next: NextFunction) {
  // TEMPORARY — End Work ~1min delay investigation. Elapsed-time-only,
  // no secrets. Remove once the slow hop is identified.
  const __t0 = Date.now();
  const deviceIdentifier = req.header("X-Device-Id");
  if (!deviceIdentifier) {
    return rejectDevice(res, "INVALID_DEVICE_IDENTIFIER", null);
  }
  const fingerprint = fingerprintDeviceIdentifier(deviceIdentifier);

  const { rows } = await pool.query(
    `select d.id as device_id, d.is_active as device_active,
            da.employee_id, e.is_active as employee_active,
            e.first_name, e.last_name, e.preferred_language
     from devices d
     left join device_assignments da on da.device_id = d.id and da.unassigned_at is null
     left join employees e on e.id = da.employee_id
     where d.device_identifier = $1`,
    [deviceIdentifier]
  );

  const row = rows[0];
  if (!row) {
    return rejectDevice(res, "DEVICE_NOT_FOUND", fingerprint);
  }
  if (!row.device_active) {
    return rejectDevice(res, "DEVICE_INACTIVE", fingerprint);
  }
  if (!row.employee_id) {
    return rejectDevice(res, "DEVICE_UNASSIGNED", fingerprint);
  }
  if (!row.employee_active) {
    return rejectDevice(res, "EMPLOYEE_INACTIVE", fingerprint);
  }

  pool
    .query("update devices set last_seen = now() where id = $1", [row.device_id])
    .catch((err) => console.error("Failed to update device last_seen:", err.message));

  console.log(`[device-auth] ok device=${fingerprint}`);
  console.log(`[timing] ${req.method} ${req.path} requireDevice: ${Date.now() - __t0}ms`);

  req.device = {
    id: row.device_id,
    employeeId: row.employee_id,
    employeeFirstName: row.first_name,
    employeeLastName: row.last_name,
    employeePreferredLanguage: row.preferred_language,
  };
  next();
}
