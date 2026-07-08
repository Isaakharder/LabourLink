import { Router, Request, Response } from 'express';
import { db } from '../db';

export const cropsRouter = Router();

// ── List ──────────────────────────────────────────────────────────────────────
cropsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id,
        c.name,
        c.planting_date::text  AS "plantingDate",
        c.pulling_date::text   AS "pullingDate",
        c.archived_at          AS "archivedAt",
        c.created_at           AS "createdAt",
        c.updated_at           AS "updatedAt",
        COUNT(v.id)::int       AS "varietyCount"
      FROM crops c
      LEFT JOIN varieties v ON v.crop_id = c.id AND v.archived_at IS NULL
      GROUP BY c.id
      ORDER BY c.planting_date DESC NULLS LAST, c.name
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/crops', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────
cropsRouter.post('/', async (req: Request, res: Response) => {
  const { name, plantingDate, pullingDate } = req.body as {
    name: string;
    plantingDate: string;
    pullingDate?: string | null;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!plantingDate) {
    res.status(400).json({ error: 'plantingDate is required' });
    return;
  }
  if (pullingDate && pullingDate < plantingDate) {
    res.status(400).json({ error: 'Pulling date cannot be before planting date' });
    return;
  }

  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO crops (name, planting_date, pulling_date)
       VALUES ($1, $2, $3)
       RETURNING id, name,
         planting_date::text AS "plantingDate",
         pulling_date::text  AS "pullingDate",
         archived_at         AS "archivedAt",
         created_at          AS "createdAt",
         updated_at          AS "updatedAt"`,
      [name.trim(), plantingDate, pullingDate || null],
    );
    res.status(201).json({ ...rows[0], varietyCount: 0 });
  } catch (err) {
    console.error('POST /api/crops', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Detail ────────────────────────────────────────────────────────────────────
cropsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  try {
    const { rows } = await db.query(`
      SELECT
        c.id,
        c.name,
        c.planting_date::text  AS "plantingDate",
        c.pulling_date::text   AS "pullingDate",
        c.archived_at          AS "archivedAt",
        c.created_at           AS "createdAt",
        c.updated_at           AS "updatedAt",
        COUNT(v.id)::int       AS "varietyCount"
      FROM crops c
      LEFT JOIN varieties v ON v.crop_id = c.id AND v.archived_at IS NULL
      WHERE c.id = $1
      GROUP BY c.id
    `, [id]);
    if (rows.length === 0) { res.status(404).json({ error: 'Crop not found' }); return; }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/crops/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Crop locations: list ──────────────────────────────────────────────────────
cropsRouter.get('/:id/locations', async (req: Request, res: Response) => {
  const cropId = parseInt(req.params.id, 10);
  if (isNaN(cropId)) { res.status(400).json({ error: 'Invalid id' }); return; }

  try {
    const { rows } = await db.query(`
      SELECT
        cl.id,
        cl.crop_id              AS "cropId",
        cl.row_id               AS "rowId",
        gr.row_number           AS "rowNumber",
        gr.side,
        gr.width_ft             AS "widthFt",
        gr.length_ft            AS "lengthFt",
        ROUND((gr.width_ft * gr.length_ft * 0.0929)::numeric, 2) AS "areaM2",
        gm.name                 AS "mapName",
        gc.name                 AS "compartmentName",
        l.code                  AS "locationCode",
        l.name                  AS "locationName",
        l.net_area_m2           AS "netAreaM2",
        cl.start_date::text     AS "startDate",
        cl.end_date::text       AS "endDate",
        cl.plant_count          AS "plantCount",
        cl.notes
      FROM crop_locations cl
      JOIN greenhouse_rows       gr ON gr.id = cl.row_id
      JOIN greenhouse_row_blocks gb ON gb.id = gr.block_id
      JOIN greenhouse_compartments gc ON gc.id = gb.compartment_id
      JOIN greenhouse_maps        gm ON gm.id = gc.map_id
      LEFT JOIN locations          l  ON l.id  = gr.location_id
      WHERE cl.crop_id = $1
      ORDER BY gm.name, gc.name, gr.row_number
    `, [cropId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/crops/:id/locations', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Crop locations: replace (PUT) ─────────────────────────────────────────────
cropsRouter.put('/:id/locations', async (req: Request, res: Response) => {
  const cropId = parseInt(req.params.id, 10);
  if (isNaN(cropId)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { rowIds } = req.body as { rowIds?: number[] };
  if (!Array.isArray(rowIds)) {
    res.status(400).json({ error: 'rowIds must be an array' }); return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM crop_locations WHERE crop_id = $1', [cropId]);
    if (rowIds.length > 0) {
      const values = rowIds.map((rid, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO crop_locations (crop_id, row_id) VALUES ${values}
         ON CONFLICT (crop_id, row_id) DO NOTHING`,
        [cropId, ...rowIds],
      );
    }
    await client.query('COMMIT');
    res.json({ linked: rowIds.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/crops/:id/locations', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Plant density: list ───────────────────────────────────────────────────────
cropsRouter.get('/:id/plant-density', async (req: Request, res: Response) => {
  const cropId = parseInt(req.params.id, 10);
  if (isNaN(cropId)) { res.status(400).json({ error: 'Invalid id' }); return; }

  try {
    const { rows } = await db.query(`
      SELECT
        pd.id,
        pd.crop_id              AS "cropId",
        pd.name,
        pd.plant_count          AS "plantCount",
        pd.area_m2              AS "areaM2",
        CASE WHEN pd.area_m2 > 0
          THEN ROUND(pd.plant_count / pd.area_m2, 2)
          ELSE NULL
        END                     AS "densityPerM2",
        pd.notes,
        pd.created_at           AS "createdAt",
        pd.updated_at           AS "updatedAt",
        COALESCE(
          array_agg(pdr.row_id ORDER BY pdr.row_id) FILTER (WHERE pdr.row_id IS NOT NULL),
          '{}'
        )                       AS "rowIds"
      FROM crop_plant_density pd
      LEFT JOIN crop_plant_density_rows pdr ON pdr.density_id = pd.id
      WHERE pd.crop_id = $1
      GROUP BY pd.id
      ORDER BY pd.created_at DESC
    `, [cropId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/crops/:id/plant-density', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Plant density: create ─────────────────────────────────────────────────────
cropsRouter.post('/:id/plant-density', async (req: Request, res: Response) => {
  const cropId = parseInt(req.params.id, 10);
  if (isNaN(cropId)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { name = 'Plants', plantCount, areaM2: providedAreaM2, notes, rowIds } = req.body as {
    name?: string;
    plantCount: number;
    areaM2?: number;
    notes?: string | null;
    rowIds?: number[];
  };

  if (!plantCount || plantCount <= 0) {
    res.status(400).json({ error: 'plantCount must be a positive number' }); return;
  }

  const hasRowIds = Array.isArray(rowIds) && rowIds.length > 0;
  if (!hasRowIds && (!providedAreaM2 || providedAreaM2 <= 0)) {
    res.status(400).json({ error: 'areaM2 must be a positive number when no rowIds are provided' }); return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // If rowIds provided, compute area from the linked rows only (guards against unlinked rows)
    let areaM2 = providedAreaM2 ?? 0;
    if (hasRowIds) {
      const areaResult = await client.query<{ area_m2: string }>(
        `SELECT ROUND(SUM(gr.width_ft * gr.length_ft * 0.0929)::numeric, 2) AS area_m2
         FROM greenhouse_rows gr
         WHERE gr.id = ANY($1::int[])
           AND gr.id IN (SELECT row_id FROM crop_locations WHERE crop_id = $2)`,
        [rowIds, cropId],
      );
      areaM2 = parseFloat(areaResult.rows[0]?.area_m2 ?? '0');
      if (areaM2 <= 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Selected rows have no area or are not linked to this crop' });
        return;
      }
    }

    // Insert density record
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO crop_plant_density (crop_id, name, plant_count, area_m2, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [cropId, (name || 'Plants').trim(), plantCount, areaM2, notes || null],
    );
    const densityId = rows[0].id;

    // Link rows to this density record
    if (hasRowIds) {
      const vals = (rowIds as number[]).map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO crop_plant_density_rows (density_id, row_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
        [densityId, ...(rowIds as number[])],
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: densityId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/crops/:id/plant-density', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Plant density: delete ─────────────────────────────────────────────────────
cropsRouter.delete('/:id/plant-density/:densityId', async (req: Request, res: Response) => {
  const cropId    = parseInt(req.params.id, 10);
  const densityId = parseInt(req.params.densityId, 10);
  if (isNaN(cropId) || isNaN(densityId)) {
    res.status(400).json({ error: 'Invalid id' }); return;
  }

  try {
    const result = await db.query(
      'DELETE FROM crop_plant_density WHERE id = $1 AND crop_id = $2',
      [densityId, cropId],
    );
    if (!result.rowCount) { res.status(404).json({ error: 'Record not found' }); return; }
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/crops/:id/plant-density/:densityId', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────
cropsRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const DB_COLS: Record<string, string> = {
    name:         'name',
    plantingDate: 'planting_date',
    pullingDate:  'pulling_date',
    archivedAt:   'archived_at',
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

  // Validate pulling >= planting if either is being set
  const body = req.body as Record<string, string | null>;
  const newPulling  = 'pullingDate'  in body ? body.pullingDate  : undefined;
  const newPlanting = 'plantingDate' in body ? body.plantingDate : undefined;
  if (newPulling && newPlanting && newPulling < newPlanting) {
    res.status(400).json({ error: 'Pulling date cannot be before planting date' });
    return;
  }

  sets.push(`updated_at = now()`);

  try {
    params.push(id);
    const result = await db.query(
      `UPDATE crops SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (!result.rowCount) { res.status(404).json({ error: 'Crop not found' }); return; }
    res.json({ id });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'constraint' in err &&
        (err as { constraint: string }).constraint === 'crops_pulling_after_planting') {
      res.status(400).json({ error: 'Pulling date cannot be before planting date' });
      return;
    }
    console.error('PATCH /api/crops/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
