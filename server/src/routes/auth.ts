import { Router, Request, Response } from 'express';
import { db } from '../db';
import { verifyPassword } from '../lib/password';
import { requireAuth } from '../middleware/auth';
import { createMobileSession, revokeMobileSessionById } from '../lib/mobileSessions';

export const authRouter = Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

interface UserCandidate {
  id: number;
  companyId: number;
  passwordHash: string;
  isActive: boolean;
  lockedUntil: string | null;
}

async function recordFailedAttempt(userId: number): Promise<void> {
  const { rows } = await db.query(
    `UPDATE users SET failed_login_attempts = failed_login_attempts + 1
     WHERE id = $1 RETURNING failed_login_attempts`,
    [userId],
  );
  if (rows[0]?.failed_login_attempts >= MAX_FAILED_ATTEMPTS) {
    await db.query(
      `UPDATE users SET locked_until = NOW() + ($2 || ' minutes')::interval WHERE id = $1`,
      [userId, LOCKOUT_MINUTES],
    );
  }
}

type CredentialCheckResult =
  | { ok: true; account: UserCandidate }
  | { ok: false; status: number; error: string };

// Shared by both /login (browser cookie session) and /mobile-login (mobile
// bearer session) so there is exactly one place that enforces password
// verification and account lockout — not a second, divergent auth
// implementation for mobile.
async function checkCredentials(email: string, password: string): Promise<CredentialCheckResult> {
  const { rows } = await db.query<UserCandidate>(
    `SELECT id, company_id AS "companyId", password_hash AS "passwordHash",
            is_active AS "isActive", locked_until AS "lockedUntil"
     FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );

  let account: UserCandidate | undefined;
  for (const candidate of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await verifyPassword(password, candidate.passwordHash)) {
      account = candidate;
      break;
    }
  }

  if (!account) {
    if (rows.length === 1) await recordFailedAttempt(rows[0].id);
    return { ok: false, status: 401, error: 'Invalid email or password' };
  }

  if (account.lockedUntil && new Date(account.lockedUntil) > new Date()) {
    return { ok: false, status: 401, error: 'Account is temporarily locked. Try again later.' };
  }
  if (!account.isActive) {
    return { ok: false, status: 401, error: 'Account is inactive' };
  }

  await db.query(
    `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
     WHERE id = $1`,
    [account.id],
  );

  return { ok: true, account };
}

authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    const result = await checkCredentials(email, password);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const { account } = result;

    // Regenerate the session id on login to prevent session fixation.
    req.session.regenerate((err) => {
      if (err) {
        console.error('POST /api/auth/login (regenerate)', err);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      req.session.userId = account.id;
      req.session.companyId = account.companyId;
      req.session.userAgent = req.get('user-agent') ?? undefined;
      req.session.ipAddress = req.ip;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('POST /api/auth/login (save)', saveErr);
          res.status(500).json({ error: 'Internal server error' });
          return;
        }
        res.json({ ok: true });
      });
    });
  } catch (err) {
    console.error('POST /api/auth/login', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dedicated mobile-client login — issues a mobile_sessions bearer token,
// completely separate from the browser cookie session above (no
// Set-Cookie, no express-session involvement at all). See
// lib/mobileSessions.ts for why this is not just the express-session id.
authRouter.post('/mobile-login', async (req: Request, res: Response) => {
  const { email, password, deviceId, deviceName, appVersion } = req.body as {
    email?: string;
    password?: string;
    deviceId?: string;
    deviceName?: string;
    appVersion?: string;
  };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    const result = await checkCredentials(email, password);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const { token, expiresAt } = await createMobileSession(db, {
      userId: result.account.id,
      companyId: result.account.companyId,
      deviceId: deviceId?.trim() || null,
      deviceName: deviceName?.trim() || null,
      appVersion: appVersion?.trim() || null,
    });
    res.json({ ok: true, token, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error('POST /api/auth/mobile-login', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/logout', requireAuth, (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('POST /api/auth/logout', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.clearCookie('labourlink.sid');
    res.json({ ok: true });
  });
});

// Mobile-only: revokes exactly the mobile_sessions row backing the
// presented bearer token. Does not touch any browser cookie session — a
// mobile client must call this, not /logout, to end its own session.
authRouter.post('/mobile-logout', requireAuth, async (req: Request, res: Response) => {
  if (!req.mobileSessionId) {
    res.status(400).json({ error: 'Not authenticated via a mobile session' });
    return;
  }
  try {
    await revokeMobileSessionById(db, req.mobileSessionId);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/auth/mobile-logout', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1
       ORDER BY p.code`,
      [req.user!.roleId],
    );
    res.json({
      id: req.user!.id,
      email: req.user!.email,
      companyId: req.user!.companyId,
      employeeId: req.user!.employeeId,
      role: req.user!.roleName,
      permissions: rows.map((r) => r.code as string),
    });
  } catch (err) {
    console.error('GET /api/auth/me', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
