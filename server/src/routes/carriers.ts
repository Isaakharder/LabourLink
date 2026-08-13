import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { buildBulkCarrierNames, normalizeCarrierName, parseTareWeightKg, validateBulkCarrierRequest } from "../lib/carrierBulk";

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
    // pg returns numeric columns as strings to avoid float precision loss —
    // converted here since callers (the carriers table, weighing math)
    // want an actual number, and 10-digit-precision kg values never
    // approach JS's safe-integer boundary.
    tareWeightKg: Number(row.tare_weight_kg),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `select id, name, notes, tare_weight_kg, is_active, created_at, updated_at from carriers`;

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
    const notes = trimOrNull(req.body?.notes);
    const isActive = req.body?.isActive === undefined ? true : Boolean(req.body.isActive);
    const tareResult = parseTareWeightKg(req.body?.tareWeightKg);

    const errors: Record<string, string> = {};
    if (!name) errors.name = "Carrier name is required";
    if (!tareResult.ok) errors.tareWeightKg = tareResult.error;
    if (Object.keys(errors).length > 0) return res.status(400).json({ errors });

    try {
      const { rows } = await pool.query(
        `insert into carriers (name, notes, is_active, tare_weight_kg) values ($1, $2, $3, $4) returning id`,
        [name, notes, isActive, (tareResult as { ok: true; value: number }).value]
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

// Bulk-creates a range of numbered carriers (e.g. "Bin 001".."Bin 050") in
// one call — see carrierBulk.ts for the name-generation/validation rules
// and the feature plan behind this endpoint. A single multi-row INSERT
// with ON CONFLICT DO NOTHING against the same normalized-name unique
// index single-create relies on (carriers_name_normalized_key) is what
// makes this atomic and race-safe: duplicates against existing carriers
// (or a concurrent bulk request racing this one) are silently skipped
// rather than aborting the whole batch, and no separate row-locking is
// needed since the index itself is the source of truth.
router.post(
  "/bulk",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const validation = validateBulkCarrierRequest(req.body ?? {});
    if (!validation.ok) return res.status(400).json({ errors: validation.errors });

    const { prefix, startNumber, endNumber, padding, tareWeightKg, notes, isActive } = validation.request;
    const candidateNames = buildBulkCarrierNames(prefix, startNumber, endNumber, padding);

    const values: unknown[] = [];
    const rowsSql = candidateNames.map((name) => {
      values.push(name, notes, isActive, tareWeightKg);
      const base = values.length - 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });

    const { rows: created } = await pool.query(
      `insert into carriers (name, notes, is_active, tare_weight_kg)
       values ${rowsSql.join(", ")}
       on conflict ((lower(trim(name)))) do nothing
       returning id, name, notes, tare_weight_kg, is_active, created_at, updated_at`,
      values
    );

    const createdNormalized = new Set(created.map((r) => normalizeCarrierName(r.name)));
    const skippedNames = candidateNames.filter((n) => !createdNormalized.has(normalizeCarrierName(n)));

    res.status(200).json({
      createdCount: created.length,
      skippedCount: skippedNames.length,
      skippedNames,
      carriers: created.map(serializeCarrier).sort((a, b) => a.name.localeCompare(b.name)),
    });
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
    if ("tareWeightKg" in body) {
      const tareResult = parseTareWeightKg(body.tareWeightKg);
      if (!tareResult.ok) return res.status(400).json({ errors: { tareWeightKg: tareResult.error } });
      values.push(tareResult.value);
      columns.push(`tare_weight_kg = $${values.length}`);
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
