import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice, requireDeviceAdmin } from "../middleware/device";
import {
  deactivateMapping,
  findActiveMappingByIdentifier,
  findActiveMappingByTarget,
  listActiveMappings,
  normalizeHardwareId,
  TargetType,
} from "../lib/nfcTagResolution";

const router = Router();
router.use(asyncHandler(requireDevice));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ridder hardware IDs observed so far are plain hex (e.g. 048E7BE2202290) —
// this is intentionally permissive (any non-empty hex run) rather than a
// fixed length, since different tag families report different UID lengths.
const HEX_ID_RE = /^[0-9A-Fa-f]+$/;

function isValidTargetType(v: unknown): v is TargetType {
  return v === "greenhouse_row" || v === "carrier";
}

async function targetExists(targetType: TargetType, targetId: string): Promise<boolean> {
  if (targetType === "greenhouse_row") {
    const { rows } = await pool.query("select 1 from greenhouse_rows where id = $1 and deleted_at is null", [
      targetId,
    ]);
    return rows.length > 0;
  }
  const { rows } = await pool.query("select 1 from carriers where id = $1 and is_active = true", [targetId]);
  return rows.length > 0;
}

// Every active mapping, for the mobile app's offline scan-resolution cache
// (web/src/lib/nfcMappingCache.ts) — no admin check, any paired device needs
// this to resolve a scan against a row/carrier, same as it already needs
// /api/mobile/greenhouse-rows and /api/mobile/activities.
router.get(
  "/mappings",
  asyncHandler(async (_req, res) => {
    const mappings = await listActiveMappings(pool);
    res.json({ mappings });
  })
);

router.post(
  "/register",
  requireDeviceAdmin,
  asyncHandler(async (req, res) => {
    const { targetType, targetId, ridderHardwareId, confirmReplaceTag, confirmReplaceTarget } = req.body as {
      targetType?: string;
      targetId?: string;
      ridderHardwareId?: string;
      confirmReplaceTag?: boolean;
      confirmReplaceTarget?: boolean;
    };
    if (!isValidTargetType(targetType) || !targetId || !UUID_RE.test(targetId)) {
      return res.status(400).json({ error: "A valid targetType and targetId are required." });
    }
    if (!ridderHardwareId || !HEX_ID_RE.test(ridderHardwareId)) {
      return res.status(400).json({ error: "A valid ridderHardwareId is required." });
    }
    if (!(await targetExists(targetType, targetId))) {
      return res.status(400).json({ error: "targetId does not match an active row or carrier." });
    }

    const normalizedId = normalizeHardwareId(ridderHardwareId);
    const client = await pool.connect();
    try {
      await client.query("begin");

      const tagConflict = await findActiveMappingByIdentifier(client, { ridderHardwareId: normalizedId });
      const targetConflict = await findActiveMappingByTarget(client, { targetType, targetId });

      const tagConflictsWithDifferentTarget =
        tagConflict !== null && !(tagConflict.targetType === targetType && tagConflict.targetId === targetId);
      const targetConflictsWithDifferentTag =
        targetConflict !== null && targetConflict.ridderHardwareId !== normalizedId;

      if ((tagConflictsWithDifferentTarget && !confirmReplaceTag) || (targetConflictsWithDifferentTag && !confirmReplaceTarget)) {
        await client.query("rollback");
        return res.status(409).json({
          error: "This would change an existing mapping — confirm to proceed.",
          tagConflict: tagConflictsWithDifferentTarget ? tagConflict : null,
          targetConflict: targetConflictsWithDifferentTag ? targetConflict : null,
        });
      }

      if (tagConflictsWithDifferentTarget) await deactivateMapping(client, tagConflict!.id, req.device!.employeeId);
      if (targetConflictsWithDifferentTag) await deactivateMapping(client, targetConflict!.id, req.device!.employeeId);

      const { rows } = await client.query(
        `insert into nfc_tag_mappings (greenhouse_row_id, carrier_id, tag_kind, ridder_hardware_id, created_by_employee_id)
         values ($1, $2, 'ridder', $3, $4) returning id`,
        [
          targetType === "greenhouse_row" ? targetId : null,
          targetType === "carrier" ? targetId : null,
          normalizedId,
          req.device!.employeeId,
        ]
      );

      await client.query("commit");
      res.json({ mappingId: rows[0].id });
    } catch (err) {
      await client.query("rollback");
      if ((err as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "This tag or target was just changed by someone else. Please try again." });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

router.post(
  "/write-mapping",
  requireDeviceAdmin,
  asyncHandler(async (req, res) => {
    const { targetType, targetId, labourlinkTagUuid, confirmReplaceTarget } = req.body as {
      targetType?: string;
      targetId?: string;
      labourlinkTagUuid?: string;
      confirmReplaceTarget?: boolean;
    };
    if (!isValidTargetType(targetType) || !targetId || !UUID_RE.test(targetId)) {
      return res.status(400).json({ error: "A valid targetType and targetId are required." });
    }
    if (!labourlinkTagUuid || !UUID_RE.test(labourlinkTagUuid)) {
      return res.status(400).json({ error: "A valid labourlinkTagUuid is required." });
    }
    if (!(await targetExists(targetType, targetId))) {
      return res.status(400).json({ error: "targetId does not match an active row or carrier." });
    }

    const normalizedUuid = labourlinkTagUuid.toLowerCase();
    const client = await pool.connect();
    try {
      await client.query("begin");

      const targetConflict = await findActiveMappingByTarget(client, { targetType, targetId });
      const targetConflictsWithDifferentTag =
        targetConflict !== null && targetConflict.labourlinkTagUuid !== normalizedUuid;

      if (targetConflictsWithDifferentTag && !confirmReplaceTarget) {
        await client.query("rollback");
        return res.status(409).json({
          error: "This target already has a different active tag — confirm to proceed.",
          targetConflict,
        });
      }

      if (targetConflictsWithDifferentTag) await deactivateMapping(client, targetConflict!.id, req.device!.employeeId);

      const { rows } = await client.query(
        `insert into nfc_tag_mappings (greenhouse_row_id, carrier_id, tag_kind, labourlink_tag_uuid, created_by_employee_id)
         values ($1, $2, 'labourlink', $3, $4) returning id`,
        [
          targetType === "greenhouse_row" ? targetId : null,
          targetType === "carrier" ? targetId : null,
          normalizedUuid,
          req.device!.employeeId,
        ]
      );

      await client.query("commit");
      res.json({ mappingId: rows[0].id });
    } catch (err) {
      await client.query("rollback");
      if ((err as { code?: string }).code === "23505") {
        // A fresh UUIDv4 colliding with an existing tag-side mapping is
        // effectively impossible — surfaced as a clear retry rather than a
        // raw 500 anyway, since the client already committed to writing
        // this UUID onto the physical tag before calling this endpoint.
        return res.status(409).json({ error: "This tag ID was just used by someone else. Generate a new tag and try again." });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

export default router;
