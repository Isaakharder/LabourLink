import { Router, Request, Response } from 'express';
import { db } from '../db';

export const locationsRouter = Router();

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

// ── Sites ─────────────────────────────────────────────────────────────────────

locationsRouter.get('/sites', async (_req: Request, res: Response) => {
  try {
    const { rows } = await db.query(`
      SELECT
        s.id, s.name, s.code, s.address, s.timezone,
        s.archived_at    AS "archivedAt",
        s.created_at     AS "createdAt",
        s.updated_at     AS "updatedAt",
        c.name           AS "companyName",
        COUNT(DISTINCT l.id)  FILTER (WHERE l.archived_at IS NULL)::int  AS "locationCount",
        COUNT(DISTINCT gm.id)::int                                        AS "mapCount"
      FROM sites s
      JOIN companies c ON c.id = s.company_id
      LEFT JOIN locations l          ON l.site_id  = s.id
      LEFT JOIN greenhouse_maps gm   ON gm.site_id = s.id
      GROUP BY s.id, c.name
      ORDER BY s.archived_at NULLS FIRST, s.name
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/locations/sites', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.post('/sites', async (req: Request, res: Response) => {
  const { name, code, address, timezone = 'Europe/Amsterdam' } = req.body as {
    name?: string; code?: string; address?: string; timezone?: string;
  };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  if (!code?.trim()) { res.status(400).json({ error: 'code is required' }); return; }
  try {
    const coRes = await db.query('SELECT id, name FROM companies LIMIT 1');
    if (!coRes.rows.length) { res.status(500).json({ error: 'No company configured' }); return; }
    const { id: company_id, name: companyName } = coRes.rows[0];
    const { rows } = await db.query(`
      INSERT INTO sites (company_id, name, code, address, timezone)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, code, address, timezone,
                archived_at AS "archivedAt",
                created_at  AS "createdAt",
                updated_at  AS "updatedAt"
    `, [company_id, name.trim(), code.trim().toUpperCase(), address?.trim() || null, timezone]);
    res.status(201).json({ ...rows[0], companyName, locationCount: 0, mapCount: 0 });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A site with that code already exists' }); return;
    }
    console.error('POST /api/locations/sites', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.get('/sites/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.code, s.name, s.address, s.timezone,
              s.archived_at AS "archivedAt",
              s.created_at  AS "createdAt",
              s.updated_at  AS "updatedAt",
              c.name        AS "companyName"
       FROM sites s
       JOIN companies c ON c.id = s.company_id
       WHERE s.id = $1`,
      [id],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/locations/sites/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.patch('/sites/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const { sets, vals } = buildPatch(req.body as Record<string, unknown>, {
    name: 'name', code: 'code', address: 'address', timezone: 'timezone', archivedAt: 'archived_at',
  });
  if (!sets.length) { res.status(400).json({ error: 'No fields to update' }); return; }
  try {
    const { rowCount } = await db.query(
      `UPDATE sites SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`,
      [...vals, id],
    );
    if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/locations/sites/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.delete('/sites/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const usageRes = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM locations       WHERE site_id = $1)::int AS loc_count,
        (SELECT COUNT(*) FROM greenhouse_maps  WHERE site_id = $1)::int AS map_count,
        (SELECT COUNT(*) FROM location_groups  WHERE site_id = $1)::int AS grp_count
    `, [id]);
    const { loc_count, map_count, grp_count } = usageRes.rows[0];
    if (loc_count > 0 || map_count > 0 || grp_count > 0) {
      const parts: string[] = [];
      if (loc_count > 0) parts.push(`${loc_count} location(s)`);
      if (map_count > 0) parts.push(`${map_count} map(s)`);
      if (grp_count > 0) parts.push(`${grp_count} location group(s)`);
      res.status(409).json({ error: `Cannot delete: site has ${parts.join(', ')}` }); return;
    }
    const { rowCount } = await db.query('DELETE FROM sites WHERE id = $1', [id]);
    if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/locations/sites/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Locations ─────────────────────────────────────────────────────────────────

locationsRouter.get('/', async (req: Request, res: Response) => {
  const siteId = req.query.siteId ? parseInt(String(req.query.siteId), 10) : null;
  const includeArchived = req.query.includeArchived === 'true';

  try {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (siteId !== null) {
      params.push(siteId);
      conditions.push(`l.site_id = $${params.length}`);
    }
    if (!includeArchived) {
      conditions.push('l.archived_at IS NULL');
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT
         l.id,
         l.site_id        AS "siteId",
         s.name           AS "siteName",
         l.code,
         l.name,
         l.abbreviated_name AS "abbreviatedName",
         l.net_area_m2    AS "netAreaM2",
         l.sort_order     AS "sortOrder",
         l.archived_at    AS "archivedAt",
         l.created_at     AS "createdAt",
         l.updated_at     AS "updatedAt"
       FROM locations l
       JOIN sites s ON s.id = l.site_id
       ${where}
       ORDER BY l.site_id, l.sort_order, l.code`,
      params,
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/locations', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.get('/:id(\\d+)', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query(
      `SELECT
         l.id,
         l.site_id           AS "siteId",
         s.name              AS "siteName",
         s.code              AS "siteCode",
         l.code,
         l.name,
         l.abbreviated_name  AS "abbreviatedName",
         l.net_area_m2       AS "netAreaM2",
         l.map_x_m           AS "mapXM",
         l.map_y_m           AS "mapYM",
         l.map_length_m      AS "mapLengthM",
         l.map_width_m       AS "mapWidthM",
         l.sort_order        AS "sortOrder",
         l.archived_at       AS "archivedAt",
         l.created_at        AS "createdAt",
         l.updated_at        AS "updatedAt"
       FROM locations l
       JOIN sites s ON s.id = l.site_id
       WHERE l.id = $1`,
      [id],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/locations/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.post('/', async (req: Request, res: Response) => {
  const { siteId, code, name, abbreviatedName, netAreaM2, mapXM, mapYM,
          mapLengthM, mapWidthM, sortOrder } = req.body as Record<string, unknown>;
  if (!siteId || !code || !name) {
    res.status(400).json({ error: 'siteId, code, and name are required' }); return;
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO locations
         (site_id, code, name, abbreviated_name, net_area_m2,
          map_x_m, map_y_m, map_length_m, map_width_m, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [siteId, code, name, abbreviatedName ?? null, netAreaM2 ?? null,
       mapXM ?? null, mapYM ?? null, mapLengthM ?? null, mapWidthM ?? null,
       sortOrder ?? 0],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      res.status(409).json({ error: 'A location with that code already exists in this site' }); return;
    }
    console.error('POST /api/locations', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.patch('/:id(\\d+)', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { sets, vals } = buildPatch(req.body as Record<string, unknown>, {
    code:            'code',
    name:            'name',
    abbreviatedName: 'abbreviated_name',
    netAreaM2:       'net_area_m2',
    mapXM:           'map_x_m',
    mapYM:           'map_y_m',
    mapLengthM:      'map_length_m',
    mapWidthM:       'map_width_m',
    sortOrder:       'sort_order',
    archivedAt:      'archived_at',
  });
  if (!sets.length) { res.status(400).json({ error: 'No fields to update' }); return; }
  try {
    const { rowCount } = await db.query(
      `UPDATE locations SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`,
      [...vals, id],
    );
    if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      res.status(409).json({ error: 'Code already in use in this site' }); return;
    }
    console.error('PATCH /api/locations/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Which groups does this location belong to?
locationsRouter.get('/:id(\\d+)/groups', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query(
      `SELECT lg.id, lg.code, lg.name, lg.sort_order AS "sortOrder",
              lg.archived_at AS "archivedAt"
       FROM location_groups lg
       JOIN location_group_locations lgl ON lgl.location_group_id = lg.id
       WHERE lgl.location_id = $1
       ORDER BY lg.sort_order, lg.code`,
      [id],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/locations/:id/groups', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Location Scan Codes ───────────────────────────────────────────────────────

locationsRouter.get('/scan-codes', async (req: Request, res: Response) => {
  const locationId = parseInt(String(req.query.locationId ?? ''), 10);
  if (isNaN(locationId)) {
    res.status(400).json({ error: 'locationId query param required' }); return;
  }
  try {
    const { rows } = await db.query(
      `SELECT id, location_id AS "locationId", scan_code AS "scanCode",
              scan_type AS "scanType", label,
              is_primary AS "isPrimary", archived_at AS "archivedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM location_scan_codes
       WHERE location_id = $1
       ORDER BY is_primary DESC, created_at`,
      [locationId],
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/locations/scan-codes', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.post('/scan-codes', async (req: Request, res: Response) => {
  const { locationId, scanCode, scanType, label, isPrimary } = req.body as Record<string, unknown>;
  if (!locationId || !scanCode || !scanType) {
    res.status(400).json({ error: 'locationId, scanCode, and scanType are required' }); return;
  }
  const validTypes = ['qr', 'rfid', 'barcode', 'manual'];
  if (!validTypes.includes(String(scanType))) {
    res.status(400).json({ error: 'scanType must be qr, rfid, barcode, or manual' }); return;
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO location_scan_codes (location_id, scan_code, scan_type, label, is_primary)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [locationId, scanCode, scanType, label ?? null, isPrimary ?? false],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      res.status(409).json({ error: 'Scan code already exists or this location already has a primary code' }); return;
    }
    console.error('POST /api/locations/scan-codes', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

locationsRouter.patch('/scan-codes/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const body = req.body as Record<string, unknown>;

  if (body.isPrimary === true) {
    try {
      const { rows: sc } = await db.query(
        `SELECT location_id FROM location_scan_codes WHERE id = $1`, [id],
      );
      if (!sc[0]) { res.status(404).json({ error: 'Not found' }); return; }
      await db.query('BEGIN');
      await db.query(
        `UPDATE location_scan_codes SET is_primary = FALSE
         WHERE location_id = $1 AND is_primary = TRUE AND archived_at IS NULL AND id != $2`,
        [sc[0].location_id, id],
      );
      const { sets, vals } = buildPatch(body, {
        scanCode: 'scan_code', scanType: 'scan_type', label: 'label',
        isPrimary: 'is_primary', archivedAt: 'archived_at',
      });
      await db.query(
        `UPDATE location_scan_codes SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`,
        [...vals, id],
      );
      await db.query('COMMIT');
      res.json({ ok: true });
    } catch (err: unknown) {
      await db.query('ROLLBACK').catch(() => {});
      const pg = err as { code?: string };
      if (pg.code === '23505') {
        res.status(409).json({ error: 'Scan code already in use' }); return;
      }
      console.error('PATCH /api/locations/scan-codes/:id', err);
      res.status(500).json({ error: 'Internal server error' });
    }
    return;
  }

  const { sets, vals } = buildPatch(body, {
    scanCode: 'scan_code', scanType: 'scan_type', label: 'label',
    isPrimary: 'is_primary', archivedAt: 'archived_at',
  });
  if (!sets.length) { res.status(400).json({ error: 'No fields to update' }); return; }
  try {
    const { rowCount } = await db.query(
      `UPDATE location_scan_codes SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`,
      [...vals, id],
    );
    if (rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      res.status(409).json({ error: 'Scan code already in use or primary conflict' }); return;
    }
    console.error('PATCH /api/locations/scan-codes/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
