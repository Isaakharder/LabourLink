import { Router, Request, Response } from 'express';
import { db } from '../db';
import { verifyPassword } from '../lib/password';
import { requireAuth } from '../middleware/auth';

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

authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
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
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    if (account.lockedUntil && new Date(account.lockedUntil) > new Date()) {
      res.status(401).json({ error: 'Account is temporarily locked. Try again later.' });
      return;
    }
    if (!account.isActive) {
      res.status(401).json({ error: 'Account is inactive' });
      return;
    }

    await db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
       WHERE id = $1`,
      [account.id],
    );

    // Regenerate the session id on login to prevent session fixation.
    req.session.regenerate((err) => {
      if (err) {
        console.error('POST /api/auth/login (regenerate)', err);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      req.session.userId = account!.id;
      req.session.companyId = account!.companyId;
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
