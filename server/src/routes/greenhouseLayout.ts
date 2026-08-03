import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";

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

export default router;
