import { Router, Request, Response } from 'express';
import { db } from '../db';
import { hashPassword, validatePasswordStrength } from '../lib/password';
import { requireAuth, requirePermission } from '../middleware/auth';
import { employeeBelongsToCompany } from '../lib/companyScope';

export const usersRouter = Router();

usersRouter.use(requireAuth);

// ── List ──────────────────────────────────────────────────────────────────────

usersRouter.get('/', requirePermission('users:manage'), async (req: Request, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.is_active AS "isActive",
              u.last_login_at AS "lastLoginAt", u.failed_login_attempts AS "failedLoginAttempts",
              u.locked_until AS "lockedUntil", u.created_at AS "createdAt",
              u.employee_id AS "employeeId",
              (e.first_name || ' ' || e.last_name) AS "employeeName",
              r.id AS "roleId", r.name AS "roleName"
       FROM users u
       JOIN security_roles r ON r.id = u.role_id
       LEFT JOIN employees e ON e.id = u.employee_id
       WHERE u.company_id = $1
       ORDER BY u.email`,
      [req.user!.companyId],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/users', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

usersRouter.post('/', requirePermission('users:manage'), async (req: Request, res: Response) => {
  const { email, password, roleId, employeeId } = req.body as {
    email?: string; password?: string; roleId?: number; employeeId?: number | null;
  };

  if (!email?.trim()) { res.status(400).json({ error: 'email is required' }); return; }
  if (!roleId) { res.status(400).json({ error: 'roleId is required' }); return; }
  const passwordError = validatePasswordStrength(password ?? '');
  if (passwordError) { res.status(400).json({ error: passwordError }); return; }

  try {
    const { rows: roleRows } = await db.query('SELECT 1 FROM security_roles WHERE id = $1', [roleId]);
    if (!roleRows.length) { res.status(400).json({ error: 'Invalid roleId' }); return; }

    if (employeeId) {
      const owned = await employeeBelongsToCompany(employeeId, req.user!.companyId);
      if (!owned) { res.status(400).json({ error: 'Invalid employeeId' }); return; }
    }

    const passwordHash = await hashPassword(password!);
    const { rows } = await db.query(
      `INSERT INTO users (company_id, employee_id, email, password_hash, role_id, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, email, is_active AS "isActive", created_at AS "createdAt"`,
      [req.user!.companyId, employeeId ?? null, email.trim(), passwordHash, roleId],
    );
    res.status(201).json(rows[0]);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A user with that email already exists' }); return;
    }
    console.error('POST /api/users', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update (role, active state, employee link) ───────────────────────────────

usersRouter.patch('/:id(\\d+)', requirePermission('users:manage'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { roleId, isActive, employeeId } = req.body as {
    roleId?: number; isActive?: boolean; employeeId?: number | null;
  };

  const sets: string[] = [];
  const vals: unknown[] = [];

  try {
    if (roleId !== undefined) {
      const { rows } = await db.query('SELECT 1 FROM security_roles WHERE id = $1', [roleId]);
      if (!rows.length) { res.status(400).json({ error: 'Invalid roleId' }); return; }
      vals.push(roleId); sets.push(`role_id = $${vals.length}`);
    }
    if (isActive !== undefined) {
      vals.push(isActive); sets.push(`is_active = $${vals.length}`);
    }
    if (employeeId !== undefined) {
      if (employeeId !== null) {
        const owned = await employeeBelongsToCompany(employeeId, req.user!.companyId);
        if (!owned) { res.status(400).json({ error: 'Invalid employeeId' }); return; }
      }
      vals.push(employeeId); sets.push(`employee_id = $${vals.length}`);
    }
    if (!sets.length) { res.status(400).json({ error: 'No fields to update' }); return; }

    vals.push(id, req.user!.companyId);
    const { rowCount } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`,
      vals,
    );
    if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }

    if (isActive === false) {
      // requireAuth/mobileAuth already re-check is_active live on every
      // request, so a deactivated account is blocked on its very next
      // call regardless — this proactively clears any lingering
      // browser/mobile session rows immediately instead of waiting for
      // that to happen or for natural expiry.
      await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await db.query('UPDATE mobile_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/users/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Reset password ───────────────────────────────────────────────────────────

usersRouter.post('/:id(\\d+)/reset-password', requirePermission('users:manage'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { password } = req.body as { password?: string };
  const passwordError = validatePasswordStrength(password ?? '');
  if (passwordError) { res.status(400).json({ error: passwordError }); return; }

  try {
    const passwordHash = await hashPassword(password!);
    const { rowCount } = await db.query(
      `UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL
       WHERE id = $2 AND company_id = $3`,
      [passwordHash, id, req.user!.companyId],
    );
    if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }

    // Resetting a password invalidates any existing sessions for that user
    // — both browser cookie sessions and mobile bearer sessions.
    await db.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [id],
    );
    await db.query(
      'UPDATE mobile_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [id],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/users/:id/reset-password', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────

usersRouter.get('/:id(\\d+)/sessions', requirePermission('users:manage'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: userRows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [id, req.user!.companyId]);
    if (!userRows.length) { res.status(404).json({ error: 'Not found' }); return; }

    const { rows } = await db.query(
      `SELECT sid, created_at AS "createdAt", last_seen_at AS "lastSeenAt",
              expires_at AS "expiresAt", user_agent AS "userAgent", ip_address AS "ipAddress"
       FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY last_seen_at DESC`,
      [id],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/users/:id/sessions', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

usersRouter.post('/:id(\\d+)/sessions/revoke-all', requirePermission('users:manage'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: userRows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [id, req.user!.companyId]);
    if (!userRows.length) { res.status(404).json({ error: 'Not found' }); return; }

    await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/users/:id/sessions/revoke-all', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Mobile sessions (separate from browser sessions above) ──────────────────

usersRouter.get('/:id(\\d+)/mobile-sessions', requirePermission('users:manage'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: userRows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [id, req.user!.companyId]);
    if (!userRows.length) { res.status(404).json({ error: 'Not found' }); return; }

    const { rows } = await db.query(
      `SELECT id, device_id AS "deviceId", device_name AS "deviceName", app_version AS "appVersion",
              created_at AS "createdAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt"
       FROM mobile_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY last_used_at DESC`,
      [id],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/users/:id/mobile-sessions', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revokes exactly one device's mobile session, without touching any other
// mobile session or any browser session for the same user — this is how
// an admin handles "employee lost their phone" without logging everyone
// else, or that employee's own web login, out.
usersRouter.post(
  '/:id(\\d+)/mobile-sessions/:sessionId(\\d+)/revoke',
  requirePermission('users:manage'),
  async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const sessionId = parseInt(req.params.sessionId, 10);
    try {
      const { rows: userRows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [id, req.user!.companyId]);
      if (!userRows.length) { res.status(404).json({ error: 'Not found' }); return; }

      const { rowCount } = await db.query(
        `UPDATE mobile_sessions SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [sessionId, id],
      );
      if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/users/:id/mobile-sessions/:sessionId/revoke', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

usersRouter.post('/:id(\\d+)/mobile-sessions/revoke-all', requirePermission('users:manage'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: userRows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [id, req.user!.companyId]);
    if (!userRows.length) { res.status(404).json({ error: 'Not found' }); return; }

    await db.query('UPDATE mobile_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/users/:id/mobile-sessions/revoke-all', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Roles & permissions (read-only list + permission assignment) ────────────

usersRouter.get('/roles', requirePermission('users:manage'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.description,
              COALESCE(json_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '[]') AS permissions
       FROM security_roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE r.archived_at IS NULL
       GROUP BY r.id
       ORDER BY r.sort_order`,
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/users/roles', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

usersRouter.patch('/roles/:id(\\d+)/permissions', requirePermission('roles:manage'), async (req: Request, res: Response) => {
  const roleId = parseInt(req.params.id, 10);
  const { permissionCodes } = req.body as { permissionCodes?: string[] };
  if (!Array.isArray(permissionCodes)) { res.status(400).json({ error: 'permissionCodes must be an array' }); return; }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: roleRows } = await client.query('SELECT 1 FROM security_roles WHERE id = $1', [roleId]);
    if (!roleRows.length) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    if (permissionCodes.length) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE code = ANY($2::text[])`,
        [roleId, permissionCodes],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('PATCH /api/users/roles/:id/permissions', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
