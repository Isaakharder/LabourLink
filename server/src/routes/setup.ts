import { Router, Request, Response } from 'express';
import { db } from '../db';
import { hashPassword, validatePasswordStrength } from '../lib/password';

export const setupRouter = Router();

async function systemHasUsers(): Promise<boolean> {
  const { rows } = await db.query('SELECT EXISTS (SELECT 1 FROM users) AS exists');
  return rows[0].exists as boolean;
}

// Public: lets the frontend decide whether to show the setup screen or the
// login screen. Reveals no sensitive data — just whether any account exists.
setupRouter.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json({ needsSetup: !(await systemHasUsers()) });
  } catch (err) {
    console.error('GET /api/setup/status', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Creates the very first company + administrator. Permanently disabled the
// moment any user exists anywhere in the system — never anonymous after that.
setupRouter.post('/bootstrap-admin', async (req: Request, res: Response) => {
  const { companyName, email, password } = req.body as {
    companyName?: string;
    email?: string;
    password?: string;
  };

  if (!email?.trim()) {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  const passwordError = validatePasswordStrength(password ?? '');
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (await systemHasUsers()) {
      await client.query('ROLLBACK');
      res.status(403).json({ error: 'Setup has already been completed' });
      return;
    }

    const { rows: existingCompanies } = await client.query(
      'SELECT id FROM companies ORDER BY id LIMIT 1',
    );

    let companyId: number;
    if (existingCompanies.length > 0) {
      companyId = existingCompanies[0].id;
    } else {
      if (!companyName?.trim()) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'companyName is required (no company exists yet)' });
        return;
      }
      const { rows: newCompany } = await client.query(
        'INSERT INTO companies (name) VALUES ($1) RETURNING id',
        [companyName.trim()],
      );
      companyId = newCompany[0].id;
    }

    const { rows: adminRoleRows } = await client.query(
      "SELECT id FROM security_roles WHERE name = 'Admin'",
    );
    if (!adminRoleRows.length) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'Admin role is not configured' });
      return;
    }
    const roleId = adminRoleRows[0].id;

    const passwordHash = await hashPassword(password!);
    const { rows: userRows } = await client.query(
      `INSERT INTO users (company_id, email, password_hash, role_id, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, company_id AS "companyId"`,
      [companyId, email.trim(), passwordHash, roleId],
    );

    await client.query('COMMIT');

    const user = userRows[0];
    req.session.regenerate((err) => {
      if (err) {
        console.error('POST /api/setup/bootstrap-admin (regenerate)', err);
        res.status(201).json({ ok: true, autoLogin: false });
        return;
      }
      req.session.userId = user.id;
      req.session.companyId = user.companyId;
      req.session.userAgent = req.get('user-agent') ?? undefined;
      req.session.ipAddress = req.ip;
      req.session.save(() => {
        res.status(201).json({ ok: true, autoLogin: true });
      });
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('POST /api/setup/bootstrap-admin', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
