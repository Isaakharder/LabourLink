import { Router, Request, Response } from 'express';
import { db } from '../db';

export const locationGroupsRouter = Router();

function buildPatch(body: Record<string, unknown>, fieldMap: Record<string, string>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (jsKey in body) {
      vals.push(body[jsKey] ?? null);
      sets.push(`${dbCol} = $${vals.length}`);
    }
  }
  return { sets, vals };
}

// ── Location Groups ───────────────────────────────────────────────────────────

locationGroupsRouter.get('/', async (req: Request, res: Response) => {
  const siteId = req.query.siteId ? parseInt(String(req.query.siteId), 10) : null;
  const includeArchived = req.query.includeArchived === 'true';

  try {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (siteId !== null) {
      params.push(siteId);
      conditions.push(`lg.site_id = $${params.length}`);
    }
    if (!includeArchived) {
      conditions.push('lg.archived_at IS NULL');
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT
         lg.id,
         lg.site_id       AS "siteId",
         s.name           AS "siteName",
         lg.code,
         lg.name,
         lg.net_area_m2   AS "netAreaM2",
         lg.sort_order    AS "sortOrder",
         lg.archived_at   AS "archivedAt",
         lg.created_at    AS "createdAt",
         lg.updated_at    AS "updatedAt",
         COUNT(lgl.location_id) AS "locationCount"
       FROM location_groups lg
       JOIN sites s ON s.id = lg.site_id
       LEFT JOIN location_group_locations lgl ON lgl.location_group_id = lg.id
       ${where}
       GROUP BY lg.id, s.name
       ORDER BY lg.site_id, lg.sort_order, lg.code`,
      params,
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/location-groups', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationGroupsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const { rows } = await db.query(
      `SELECT
         lg.id,
         lg.site_id       AS "siteId",
         s.name           AS "siteName",
         s.code           AS "siteCode",
         lg.code,
         lg.name,
         lg.net_area_m2   AS "netAreaM2",
         lg.sort_order    AS "sortOrder",
         lg.archived_at   AS "archivedAt",
         lg.created_at    AS "createdAt",
         lg.updated_at    AS "updatedAt"
       FROM location_groups lg
       JOIN sites s ON s.id = lg.site_id
       WHERE lg.id = $1`,
      [id],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/location-groups/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationGroupsRouter.post('/', async (req: Request, res: Response) => {
  const { siteId, code, name, netAreaM2, sortOrder } = req.body as Record<string, unknown>;
  if (!siteId || !code || !name) {
    res.status(400).json({ error: 'siteId, code, and name are required' }); return;
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO location_groups (site_id, code, name, net_area_m2, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [siteId, code, name, netAreaM2 ?? null, sortOrder ?? 0],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      res.status(409).json({ error: 'A location group with that code already exists in this site' }); return;
    }
    console.error('POST /api/location-groups', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationGroupsRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const { sets, vals } = buildPatch(req.body as Record<string, unknown>, {
    code:       'code',
    name:       'name',
    netAreaM2:  'net_area_m2',
    sortOrder:  'sort_order',
    archivedAt: 'archived_at',
  });
  if (!sets.length) { res.status(400).json({ error: 'No fields to update' }); return; }
  try {
    const { rowCount } = await db.query(
      `UPDATE location_groups SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`,
      [...vals, id],
    );
    if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      res.status(409).json({ error: 'Code already in use in this site' }); return;
    }
    console.error('PATCH /api/location-groups/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Group membership ──────────────────────────────────────────────────────────

locationGroupsRouter.get('/:id/locations', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const { rows } = await db.query(
      `SELECT
         l.id,
         l.code,
         l.name,
         l.abbreviated_name AS "abbreviatedName",
         l.sort_order       AS "sortOrder",
         l.archived_at      AS "archivedAt"
       FROM locations l
       JOIN location_group_locations lgl ON lgl.location_id = l.id
       WHERE lgl.location_group_id = $1
       ORDER BY l.sort_order, l.code`,
      [id],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/location-groups/:id/locations', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationGroupsRouter.post('/:id/locations', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const { locationId } = req.body as Record<string, unknown>;
  if (!locationId) {
    res.status(400).json({ error: 'locationId is required' }); return;
  }
  try {
    await db.query(
      `INSERT INTO location_group_locations (location_group_id, location_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, locationId],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /api/location-groups/:id/locations', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationGroupsRouter.delete('/:id/locations/:locationId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const locationId = parseInt(req.params.locationId, 10);
  if (isNaN(id) || isNaN(locationId)) {
    res.status(400).json({ error: 'Invalid id' }); return;
  }
  try {
    await db.query(
      `DELETE FROM location_group_locations
       WHERE location_group_id = $1 AND location_id = $2`,
      [id, locationId],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/location-groups/:id/locations/:locationId', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
