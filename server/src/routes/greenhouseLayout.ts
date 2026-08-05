import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  BatchParams,
  RowRect,
  generateRowPreview,
  detectRowOverlap,
  validateRowsInsidePhase,
  isValidSide,
  isValidNumberingMode,
} from "../lib/rowLayout";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function parsePositiveNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseNonNegativeNumber(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// -- shared query pieces -----------------------------------------------------

const LAND_LIST_SELECT = `
  select gl.id, gl.name, gl.north_south_feet, gl.east_west_feet, gl.is_active, gl.created_at, gl.updated_at,
         coalesce(p.phase_count, 0) as phase_count
  from greenhouse_lands gl
  left join lateral (
    select count(*) as phase_count from greenhouse_phases gp where gp.land_id = gl.id
  ) p on true
`;

const LAND_DETAIL_SELECT = `
  select gl.id, gl.name, gl.north_south_feet, gl.east_west_feet, gl.is_active, gl.created_at, gl.updated_at,
         coalesce(p.phases, '[]'::json) as phases
  from greenhouse_lands gl
  left join lateral (
    select json_agg(json_build_object(
             'id', gp.id,
             'landId', gp.land_id,
             'name', gp.name,
             'description', gp.description,
             'northSouthFeet', gp.north_south_feet,
             'eastWestFeet', gp.east_west_feet,
             'xFeetFromWest', gp.x_feet_from_west,
             'yFeetFromNorth', gp.y_feet_from_north,
             'isActive', gp.is_active,
             'sortOrder', gp.sort_order,
             'createdAt', gp.created_at,
             'updatedAt', gp.updated_at
           ) order by gp.sort_order nulls last, gp.created_at) as phases
    from greenhouse_phases gp
    where gp.land_id = gl.id
  ) p on true
`;

const PHASE_SELECT = `
  select gp.id, gp.land_id, gp.name, gp.description, gp.north_south_feet, gp.east_west_feet,
         gp.x_feet_from_west, gp.y_feet_from_north, gp.is_active, gp.sort_order, gp.created_at, gp.updated_at
  from greenhouse_phases gp
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeLandListItem(row: any) {
  return {
    id: row.id,
    name: row.name,
    northSouthFeet: Number(row.north_south_feet),
    eastWestFeet: Number(row.east_west_feet),
    isActive: row.is_active,
    phaseCount: Number(row.phase_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeLandDetail(row: any) {
  return {
    id: row.id,
    name: row.name,
    northSouthFeet: Number(row.north_south_feet),
    eastWestFeet: Number(row.east_west_feet),
    isActive: row.is_active,
    // Every field inside each phase object was built by json_build_object
    // from already-correctly-typed Postgres values (numeric -> JSON number,
    // boolean -> JSON boolean), so no further Number()/Boolean() coercion
    // is needed here the way the flat top-level columns above require.
    phases: row.phases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializePhase(row: any) {
  return {
    id: row.id,
    landId: row.land_id,
    name: row.name,
    description: row.description,
    northSouthFeet: Number(row.north_south_feet),
    eastWestFeet: Number(row.east_west_feet),
    xFeetFromWest: Number(row.x_feet_from_west),
    yFeetFromNorth: Number(row.y_feet_from_north),
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -- lands --------------------------------------------------------------

router.get(
  "/lands",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`${LAND_LIST_SELECT} order by gl.name`);
    res.json({ lands: rows.map(serializeLandListItem) });
  })
);

router.get(
  "/lands/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid land id" });

    const { rows } = await pool.query(`${LAND_DETAIL_SELECT} where gl.id = $1`, [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Land not found" });
    res.json({ land: serializeLandDetail(row) });
  })
);

router.post(
  "/lands",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const errors: Record<string, string> = {};
    const name = trimOrNull(req.body?.name);
    if (!name) errors.name = "Land name is required";

    const northSouthFeet = parsePositiveNumber(req.body?.northSouthFeet);
    if (northSouthFeet === null) errors.northSouthFeet = "North–South length must be a number greater than 0";

    const eastWestFeet = parsePositiveNumber(req.body?.eastWestFeet);
    if (eastWestFeet === null) errors.eastWestFeet = "East–West width must be a number greater than 0";

    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const isActive = req.body?.isActive === undefined ? true : Boolean(req.body.isActive);

    try {
      const { rows } = await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active)
         values ($1, $2, $3, $4) returning id`,
        [name, northSouthFeet, eastWestFeet, isActive]
      );
      const { rows: full } = await pool.query(`${LAND_DETAIL_SELECT} where gl.id = $1`, [rows[0].id]);
      res.status(201).json({ land: serializeLandDetail(full[0]) });
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        return res.status(409).json({ errors: { name: "A land with this name already exists" } });
      }
      throw err;
    }
  })
);

router.patch(
  "/lands/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid land id" });

    const body = req.body ?? {};
    const errors: Record<string, string> = {};

    let name: string | undefined;
    if ("name" in body) {
      name = trimOrNull(body.name) ?? undefined;
      if (!name) errors.name = "Land name is required";
    }
    let northSouthFeet: number | undefined;
    if ("northSouthFeet" in body) {
      const v = parsePositiveNumber(body.northSouthFeet);
      if (v === null) errors.northSouthFeet = "North–South length must be a number greater than 0";
      else northSouthFeet = v;
    }
    let eastWestFeet: number | undefined;
    if ("eastWestFeet" in body) {
      const v = parsePositiveNumber(body.eastWestFeet);
      if (v === null) errors.eastWestFeet = "East–West width must be a number greater than 0";
      else eastWestFeet = v;
    }
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const client = await pool.connect();
    try {
      await client.query("begin");

      // Locked so a concurrent phase create/move can't race the resize
      // (and so the before/after dimensions used for the rescale ratio
      // below are guaranteed consistent).
      const currentRes = await client.query(
        "select north_south_feet, east_west_feet from greenhouse_lands where id = $1 for update",
        [id]
      );
      const current = currentRes.rows[0];
      if (!current) {
        await client.query("rollback");
        return res.status(404).json({ error: "Land not found" });
      }

      const columns: string[] = [];
      const values: unknown[] = [];
      if (name !== undefined) {
        values.push(name);
        columns.push(`name = $${values.length}`);
      }
      if (northSouthFeet !== undefined) {
        values.push(northSouthFeet);
        columns.push(`north_south_feet = $${values.length}`);
      }
      if (eastWestFeet !== undefined) {
        values.push(eastWestFeet);
        columns.push(`east_west_feet = $${values.length}`);
      }
      if ("isActive" in body) {
        values.push(Boolean(body.isActive));
        columns.push(`is_active = $${values.length}`);
      }
      if (columns.length === 0) {
        await client.query("rollback");
        return res.status(400).json({ error: "No fields to update" });
      }
      columns.push("updated_at = now()");

      try {
        values.push(id);
        await client.query(`update greenhouse_lands set ${columns.join(", ")} where id = $${values.length}`, values);
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          await client.query("rollback");
          return res.status(409).json({ errors: { name: "A land with this name already exists" } });
        }
        throw err;
      }

      // Resizing proportionally rescales every phase's own dimensions and
      // position by the same before/after ratio on each axis. This is
      // always safe — if (x + w) / oldW <= 1 held before the resize, then
      // (x*r + w*r) / newW = (x + w) / oldW <= 1 holds after it too, for
      // any ratio r = newW / oldW — so no phase can be pushed out of
      // bounds by this, and no extra validation pass is needed. The client
      // is responsible for warning the admin before calling this that
      // existing phases will be rescaled.
      const nsRatio = northSouthFeet !== undefined ? northSouthFeet / Number(current.north_south_feet) : 1;
      const ewRatio = eastWestFeet !== undefined ? eastWestFeet / Number(current.east_west_feet) : 1;
      if (nsRatio !== 1 || ewRatio !== 1) {
        await client.query(
          `update greenhouse_phases
           set north_south_feet = north_south_feet * $1,
               east_west_feet = east_west_feet * $2,
               y_feet_from_north = y_feet_from_north * $1,
               x_feet_from_west = x_feet_from_west * $2,
               updated_at = now()
           where land_id = $3`,
          [nsRatio, ewRatio, id]
        );

        // Rows are phase-relative (see rowLayout.ts) — cascading the exact
        // same per-axis ratio to every active row keeps each one at the
        // same relative position/size within its (also just-rescaled)
        // phase, so nothing is "left behind" by a land resize. Safe by the
        // same always-fits argument as the phase rescale above: scaling
        // both a row's position and size by the same ratio the phase
        // itself just scaled by preserves every boundary relationship that
        // held before. The batch's own recipe (greenhouse_row_batches) is
        // deliberately left as originally entered — it's a historical
        // record of what was asked for, not live geometry.
        await client.query(
          `update greenhouse_rows gr
           set x_ft = gr.x_ft * $1,
               y_ft = gr.y_ft * $2,
               width_ft = case when gr.orientation = 'horizontal' then gr.width_ft * $2 else gr.width_ft * $1 end,
               length_ft = case when gr.orientation = 'horizontal' then gr.length_ft * $1 else gr.length_ft * $2 end,
               updated_at = now()
           from greenhouse_phases gp
           where gr.phase_id = gp.id and gp.land_id = $3 and gr.deleted_at is null`,
          [ewRatio, nsRatio, id]
        );
      }

      await client.query("commit");
      const { rows: full } = await pool.query(`${LAND_DETAIL_SELECT} where gl.id = $1`, [id]);
      res.json({ land: serializeLandDetail(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

// -- phases ---------------------------------------------------------------

router.post(
  "/lands/:landId/phases",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { landId } = req.params;
    if (!UUID_RE.test(landId)) return res.status(400).json({ error: "Invalid land id" });

    const errors: Record<string, string> = {};
    const name = trimOrNull(req.body?.name);
    if (!name) errors.name = "Phase name is required";
    const description = trimOrNull(req.body?.description);

    const northSouthFeet = parsePositiveNumber(req.body?.northSouthFeet);
    if (northSouthFeet === null) errors.northSouthFeet = "North–South length must be a number greater than 0";
    const eastWestFeet = parsePositiveNumber(req.body?.eastWestFeet);
    if (eastWestFeet === null) errors.eastWestFeet = "East–West width must be a number greater than 0";
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const landRes = await client.query(
        "select north_south_feet, east_west_feet from greenhouse_lands where id = $1 for update",
        [landId]
      );
      const land = landRes.rows[0];
      if (!land) {
        await client.query("rollback");
        return res.status(404).json({ error: "Land not found" });
      }

      if (eastWestFeet! > Number(land.east_west_feet) || northSouthFeet! > Number(land.north_south_feet)) {
        await client.query("rollback");
        return res.status(409).json({ error: "Phase dimensions do not fit within the land" });
      }

      // Default placement: a small margin from the top-left (north-west
      // corner) if it fits, else the corner itself — refined afterward via
      // drag in Edit Phases mode. Position is deliberately not a create-time
      // form field.
      const margin = 10;
      const x = margin + eastWestFeet! <= Number(land.east_west_feet) ? margin : 0;
      const y = margin + northSouthFeet! <= Number(land.north_south_feet) ? margin : 0;

      try {
        await client.query(
          `insert into greenhouse_phases
             (land_id, name, description, north_south_feet, east_west_feet, x_feet_from_west, y_feet_from_north)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [landId, name, description, northSouthFeet, eastWestFeet, x, y]
        );
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          await client.query("rollback");
          return res.status(409).json({ errors: { name: "A phase with this name already exists in this land" } });
        }
        throw err;
      }

      await client.query("commit");
      const { rows: full } = await pool.query(`${LAND_DETAIL_SELECT} where gl.id = $1`, [landId]);
      res.status(201).json({ land: serializeLandDetail(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.patch(
  "/phases/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid phase id" });

    const body = req.body ?? {};
    const errors: Record<string, string> = {};

    let name: string | undefined;
    if ("name" in body) {
      name = trimOrNull(body.name) ?? undefined;
      if (!name) errors.name = "Phase name is required";
    }
    let description: string | null | undefined;
    if ("description" in body) description = trimOrNull(body.description);

    let northSouthFeet: number | undefined;
    if ("northSouthFeet" in body) {
      const v = parsePositiveNumber(body.northSouthFeet);
      if (v === null) errors.northSouthFeet = "North–South length must be a number greater than 0";
      else northSouthFeet = v;
    }
    let eastWestFeet: number | undefined;
    if ("eastWestFeet" in body) {
      const v = parsePositiveNumber(body.eastWestFeet);
      if (v === null) errors.eastWestFeet = "East–West width must be a number greater than 0";
      else eastWestFeet = v;
    }
    let xFeetFromWest: number | undefined;
    if ("xFeetFromWest" in body) {
      const v = parseNonNegativeNumber(body.xFeetFromWest);
      if (v === null) errors.xFeetFromWest = "Invalid position";
      else xFeetFromWest = v;
    }
    let yFeetFromNorth: number | undefined;
    if ("yFeetFromNorth" in body) {
      const v = parseNonNegativeNumber(body.yFeetFromNorth);
      if (v === null) errors.yFeetFromNorth = "Invalid position";
      else yFeetFromNorth = v;
    }
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const phaseRes = await client.query(
        `select gp.land_id, gp.north_south_feet, gp.east_west_feet, gp.x_feet_from_west, gp.y_feet_from_north,
                gl.north_south_feet as land_north_south_feet, gl.east_west_feet as land_east_west_feet
         from greenhouse_phases gp
         join greenhouse_lands gl on gl.id = gp.land_id
         where gp.id = $1
         for update of gp`,
        [id]
      );
      const phase = phaseRes.rows[0];
      if (!phase) {
        await client.query("rollback");
        return res.status(404).json({ error: "Phase not found" });
      }

      // Boundary check uses whatever's final for each axis — either the
      // newly supplied value or whatever's already stored. The server
      // never repositions on its own: if a dimension change alone would
      // push the phase out of bounds, this call is rejected outright, and
      // the client is expected to offer a reposition-and-retry action
      // (e.g. resending with xFeetFromWest/yFeetFromNorth reset to 0)
      // rather than the server silently moving it.
      const finalNorthSouth = northSouthFeet ?? Number(phase.north_south_feet);
      const finalEastWest = eastWestFeet ?? Number(phase.east_west_feet);
      const finalX = xFeetFromWest ?? Number(phase.x_feet_from_west);
      const finalY = yFeetFromNorth ?? Number(phase.y_feet_from_north);

      if (
        finalX + finalEastWest > Number(phase.land_east_west_feet) ||
        finalY + finalNorthSouth > Number(phase.land_north_south_feet)
      ) {
        await client.query("rollback");
        return res.status(409).json({
          error: "This size/position does not fit within the land. Reposition the phase and try again.",
        });
      }

      // Rows are stored phase-relative (see rowLayout.ts) and never
      // recomputed on their own — so a phase resize that would leave any
      // existing active row outside the new (smaller) bounds is rejected
      // outright rather than silently clipping or moving rows.
      if (northSouthFeet !== undefined || eastWestFeet !== undefined) {
        const rowsRes = await client.query(
          `select row_number, x_ft, y_ft, width_ft, length_ft, orientation
           from greenhouse_rows where phase_id = $1 and deleted_at is null`,
          [id]
        );
        if (rowsRes.rows.length > 0) {
          const rowRects: RowRect[] = rowsRes.rows.map((r) => ({
            rowNumber: r.row_number,
            xFt: Number(r.x_ft),
            yFt: Number(r.y_ft),
            widthFt: Number(r.width_ft),
            lengthFt: Number(r.length_ft),
            orientation: r.orientation,
          }));
          const outOfBounds = validateRowsInsidePhase(rowRects, {
            eastWestFeet: finalEastWest,
            northSouthFeet: finalNorthSouth,
          });
          if (outOfBounds.length > 0) {
            await client.query("rollback");
            return res.status(409).json({
              error: `Resizing this phase would leave ${outOfBounds.length} row(s) (e.g. row ${outOfBounds[0].rowNumber}) outside its new bounds. Delete or adjust those rows first.`,
            });
          }
        }
      }

      const columns: string[] = [];
      const values: unknown[] = [];
      if (name !== undefined) {
        values.push(name);
        columns.push(`name = $${values.length}`);
      }
      if (description !== undefined) {
        values.push(description);
        columns.push(`description = $${values.length}`);
      }
      if (northSouthFeet !== undefined) {
        values.push(northSouthFeet);
        columns.push(`north_south_feet = $${values.length}`);
      }
      if (eastWestFeet !== undefined) {
        values.push(eastWestFeet);
        columns.push(`east_west_feet = $${values.length}`);
      }
      if (xFeetFromWest !== undefined) {
        values.push(xFeetFromWest);
        columns.push(`x_feet_from_west = $${values.length}`);
      }
      if (yFeetFromNorth !== undefined) {
        values.push(yFeetFromNorth);
        columns.push(`y_feet_from_north = $${values.length}`);
      }
      if ("isActive" in body) {
        values.push(Boolean(body.isActive));
        columns.push(`is_active = $${values.length}`);
      }
      if (columns.length === 0) {
        await client.query("rollback");
        return res.status(400).json({ error: "No fields to update" });
      }
      columns.push("updated_at = now()");

      try {
        values.push(id);
        await client.query(`update greenhouse_phases set ${columns.join(", ")} where id = $${values.length}`, values);
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          await client.query("rollback");
          return res.status(409).json({ errors: { name: "A phase with this name already exists in this land" } });
        }
        throw err;
      }

      await client.query("commit");
      const { rows: full } = await pool.query(`${PHASE_SELECT} where gp.id = $1`, [id]);
      res.json({ phase: serializePhase(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.patch(
  "/phases/:id/position",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid phase id" });

    const errors: Record<string, string> = {};
    const x = parseNonNegativeNumber(req.body?.xFeetFromWest);
    if (x === null) errors.xFeetFromWest = "xFeetFromWest must be a finite number of 0 or greater";
    const y = parseNonNegativeNumber(req.body?.yFeetFromNorth);
    if (y === null) errors.yFeetFromNorth = "yFeetFromNorth must be a finite number of 0 or greater";
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const phaseRes = await client.query(
        `select gp.north_south_feet, gp.east_west_feet,
                gl.north_south_feet as land_north_south_feet, gl.east_west_feet as land_east_west_feet
         from greenhouse_phases gp
         join greenhouse_lands gl on gl.id = gp.land_id
         where gp.id = $1
         for update of gp`,
        [id]
      );
      const phase = phaseRes.rows[0];
      if (!phase) {
        await client.query("rollback");
        return res.status(404).json({ error: "Phase not found" });
      }

      // Dimensions always come from the DB row, never the client — this
      // endpoint only ever moves a phase, it never resizes one.
      if (
        x! + Number(phase.east_west_feet) > Number(phase.land_east_west_feet) ||
        y! + Number(phase.north_south_feet) > Number(phase.land_north_south_feet)
      ) {
        await client.query("rollback");
        return res.status(409).json({ error: "This position would place the phase outside the land boundary" });
      }

      await client.query(
        "update greenhouse_phases set x_feet_from_west = $1, y_feet_from_north = $2, updated_at = now() where id = $3",
        [x, y, id]
      );

      await client.query("commit");
      const { rows: full } = await pool.query(`${PHASE_SELECT} where gp.id = $1`, [id]);
      res.json({ phase: serializePhase(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.patch(
  "/lands/:landId/phase-positions",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { landId } = req.params;
    if (!UUID_RE.test(landId)) return res.status(400).json({ error: "Invalid land id" });

    const raw = req.body?.positions;
    if (!Array.isArray(raw)) return res.status(400).json({ error: "positions must be an array" });

    const positions: { id: string; x: number; y: number }[] = [];
    for (const p of raw) {
      const entry = p as { id?: unknown; xFeetFromWest?: unknown; yFeetFromNorth?: unknown };
      if (typeof entry?.id !== "string" || !UUID_RE.test(entry.id)) {
        return res.status(400).json({ error: "Each position requires a valid phase id" });
      }
      const x = parseNonNegativeNumber(entry.xFeetFromWest);
      const y = parseNonNegativeNumber(entry.yFeetFromNorth);
      if (x === null || y === null) {
        return res.status(400).json({ error: `Invalid position for phase ${entry.id}` });
      }
      positions.push({ id: entry.id, x, y });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const landRes = await client.query(
        "select north_south_feet, east_west_feet from greenhouse_lands where id = $1 for update",
        [landId]
      );
      const land = landRes.rows[0];
      if (!land) {
        await client.query("rollback");
        return res.status(404).json({ error: "Land not found" });
      }

      // Validate every position before writing any of them — batch save
      // is all-or-nothing. Dimensions always come from the DB row, never
      // the client, even though only x/y are being changed here.
      for (const pos of positions) {
        const phaseRes = await client.query(
          "select land_id, north_south_feet, east_west_feet from greenhouse_phases where id = $1 for update",
          [pos.id]
        );
        const phase = phaseRes.rows[0];
        if (!phase || phase.land_id !== landId) {
          await client.query("rollback");
          return res.status(404).json({ error: `Phase ${pos.id} not found in this land` });
        }
        if (
          pos.x + Number(phase.east_west_feet) > Number(land.east_west_feet) ||
          pos.y + Number(phase.north_south_feet) > Number(land.north_south_feet)
        ) {
          await client.query("rollback");
          return res.status(409).json({ error: `Phase ${pos.id} would be positioned outside the land boundary` });
        }
      }

      for (const pos of positions) {
        await client.query(
          "update greenhouse_phases set x_feet_from_west = $1, y_feet_from_north = $2, updated_at = now() where id = $3",
          [pos.x, pos.y, pos.id]
        );
      }

      await client.query("commit");
      const { rows: full } = await pool.query(`${LAND_DETAIL_SELECT} where gl.id = $1`, [landId]);
      res.json({ land: serializeLandDetail(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

// -- row batches / rows ------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeRow(row: any) {
  return {
    id: row.id,
    phaseId: row.phase_id,
    rowBatchId: row.row_batch_id,
    rowNumber: row.row_number,
    xFt: Number(row.x_ft),
    yFt: Number(row.y_ft),
    widthFt: Number(row.width_ft),
    lengthFt: Number(row.length_ft),
    orientation: row.orientation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeBatch(row: any) {
  return {
    id: row.id,
    phaseId: row.phase_id,
    name: row.name,
    startSide: row.start_side,
    anchorSide: row.anchor_side,
    rowWidthFt: Number(row.row_width_ft),
    rowLengthFt: Number(row.row_length_ft),
    rowGapFt: Number(row.row_gap_ft),
    startOffsetFt: Number(row.offset_ft),
    anchorOffsetFt: Number(row.anchor_offset_ft),
    // Backward-compatible alias.
    offsetFt: Number(row.offset_ft),
    numberingMode: row.numbering_mode,
    startRowNumber: row.start_row_number,
    endRowNumber: row.end_row_number,
    continuationMode: row.continuation_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ROW_SELECT = `
  select id, phase_id, row_batch_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation, created_at, updated_at
  from greenhouse_rows
`;
const BATCH_SELECT = `
  select id, phase_id, name, start_side, anchor_side, row_width_ft, row_length_ft, row_gap_ft, offset_ft, anchor_offset_ft,
         numbering_mode, start_row_number, end_row_number, continuation_mode, created_at, updated_at
  from greenhouse_row_batches
`;

function parseRowNumber(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRowRect(r: any): RowRect {
  return {
    rowNumber: r.row_number,
    xFt: Number(r.x_ft),
    yFt: Number(r.y_ft),
    widthFt: Number(r.width_ft),
    lengthFt: Number(r.length_ft),
    orientation: r.orientation,
  };
}

router.get(
  "/phases/:phaseId/rows",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { phaseId } = req.params;
    if (!UUID_RE.test(phaseId)) return res.status(400).json({ error: "Invalid phase id" });

    const phaseRes = await pool.query("select id from greenhouse_phases where id = $1", [phaseId]);
    if (!phaseRes.rows[0]) return res.status(404).json({ error: "Phase not found" });

    const { rows } = await pool.query(
      `${ROW_SELECT} where phase_id = $1 and deleted_at is null order by row_number`,
      [phaseId]
    );
    const { rows: batches } = await pool.query(
      `${BATCH_SELECT} where phase_id = $1 and deleted_at is null order by created_at`,
      [phaseId]
    );
    res.json({ rows: rows.map(serializeRow), batches: batches.map(serializeBatch) });
  })
);

router.post(
  "/phases/:phaseId/row-batches",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { phaseId } = req.params;
    if (!UUID_RE.test(phaseId)) return res.status(400).json({ error: "Invalid phase id" });

    const body = req.body ?? {};
    const errors: Record<string, string> = {};

    const name = trimOrNull(body.name);
    const startSide = body.startSide;
    if (!isValidSide(startSide)) errors.startSide = "Start side must be north, south, east, or west";
    const anchorSide = body.anchorSide;
    if (!isValidSide(anchorSide)) errors.anchorSide = "Anchor side must be north, south, east, or west";
    const numberingMode = body.numberingMode;
    if (!isValidNumberingMode(numberingMode)) errors.numberingMode = "Numbering mode must be all, odd, or even";

    const rowWidthFt = parsePositiveNumber(body.rowWidthFt);
    if (rowWidthFt === null) errors.rowWidthFt = "Row width must be a number greater than 0";
    const rowLengthFt = parsePositiveNumber(body.rowLengthFt);
    if (rowLengthFt === null) errors.rowLengthFt = "Row length must be a number greater than 0";
    const rowGapFt = body.rowGapFt === undefined ? 0 : parseNonNegativeNumber(body.rowGapFt);
    if (rowGapFt === null) errors.rowGapFt = "Row gap must be a number of 0 or greater";
    // Legacy clients send offsetFt. New clients send startOffsetFt.
    const startOffsetInput = body.startOffsetFt ?? body.offsetFt;
    const startOffsetFt = startOffsetInput === undefined ? 0 : parseNonNegativeNumber(startOffsetInput);
    if (startOffsetFt === null) errors.startOffsetFt = "Start-side offset must be a number of 0 or greater";
    const anchorOffsetFt = body.anchorOffsetFt === undefined ? 0 : parseNonNegativeNumber(body.anchorOffsetFt);
    if (anchorOffsetFt === null) errors.anchorOffsetFt = "Anchor-side offset must be a number of 0 or greater";
    const startRowNumber = parseRowNumber(body.startRowNumber);
    if (startRowNumber === null) errors.startRowNumber = "Start row number must be a whole number of 1 or greater";
    const endRowNumber = parseRowNumber(body.endRowNumber);
    if (endRowNumber === null) errors.endRowNumber = "End row number must be a whole number of 1 or greater";
    const continueAfterExisting = Boolean(body.continueAfterExisting);

    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const phaseRes = await client.query(
        "select north_south_feet, east_west_feet, is_active from greenhouse_phases where id = $1 for update",
        [phaseId]
      );
      const phase = phaseRes.rows[0];
      if (!phase) {
        await client.query("rollback");
        return res.status(404).json({ error: "Phase not found" });
      }
      if (!phase.is_active) {
        await client.query("rollback");
        return res.status(409).json({ error: "Rows cannot be added to a deactivated phase" });
      }

      const phaseSize = { eastWestFeet: Number(phase.east_west_feet), northSouthFeet: Number(phase.north_south_feet) };
      const params: BatchParams = {
        startSide,
        anchorSide,
        rowWidthFt: rowWidthFt!,
        rowLengthFt: rowLengthFt!,
        rowGapFt: rowGapFt!,
        startOffsetFt: startOffsetFt!,
        anchorOffsetFt: anchorOffsetFt!,
        offsetFt: startOffsetFt!,
        numberingMode,
        startRowNumber: startRowNumber!,
        endRowNumber: endRowNumber!,
      };

      // Continuation is scoped to rows placed from the SAME phase +
      // start-side/anchor-side lane — e.g. South+West must not continue
      // from South+East occupancy.
      let existingRowsSameStartSide: RowRect[] = [];
      if (continueAfterExisting) {
        const sameSideRes = await client.query(
          `select gr.row_number, gr.x_ft, gr.y_ft, gr.width_ft, gr.length_ft, gr.orientation
           from greenhouse_rows gr
           join greenhouse_row_batches grb on grb.id = gr.row_batch_id
           where gr.phase_id = $1 and gr.deleted_at is null and grb.deleted_at is null and grb.start_side = $2 and grb.anchor_side = $3`,
          [phaseId, startSide, anchorSide]
        );
        existingRowsSameStartSide = sameSideRes.rows.map(toRowRect);
      }

      const preview = generateRowPreview(params, phaseSize, { continueAfterExisting, existingRowsSameStartSide });
      if (preview.errors.length > 0) {
        await client.query("rollback");
        return res.status(422).json({ error: preview.errors[0], errors: preview.errors });
      }

      // Duplicate-number and overlap checks are against EVERY active row
      // in the phase (any batch, any start side), not just the
      // continuation-scoped set above — locked so a concurrent batch
      // create on the same phase can't race past these checks.
      const allExistingRes = await client.query(
        `select row_number, x_ft, y_ft, width_ft, length_ft, orientation
         from greenhouse_rows where phase_id = $1 and deleted_at is null for update`,
        [phaseId]
      );
      const allExisting: RowRect[] = allExistingRes.rows.map(toRowRect);

      const existingNumbers = new Set(allExisting.map((r) => r.rowNumber));
      const duplicates = preview.rowNumbers.filter((n) => existingNumbers.has(n));
      if (duplicates.length > 0) {
        await client.query("rollback");
        return res.status(409).json({
          error: `Row number${duplicates.length > 1 ? "s" : ""} ${duplicates.join(", ")} already exist in this phase.`,
        });
      }

      const overlaps = detectRowOverlap(preview.rows, allExisting);
      if (overlaps.length > 0) {
        await client.query("rollback");
        const [a, b] = overlaps[0];
        return res.status(409).json({ error: `New row ${a.rowNumber} would overlap existing row ${b.rowNumber}.` });
      }

      const batchIns = await client.query(
        `insert into greenhouse_row_batches
            (phase_id, name, start_side, anchor_side, row_width_ft, row_length_ft, row_gap_ft, offset_ft, anchor_offset_ft,
            numbering_mode, start_row_number, end_row_number, continuation_mode)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         returning id`,
        [
          phaseId,
          name,
          startSide,
          anchorSide,
          rowWidthFt,
          rowLengthFt,
          rowGapFt,
          startOffsetFt,
          anchorOffsetFt,
          numberingMode,
          startRowNumber,
          endRowNumber,
          continueAfterExisting ? "continue" : null,
        ]
      );
      const batchId = batchIns.rows[0].id;

      for (const r of preview.rows) {
        await client.query(
          `insert into greenhouse_rows (phase_id, row_batch_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [phaseId, batchId, r.rowNumber, r.xFt, r.yFt, r.widthFt, r.lengthFt, r.orientation]
        );
      }

      await client.query("commit");

      const { rows: batchFull } = await pool.query(`${BATCH_SELECT} where id = $1`, [batchId]);
      const { rows: rowsFull } = await pool.query(`${ROW_SELECT} where row_batch_id = $1 order by row_number`, [batchId]);
      res.status(201).json({ batch: serializeBatch(batchFull[0]), rows: rowsFull.map(serializeRow) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.get(
  "/row-batches/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid batch id" });

    const { rows } = await pool.query(`${BATCH_SELECT} where id = $1 and deleted_at is null`, [id]);
    const batch = rows[0];
    if (!batch) return res.status(404).json({ error: "Row batch not found" });

    const { rows: rowsFull } = await pool.query(
      `${ROW_SELECT} where row_batch_id = $1 and deleted_at is null order by row_number`,
      [id]
    );
    res.json({ batch: serializeBatch(batch), rows: rowsFull.map(serializeRow) });
  })
);

router.patch(
  "/row-batches/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid batch id" });

    const body = req.body ?? {};
    // Scoped to renaming a batch only for this first implementation —
    // editing a batch's geometry (side/anchor/numbering/etc.) safely would
    // mean re-deriving and re-validating every one of its rows against
    // whatever else now exists in the phase; out of scope here per the
    // spec's "do not expand scope if it risks the first implementation."
    if (!("name" in body)) return res.status(400).json({ error: "Only the batch name can be edited here" });
    const name = trimOrNull(body.name);

    const { rows } = await pool.query(
      `update greenhouse_row_batches set name = $1, updated_at = now() where id = $2 and deleted_at is null returning id`,
      [name, id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Row batch not found" });

    const { rows: full } = await pool.query(`${BATCH_SELECT} where id = $1`, [id]);
    res.json({ batch: serializeBatch(full[0]) });
  })
);

router.delete(
  "/rows/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid row id" });

    const { rows } = await pool.query(
      `update greenhouse_rows set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null returning id`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Row not found" });
    res.json({ ok: true });
  })
);

router.delete(
  "/row-batches/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid batch id" });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const batchRes = await client.query(
        "select id from greenhouse_row_batches where id = $1 and deleted_at is null for update",
        [id]
      );
      if (!batchRes.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Row batch not found" });
      }

      await client.query("update greenhouse_row_batches set deleted_at = now(), updated_at = now() where id = $1", [id]);
      // Only this batch's own rows — other batches in the same phase are
      // untouched.
      await client.query(
        "update greenhouse_rows set deleted_at = now(), updated_at = now() where row_batch_id = $1 and deleted_at is null",
        [id]
      );

      await client.query("commit");
      res.json({ ok: true });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

// Flat, cross-phase listing for the Base Data > Rows tab — reads the exact
// same greenhouse_rows table the map does, never a separate copy.
router.get(
  "/rows",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const search = trimOrNull(req.query.search as string);
    const phaseId = req.query.phaseId as string | undefined;
    const status = (req.query.status as string) || "active";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status === "active") conditions.push("gr.deleted_at is null");
    else if (status === "inactive") conditions.push("gr.deleted_at is not null");
    // status === "all": no condition.

    if (phaseId) {
      if (!UUID_RE.test(phaseId)) return res.status(400).json({ error: "Invalid phase id" });
      params.push(phaseId);
      conditions.push(`gr.phase_id = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const p = params.length;
      conditions.push(
        `(gr.row_number::text like $${p} or lower(gp.name) like $${p} or lower(coalesce(grb.name, '')) like $${p})`
      );
    }

    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const { rows } = await pool.query(
      `select gr.id, gr.phase_id, gr.row_batch_id, gr.row_number, gr.x_ft, gr.y_ft, gr.width_ft, gr.length_ft,
              gr.orientation, gr.created_at, gr.updated_at, gr.deleted_at,
              gp.name as phase_name,
              grb.name as batch_name, grb.start_side, grb.anchor_side
       from greenhouse_rows gr
       join greenhouse_phases gp on gp.id = gr.phase_id
       left join greenhouse_row_batches grb on grb.id = gr.row_batch_id
       ${where}
       order by gp.name, gr.row_number
       limit 1000`,
      params
    );

    res.json({
      rows: rows.map((r) => ({
        ...serializeRow(r),
        phaseName: r.phase_name,
        batchName: r.batch_name,
        startSide: r.start_side,
        anchorSide: r.anchor_side,
        isActive: r.deleted_at === null,
      })),
    });
  })
);

export default router;
