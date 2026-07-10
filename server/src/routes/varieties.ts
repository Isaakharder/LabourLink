import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requirePermission } from '../middleware/auth';
import { cropBelongsToCompany, varietyBelongsToCompany } from '../lib/companyScope';

export const varietiesRouter = Router();

// ── List ──────────────────────────────────────────────────────────────────────
varietiesRouter.get('/', requirePermission('crops:view'), async (req: Request, res: Response) => {
  const cropId = req.query.cropId ? parseInt(req.query.cropId as string, 10) : null;

  try {
    const params: unknown[] = [req.user!.companyId];
    let cropFilter = '';
    if (cropId) {
      params.push(cropId);
      cropFilter = `AND v.crop_id = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT
        v.id,
        v.name,
        v.color,
        v.archived_at                AS "archivedAt",
        v.created_at                 AS "createdAt",
        v.updated_at                 AS "updatedAt",
        c.id                         AS "cropId",
        c.name                       AS "cropName",
        c.planting_date::text        AS "cropPlantingDate",
        c.pulling_date::text         AS "cropPullingDate",
        c.archived_at                AS "cropArchivedAt"
      FROM varieties v
      JOIN crops c ON c.id = v.crop_id
      WHERE c.company_id = $1 ${cropFilter}
      ORDER BY c.planting_date DESC NULLS LAST, c.name, v.name`,
      params,
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/varieties', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────
varietiesRouter.post('/', requirePermission('crops:edit'), async (req: Request, res: Response) => {
  const { cropId, name, color } = req.body as {
    cropId: number;
    name: string;
    color?: string | null;
  };

  if (!cropId) { res.status(400).json({ error: 'cropId is required' }); return; }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  if (!(await cropBelongsToCompany(cropId, req.user!.companyId))) {
    res.status(400).json({ error: 'Crop not found' });
    return;
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO varieties (crop_id, name, color)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [cropId, name.trim(), color || null],
    );
    res.status(201).json(rows[0]);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23503') {
      res.status(400).json({ error: 'Crop not found' });
      return;
    }
    console.error('POST /api/varieties', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────
varietiesRouter.patch('/:id', requirePermission('crops:edit'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  if (!(await varietyBelongsToCompany(id, req.user!.companyId))) {
    res.status(404).json({ error: 'Variety not found' });
    return;
  }

  const DB_COLS: Record<string, string> = {
    name:       'name',
    color:      'color',
    cropId:     'crop_id',
    archivedAt: 'archived_at',
  };

  const sets: string[] = [];
  const params: unknown[] = [];

  for (const key of Object.keys(DB_COLS)) {
    if (key in req.body) {
      params.push(req.body[key] ?? null);
      sets.push(`${DB_COLS[key]} = $${params.length}`);
    }
  }

  if (sets.length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  if (req.body.cropId && !(await cropBelongsToCompany(req.body.cropId, req.user!.companyId))) {
    res.status(400).json({ error: 'Crop not found' });
    return;
  }

  sets.push(`updated_at = now()`);

  try {
    params.push(id);
    const result = await db.query(
      `UPDATE varieties SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (!result.rowCount) { res.status(404).json({ error: 'Variety not found' }); return; }
    res.json({ id });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23503') {
      res.status(400).json({ error: 'Crop not found' });
      return;
    }
    console.error('PATCH /api/varieties/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
