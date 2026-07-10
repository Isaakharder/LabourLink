import crypto from 'crypto';
import { Pool } from 'pg';

const TOKEN_ID_BYTES = 16; // 128-bit public lookup key, stored in plaintext
const TOKEN_SECRET_BYTES = 32; // 256-bit bearer secret — never stored, only its hash
const MOBILE_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h rolling, matches browser sessions

export interface MobileSessionIdentity {
  mobileSessionId: number;
  userId: number;
  companyId: number;
  employeeId: number | null;
  email: string;
  roleId: number;
  roleName: string;
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function parseBearerToken(raw: string): { tokenId: string; secret: string } | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { tokenId: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

export interface CreateMobileSessionInput {
  userId: number;
  companyId: number;
  deviceId?: string | null;
  deviceName?: string | null;
  appVersion?: string | null;
}

// Generates a fresh bearer token and stores only its hash. The full
// token (token_id + secret) is returned exactly once — the caller
// (the mobile-login route) is the only place the raw secret ever
// exists outside the client device.
export async function createMobileSession(
  pool: Pool,
  input: CreateMobileSessionInput,
): Promise<{ token: string; expiresAt: Date }> {
  const tokenId = crypto.randomBytes(TOKEN_ID_BYTES).toString('base64url');
  const secret = crypto.randomBytes(TOKEN_SECRET_BYTES).toString('base64url');
  const tokenHash = hashSecret(secret);
  const expiresAt = new Date(Date.now() + MOBILE_SESSION_TTL_MS);

  await pool.query(
    `INSERT INTO mobile_sessions
       (token_id, token_hash, user_id, company_id, device_id, device_name, app_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tokenId,
      tokenHash,
      input.userId,
      input.companyId,
      input.deviceId ?? null,
      input.deviceName ?? null,
      input.appVersion ?? null,
      expiresAt,
    ],
  );

  return { token: `${tokenId}.${secret}`, expiresAt };
}

// Verifies a presented bearer token and, on success, rolls its expiry
// forward (same rolling-TTL policy as browser sessions). Returns null
// for every failure case (malformed, unknown, wrong secret, revoked,
// expired, inactive user) — callers must treat all of these
// identically and fall through to a generic 401, never revealing which
// specific check failed.
export async function verifyAndTouchMobileSession(
  pool: Pool,
  rawToken: string,
): Promise<MobileSessionIdentity | null> {
  const parsed = parseBearerToken(rawToken);
  if (!parsed) return null;

  const { rows } = await pool.query(
    `SELECT ms.id, ms.token_hash, ms.revoked_at, ms.expires_at,
            u.id AS "userId", u.company_id AS "companyId", u.employee_id AS "employeeId",
            u.email, u.is_active AS "isActive",
            r.id AS "roleId", r.name AS "roleName"
     FROM mobile_sessions ms
     JOIN users u ON u.id = ms.user_id
     JOIN security_roles r ON r.id = u.role_id
     WHERE ms.token_id = $1`,
    [parsed.tokenId],
  );
  const row = rows[0];
  if (!row) return null;

  const presentedHash = Buffer.from(hashSecret(parsed.secret), 'hex');
  const storedHash = Buffer.from(row.token_hash as string, 'hex');
  if (presentedHash.length !== storedHash.length || !crypto.timingSafeEqual(presentedHash, storedHash)) {
    return null;
  }
  if (row.revoked_at) return null;
  if (new Date(row.expires_at as string) <= new Date()) return null;
  if (!row.isActive) return null;

  const newExpiresAt = new Date(Date.now() + MOBILE_SESSION_TTL_MS);
  await pool.query('UPDATE mobile_sessions SET last_used_at = NOW(), expires_at = $2 WHERE id = $1', [
    row.id,
    newExpiresAt,
  ]);

  return {
    mobileSessionId: row.id,
    userId: row.userId,
    companyId: row.companyId,
    employeeId: row.employeeId,
    email: row.email,
    roleId: row.roleId,
    roleName: row.roleName,
  };
}

export async function revokeMobileSessionById(pool: Pool, id: number): Promise<void> {
  await pool.query('UPDATE mobile_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [id]);
}

export async function revokeAllMobileSessionsForUser(pool: Pool, userId: number): Promise<void> {
  await pool.query('UPDATE mobile_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
}
