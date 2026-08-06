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

// No WHERE/GROUP BY baked in — every call site appends its own via
// blockSelect() below, so a WHERE (needed everywhere except the plain list)
// always lands before GROUP BY rather than after it.
const BLOCK_BASE_SELECT = `
  select eb.id, eb.name, eb.employee_id, e.first_name, e.last_name,
         eb.created_at, eb.updated_at,
         count(ebr.greenhouse_row_id) as row_count
  from employee_blocks eb
  left join employees e on e.id = eb.employee_id
  left join employee_block_rows ebr on ebr.block_id = eb.id
`;

function blockSelect(where?: string): string {
  return `${BLOCK_BASE_SELECT} ${where ? `where ${where}` : ""} group by eb.id, e.first_name, e.last_name`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeBlockSummary(row: any) {
  return {
    id: row.id,
    name: row.name,
    employeeId: row.employee_id,
    employeeName: row.employee_id ? `${row.first_name} ${row.last_name}` : null,
    rowCount: Number(row.row_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`${blockSelect()} order by eb.name`);
    res.json({ blocks: rows.map(serializeBlockSummary) });
  })
);

// Every currently-linked row across every block, with the owning block's
// name — used only by the office Link Rows map to highlight rows already
// claimed by a *different* block and to power its reassignment confirm.
// Not scoped to one land/block: the total number of linked rows is small
// (bounded by the greenhouse's own row count), so one flat list is simpler
// than a per-land query and the client already filters by land itself.
router.get(
  "/row-links",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select ebr.greenhouse_row_id, ebr.block_id, eb.name as block_name
       from employee_block_rows ebr
       join employee_blocks eb on eb.id = ebr.block_id`
    );
    res.json({
      links: rows.map((r) => ({
        greenhouseRowId: r.greenhouse_row_id,
        blockId: r.block_id,
        blockName: r.block_name,
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
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid block id" });

    const { rows } = await pool.query(`${blockSelect("eb.id = $1")}`, [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Block not found" });

    const linkedRows = await pool.query(
      `select gr.id, gr.row_number, gp.name as phase_name
       from employee_block_rows ebr
       join greenhouse_rows gr on gr.id = ebr.greenhouse_row_id
       join greenhouse_phases gp on gp.id = gr.phase_id
       where ebr.block_id = $1
       order by gp.name, gr.row_number`,
      [id]
    );

    res.json({
      block: {
        ...serializeBlockSummary(row),
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
    if (!name) return res.status(400).json({ errors: { name: "Block name is required" } });

    const employeeId = trimOrNull(req.body?.employeeId);
    if (employeeId) {
      if (!UUID_RE.test(employeeId)) return res.status(400).json({ errors: { employeeId: "Invalid employee" } });
      const employee = await pool.query("select id from employees where id = $1 and is_active = true", [
        employeeId,
      ]);
      if (!employee.rows[0]) return res.status(400).json({ errors: { employeeId: "Employee not found" } });
    }

    const { rows } = await pool.query(
      `insert into employee_blocks (name, employee_id) values ($1, $2) returning id`,
      [name, employeeId]
    );
    const { rows: full } = await pool.query(`${blockSelect("eb.id = $1")}`, [rows[0].id]);
    res.status(201).json({ block: { ...serializeBlockSummary(full[0]), rows: [] } });
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid block id" });

    const body = req.body ?? {};
    const columns: string[] = [];
    const values: unknown[] = [];

    if ("name" in body) {
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ errors: { name: "Block name is required" } });
      values.push(name);
      columns.push(`name = $${values.length}`);
    }
    if ("employeeId" in body) {
      const employeeId = trimOrNull(body.employeeId);
      if (employeeId) {
        if (!UUID_RE.test(employeeId)) return res.status(400).json({ errors: { employeeId: "Invalid employee" } });
        const employee = await pool.query("select id from employees where id = $1 and is_active = true", [
          employeeId,
        ]);
        if (!employee.rows[0]) return res.status(400).json({ errors: { employeeId: "Employee not found" } });
      }
      values.push(employeeId);
      columns.push(`employee_id = $${values.length}`);
    }
    if (columns.length === 0) return res.status(400).json({ error: "No fields to update" });
    columns.push("updated_at = now()");

    values.push(id);
    const { rows } = await pool.query(
      `update employee_blocks set ${columns.join(", ")} where id = $${values.length} returning id`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: "Block not found" });

    const { rows: full } = await pool.query(`${blockSelect("eb.id = $1")}`, [id]);
    res.json({ block: serializeBlockSummary(full[0]) });
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid block id" });

    // employee_block_rows rows for this block are removed automatically via
    // "on delete cascade" (022_employee_blocks.sql) — greenhouse_rows itself
    // is never touched by this.
    const { rows } = await pool.query("delete from employee_blocks where id = $1 returning id", [id]);
    if (!rows[0]) return res.status(404).json({ error: "Block not found" });
    res.json({ ok: true });
  })
);

// Replaces this block's entire linked-row set with exactly the given
// rowIds in one transaction — any of those rows currently linked to a
// *different* block are silently reassigned (the office UI already walks
// the admin through a confirmation per row before they ever reach Save;
// see EmployeeBlockFormModal's Link Rows step), and any row previously
// linked to this block but not in the new set is unlinked.
router.put(
  "/:id/rows",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid block id" });

    const rowIds = req.body?.rowIds;
    if (!Array.isArray(rowIds) || !rowIds.every((r) => typeof r === "string" && UUID_RE.test(r))) {
      return res.status(400).json({ error: "rowIds must be an array of row ids" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const block = await client.query("select id from employee_blocks where id = $1 for update", [id]);
      if (!block.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Block not found" });
      }

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

      await client.query("delete from employee_block_rows where block_id = $1", [id]);
      if (rowIds.length > 0) {
        await client.query("delete from employee_block_rows where greenhouse_row_id = any($1::uuid[])", [rowIds]);
        await client.query(
          `insert into employee_block_rows (block_id, greenhouse_row_id)
           select $1, unnest($2::uuid[])`,
          [id, rowIds]
        );
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const { rows: full } = await pool.query(`${blockSelect("eb.id = $1")}`, [id]);
    const linkedRows = await pool.query(
      `select gr.id, gr.row_number, gp.name as phase_name
       from employee_block_rows ebr
       join greenhouse_rows gr on gr.id = ebr.greenhouse_row_id
       join greenhouse_phases gp on gp.id = gr.phase_id
       where ebr.block_id = $1
       order by gp.name, gr.row_number`,
      [id]
    );
    res.json({
      block: {
        ...serializeBlockSummary(full[0]),
        rows: linkedRows.rows.map((r) => ({ id: r.id, rowNumber: r.row_number, phaseName: r.phase_name })),
      },
    });
  })
);

export default router;
