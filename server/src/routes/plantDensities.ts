import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENSITY_TYPES = new Set(["plants", "stems"]);

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isValidDensityType(v: unknown): v is "plants" | "stems" {
  return typeof v === "string" && DENSITY_TYPES.has(v);
}

// Required positive whole number (e.g. 996), same "trim/validate, don't
// silently coerce" spirit as trimOrNull above.
function parsePositiveInteger(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// No WHERE baked in — every call site appends its own via densitySelect()
// below, matching employeeBlocks.ts's identical blockSelect() convention
// (a WHERE added after this string would otherwise have to land after the
// GROUP BY, which is invalid SQL).
const DENSITY_BASE_SELECT = `
  select pd.id, pd.name, pd.type, pd.count_per_row, pd.created_at, pd.updated_at,
         count(pdr.greenhouse_row_id) as row_count
  from plant_densities pd
  left join plant_density_rows pdr on pdr.density_id = pd.id
`;

function densitySelect(where?: string): string {
  return `${DENSITY_BASE_SELECT} ${where ? `where ${where}` : ""} group by pd.id`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeDensitySummary(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    countPerRow: Number(row.count_per_row),
    rowCount: Number(row.row_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (type !== undefined && !isValidDensityType(type)) {
      return res.status(400).json({ error: "type must be 'plants' or 'stems'" });
    }
    const { rows } = await pool.query(
      `${densitySelect(type ? "pd.type = $1" : undefined)} order by pd.name`,
      type ? [type] : []
    );
    res.json({ densities: rows.map(serializeDensitySummary) });
  })
);

// Every currently-linked row across every density, with the owning
// density's name and type — used only by the Link Rows map to highlight
// rows already claimed by a *different* density of the *same* type (a row
// having both a Plants and a Stems density is normal, not a conflict) and
// to power its reassignment confirm. Entirely independent of
// employee-blocks/row-links: this only ever reads plant_density_rows, so
// a row already in an Employee Block never shows here as "taken."
router.get(
  "/row-links",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    if (type !== undefined && !isValidDensityType(type)) {
      return res.status(400).json({ error: "type must be 'plants' or 'stems'" });
    }
    const { rows } = await pool.query(
      `select pdr.greenhouse_row_id, pdr.density_id, pdr.density_type, pd.name as density_name
       from plant_density_rows pdr
       join plant_densities pd on pd.id = pdr.density_id
       ${type ? "where pdr.density_type = $1" : ""}`,
      type ? [type] : []
    );
    res.json({
      links: rows.map((r) => ({
        greenhouseRowId: r.greenhouse_row_id,
        densityId: r.density_id,
        densityType: r.density_type,
        densityName: r.density_name,
      })),
    });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid density id" });

    const { rows } = await pool.query(`${densitySelect("pd.id = $1")}`, [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Density not found" });

    const linkedRows = await pool.query(
      `select gr.id, gr.row_number, gp.name as phase_name
       from plant_density_rows pdr
       join greenhouse_rows gr on gr.id = pdr.greenhouse_row_id
       join greenhouse_phases gp on gp.id = gr.phase_id
       where pdr.density_id = $1
       order by gp.name, gr.row_number`,
      [id]
    );

    res.json({
      density: {
        ...serializeDensitySummary(row),
        rows: linkedRows.rows.map((r) => ({ id: r.id, rowNumber: r.row_number, phaseName: r.phase_name })),
      },
    });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const name = trimOrNull(req.body?.name);
    if (!name) return res.status(400).json({ errors: { name: "Density name is required" } });

    const type = req.body?.type;
    if (!isValidDensityType(type)) {
      return res.status(400).json({ errors: { type: "type must be 'plants' or 'stems'" } });
    }

    const countPerRow = parsePositiveInteger(req.body?.countPerRow);
    if (countPerRow === null) {
      return res.status(400).json({ errors: { countPerRow: "Must be a whole number greater than 0" } });
    }

    const { rows } = await pool.query(
      `insert into plant_densities (name, type, count_per_row) values ($1, $2, $3) returning id`,
      [name, type, countPerRow]
    );
    const { rows: full } = await pool.query(`${densitySelect("pd.id = $1")}`, [rows[0].id]);
    res.status(201).json({ density: { ...serializeDensitySummary(full[0]), rows: [] } });
  })
);

// type is deliberately not editable here — it's fixed by the
// fk_plant_density_rows_density_type constraint the moment any row is
// linked (024_plant_density_types.sql), and allowing it to change would
// mean silently reinterpreting every already-linked row's density_type.
// Creating a new density of the other type is the supported way to
// change your mind.
router.patch(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid density id" });

    const body = req.body ?? {};
    const columns: string[] = [];
    const values: unknown[] = [];

    if ("name" in body) {
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ errors: { name: "Density name is required" } });
      values.push(name);
      columns.push(`name = $${values.length}`);
    }
    if ("countPerRow" in body) {
      const countPerRow = parsePositiveInteger(body.countPerRow);
      if (countPerRow === null) {
        return res.status(400).json({ errors: { countPerRow: "Must be a whole number greater than 0" } });
      }
      values.push(countPerRow);
      columns.push(`count_per_row = $${values.length}`);
    }
    if (columns.length === 0) return res.status(400).json({ error: "No fields to update" });
    columns.push("updated_at = now()");

    values.push(id);
    const { rows } = await pool.query(
      `update plant_densities set ${columns.join(", ")} where id = $${values.length} returning id`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: "Density not found" });

    const { rows: full } = await pool.query(`${densitySelect("pd.id = $1")}`, [id]);
    res.json({ density: serializeDensitySummary(full[0]) });
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid density id" });

    // plant_density_rows rows for this density are removed automatically
    // via "on delete cascade" (023_plant_densities.sql) — greenhouse_rows
    // itself is never touched by this.
    const { rows } = await pool.query("delete from plant_densities where id = $1 returning id", [id]);
    if (!rows[0]) return res.status(404).json({ error: "Density not found" });
    res.json({ ok: true });
  })
);

// Replaces this density's entire linked-row set with exactly the given
// rowIds in one transaction — any of those rows currently linked to a
// *different* density of the *same* type are silently reassigned (the
// office UI already walks the admin through a confirmation before they
// ever reach Save; see PlantDensityFormModal's Link Rows step), and any
// row previously linked to this density but not in the new set is
// unlinked. A row's density of the *other* type (if any) is never
// touched — the steal/replace below is always scoped by density_type, so
// reassigning someone's Plants density can never disturb their Stems one.
// Never touches employee_block_rows — entirely separate tables.
router.put(
  "/:id/rows",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid density id" });

    const rowIds = req.body?.rowIds;
    if (!Array.isArray(rowIds) || !rowIds.every((r) => typeof r === "string" && UUID_RE.test(r))) {
      return res.status(400).json({ error: "rowIds must be an array of row ids" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const density = await client.query("select id, type from plant_densities where id = $1 for update", [id]);
      if (!density.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Density not found" });
      }
      const densityType = density.rows[0].type;

      if (rowIds.length > 0) {
        const rowsExist = await client.query(
          "select id from greenhouse_rows where id = any($1::uuid[]) and deleted_at is null",
          [rowIds]
        );
        if (rowsExist.rows.length !== new Set(rowIds).size) {
          await client.query("rollback");
          return res.status(400).json({ error: "One or more rows were not found" });
        }
      }

      await client.query("delete from plant_density_rows where density_id = $1", [id]);
      if (rowIds.length > 0) {
        await client.query(
          "delete from plant_density_rows where greenhouse_row_id = any($1::uuid[]) and density_type = $2",
          [rowIds, densityType]
        );
        await client.query(
          `insert into plant_density_rows (density_id, greenhouse_row_id, density_type)
           select $1, unnest($2::uuid[]), $3`,
          [id, rowIds, densityType]
        );
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const { rows: full } = await pool.query(`${densitySelect("pd.id = $1")}`, [id]);
    const linkedRows = await pool.query(
      `select gr.id, gr.row_number, gp.name as phase_name
       from plant_density_rows pdr
       join greenhouse_rows gr on gr.id = pdr.greenhouse_row_id
       join greenhouse_phases gp on gp.id = gr.phase_id
       where pdr.density_id = $1
       order by gp.name, gr.row_number`,
      [id]
    );
    res.json({
      density: {
        ...serializeDensitySummary(full[0]),
        rows: linkedRows.rows.map((r) => ({ id: r.id, rowNumber: r.row_number, phaseName: r.phase_name })),
      },
    });
  })
);

export default router;
