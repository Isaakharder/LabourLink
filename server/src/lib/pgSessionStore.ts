import { Store, SessionData } from 'express-session';
import { Pool } from 'pg';

interface PgSessionStoreOptions {
  pool: Pool;
  ttlMs: number;
}

// Server-side sessions in Postgres, not JWT/localStorage. Kept as explicit
// columns (user_id, company_id, expires_at, revoked_at, user_agent) rather
// than an opaque blob so the admin panel can list and revoke sessions.
export class PgSessionStore extends Store {
  private pool: Pool;
  private ttlMs: number;

  constructor(options: PgSessionStoreOptions) {
    super();
    this.pool = options.pool;
    this.ttlMs = options.ttlMs;
  }

  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    this.pool
      .query(
        `SELECT sess FROM sessions
         WHERE sid = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [sid],
      )
      .then(({ rows }) => {
        if (!rows[0]) {
          callback(null, null);
          return;
        }
        callback(null, rows[0].sess as SessionData);
      })
      .catch((err) => callback(err));
  }

  set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    const { userId, companyId, userAgent, ipAddress } = session;
    if (!userId || !companyId) {
      // Anonymous / pre-login session: nothing meaningful to persist yet.
      callback?.();
      return;
    }
    const expiresAt = new Date(Date.now() + this.ttlMs);
    this.pool
      .query(
        `INSERT INTO sessions (sid, user_id, company_id, sess, user_agent, ip_address, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (sid) DO UPDATE SET
           sess         = EXCLUDED.sess,
           expires_at   = EXCLUDED.expires_at,
           last_seen_at = NOW()`,
        [sid, userId, companyId, JSON.stringify(session), userAgent ?? null, ipAddress ?? null, expiresAt],
      )
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.pool
      .query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  touch(sid: string, _session: SessionData, callback?: (err?: unknown) => void): void {
    const expiresAt = new Date(Date.now() + this.ttlMs);
    this.pool
      .query(
        `UPDATE sessions SET expires_at = $2, last_seen_at = NOW()
         WHERE sid = $1 AND revoked_at IS NULL`,
        [sid, expiresAt],
      )
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }
}
