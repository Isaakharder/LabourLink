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

function duplicateFieldFromConstraint(constraint?: string): string | null {
  if (constraint === "carriers_name_normalized_key") return "name";
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeCarrier(row: any) {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `select id, name, notes, is_active, created_at, updated_at from carriers`;

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const search = trimOrNull(req.query.search as string);
    const status = (req.query.status as string) || "all";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status === "active") conditions.push("is_active = true");
    else if (status === "inactive") conditions.push("is_active = false");

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`lower(name) like $${params.length}`);
    }

    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const { rows } = await pool.query(`${SELECT} ${where} order by name`, params);
    res.json({ carriers: rows.map(serializeCarrier) });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid carrier id" });

    const { rows } = await pool.query(`${SELECT} where id = $1`, [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Carrier not found" });
    res.json({ carrier: serializeCarrier(row) });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const name = trimOrNull(req.body?.name);
    if (!name) return res.status(400).json({ errors: { name: "Carrier name is required" } });
    const notes = trimOrNull(req.body?.notes);
    const isActive = req.body?.isActive === undefined ? true : Boolean(req.body.isActive);

    try {
      const { rows } = await pool.query(
        `insert into carriers (name, notes, is_active) values ($1, $2, $3) returning id`,
        [name, notes, isActive]
      );
      const { rows: full } = await pool.query(`${SELECT} where id = $1`, [rows[0].id]);
      res.status(201).json({ carrier: serializeCarrier(full[0]) });
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && duplicateFieldFromConstraint(pgErr.constraint) === "name") {
        return res.status(409).json({ errors: { name: "A carrier with this name already exists" } });
      }
      throw err;
    }
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid carrier id" });

    const body = req.body ?? {};
    const columns: string[] = [];
    const values: unknown[] = [];

    if ("name" in body) {
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ errors: { name: "Carrier name is required" } });
      values.push(name);
      columns.push(`name = $${values.length}`);
    }
    if ("notes" in body) {
      values.push(trimOrNull(body.notes));
      columns.push(`notes = $${values.length}`);
    }
    if ("isActive" in body) {
      values.push(Boolean(body.isActive));
      columns.push(`is_active = $${values.length}`);
    }
    if (columns.length === 0) return res.status(400).json({ error: "No fields to update" });
    columns.push("updated_at = now()");

    try {
      values.push(id);
      const { rows } = await pool.query(
        `update carriers set ${columns.join(", ")} where id = $${values.length} returning id`,
        values
      );
      if (!rows[0]) return res.status(404).json({ error: "Carrier not found" });

      const { rows: full } = await pool.query(`${SELECT} where id = $1`, [id]);
      res.json({ carrier: serializeCarrier(full[0]) });
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && duplicateFieldFromConstraint(pgErr.constraint) === "name") {
        return res.status(409).json({ errors: { name: "A carrier with this name already exists" } });
      }
      throw err;
    }
  })
);

export default router;
