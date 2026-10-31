import { Router } from "express";
import { PoolClient } from "pg";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { buildBulkCarrierNames, normalizeCarrierName, parseTareWeightKg, validateBulkCarrierRequest } from "../lib/carrierBulk";
import { normalizeRfidTag, parseRfidTag } from "../lib/rfidTag";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function duplicateFieldFromConstraint(constraint?: string): string | null {
  if (constraint === "carriers_name_normalized_key") return "name";
  if (constraint === "carriers_rfid_tag_key") return "rfidTag";
  return null;
}

// Maps a unique-violation on create/edit to the 409 field error the form
// shows. For a duplicate RFID tag it names the carrier that already holds
// the tag, so the admin knows which assignment to clear first — a tag is
// never moved off another carrier implicitly.
async function duplicateErrors(err: unknown, rfidTag: string | null): Promise<Record<string, string> | null> {
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr.code !== "23505") return null;
  const field = duplicateFieldFromConstraint(pgErr.constraint);
  if (field === "name") return { name: "A carrier with this name already exists" };
  if (field === "rfidTag") {
    const { rows } = await pool.query(`select name from carriers where rfid_tag = $1`, [rfidTag]);
    const owner = rows[0]?.name as string | undefined;
    return {
      rfidTag: owner
        ? `RFID tag ${rfidTag} is already assigned to "${owner}". Clear it there first.`
        : `RFID tag ${rfidTag} is already assigned to another carrier`,
    };
  }
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
    rfidTag: row.rfid_tag ?? null,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `select id, name, notes, tare_weight_kg, rfid_tag, is_active, created_at, updated_at from carriers`;

// Every tag or tare change made here is recorded in
// carrier_registration_audit (071), in the same transaction as the change,
// alongside the weighing station's own registrations.
async function auditPageChange(
  db: PoolClient,
  e: { carrierId: string; action: "page_create" | "page_edit"; oldTag: string | null; newTag: string | null; oldTare: number | null; newTare: number; by: string }
) {
  await db.query(
    `insert into carrier_registration_audit
       (carrier_id, source, action, old_rfid_tag, new_rfid_tag, old_tare_weight_kg, new_tare_weight_kg, performed_by_employee_id)
     values ($1, 'carriers_page', $2, $3, $4, $5, $6, $7)`,
    [e.carrierId, e.action, e.oldTag, e.newTag, e.oldTare, e.newTare, e.by]
  );
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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

    // Matches the carrier name or its RFID tag (stored normalized, so the
    // search term is normalized the same way for the tag side).
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      params.push(`%${normalizeRfidTag(search)}%`);
      conditions.push(`(lower(name) like $${params.length - 1} or rfid_tag like $${params.length})`);
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
    const rfidResult = parseRfidTag(req.body?.rfidTag);

    const errors: Record<string, string> = {};
    if (!name) errors.name = "Carrier name is required";
    if (!tareResult.ok) errors.tareWeightKg = tareResult.error;
    if (!rfidResult.ok) errors.rfidTag = rfidResult.error;
    if (Object.keys(errors).length > 0) return res.status(400).json({ errors });
    const rfidTag = (rfidResult as { ok: true; value: string | null }).value;

    const tare = (tareResult as { ok: true; value: number }).value;
    try {
      const id = await inTransaction(async (client) => {
        const { rows } = await client.query(
          `insert into carriers (name, notes, is_active, tare_weight_kg, rfid_tag) values ($1, $2, $3, $4, $5) returning id`,
          [name, notes, isActive, tare, rfidTag]
        );
        if (rfidTag !== null || tare > 0) {
          await auditPageChange(client, {
            carrierId: rows[0].id,
            action: "page_create",
            oldTag: null,
            newTag: rfidTag,
            oldTare: null,
            newTare: tare,
            by: req.employee!.id,
          });
        }
        return rows[0].id as string;
      });
      const { rows: full } = await pool.query(`${SELECT} where id = $1`, [id]);
      res.status(201).json({ carrier: serializeCarrier(full[0]) });
    } catch (err) {
      const dupErrors = await duplicateErrors(err, rfidTag);
      if (dupErrors) return res.status(409).json({ errors: dupErrors });
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

    const created = await inTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into carriers (name, notes, is_active, tare_weight_kg)
         values ${rowsSql.join(", ")}
         on conflict ((lower(trim(name)))) do nothing
         returning id, name, notes, tare_weight_kg, rfid_tag, is_active, created_at, updated_at`,
        values
      );
      if (tareWeightKg > 0 && rows.length > 0) {
        await client.query(
          `insert into carrier_registration_audit
             (carrier_id, source, action, old_rfid_tag, new_rfid_tag, old_tare_weight_kg, new_tare_weight_kg, performed_by_employee_id)
           select id, 'carriers_page', 'page_create', null, null, null, $2, $3 from unnest($1::uuid[]) as id`,
          [rows.map((r) => r.id), tareWeightKg, req.employee!.id]
        );
      }
      return rows;
    });

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
    // Only touched when the body names it, so edits that don't mention the
    // tag (e.g. the Activate/Deactivate toggle) never clear it.
    let rfidTag: string | null = null;
    if ("rfidTag" in body) {
      const rfidResult = parseRfidTag(body.rfidTag);
      if (!rfidResult.ok) return res.status(400).json({ errors: { rfidTag: rfidResult.error } });
      rfidTag = rfidResult.value;
      values.push(rfidTag);
      columns.push(`rfid_tag = $${values.length}`);
    }
    if (columns.length === 0) return res.status(400).json({ error: "No fields to update" });
    columns.push("updated_at = now()");

    try {
      values.push(id);
      const found = await inTransaction(async (client) => {
        const { rows: before } = await client.query(`select rfid_tag, tare_weight_kg from carriers where id = $1 for update`, [id]);
        if (!before[0]) return false;
        const { rows } = await client.query(
          `update carriers set ${columns.join(", ")} where id = $${values.length} returning rfid_tag, tare_weight_kg`,
          values
        );
        const oldTare = Number(before[0].tare_weight_kg);
        const newTare = Number(rows[0].tare_weight_kg);
        if (before[0].rfid_tag !== rows[0].rfid_tag || oldTare !== newTare) {
          await auditPageChange(client, {
            carrierId: id,
            action: "page_edit",
            oldTag: before[0].rfid_tag,
            newTag: rows[0].rfid_tag,
            oldTare,
            newTare,
            by: req.employee!.id,
          });
        }
        return true;
      });
      if (!found) return res.status(404).json({ error: "Carrier not found" });

      const { rows: full } = await pool.query(`${SELECT} where id = $1`, [id]);
      res.json({ carrier: serializeCarrier(full[0]) });
    } catch (err) {
      const dupErrors = await duplicateErrors(err, rfidTag);
      if (dupErrors) return res.status(409).json({ errors: dupErrors });
      throw err;
    }
  })
);

// Every tag and tare change for one bin, newest first: registrations at the
// weighing station and edits on this page.
router.get(
  "/:id/history",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid carrier id" });
    const { rows } = await pool.query(
      `select a.id, a.source, a.action, a.old_rfid_tag, a.new_rfid_tag, a.old_tare_weight_kg, a.new_tare_weight_kg,
              a.measured_gross_kg, a.overwrite_confirmed, a.reason, a.performed_at,
              trim(e.first_name || ' ' || coalesce(e.last_name, '')) as performed_by,
              s.name as station_name, mt.name as moved_to_name, mf.name as moved_from_name
       from carrier_registration_audit a
       join employees e on e.id = a.performed_by_employee_id
       left join scale_stations s on s.id = a.station_id
       left join carriers mt on mt.id = a.moved_to_carrier_id
       left join carriers mf on mf.id = a.moved_from_carrier_id
       where a.carrier_id = $1
       order by a.performed_at desc, a.id
       limit 200`,
      [id]
    );
    const kg = (v: string | null) => (v === null ? null : Number(v));
    res.json({
      history: rows.map((r) => ({
        id: r.id,
        source: r.source,
        action: r.action,
        oldRfidTag: r.old_rfid_tag,
        newRfidTag: r.new_rfid_tag,
        oldTareWeightKg: kg(r.old_tare_weight_kg),
        newTareWeightKg: kg(r.new_tare_weight_kg),
        measuredGrossKg: kg(r.measured_gross_kg),
        overwriteConfirmed: r.overwrite_confirmed,
        reason: r.reason,
        performedAt: r.performed_at,
        performedBy: r.performed_by,
        stationName: r.station_name,
        movedToName: r.moved_to_name,
        movedFromName: r.moved_from_name,
      })),
    });
  })
);

export default router;
