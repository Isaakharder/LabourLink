import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requirePermission } from '../middleware/auth';
import { contractTemplateBelongsToCompany } from '../lib/companyScope';

export const contractsRouter = Router();

// ── List ──────────────────────────────────────────────────────────────────────

contractsRouter.get('/', requirePermission('contracts:view'), async (req: Request, res: Response) => {
  try {
    const { rows } = await db.query(`
      SELECT
        ct.id,
        ct.name,
        ct.archived_at   AS "archivedAt",
        ct.created_at    AS "createdAt",
        COUNT(cp.id)     AS "profileCount"
      FROM contract_templates ct
      LEFT JOIN contract_profiles cp
        ON cp.contract_template_id = ct.id AND cp.archived_at IS NULL
      WHERE ct.company_id = $1
      GROUP BY ct.id
      ORDER BY ct.archived_at NULLS FIRST, ct.name
    `, [req.user!.companyId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/contracts', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Detail (with profiles) ────────────────────────────────────────────────────

contractsRouter.get('/:id', requirePermission('contracts:view'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  try {
    const [templateResult, profilesResult] = await Promise.all([
      db.query(`
        SELECT id, name, archived_at AS "archivedAt",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM contract_templates WHERE id = $1 AND company_id = $2
      `, [id, req.user!.companyId]),

      db.query(`
        SELECT
          id,
          contract_template_id  AS "contractTemplateId",
          effective_from        AS "effectiveFrom",
          hours_per_week        AS "hoursPerWeek",
          work_start_rounding_rule    AS "workStartRoundingRule",
          work_start_rounding_minutes AS "workStartRoundingMinutes",
          allow_night_work      AS "allowNightWork",
          public_holiday_rule   AS "publicHolidayRule",
          archived_at           AS "archivedAt",
          created_at            AS "createdAt",
          updated_at            AS "updatedAt"
        FROM contract_profiles
        WHERE contract_template_id = $1
        ORDER BY effective_from DESC
      `, [id]),
    ]);

    if (!templateResult.rows[0]) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    res.json({
      ...templateResult.rows[0],
      profiles: profilesResult.rows,
    });
  } catch (err) {
    console.error('GET /api/contracts/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

contractsRouter.post('/', requirePermission('contracts:edit'), async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const { rows } = await db.query<{ id: number; name: string }>(
      `INSERT INTO contract_templates (name, company_id) VALUES ($1, $2) RETURNING id, name`,
      [name.trim(), req.user!.companyId],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/contracts', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

contractsRouter.patch('/:id', requirePermission('contracts:edit'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const allowed: Record<string, string> = { name: 'name', archivedAt: 'archived_at' };
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const key of Object.keys(allowed)) {
    if (key in req.body) {
      params.push(req.body[key] ?? null);
      sets.push(`${allowed[key]} = $${params.length}`);
    }
  }

  if (sets.length === 0) {
    res.status(400).json({ error: 'No valid fields' });
    return;
  }

  try {
    params.push(id, req.user!.companyId);
    const { rows } = await db.query(
      `UPDATE contract_templates SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND company_id = $${params.length} RETURNING id`,
      params,
    );
    if (!rows[0]) { res.status(404).json({ error: 'Contract not found' }); return; }
    res.json({ id });
  } catch (err) {
    console.error('PATCH /api/contracts/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create Profile ────────────────────────────────────────────────────────────

contractsRouter.post('/:id/profiles', requirePermission('contracts:edit'), async (req: Request, res: Response) => {
  const contractId = parseInt(req.params.id, 10);
  if (isNaN(contractId)) { res.status(400).json({ error: 'Invalid id' }); return; }
  if (!(await contractTemplateBelongsToCompany(contractId, req.user!.companyId))) {
    res.status(404).json({ error: 'Contract not found' });
    return;
  }

  const {
    effectiveFrom,
    hoursPerWeek       = null,
    workStartRoundingRule    = 'none',
    workStartRoundingMinutes = 15,
    allowNightWork     = false,
    publicHolidayRule  = null,
  } = req.body as {
    effectiveFrom: string;
    hoursPerWeek?: number | null;
    workStartRoundingRule?: string;
    workStartRoundingMinutes?: number;
    allowNightWork?: boolean;
    publicHolidayRule?: string | null;
  };

  if (!effectiveFrom) {
    res.status(400).json({ error: 'effectiveFrom is required' });
    return;
  }

  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO contract_profiles
         (contract_template_id, effective_from, hours_per_week,
          work_start_rounding_rule, work_start_rounding_minutes,
          allow_night_work, public_holiday_rule)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [contractId, effectiveFrom, hoursPerWeek,
       workStartRoundingRule, workStartRoundingMinutes,
       allowNightWork, publicHolidayRule],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('cp_unique_template_date')) {
      res.status(409).json({ error: 'A profile with this effective date already exists' });
      return;
    }
    console.error('POST /api/contracts/:id/profiles', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Clone Profile ─────────────────────────────────────────────────────────────

contractsRouter.post('/:id/profiles/:profileId/clone', requirePermission('contracts:edit'), async (req: Request, res: Response) => {
  const contractId  = parseInt(req.params.id, 10);
  const profileId   = parseInt(req.params.profileId, 10);
  if (isNaN(contractId) || isNaN(profileId)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!(await contractTemplateBelongsToCompany(contractId, req.user!.companyId))) {
    res.status(404).json({ error: 'Contract not found' });
    return;
  }

  const { effectiveFrom } = req.body as { effectiveFrom?: string };
  if (!effectiveFrom) {
    res.status(400).json({ error: 'effectiveFrom is required' });
    return;
  }

  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO contract_profiles
         (contract_template_id, effective_from, hours_per_week,
          work_start_rounding_rule, work_start_rounding_minutes,
          allow_night_work, public_holiday_rule)
       SELECT contract_template_id, $1, hours_per_week,
              work_start_rounding_rule, work_start_rounding_minutes,
              allow_night_work, public_holiday_rule
       FROM contract_profiles
       WHERE id = $2 AND contract_template_id = $3
       RETURNING id`,
      [effectiveFrom, profileId, contractId],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Profile not found' }); return; }
    res.status(201).json({ id: rows[0].id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('cp_unique_template_date')) {
      res.status(409).json({ error: 'A profile with this effective date already exists' });
      return;
    }
    console.error('POST /api/contracts/:id/profiles/:profileId/clone', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update Profile ────────────────────────────────────────────────────────────

contractsRouter.patch('/:id/profiles/:profileId', requirePermission('contracts:edit'), async (req: Request, res: Response) => {
  const contractId = parseInt(req.params.id, 10);
  const profileId  = parseInt(req.params.profileId, 10);
  if (isNaN(contractId) || isNaN(profileId)) {
    res.status(400).json({ error: 'Invalid id' }); return;
  }
  if (!(await contractTemplateBelongsToCompany(contractId, req.user!.companyId))) {
    res.status(404).json({ error: 'Contract not found' });
    return;
  }

  const allowed: Record<string, string> = {
    effectiveFrom:            'effective_from',
    hoursPerWeek:             'hours_per_week',
    workStartRoundingRule:    'work_start_rounding_rule',
    workStartRoundingMinutes: 'work_start_rounding_minutes',
    allowNightWork:           'allow_night_work',
    publicHolidayRule:        'public_holiday_rule',
    archivedAt:               'archived_at',
  };

  const sets: string[] = [];
  const params: unknown[] = [];

  for (const key of Object.keys(allowed)) {
    if (key in req.body) {
      params.push(req.body[key] ?? null);
      sets.push(`${allowed[key]} = $${params.length}`);
    }
  }

  if (sets.length === 0) { res.status(400).json({ error: 'No valid fields' }); return; }

  try {
    params.push(profileId, contractId);
    const { rows } = await db.query(
      `UPDATE contract_profiles SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND contract_template_id = $${params.length}
       RETURNING id`,
      params,
    );
    if (!rows[0]) { res.status(404).json({ error: 'Profile not found' }); return; }
    res.json({ id: profileId });
  } catch (err) {
    console.error('PATCH /api/contracts/:id/profiles/:profileId', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
