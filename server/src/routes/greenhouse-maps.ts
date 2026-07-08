import { Router, Request, Response } from 'express';
import { db as pool } from '../db';
import {
  blockRowRect,
  blockAlongWallSpan,
  rangesOverlap,
  rectsOverlap,
  walkwayRect,
  EPS,
  type CompGeom,
  type BlockGeom,
  type WkGeom,
  type Rect,
} from '../../../shared/greenhouse-geometry';
import { detectMissingSlots } from '../lib/missing-rows';

export const greenhouseMapsRouter = Router();

const FT2_TO_M2 = 0.09290304;

function rowNums(start: number, end: number, filter: 'all' | 'odd' | 'even'): number[] {
  const nums: number[] = [];
  for (let n = start; n <= end; n++) {
    if (filter === 'odd'  && n % 2 === 0) continue;
    if (filter === 'even' && n % 2 !== 0) continue;
    nums.push(n);
  }
  return nums;
}

// Check that newRects fit inside the compartment and don't overlap existing rows/walkways.
// Pass excludeBlockId to ignore a block that's being replaced/updated.
async function checkOverlap(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  compartmentId: number,
  comp: CompGeom,
  newRects: Rect[],
  excludeBlockId?: number,
): Promise<string | null> {
  // Bounds check
  for (const r of newRects) {
    if (r.x < comp.x_ft - EPS || r.x + r.w > comp.x_ft + comp.east_west_ft + EPS ||
        r.y < comp.y_ft - EPS || r.y + r.h > comp.y_ft + comp.north_south_ft + EPS) {
      return 'Row block extends outside compartment boundaries';
    }
  }

  // Existing rows: use stored x_ft/y_ft/width_ft/length_ft/orientation
  // (handles gaps from deleted rows correctly — no index arithmetic)
  const bq = excludeBlockId
    ? `SELECT gr.x_ft::float, gr.y_ft::float, gr.width_ft::float, gr.length_ft::float, gr.orientation
       FROM greenhouse_rows gr
       JOIN greenhouse_row_blocks rb ON rb.id = gr.block_id
       WHERE rb.compartment_id = $1 AND rb.id != $2`
    : `SELECT gr.x_ft::float, gr.y_ft::float, gr.width_ft::float, gr.length_ft::float, gr.orientation
       FROM greenhouse_rows gr
       JOIN greenhouse_row_blocks rb ON rb.id = gr.block_id
       WHERE rb.compartment_id = $1`;

  const existingRes = await client.query(bq, excludeBlockId ? [compartmentId, excludeBlockId] : [compartmentId]);

  for (const row of existingRes.rows) {
    const isEW = (row.orientation as string) === 'east_west';
    const er: Rect = {
      x: row.x_ft as number,
      y: row.y_ft as number,
      w: isEW ? (row.length_ft as number) : (row.width_ft as number),
      h: isEW ? (row.width_ft as number)  : (row.length_ft as number),
    };
    for (const nr of newRects) {
      if (rectsOverlap(nr, er)) return 'New rows overlap with existing rows';
    }
  }

  // Walkway rects
  const wkRes = await client.query(
    `SELECT orientation, width_ft::float, offset_from_side, offset_ft::float
     FROM greenhouse_walkways WHERE compartment_id = $1`,
    [compartmentId]
  );
  for (const wk of wkRes.rows) {
    const wr = walkwayRect(comp, wk as unknown as WkGeom);
    for (const nr of newRects) {
      if (rectsOverlap(nr, wr)) return 'New rows overlap with a walkway';
    }
  }

  return null;
}

// ── List maps ──────────────────────────────────────────────────────────────────
greenhouseMapsRouter.get('/', async (req: Request, res: Response) => {
  const siteId = req.query.siteId ? Number(req.query.siteId) : null;
  try {
    const { rows } = await pool.query(`
      SELECT gm.id, gm.site_id AS "siteId", s.name AS "siteName", gm.name,
             COUNT(DISTINCT gc.id)::int AS "compartmentCount",
             COUNT(DISTINCT gr.id)::int AS "rowCount",
             gm.created_at AS "createdAt", gm.updated_at AS "updatedAt"
      FROM greenhouse_maps gm
      JOIN sites s ON s.id = gm.site_id
      LEFT JOIN greenhouse_compartments gc ON gc.map_id = gm.id
      LEFT JOIN greenhouse_rows gr ON gr.compartment_id = gc.id
      WHERE ($1::int IS NULL OR gm.site_id = $1)
      GROUP BY gm.id, s.name
      ORDER BY s.name, gm.name
    `, [siteId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list greenhouse maps' });
  }
});

// ── Get map detail ─────────────────────────────────────────────────────────────
greenhouseMapsRouter.get('/:id(\\d+)', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const mapRes = await pool.query(`
      SELECT gm.id, gm.site_id AS "siteId", s.name AS "siteName", gm.name,
             gm.north_extent_ft::float AS "northExtentFt",
             gm.south_extent_ft::float AS "southExtentFt",
             gm.east_extent_ft::float  AS "eastExtentFt",
             gm.west_extent_ft::float  AS "westExtentFt",
             gm.created_at AS "createdAt", gm.updated_at AS "updatedAt"
      FROM greenhouse_maps gm
      JOIN sites s ON s.id = gm.site_id
      WHERE gm.id = $1
    `, [id]);
    if (!mapRes.rows.length) return res.status(404).json({ error: 'Map not found' });

    const compRes = await pool.query(`
      SELECT id, name,
             east_west_ft::float   AS "eastWestFt",  north_south_ft::float AS "northSouthFt",
             x_ft::float           AS "xFt",         y_ft::float           AS "yFt",
             sort_order AS "sortOrder"
      FROM greenhouse_compartments
      WHERE map_id = $1
      ORDER BY sort_order, id
    `, [id]);

    if (!compRes.rows.length) {
      return res.json({ ...mapRes.rows[0], compartments: [] });
    }

    const compIds = compRes.rows.map((c: Record<string, unknown>) => c.id);

    // All blocks for these compartments
    const blockRes = await pool.query(`
      SELECT rb.id, rb.compartment_id AS "compartmentId", rb.orientation,
             rb.anchor_side AS "anchorSide", rb.placement_mode AS "placementMode",
             rb.offset_ft::float          AS "offsetFt",
             rb.row_width_ft::float       AS "rowWidthFt",
             rb.row_length_ft::float      AS "rowLengthFt",
             rb.row_spacing_ft::float     AS "rowSpacingFt",
             rb.along_wall_start          AS "alongWallStart",
             rb.along_wall_offset_ft::float AS "alongWallOffsetFt"
      FROM greenhouse_row_blocks rb
      WHERE rb.compartment_id = ANY($1)
      ORDER BY rb.compartment_id, rb.id
    `, [compIds]);

    const blockIds = blockRes.rows.map((b: Record<string, unknown>) => b.id);

    // All rows keyed by block_id
    const rowsByBlock: Record<number, unknown[]> = {};
    if (blockIds.length) {
      const rowRes = await pool.query(`
        SELECT gr.id, gr.block_id AS "blockId", gr.row_number AS "rowNumber", gr.side,
               gr.width_ft::float   AS "widthFt",  gr.length_ft::float AS "lengthFt",
               gr.x_ft::float       AS "xFt",      gr.y_ft::float      AS "yFt",
               gr.orientation       AS "orientation",
               gr.sort_order AS "sortOrder",
               gr.location_id AS "locationId", l.code AS "locationCode"
        FROM greenhouse_rows gr
        LEFT JOIN locations l ON l.id = gr.location_id
        WHERE gr.block_id = ANY($1)
        ORDER BY gr.block_id, gr.row_number
      `, [blockIds]);
      for (const row of rowRes.rows) {
        const bid = (row as Record<string, unknown>).blockId as number;
        (rowsByBlock[bid] ??= []).push(row);
      }
    }

    // Walkways keyed by compartment_id
    const wkByComp: Record<number, unknown[]> = {};
    const wkRes = await pool.query(`
      SELECT id, compartment_id AS "compartmentId", label, orientation,
             width_ft::float        AS "widthFt",
             offset_from_side       AS "offsetFromSide",
             offset_ft::float       AS "offsetFt",
             x_ft::float            AS "xFt",
             y_ft::float            AS "yFt"
      FROM greenhouse_walkways
      WHERE compartment_id = ANY($1)
      ORDER BY compartment_id, id
    `, [compIds]);
    for (const wk of wkRes.rows) {
      const cid = (wk as Record<string, unknown>).compartmentId as number;
      (wkByComp[cid] ??= []).push(wk);
    }

    const compartments = compRes.rows.map((comp: Record<string, unknown>) => {
      const cid = comp.id as number;
      const blocks = (blockRes.rows as Record<string, unknown>[])
        .filter(b => b.compartmentId === cid)
        .map(block => {
          const bid = block.id as number;
          const rows = (rowsByBlock[bid] ?? []).map((r: unknown) => {
            const row = r as Record<string, unknown>;
            const { blockId: _b, ...rest } = row;
            return rest;
          });
          return { ...block, rows };
        });

      const walkways = (wkByComp[cid] ?? []).map((wk: unknown) => {
        const w = wk as Record<string, unknown>;
        const { compartmentId: _c, ...rest } = w;
        return rest;
      });

      return { ...comp, blocks, walkways };
    });

    res.json({ ...mapRes.rows[0], compartments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get map' });
  }
});

// ── Create map ─────────────────────────────────────────────────────────────────
greenhouseMapsRouter.post('/', async (req: Request, res: Response) => {
  const { siteId, name } = req.body as { siteId: number; name: string };
  if (!siteId || !name?.trim()) return res.status(400).json({ error: 'siteId and name are required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO greenhouse_maps (site_id, name) VALUES ($1, $2)
      RETURNING id, site_id AS "siteId", name, created_at AS "createdAt"
    `, [siteId, name.trim()]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create map' });
  }
});

// ── Update map (name and/or canvas extents) ────────────────────────────────────
greenhouseMapsRouter.patch('/:id(\\d+)', async (req: Request, res: Response) => {
  const { id } = req.params;
  const body = req.body as {
    name?: string;
    northExtentFt?: number;
    southExtentFt?: number;
    eastExtentFt?: number;
    westExtentFt?: number;
  };
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (body.name?.trim())                { sets.push(`name = $${vals.push(body.name.trim())}`); }
  if (body.northExtentFt != null)       { sets.push(`north_extent_ft = $${vals.push(body.northExtentFt)}`); }
  if (body.southExtentFt != null)       { sets.push(`south_extent_ft = $${vals.push(body.southExtentFt)}`); }
  if (body.eastExtentFt  != null)       { sets.push(`east_extent_ft  = $${vals.push(body.eastExtentFt)}`); }
  if (body.westExtentFt  != null)       { sets.push(`west_extent_ft  = $${vals.push(body.westExtentFt)}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const { rows } = await pool.query(
      `UPDATE greenhouse_maps SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, name,
                 north_extent_ft::float AS "northExtentFt",
                 south_extent_ft::float AS "southExtentFt",
                 east_extent_ft::float  AS "eastExtentFt",
                 west_extent_ft::float  AS "westExtentFt",
                 updated_at AS "updatedAt"`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Map not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update map' });
  }
});

// ── Delete map ─────────────────────────────────────────────────────────────────
greenhouseMapsRouter.delete('/:id(\\d+)', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM greenhouse_maps WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete map' });
  }
});

// ── Add compartment ────────────────────────────────────────────────────────────
greenhouseMapsRouter.post('/:mapId(\\d+)/compartments', async (req: Request, res: Response) => {
  const mapId = Number(req.params.mapId);
  const { name, eastWestFt, northSouthFt } = req.body as { name: string; eastWestFt: number; northSouthFt: number };
  if (!name?.trim() || !eastWestFt || !northSouthFt) return res.status(400).json({ error: 'name, eastWestFt, and northSouthFt are required' });
  try {
    const posRes = await pool.query(`
      SELECT COALESCE(MAX(sort_order) + 1, 0) AS "nextSort"
      FROM greenhouse_compartments WHERE map_id = $1
    `, [mapId]);
    const { nextSort } = posRes.rows[0];
    const { rows } = await pool.query(`
      INSERT INTO greenhouse_compartments (map_id, name, east_west_ft, north_south_ft, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name,
                east_west_ft::float   AS "eastWestFt",  north_south_ft::float AS "northSouthFt",
                x_ft::float           AS "xFt",         y_ft::float           AS "yFt",
                sort_order AS "sortOrder"
    `, [mapId, name.trim(), eastWestFt, northSouthFt, nextSort]);
    res.status(201).json({ ...rows[0], blocks: [], walkways: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add compartment' });
  }
});

// ── Update compartment ─────────────────────────────────────────────────────────
greenhouseMapsRouter.patch('/:mapId(\\d+)/compartments/:id(\\d+)', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, eastWestFt, northSouthFt, xFt, yFt } = req.body as {
    name?: string; eastWestFt?: number; northSouthFt?: number; xFt?: number; yFt?: number;
  };

  // Position move — batch-shift all rows in this compartment by delta
  if (xFt != null || yFt != null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currRes = await client.query(
        'SELECT x_ft::float AS x, y_ft::float AS y FROM greenhouse_compartments WHERE id = $1',
        [id],
      );
      if (!currRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Compartment not found' });
      }
      const currX = currRes.rows[0].x as number;
      const currY = currRes.rows[0].y as number;
      const newX  = xFt ?? currX;
      const newY  = yFt ?? currY;
      const dx    = newX - currX;
      const dy    = newY - currY;

      const sets: string[] = ['x_ft = $2', 'y_ft = $3'];
      const vals: unknown[] = [id, newX, newY];
      if (name?.trim())        { vals.push(name.trim());    sets.push(`name = $${vals.length}`); }
      if (eastWestFt  != null) { vals.push(eastWestFt);     sets.push(`east_west_ft = $${vals.length}`); }
      if (northSouthFt != null){ vals.push(northSouthFt);   sets.push(`north_south_ft = $${vals.length}`); }

      const { rows } = await client.query(`
        UPDATE greenhouse_compartments SET ${sets.join(', ')} WHERE id = $1
        RETURNING id, name,
                  east_west_ft::float AS "eastWestFt", north_south_ft::float AS "northSouthFt",
                  x_ft::float AS "xFt", y_ft::float AS "yFt"
      `, vals);

      if (dx !== 0 || dy !== 0) {
        await client.query(
          'UPDATE greenhouse_rows SET x_ft = x_ft + $1, y_ft = y_ft + $2 WHERE compartment_id = $3',
          [dx, dy, id],
        );
      }

      await client.query('COMMIT');
      return res.json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      return res.status(500).json({ error: 'Failed to move compartment' });
    } finally {
      client.release();
    }
  }

  // Non-position update (name / dimensions only)
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (name?.trim())        { vals.push(name.trim());    sets.push(`name = $${vals.length}`); }
  if (eastWestFt  != null) { vals.push(eastWestFt);     sets.push(`east_west_ft = $${vals.length}`); }
  if (northSouthFt != null){ vals.push(northSouthFt);   sets.push(`north_south_ft = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  try {
    const { rows } = await pool.query(`
      UPDATE greenhouse_compartments SET ${sets.join(', ')} WHERE id = $1
      RETURNING id, name,
                east_west_ft::float AS "eastWestFt", north_south_ft::float AS "northSouthFt",
                x_ft::float AS "xFt", y_ft::float AS "yFt"
    `, vals);
    if (!rows.length) return res.status(404).json({ error: 'Compartment not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update compartment' });
  }
});

// ── Delete compartment ─────────────────────────────────────────────────────────
greenhouseMapsRouter.delete('/:mapId(\\d+)/compartments/:id(\\d+)', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM greenhouse_compartments WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete compartment' });
  }
});

// ── Create row block ───────────────────────────────────────────────────────────
greenhouseMapsRouter.post(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/blocks',
  async (req: Request, res: Response) => {
    const compartmentId = Number(req.params.compartmentId);
    const {
      orientation, anchorSide, placementMode = 'edge',
      offsetFt: rawOffsetFt = 0,
      startRow, endRow, filter = 'all',
      rowWidthFt, rowLengthFt, rowSpacingFt = 0,
      alongWallStart = 'near', alongWallOffsetFt = 0,
    } = req.body as {
      orientation: string; anchorSide: string; placementMode?: string;
      offsetFt?: number; startRow: number; endRow: number; filter?: string;
      rowWidthFt: number; rowLengthFt: number; rowSpacingFt?: number;
      alongWallStart?: string; alongWallOffsetFt?: number;
    };

    if (!['north_south', 'east_west'].includes(orientation))
      return res.status(400).json({ error: 'orientation must be north_south or east_west' });
    if (!['north', 'east', 'south', 'west'].includes(anchorSide))
      return res.status(400).json({ error: 'Invalid anchorSide' });
    if (orientation === 'north_south' && !['east', 'west'].includes(anchorSide))
      return res.status(400).json({ error: 'north_south rows must be anchored to east or west' });
    if (orientation === 'east_west' && !['north', 'south'].includes(anchorSide))
      return res.status(400).json({ error: 'east_west rows must be anchored to north or south' });
    if (!['all', 'odd', 'even'].includes(filter))
      return res.status(400).json({ error: 'filter must be all, odd, or even' });
    if (!['near', 'far', 'centered', 'custom'].includes(alongWallStart))
      return res.status(400).json({ error: 'alongWallStart must be near, far, centered, or custom' });
    if (startRow == null || endRow == null || rowWidthFt == null || rowLengthFt == null)
      return res.status(400).json({ error: 'startRow, endRow, rowWidthFt, rowLengthFt are required' });
    if (endRow < startRow)
      return res.status(400).json({ error: 'endRow must be >= startRow' });
    if (endRow - startRow > 999)
      return res.status(400).json({ error: 'Too many rows (max 1000)' });

    const nums = rowNums(startRow, endRow, filter as 'all' | 'odd' | 'even');
    if (!nums.length) return res.status(400).json({ error: 'No rows match range and filter' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get compartment + site
      const compRes = await client.query(`
        SELECT gc.x_ft::float, gc.y_ft::float, gc.east_west_ft::float, gc.north_south_ft::float, gm.site_id
        FROM greenhouse_compartments gc
        JOIN greenhouse_maps gm ON gm.id = gc.map_id
        WHERE gc.id = $1
      `, [compartmentId]);
      if (!compRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Compartment not found' });
      }
      const { site_id, ...comp } = compRes.rows[0] as Record<string, unknown>;
      const compGeom = comp as unknown as CompGeom;

      // ── Compute offsetFt for 'continue' mode ───────────────────────────────
      let offsetFt = rawOffsetFt;
      if (placementMode === 'continue') {
        // Fetch same-anchor same-orientation blocks with:
        //   - along-wall geometry (to filter by span overlap)
        //   - actual occupied depth from STORED row coordinates
        //     (not from row count, so gaps from deleted rows are handled correctly)
        const candidateRes = await client.query(`
          SELECT
            rb.along_wall_start,
            rb.along_wall_offset_ft::float,
            rb.row_length_ft::float,
            CASE rb.anchor_side
              WHEN 'south' THEN (gc.y_ft + gc.north_south_ft)::float - MIN(gr.y_ft)::float
              WHEN 'north' THEN MAX(gr.y_ft + gr.width_ft)::float   - gc.y_ft::float
              WHEN 'east'  THEN (gc.x_ft + gc.east_west_ft)::float  - MIN(gr.x_ft)::float
              WHEN 'west'  THEN MAX(gr.x_ft + gr.width_ft)::float   - gc.x_ft::float
            END AS actual_depth,
            COUNT(gr.id)::int AS row_count
          FROM greenhouse_row_blocks rb
          JOIN greenhouse_compartments gc ON gc.id = rb.compartment_id
          LEFT JOIN greenhouse_rows gr ON gr.block_id = rb.id
          WHERE rb.compartment_id = $1 AND rb.anchor_side = $2 AND rb.orientation = $3
          GROUP BY rb.id, gc.y_ft, gc.north_south_ft, gc.x_ft, gc.east_west_ft
        `, [compartmentId, anchorSide, orientation]);

        // The new block's along-wall span (offset_ft irrelevant for span calc).
        const newSpanGeom: BlockGeom = {
          orientation,
          anchor_side: anchorSide,
          offset_ft: 0,
          row_width_ft: rowWidthFt,
          row_length_ft: rowLengthFt,
          row_spacing_ft: rowSpacingFt,
          along_wall_start: alongWallStart,
          along_wall_offset_ft: alongWallOffsetFt,
        };
        const newBlockSpan = blockAlongWallSpan(compGeom, newSpanGeom);

        let maxOccupied = 0;
        for (const b of candidateRes.rows) {
          const cnt = b.row_count as number;
          if (!cnt) continue;

          // Only continue after blocks whose along-wall span overlaps ours.
          const existingGeom: BlockGeom = {
            orientation,
            anchor_side: anchorSide,
            offset_ft: 0,
            row_width_ft: 0,
            row_length_ft: b.row_length_ft as number,
            row_spacing_ft: 0,
            along_wall_start:     (b.along_wall_start as string) ?? 'near',
            along_wall_offset_ft: (b.along_wall_offset_ft as number) ?? 0,
          };
          const existingSpan = blockAlongWallSpan(compGeom, existingGeom);
          if (!rangesOverlap(newBlockSpan, existingSpan)) continue;

          const depth = (b.actual_depth as number | null) ?? 0;
          if (depth > maxOccupied) maxOccupied = depth;
        }

        offsetFt = maxOccupied;
      }

      const blockGeom: BlockGeom = {
        orientation, anchor_side: anchorSide, offset_ft: offsetFt,
        row_width_ft: rowWidthFt, row_length_ft: rowLengthFt, row_spacing_ft: rowSpacingFt,
        along_wall_start: alongWallStart, along_wall_offset_ft: alongWallOffsetFt,
      };
      const newRects = nums.map((_, i) => blockRowRect(compGeom, blockGeom, i));

      const overlapErr = await checkOverlap(client, compartmentId, compGeom, newRects);
      if (overlapErr) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: overlapErr });
      }

      // Create block
      const blockRes = await client.query(`
        INSERT INTO greenhouse_row_blocks
          (compartment_id, orientation, anchor_side, placement_mode, offset_ft,
           row_width_ft, row_length_ft, row_spacing_ft, along_wall_start, along_wall_offset_ft)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, orientation, anchor_side AS "anchorSide",
                  placement_mode AS "placementMode",
                  offset_ft::float           AS "offsetFt",
                  row_width_ft::float        AS "rowWidthFt",
                  row_length_ft::float       AS "rowLengthFt",
                  row_spacing_ft::float      AS "rowSpacingFt",
                  along_wall_start           AS "alongWallStart",
                  along_wall_offset_ft::float AS "alongWallOffsetFt"
      `, [compartmentId, orientation, anchorSide, placementMode, offsetFt,
          rowWidthFt, rowLengthFt, rowSpacingFt, alongWallStart, alongWallOffsetFt]);
      const block = blockRes.rows[0];
      const blockId = block.id as number;

      // Create locations + rows, storing computed physical coordinates per row
      let created = 0;
      const createdRows: unknown[] = [];
      for (let i = 0; i < nums.length; i++) {
        const num = nums[i];
        const code = `R${String(num).padStart(3, '0')}`;
        const netAreaM2 = Math.round(rowWidthFt * rowLengthFt * FT2_TO_M2 * 100) / 100;
        await client.query(`
          INSERT INTO locations (site_id, code, name, sort_order, net_area_m2)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (site_id, code) DO UPDATE SET net_area_m2 = EXCLUDED.net_area_m2
          WHERE locations.net_area_m2 IS NULL
        `, [site_id, code, `Row ${num}`, num, netAreaM2]);
        const locRes = await client.query('SELECT id FROM locations WHERE site_id = $1 AND code = $2', [site_id, code]);
        const locationId = locRes.rows[0].id;

        // Compute this row's fixed physical position (idx = i, sequential within the new block)
        const rect = blockRowRect(compGeom, blockGeom, i);

        const rowRes = await client.query(`
          INSERT INTO greenhouse_rows
            (compartment_id, block_id, row_number, side, width_ft, length_ft,
             x_ft, y_ft, orientation, sort_order, location_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT DO NOTHING
          RETURNING id, row_number AS "rowNumber", side,
                    width_ft::float AS "widthFt", length_ft::float AS "lengthFt",
                    x_ft::float AS "xFt", y_ft::float AS "yFt",
                    orientation AS "orientation",
                    sort_order AS "sortOrder", location_id AS "locationId"
        `, [compartmentId, blockId, num, anchorSide, rowWidthFt, rowLengthFt,
            rect.x, rect.y, orientation, num, locationId]);

        if ((rowRes.rowCount ?? 0) > 0) {
          created++;
          createdRows.push({ ...rowRes.rows[0], locationCode: code });
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ ...block, rows: createdRows, created, skipped: nums.length - created, total: nums.length });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed to create row block' });
    } finally {
      client.release();
    }
  }
);

// ── Delete row block ───────────────────────────────────────────────────────────
greenhouseMapsRouter.delete(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/blocks/:blockId(\\d+)',
  async (req: Request, res: Response) => {
    const { blockId } = req.params;
    try {
      await pool.query('DELETE FROM greenhouse_row_blocks WHERE id = $1', [blockId]);
      res.status(204).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete row block' });
    }
  }
);

// ── Create walkway ─────────────────────────────────────────────────────────────
greenhouseMapsRouter.post(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/walkways',
  async (req: Request, res: Response) => {
    const compartmentId = Number(req.params.compartmentId);
    const { orientation, widthFt, offsetFromSide = 'centered', offsetFt = 0, label } =
      req.body as { orientation: string; widthFt: number; offsetFromSide?: string; offsetFt?: number; label?: string };

    if (!['north_south', 'east_west'].includes(orientation))
      return res.status(400).json({ error: 'orientation must be north_south or east_west' });
    if (!widthFt) return res.status(400).json({ error: 'widthFt is required' });
    if (!['north', 'east', 'south', 'west', 'centered'].includes(offsetFromSide))
      return res.status(400).json({ error: 'Invalid offsetFromSide' });

    try {
      const compRes = await pool.query(`
        SELECT x_ft::float, y_ft::float, east_west_ft::float, north_south_ft::float
        FROM greenhouse_compartments WHERE id = $1
      `, [compartmentId]);
      if (!compRes.rows.length) return res.status(404).json({ error: 'Compartment not found' });

      const comp = compRes.rows[0] as unknown as CompGeom;
      const wkGeom: WkGeom = { orientation, width_ft: widthFt, offset_from_side: offsetFromSide, offset_ft: offsetFt };
      const rect = walkwayRect(comp, wkGeom);

      const { rows } = await pool.query(`
        INSERT INTO greenhouse_walkways
          (compartment_id, label, orientation, width_ft, offset_from_side, offset_ft, x_ft, y_ft)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, label, orientation,
                  width_ft::float        AS "widthFt",
                  offset_from_side       AS "offsetFromSide",
                  offset_ft::float       AS "offsetFt",
                  x_ft::float            AS "xFt",
                  y_ft::float            AS "yFt"
      `, [compartmentId, label ?? null, orientation, widthFt, offsetFromSide, offsetFt, rect.x - comp.x_ft, rect.y - comp.y_ft]);

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create walkway' });
    }
  }
);

// ── Delete walkway ─────────────────────────────────────────────────────────────
greenhouseMapsRouter.delete(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/walkways/:walkwayId(\\d+)',
  async (req: Request, res: Response) => {
    const { walkwayId } = req.params;
    try {
      await pool.query('DELETE FROM greenhouse_walkways WHERE id = $1', [walkwayId]);
      res.status(204).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete walkway' });
    }
  }
);

// ── Quick layout: rows on both sides of a center walkway ───────────────────────
greenhouseMapsRouter.post(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/layout/both-sides',
  async (req: Request, res: Response) => {
    const compartmentId = Number(req.params.compartmentId);
    const {
      orientation, walkwayWidthFt = 0,
      rowWidthFt, rowLengthFt, rowSpacingFt = 0,
      sideA, sideB,
    } = req.body as {
      orientation: string;
      walkwayWidthFt?: number;
      rowWidthFt: number;
      rowLengthFt: number;
      rowSpacingFt?: number;
      sideA: { anchorSide: string; startRow: number; endRow: number; filter?: string };
      sideB: { anchorSide: string; startRow: number; endRow: number; filter?: string };
    };

    if (!['north_south', 'east_west'].includes(orientation))
      return res.status(400).json({ error: 'Invalid orientation' });
    if (!sideA || !sideB) return res.status(400).json({ error: 'sideA and sideB are required' });

    const validSides = orientation === 'north_south' ? ['east', 'west'] : ['north', 'south'];
    if (!validSides.includes(sideA.anchorSide) || !validSides.includes(sideB.anchorSide))
      return res.status(400).json({ error: `Both sides must be ${validSides.join(' or ')} for ${orientation} orientation` });
    if (sideA.anchorSide === sideB.anchorSide)
      return res.status(400).json({ error: 'sideA and sideB must use different anchor walls' });

    const numsA = rowNums(sideA.startRow, sideA.endRow, (sideA.filter ?? 'all') as 'all' | 'odd' | 'even');
    const numsB = rowNums(sideB.startRow, sideB.endRow, (sideB.filter ?? 'all') as 'all' | 'odd' | 'even');
    if (!numsA.length || !numsB.length) return res.status(400).json({ error: 'Both sides must have at least one row' });

    const step = rowWidthFt + rowSpacingFt;
    const widthA = rowWidthFt + (numsA.length - 1) * step;
    const widthB = rowWidthFt + (numsB.length - 1) * step;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const compRes = await client.query(`
        SELECT gc.x_ft::float, gc.y_ft::float, gc.east_west_ft::float, gc.north_south_ft::float, gm.site_id
        FROM greenhouse_compartments gc
        JOIN greenhouse_maps gm ON gm.id = gc.map_id
        WHERE gc.id = $1
      `, [compartmentId]);
      if (!compRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Compartment not found' }); }

      const { site_id, ...comp } = compRes.rows[0] as Record<string, unknown>;
      const compGeom = comp as unknown as CompGeom;
      const perpDim = orientation === 'north_south' ? (comp.east_west_ft as number) : (comp.north_south_ft as number);

      if (widthA + walkwayWidthFt + widthB > perpDim + EPS)
        return res.status(409).json({ error: `Total width (${(widthA + walkwayWidthFt + widthB).toFixed(1)} ft) exceeds compartment ${orientation === 'north_south' ? 'width' : 'length'} (${perpDim} ft)` });

      // Create walkway
      let walkwayId: number | null = null;
      if (walkwayWidthFt > 0) {
        const wkGeom: WkGeom = { orientation, width_ft: walkwayWidthFt, offset_from_side: 'centered', offset_ft: 0 };
        const wr = walkwayRect(compGeom, wkGeom);
        const wkRes = await client.query(`
          INSERT INTO greenhouse_walkways (compartment_id, label, orientation, width_ft, offset_from_side, offset_ft, x_ft, y_ft)
          VALUES ($1, 'Center Walkway', $2, $3, 'centered', 0, $4, $5)
          RETURNING id
        `, [compartmentId, orientation, walkwayWidthFt, wr.x - (comp.x_ft as number), wr.y - (comp.y_ft as number)]);
        walkwayId = wkRes.rows[0].id as number;
      }

      // Helper to create a block + rows with stored physical coordinates
      const createBlock = async (anchorSide: string, nums: number[]) => {
        const geom: BlockGeom = {
          orientation, anchor_side: anchorSide, offset_ft: 0,
          row_width_ft: rowWidthFt, row_length_ft: rowLengthFt, row_spacing_ft: rowSpacingFt,
          along_wall_start: 'near', along_wall_offset_ft: 0,
        };
        const newRects = nums.map((_, i) => blockRowRect(compGeom, geom, i));
        const overlapErr = await checkOverlap(client, compartmentId, compGeom, newRects);
        if (overlapErr) throw new Error(overlapErr);

        const bRes = await client.query(`
          INSERT INTO greenhouse_row_blocks
            (compartment_id, orientation, anchor_side, placement_mode, offset_ft,
             row_width_ft, row_length_ft, row_spacing_ft, along_wall_start, along_wall_offset_ft)
          VALUES ($1, $2, $3, 'edge', 0, $4, $5, $6, 'near', 0)
          RETURNING id, orientation, anchor_side AS "anchorSide", placement_mode AS "placementMode",
                    offset_ft::float AS "offsetFt", row_width_ft::float AS "rowWidthFt",
                    row_length_ft::float AS "rowLengthFt", row_spacing_ft::float AS "rowSpacingFt",
                    along_wall_start AS "alongWallStart", along_wall_offset_ft::float AS "alongWallOffsetFt"
        `, [compartmentId, orientation, anchorSide, rowWidthFt, rowLengthFt, rowSpacingFt]);
        const block = bRes.rows[0];
        const blockId = block.id as number;

        const rows: unknown[] = [];
        for (let i = 0; i < nums.length; i++) {
          const num = nums[i];
          const code = `R${String(num).padStart(3, '0')}`;
          const netAreaM2 = Math.round(rowWidthFt * rowLengthFt * FT2_TO_M2 * 100) / 100;
          await client.query(`
            INSERT INTO locations (site_id, code, name, sort_order, net_area_m2)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (site_id, code) DO UPDATE SET net_area_m2 = EXCLUDED.net_area_m2
            WHERE locations.net_area_m2 IS NULL
          `, [site_id, code, `Row ${num}`, num, netAreaM2]);
          const locRes = await client.query('SELECT id FROM locations WHERE site_id = $1 AND code = $2', [site_id, code]);
          const locationId = locRes.rows[0].id;
          const rect = newRects[i];
          const rRes = await client.query(`
            INSERT INTO greenhouse_rows
              (compartment_id, block_id, row_number, side, width_ft, length_ft,
               x_ft, y_ft, orientation, sort_order, location_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT DO NOTHING
            RETURNING id, row_number AS "rowNumber"
          `, [compartmentId, blockId, num, anchorSide, rowWidthFt, rowLengthFt,
              rect.x, rect.y, orientation, num, locationId]);
          if ((rRes.rowCount ?? 0) > 0) rows.push(rRes.rows[0]);
        }
        return { ...block, rows };
      };

      const blockA = await createBlock(sideA.anchorSide, numsA);
      const blockB = await createBlock(sideB.anchorSide, numsB);

      await client.query('COMMIT');
      res.status(201).json({ walkwayId, blockA, blockB });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      const msg = err instanceof Error ? err.message : 'Failed to create layout';
      res.status(msg.includes('overlap') || msg.includes('boundaries') ? 409 : 500).json({ error: msg });
    } finally {
      client.release();
    }
  }
);

// ── List missing physical row slots in a block ────────────────────────────────
greenhouseMapsRouter.get(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/blocks/:blockId(\\d+)/missing-rows',
  async (req: Request, res: Response) => {
    const { blockId, compartmentId } = req.params;
    try {
      const blockRes = await pool.query(`
        SELECT anchor_side, orientation,
               row_width_ft::float, row_length_ft::float, row_spacing_ft::float
        FROM greenhouse_row_blocks
        WHERE id = $1 AND compartment_id = $2
      `, [blockId, compartmentId]);
      if (!blockRes.rows.length) return res.status(404).json({ error: 'Block not found' });

      const rowsRes = await pool.query(`
        SELECT row_number, x_ft::float, y_ft::float,
               width_ft::float, length_ft::float, orientation
        FROM greenhouse_rows
        WHERE block_id = $1
        ORDER BY row_number
      `, [blockId]);

      const missing = detectMissingSlots(
        blockRes.rows[0] as Parameters<typeof detectMissingSlots>[0],
        rowsRes.rows as Parameters<typeof detectMissingSlots>[1],
      );
      res.json({ missing });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to detect missing rows' });
    }
  },
);

// ── Insert a single row into an existing block ────────────────────────────────
// Used to restore a deleted row at its original physical position.
// Never renumbers or shifts any other row.
greenhouseMapsRouter.post(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/blocks/:blockId(\\d+)/rows',
  async (req: Request, res: Response) => {
    const mapId        = Number(req.params.mapId);
    const compartmentId = Number(req.params.compartmentId);
    const blockId      = Number(req.params.blockId);
    const { rowNumber, xFt, yFt, widthFt, lengthFt, orientation } =
      req.body as {
        rowNumber: unknown;
        xFt: unknown; yFt: unknown;
        widthFt: unknown; lengthFt: unknown;
        orientation: unknown;
      };

    if (typeof rowNumber !== 'number' || !Number.isInteger(rowNumber) || rowNumber < 1)
      return res.status(400).json({ error: 'rowNumber must be a positive integer' });
    if (typeof xFt !== 'number' || typeof yFt !== 'number')
      return res.status(400).json({ error: 'xFt and yFt are required numbers' });
    if (typeof widthFt !== 'number' || widthFt <= 0)
      return res.status(400).json({ error: 'widthFt must be a positive number' });
    if (typeof lengthFt !== 'number' || lengthFt <= 0)
      return res.status(400).json({ error: 'lengthFt must be a positive number' });
    if (!['north_south', 'east_west'].includes(orientation as string))
      return res.status(400).json({ error: 'orientation must be north_south or east_west' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Load block + compartment + site
      const ctxRes = await client.query(`
        SELECT gc.x_ft::float, gc.y_ft::float,
               gc.east_west_ft::float, gc.north_south_ft::float,
               gm.site_id,
               rb.anchor_side
        FROM greenhouse_row_blocks rb
        JOIN greenhouse_compartments gc ON gc.id = rb.compartment_id
        JOIN greenhouse_maps gm ON gm.id = gc.map_id
        WHERE rb.id = $1 AND rb.compartment_id = $2 AND gc.map_id = $3
      `, [blockId, compartmentId, mapId]);
      if (!ctxRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Block not found in this map/compartment' });
      }
      const { site_id, anchor_side, ...compRaw } = ctxRes.rows[0] as Record<string, unknown>;
      const comp = compRaw as unknown as CompGeom;

      // Row number uniqueness: must not already exist in any map for this site
      const dupRes = await client.query(`
        SELECT 1
        FROM greenhouse_rows gr
        JOIN greenhouse_row_blocks rb ON rb.id = gr.block_id
        JOIN greenhouse_compartments gc ON gc.id = rb.compartment_id
        JOIN greenhouse_maps gm ON gm.id = gc.map_id
        WHERE gm.site_id = $1 AND gr.row_number = $2
        LIMIT 1
      `, [site_id, rowNumber]);
      if (dupRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Row ${rowNumber} already exists in this site` });
      }

      // Compartment bounds check
      const newRect: Rect = {
        x: xFt as number, y: yFt as number,
        w: (orientation as string) === 'east_west' ? (lengthFt as number) : (widthFt as number),
        h: (orientation as string) === 'east_west' ? (widthFt as number)  : (lengthFt as number),
      };
      if (newRect.x < comp.x_ft - EPS || newRect.x + newRect.w > comp.x_ft + comp.east_west_ft + EPS ||
          newRect.y < comp.y_ft - EPS || newRect.y + newRect.h > comp.y_ft + comp.north_south_ft + EPS) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Row position is outside compartment boundaries' });
      }

      // Collision check against all existing rows in this compartment
      const overlapErr = await checkOverlap(client, compartmentId, comp, [newRect]);
      if (overlapErr) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: overlapErr });
      }

      // Create or find location — if previously archived, restore it
      const code = `R${String(rowNumber).padStart(3, '0')}`;
      const netAreaM2 = Math.round((widthFt as number) * (lengthFt as number) * FT2_TO_M2 * 100) / 100;
      await client.query(`
        INSERT INTO locations (site_id, code, name, sort_order, net_area_m2)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (site_id, code) DO UPDATE SET net_area_m2 = EXCLUDED.net_area_m2
        WHERE locations.net_area_m2 IS NULL
      `, [site_id, code, `Row ${rowNumber}`, rowNumber, netAreaM2]);

      const locRes = await client.query(
        'SELECT id FROM locations WHERE site_id = $1 AND code = $2',
        [site_id, code],
      );
      if (!locRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Failed to create location' });
      }
      const locationId = locRes.rows[0].id as number;

      // Un-archive the location if it was soft-deleted by a previous row deletion
      await client.query(
        'UPDATE locations SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL',
        [locationId],
      );

      // Insert the row at the specified physical position
      const rowRes = await client.query(`
        INSERT INTO greenhouse_rows
          (compartment_id, block_id, row_number, side, width_ft, length_ft,
           x_ft, y_ft, orientation, sort_order, location_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, row_number AS "rowNumber", side,
                  width_ft::float AS "widthFt", length_ft::float AS "lengthFt",
                  x_ft::float AS "xFt", y_ft::float AS "yFt",
                  orientation AS "orientation",
                  sort_order AS "sortOrder", location_id AS "locationId"
      `, [compartmentId, blockId, rowNumber, anchor_side, widthFt, lengthFt,
          xFt, yFt, orientation, rowNumber, locationId]);

      await client.query('COMMIT');
      res.status(201).json({ ...rowRes.rows[0], locationCode: code });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed to insert row' });
    } finally {
      client.release();
    }
  },
);

// ── Delete single row ──────────────────────────────────────────────────────────
greenhouseMapsRouter.delete(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/rows/:rowId(\\d+)',
  async (req: Request, res: Response) => {
    const { rowId } = req.params;
    try {
      await pool.query('DELETE FROM greenhouse_rows WHERE id = $1', [rowId]);
      res.status(204).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete row' });
    }
  }
);

// ── Bulk delete rows ───────────────────────────────────────────────────────────
// Rows with labour history are soft-deleted (location archived, row removed from map).
// Rows with no history are hard-deleted (row + location removed).
greenhouseMapsRouter.delete(
  '/:mapId(\\d+)/rows',
  async (req: Request, res: Response) => {
    const mapId = Number(req.params.mapId);
    const { rowIds } = req.body as { rowIds?: unknown };

    if (!Array.isArray(rowIds) || rowIds.length === 0)
      return res.status(400).json({ error: 'rowIds must be a non-empty array' });
    if (rowIds.length > 500)
      return res.status(400).json({ error: 'Cannot delete more than 500 rows at once' });

    const typedIds = (rowIds as unknown[]).filter(x => typeof x === 'number') as number[];
    if (!typedIds.length)
      return res.status(400).json({ error: 'rowIds must contain numbers' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify all rowIds belong to this map (security + data integrity)
      const validRes = await client.query(`
        SELECT gr.id, gr.location_id
        FROM greenhouse_rows gr
        JOIN greenhouse_row_blocks rb ON rb.id = gr.block_id
        JOIN greenhouse_compartments gc ON gc.id = rb.compartment_id
        WHERE gr.id = ANY($1) AND gc.map_id = $2
      `, [typedIds, mapId]);

      const validRows = validRes.rows as { id: number; location_id: number | null }[];
      const notFound  = typedIds.length - validRows.length;

      let deleted  = 0;
      let archived = 0;
      const processedLocIds = new Set<number>();

      for (const row of validRows) {
        // Remove the map record first (always)
        await client.query('DELETE FROM greenhouse_rows WHERE id = $1', [row.id]);

        if (row.location_id == null) {
          deleted++;
          continue;
        }

        if (processedLocIds.has(row.location_id)) {
          deleted++;
          continue;
        }
        processedLocIds.add(row.location_id);

        // Check for labour history on this location
        const regHit = await client.query(
          'SELECT 1 FROM work_registrations WHERE location_id = $1 LIMIT 1',
          [row.location_id]
        );
        const evtHit = regHit.rows.length === 0
          ? await client.query('SELECT 1 FROM work_events WHERE location_id = $1 LIMIT 1', [row.location_id])
          : { rows: [1] };

        if (regHit.rows.length > 0 || evtHit.rows.length > 0) {
          await client.query(
            'UPDATE locations SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL',
            [row.location_id]
          );
          archived++;
        } else {
          const otherRef = await client.query(
            'SELECT 1 FROM greenhouse_rows WHERE location_id = $1 LIMIT 1',
            [row.location_id]
          );
          if (otherRef.rows.length === 0) {
            await client.query('DELETE FROM locations WHERE id = $1', [row.location_id]);
          }
          deleted++;
        }
      }

      await client.query('COMMIT');
      res.json({ deleted, archived, total: deleted + archived, notFound });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed to delete rows' });
    } finally {
      client.release();
    }
  }
);

// ── Legacy: batch add rows (creates a block internally) ────────────────────────
greenhouseMapsRouter.post(
  '/:mapId(\\d+)/compartments/:compartmentId(\\d+)/rows/batch',
  async (req: Request, res: Response) => {
    const compartmentId = Number(req.params.compartmentId);
    const { startRow, endRow, filter = 'all', side, widthFt, lengthFt } = req.body as {
      startRow: number; endRow: number; filter?: string;
      side: string; widthFt: number; lengthFt: number;
    };

    if (!['north', 'south', 'east', 'west'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
    if (endRow < startRow) return res.status(400).json({ error: 'endRow must be >= startRow' });

    const orientation = ['east', 'west'].includes(side) ? 'north_south' : 'east_west';
    const nums = rowNums(startRow, endRow, filter as 'all' | 'odd' | 'even');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const compRes = await client.query(`
        SELECT gc.x_ft::float, gc.y_ft::float, gc.east_west_ft::float, gc.north_south_ft::float, gm.site_id
        FROM greenhouse_compartments gc
        JOIN greenhouse_maps gm ON gm.id = gc.map_id
        WHERE gc.id = $1
      `, [compartmentId]);
      if (!compRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Compartment not found' }); }

      const { site_id, ...comp } = compRes.rows[0] as Record<string, unknown>;
      const compGeomLeg = comp as unknown as CompGeom;

      // Find or create a block for this (compartment, orientation, side) combination
      const existingBlock = await client.query(`
        SELECT id, offset_ft::float, row_width_ft::float, row_length_ft::float,
               row_spacing_ft::float, along_wall_start, along_wall_offset_ft::float
        FROM greenhouse_row_blocks
        WHERE compartment_id = $1 AND anchor_side = $2 AND orientation = $3
        LIMIT 1
      `, [compartmentId, side, orientation]);

      let blockId: number;
      let legacyGeom: BlockGeom;
      if (existingBlock.rows.length) {
        blockId = existingBlock.rows[0].id as number;
        legacyGeom = {
          orientation,
          anchor_side: side,
          offset_ft:            existingBlock.rows[0].offset_ft as number,
          row_width_ft:         existingBlock.rows[0].row_width_ft as number,
          row_length_ft:        existingBlock.rows[0].row_length_ft as number,
          row_spacing_ft:       existingBlock.rows[0].row_spacing_ft as number,
          along_wall_start:     (existingBlock.rows[0].along_wall_start as string) ?? 'near',
          along_wall_offset_ft: (existingBlock.rows[0].along_wall_offset_ft as number) ?? 0,
        };
      } else {
        const bRes = await client.query(`
          INSERT INTO greenhouse_row_blocks
            (compartment_id, orientation, anchor_side, placement_mode, offset_ft, row_width_ft, row_length_ft)
          VALUES ($1, $2, $3, 'edge', 0, $4, $5)
          RETURNING id
        `, [compartmentId, orientation, side, widthFt, lengthFt]);
        blockId = bRes.rows[0].id as number;
        legacyGeom = {
          orientation,
          anchor_side: side,
          offset_ft: 0, row_width_ft: widthFt, row_length_ft: lengthFt,
          row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
        };
      }

      // Starting idx = how many rows already exist in this block
      const existingCountRes = await client.query(
        'SELECT COUNT(*)::int AS cnt FROM greenhouse_rows WHERE block_id = $1',
        [blockId]
      );
      let idxOffset = existingCountRes.rows[0].cnt as number;

      let created = 0;
      for (let i = 0; i < nums.length; i++) {
        const num = nums[i];
        const code = `R${String(num).padStart(3, '0')}`;
        const netAreaM2 = Math.round(widthFt * lengthFt * FT2_TO_M2 * 100) / 100;
        await client.query(`
          INSERT INTO locations (site_id, code, name, sort_order, net_area_m2)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (site_id, code) DO UPDATE SET net_area_m2 = EXCLUDED.net_area_m2
          WHERE locations.net_area_m2 IS NULL
        `, [site_id, code, `Row ${num}`, num, netAreaM2]);
        const locRes = await client.query('SELECT id FROM locations WHERE site_id = $1 AND code = $2', [site_id, code]);
        const rect = blockRowRect(compGeomLeg, legacyGeom, idxOffset + i);
        const rRes = await client.query(`
          INSERT INTO greenhouse_rows
            (compartment_id, block_id, row_number, side, width_ft, length_ft,
             x_ft, y_ft, orientation, sort_order, location_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT DO NOTHING
        `, [compartmentId, blockId, num, side, widthFt, lengthFt,
            rect.x, rect.y, orientation, num, locRes.rows[0].id]);
        if ((rRes.rowCount ?? 0) > 0) { created++; idxOffset++; }
      }

      await client.query('COMMIT');
      res.json({ created, skipped: nums.length - created, total: nums.length });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed to batch-add rows' });
    } finally {
      client.release();
    }
  }
);
