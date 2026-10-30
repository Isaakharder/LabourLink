import crypto from "crypto";
import { Pool, PoolClient } from "pg";
import { AuthEmployee } from "../types/express";

// Desktop web sign-in lifetime. A sign-in is a web_sessions row (migration
// 066) plus two cookies:
//   - labourlink_session: the short-lived access JWT requireAuth checks on
//     every request without touching the database (ACCESS_TOKEN_TTL_SECONDS).
//   - labourlink_refresh: a random token, httpOnly and scoped to /api, that
//     requireAuth trades for a new access JWT once the old one has expired.
//     Every renewal re-reads the employee, so a deactivated employee, a PIN
//     reset or a sign-out ends the sign-in within one access-token lifetime.
// The refresh token is deliberately not rotated on each renewal: several tabs
// share the one cookie, and a renewal response lost to a dropped connection
// (the overnight case this exists for) would otherwise leave the browser
// holding a token the server had already replaced — signing the user out,
// the exact failure being fixed. It never leaves the httpOnly cookie, only
// its sha256 digest is stored, and the row can be revoked at any time.
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const SESSION_IDLE_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

// Every expiry decision in this file and in middleware/auth.ts reads time
// from here, so tests can advance it across days instead of waiting.
export const sessionClock = {
  now: (): number => Date.now(),
};

export type SessionRevokedReason = "signed_out" | "expired" | "employee_inactive" | "employee_deactivated" | "pin_reset";

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

type Db = Pool | PoolClient;

export interface CreatedWebSession {
  sessionId: string;
  refreshToken: string;
  // Remaining lifetime for the refresh cookie's maxAge.
  refreshCookieMaxAgeMs: number;
}

export async function createWebSession(db: Db, employeeId: string): Promise<CreatedWebSession> {
  const now = sessionClock.now();
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  const idleExpiresAt = new Date(now + SESSION_IDLE_TIMEOUT_MS);
  const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_LIFETIME_MS);
  const { rows } = await db.query(
    `insert into web_sessions
       (employee_id, refresh_token_hash, created_at, last_refreshed_at, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, $3, $4, $5)
     returning id`,
    [employeeId, hashRefreshToken(refreshToken), new Date(now), idleExpiresAt, absoluteExpiresAt]
  );
  // Housekeeping: this employee's long-dead rows (no table-wide sweep job).
  await db.query(
    `delete from web_sessions
     where employee_id = $1
       and coalesce(revoked_at, absolute_expires_at) < $2`,
    [employeeId, new Date(now - SESSION_ABSOLUTE_LIFETIME_MS)]
  );
  return { sessionId: rows[0].id, refreshToken, refreshCookieMaxAgeMs: SESSION_IDLE_TIMEOUT_MS };
}

export interface RenewedWebSession {
  sessionId: string;
  employee: AuthEmployee;
  refreshCookieMaxAgeMs: number;
}

// The renewal step behind requireAuth. Returns null whenever the refresh
// token can no longer sign anyone in — unknown, revoked, expired, or its
// employee is inactive / has no PIN — revoking the row in the last two cases
// so it can never come back. Throws only on a database failure, which the
// caller must report as "try again", never as "signed out".
export async function renewWebSession(db: Db, refreshToken: string): Promise<RenewedWebSession | null> {
  const now = sessionClock.now();
  const { rows } = await db.query(
    `select s.id, s.revoked_at, s.idle_expires_at, s.absolute_expires_at,
            e.id as employee_id, e.first_name, e.last_name, e.is_active, e.settings_pin_hash is not null as has_pin,
            sr.name as security_role, tr.name as team_role
     from web_sessions s
     join employees e on e.id = s.employee_id
     join security_roles sr on sr.id = e.security_role_id
     join team_roles tr on tr.id = e.team_role_id
     where s.refresh_token_hash = $1`,
    [hashRefreshToken(refreshToken)]
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;

  if (now >= new Date(row.idle_expires_at).getTime() || now >= new Date(row.absolute_expires_at).getTime()) {
    await revokeWebSession(db, row.id, "expired");
    return null;
  }
  if (!row.is_active || !row.has_pin) {
    await revokeWebSession(db, row.id, "employee_inactive");
    return null;
  }

  const absoluteMs = new Date(row.absolute_expires_at).getTime();
  const idleExpiresMs = Math.min(now + SESSION_IDLE_TIMEOUT_MS, absoluteMs);
  await db.query(
    `update web_sessions set last_refreshed_at = $2, idle_expires_at = $3 where id = $1`,
    [row.id, new Date(now), new Date(idleExpiresMs)]
  );

  return {
    sessionId: row.id,
    employee: {
      id: row.employee_id,
      firstName: row.first_name,
      lastName: row.last_name,
      securityRole: row.security_role,
      teamRole: row.team_role,
    },
    refreshCookieMaxAgeMs: idleExpiresMs - now,
  };
}

export async function revokeWebSession(db: Db, sessionId: string, reason: SessionRevokedReason): Promise<void> {
  await db.query(
    `update web_sessions set revoked_at = $2, revoked_reason = $3 where id = $1 and revoked_at is null`,
    [sessionId, new Date(sessionClock.now()), reason]
  );
}

export async function revokeWebSessionByToken(db: Db, refreshToken: string, reason: SessionRevokedReason): Promise<void> {
  await db.query(
    `update web_sessions set revoked_at = $2, revoked_reason = $3
     where refresh_token_hash = $1 and revoked_at is null`,
    [hashRefreshToken(refreshToken), new Date(sessionClock.now()), reason]
  );
}

export async function revokeEmployeeWebSessions(db: Db, employeeId: string, reason: SessionRevokedReason): Promise<void> {
  await db.query(
    `update web_sessions set revoked_at = $2, revoked_reason = $3
     where employee_id = $1 and revoked_at is null`,
    [employeeId, new Date(sessionClock.now()), reason]
  );
}
