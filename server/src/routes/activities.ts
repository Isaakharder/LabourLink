import { Router, Request, Response } from 'express';
import { db } from '../db';

export const activitiesRouter = Router();

function generateCode(name: string): string {
  const code = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return code || 'ACTIVITY';
}

async function resolveUniqueCode(baseCode: string): Promise<string> {
  const { rows } = await db.query<{ code: string }>(
    `SELECT code FROM activities WHERE code = $1 OR code ~ $2`,
    [baseCode, `^${baseCode}_[0-9]+$`],
  );
  const existing = new Set(rows.map(r => r.code));
  if (!existing.has(baseCode)) return baseCode;
  for (let i = 2; ; i++) {
    const candidate = `${baseCode}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

// ── Form options  (must come before /:id) ────────────────────────────────────
activitiesRouter.get('/form-options', async (_req: Request, res: Response) => {
  try {
    const [groups, units] = await Promise.all([
      db.query(`SELECT id, name FROM activity_groups WHERE archived_at IS NULL ORDER BY sort_order`),
      db.query(`SELECT id, code, name FROM units WHERE archived_at IS NULL ORDER BY sort_order`),
    ]);
    res.json({ groups: groups.rows, units: units.rows });
  } catch (err) {
    console.error('GET /api/activities/form-options', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── List ──────────────────────────────────────────────────────────────────────
activitiesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        a.id,
        a.code,
        a.name,
        a.display_name        AS "displayName",
        a.activity_group_id   AS "groupId",
        g.name                AS "groupName",
        g.sort_order          AS "groupSortOrder",
        a.default_unit_id     AS "defaultUnitId",
        u.name                AS "defaultUnit",
        a.icon,
        a.color,
        a.visible_on_mobile   AS "visibleOnMobile",
        a.sort_order          AS "sortOrder",
        a.archived_at         AS "archivedAt"
      FROM activities a
      JOIN activity_groups g ON g.id = a.activity_group_id
      LEFT JOIN units u ON u.id = a.default_unit_id
      ORDER BY g.sort_order, a.sort_order, a.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/activities', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Detail ────────────────────────────────────────────────────────────────────
activitiesRouter.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  try {
    const result = await db.query(`
      SELECT
        a.id,
        a.code,
        a.name,
        a.display_name        AS "displayName",
        a.activity_group_id   AS "groupId",
        g.name                AS "groupName",
        a.default_unit_id     AS "defaultUnitId",
        u.code                AS "defaultUnitCode",
        u.name                AS "defaultUnit",
        a.icon,
        a.color,
        a.requires_location   AS "requiresLocation",
        a.requires_carrier    AS "requiresCarrier",
        a.requires_yield      AS "requiresYield",
        a.requires_crop       AS "requiresCrop",
        a.requires_note       AS "requiresNote",
        a.requires_photo      AS "requiresPhoto",
        a.requires_question   AS "requiresQuestion",
        a.visible_on_mobile   AS "visibleOnMobile",
        a.sort_order          AS "sortOrder",
        a.archived_at         AS "archivedAt",
        a.created_at          AS "createdAt",
        a.updated_at          AS "updatedAt"
      FROM activities a
      JOIN activity_groups g ON g.id = a.activity_group_id
      LEFT JOIN units u ON u.id = a.default_unit_id
      WHERE a.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Activity not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /api/activities/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────
activitiesRouter.post('/', async (req: Request, res: Response) => {
  const {
    name, displayName, groupId, defaultUnitId,
    icon, color,
    requiresLocation  = false,
    requiresCarrier   = false,
    requiresYield     = false,
    requiresCrop      = false,
    requiresNote      = false,
    requiresPhoto     = false,
    requiresQuestion  = false,
    visibleOnMobile   = true,
    sortOrder         = 0,
  } = req.body as {
    name: string; displayName?: string;
    groupId: number; defaultUnitId?: number;
    icon?: string; color?: string;
    requiresLocation?: boolean; requiresCarrier?: boolean;
    requiresYield?: boolean; requiresCrop?: boolean;
    requiresNote?: boolean; requiresPhoto?: boolean; requiresQuestion?: boolean;
    visibleOnMobile?: boolean; sortOrder?: number;
  };

  if (!name?.trim() || !groupId) {
    res.status(400).json({ error: 'name and groupId are required' });
    return;
  }

  try {
    const code = await resolveUniqueCode(generateCode(name));
    const result = await db.query<{ id: number; code: string }>(`
      INSERT INTO activities (
        code, name, display_name, activity_group_id, default_unit_id,
        icon, color,
        requires_location, requires_carrier, requires_yield, requires_crop,
        requires_note, requires_photo, requires_question,
        visible_on_mobile, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id, code
    `, [
      code, name.trim(), displayName || null, groupId, defaultUnitId || null,
      icon || null, color || null,
      requiresLocation, requiresCarrier, requiresYield, requiresCrop,
      requiresNote, requiresPhoto, requiresQuestion,
      visibleOnMobile, sortOrder,
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/activities', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────
activitiesRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  // code is intentionally excluded — it is immutable after creation
  const DB_COLS: Record<string, string> = {
    name:             'name',
    displayName:      'display_name',
    groupId:          'activity_group_id',
    defaultUnitId:    'default_unit_id',
    icon:             'icon',
    color:            'color',
    requiresLocation: 'requires_location',
    requiresCarrier:  'requires_carrier',
    requiresYield:    'requires_yield',
    requiresCrop:     'requires_crop',
    requiresNote:     'requires_note',
    requiresPhoto:    'requires_photo',
    requiresQuestion: 'requires_question',
    visibleOnMobile:  'visible_on_mobile',
    sortOrder:        'sort_order',
    archivedAt:       'archived_at',
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

  try {
    params.push(id);
    const result = await db.query(
      `UPDATE activities SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Activity not found' });
      return;
    }
    res.json({ id });
  } catch (err) {
    console.error('PATCH /api/activities/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
