import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { verifyAndTouchMobileSession } from '../lib/mobileSessions';

// Populates req.user (and req.mobileSessionId) from an
// `Authorization: Bearer <tokenId>.<secret>` header, verified against
// the dedicated mobile_sessions table (lib/mobileSessions.ts) — entirely
// separate from express-session and the browser `sessions` table. This
// is deliberately NOT a variant of cookie-based auth: unlike a scheme
// that re-signs a client-supplied value with the server's own secret,
// verification here requires the client to have possessed the original
// random secret (only its one-way hash is stored), so a Postgres
// backup/read leak of this table cannot be replayed as a working token.
//
// Falls through silently on any missing/invalid/expired/revoked token
// so requireAuth's cookie-session path still runs and 401s with one
// consistent error message — this middleware never itself rejects a
// request.
export function mobileAuth(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      next();
      return;
    }
    const presented = authHeader.slice('Bearer '.length).trim();
    if (!presented) {
      next();
      return;
    }
    try {
      const identity = await verifyAndTouchMobileSession(pool, presented);
      if (identity) {
        req.user = {
          id: identity.userId,
          companyId: identity.companyId,
          employeeId: identity.employeeId,
          email: identity.email,
          roleId: identity.roleId,
          roleName: identity.roleName,
        };
        req.mobileSessionId = identity.mobileSessionId;
      }
    } catch (err) {
      console.error('mobileAuth', err);
    }
    next();
  };
}
