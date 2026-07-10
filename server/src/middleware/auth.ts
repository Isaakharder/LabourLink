import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

export interface AuthenticatedUser {
  id: number;
  companyId: number;
  employeeId: number | null;
  email: string;
  roleId: number;
  roleName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

// Resolves req.user from the session-stored userId/companyId. Never trusts
// company_id/user_id/role values supplied by the request body or query.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.session.userId;
  const companyId = req.session.companyId;
  if (!userId || !companyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { rows } = await db.query(
      `SELECT u.id, u.company_id AS "companyId", u.employee_id AS "employeeId",
              u.email, u.is_active AS "isActive",
              r.id AS "roleId", r.name AS "roleName"
       FROM users u
       JOIN security_roles r ON r.id = u.role_id
       WHERE u.id = $1 AND u.company_id = $2`,
      [userId, companyId],
    );
    const row = rows[0];
    if (!row || !row.isActive) {
      req.session.destroy(() => undefined);
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = {
      id: row.id,
      companyId: row.companyId,
      employeeId: row.employeeId,
      email: row.email,
      roleId: row.roleId,
      roleName: row.roleName,
    };
    next();
  } catch (err) {
    console.error('requireAuth', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function requirePermission(code: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      const { rows } = await db.query(
        `SELECT 1 FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = $1 AND p.code = $2`,
        [req.user.roleId, code],
      );
      if (!rows.length) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      next();
    } catch (err) {
      console.error('requirePermission', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
