import { Router } from "express";
import { PoolClient } from "pg";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice, requireDeviceAdmin } from "../middleware/device";
import {
  deactivateMapping,
  findActiveMappingByIdentifier,
  findActiveMappingByTarget,
  isTagAction,
  listActiveMappings,
  normalizeHardwareId,
  TagMapping,
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
  return v === "greenhouse_row" || v === "carrier" || v === "activity" || v === "action";
}

// targetId is a row/carrier/activity UUID, or one of TAG_ACTIONS for "action".
function isValidTargetId(targetType: TargetType, targetId: unknown): targetId is string {
  if (typeof targetId !== "string") return false;
  return targetType === "action" ? isTagAction(targetId) : UUID_RE.test(targetId);
}

async function targetExists(targetType: TargetType, targetId: string): Promise<boolean> {
  if (targetType === "action") return isTagAction(targetId);
  const sql =
    targetType === "greenhouse_row"
      ? "select 1 from greenhouse_rows where id = $1 and deleted_at is null"
      : targetType === "carrier"
        ? "select 1 from carriers where id = $1 and is_active = true"
        : "select 1 from activities where id = $1 and is_active = true";
  const { rows } = await pool.query(sql, [targetId]);
  return rows.length > 0;
}

function sameTarget(m: TagMapping, targetType: TargetType, targetId: string): boolean {
  return m.targetType === targetType && m.targetId === targetId;
}

async function insertMapping(
  client: PoolClient,
  targetType: TargetType,
  targetId: string,
  identifier: { labourlinkTagUuid: string } | { ridderHardwareId: string },
  employeeId: string
): Promise<string> {
  const isLabourlink = "labourlinkTagUuid" in identifier;
  const { rows } = await client.query(
    `insert into nfc_tag_mappings
       (greenhouse_row_id, carrier_id, activity_id, action, tag_kind, labourlink_tag_uuid, ridder_hardware_id, created_by_employee_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      targetType === "greenhouse_row" ? targetId : null,
      targetType === "carrier" ? targetId : null,
      targetType === "activity" ? targetId : null,
      targetType === "action" ? targetId : null,
      isLabourlink ? "labourlink" : "ridder",
      isLabourlink ? identifier.labourlinkTagUuid : null,
      isLabourlink ? null : identifier.ridderHardwareId,
      employeeId,
    ]
  );
  return rows[0].id;
}

// Every active mapping, for the mobile app's offline scan-resolution cache
// (web/src/lib/nfcMappingCache.ts) — no admin check, any paired device needs
// this to resolve a scan, same as it already needs /api/mobile/greenhouse-rows
// and /api/mobile/activities. Row/carrier only unless ?include=all: clients
// from before activity/action tags (migration 062) would misread those.
router.get(
  "/mappings",
  asyncHandler(async (req, res) => {
    const mappings = await listActiveMappings(pool, { includeAll: req.query.include === "all" });
    res.json({ mappings });
  })
);

// Registers a tag by its hardware ID (Ridder tags, read-only tags, or any tag
// registered as-is without writing to it). Retrying the same tag + target is
// a no-op success.
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
    if (!isValidTargetType(targetType) || !isValidTargetId(targetType, targetId)) {
      return res.status(400).json({ error: "A valid targetType and targetId are required." });
    }
    if (!ridderHardwareId || !HEX_ID_RE.test(ridderHardwareId)) {
      return res.status(400).json({ error: "A valid ridderHardwareId is required." });
    }
    if (!(await targetExists(targetType, targetId))) {
      return res.status(400).json({ error: "targetId does not match an active row, carrier, activity or action." });
    }

    const normalizedId = normalizeHardwareId(ridderHardwareId);
    const client = await pool.connect();
    try {
      await client.query("begin");

      const tagConflict = await findActiveMappingByIdentifier(client, { ridderHardwareId: normalizedId });
      if (tagConflict && sameTarget(tagConflict, targetType, targetId)) {
        await client.query("rollback");
        return res.json({ mappingId: tagConflict.id, alreadyRegistered: true });
      }
      const targetConflict = await findActiveMappingByTarget(client, { targetType, targetId });

      const tagConflictsWithDifferentTarget = tagConflict !== null;
      const targetConflictsWithDifferentTag = targetConflict !== null && targetConflict.ridderHardwareId !== normalizedId;

      if ((tagConflictsWithDifferentTarget && !confirmReplaceTag) || (targetConflictsWithDifferentTag && !confirmReplaceTarget)) {
        await client.query("rollback");
        return res.status(409).json({
          error: "This would change an existing mapping — confirm to proceed.",
          code: tagConflictsWithDifferentTarget ? "TAG_ASSIGNED_ELSEWHERE" : "TARGET_HAS_DIFFERENT_TAG",
          tagConflict: tagConflictsWithDifferentTarget ? tagConflict : null,
          targetConflict: targetConflictsWithDifferentTag ? targetConflict : null,
        });
      }

      if (tagConflictsWithDifferentTarget) await deactivateMapping(client, tagConflict!.id, req.device!.employeeId);
      if (targetConflictsWithDifferentTag) await deactivateMapping(client, targetConflict!.id, req.device!.employeeId);

      const mappingId = await insertMapping(client, targetType, targetId, { ridderHardwareId: normalizedId }, req.device!.employeeId);
      await client.query("commit");
      res.json({ mappingId });
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

// Maps a freshly written LabourLink tag ID. Retrying the same tag ID + target
// returns the existing mapping (an offline-queued registration may be re-sent
// after a lost response).
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
    if (!isValidTargetType(targetType) || !isValidTargetId(targetType, targetId)) {
      return res.status(400).json({ error: "A valid targetType and targetId are required." });
    }
    if (!labourlinkTagUuid || !UUID_RE.test(labourlinkTagUuid)) {
      return res.status(400).json({ error: "A valid labourlinkTagUuid is required." });
    }
    if (!(await targetExists(targetType, targetId))) {
      return res.status(400).json({ error: "targetId does not match an active row, carrier, activity or action." });
    }

    const normalizedUuid = labourlinkTagUuid.toLowerCase();
    const client = await pool.connect();
    try {
      await client.query("begin");

      const existing = await findActiveMappingByIdentifier(client, { labourlinkTagUuid: normalizedUuid });
      if (existing && sameTarget(existing, targetType, targetId)) {
        await client.query("rollback");
        return res.json({ mappingId: existing.id, alreadyRegistered: true });
      }
      if (existing) {
        await client.query("rollback");
        return res.status(409).json({
          error: "This tag ID was just used by someone else. Generate a new tag and try again.",
          code: "TAG_ID_IN_USE",
        });
      }

      const targetConflict = await findActiveMappingByTarget(client, { targetType, targetId });
      if (targetConflict && !confirmReplaceTarget) {
        await client.query("rollback");
        return res.status(409).json({
          error: "This target already has a different active tag — confirm to proceed.",
          code: "TARGET_HAS_DIFFERENT_TAG",
          targetConflict,
        });
      }
      if (targetConflict) await deactivateMapping(client, targetConflict.id, req.device!.employeeId);

      const mappingId = await insertMapping(client, targetType, targetId, { labourlinkTagUuid: normalizedUuid }, req.device!.employeeId);
      await client.query("commit");
      res.json({ mappingId });
    } catch (err) {
      await client.query("rollback");
      if ((err as { code?: string }).code === "23505") {
        return res.status(409).json({
          error: "This tag ID was just used by someone else. Generate a new tag and try again.",
          code: "TAG_ID_IN_USE",
        });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

// Removes a tag's assignment ("Clear Tag"). The caller states which target it
// expects the tag to be assigned to; if the tag now belongs to something else
// (reassigned since the phone last refreshed — e.g. a queued offline removal)
// nothing is removed. Idempotent: an already-removed assignment is a success.
router.post(
  "/unassign",
  requireDeviceAdmin,
  asyncHandler(async (req, res) => {
    const { labourlinkTagUuid, ridderHardwareId, expectedTargetType, expectedTargetId } = req.body as {
      labourlinkTagUuid?: string;
      ridderHardwareId?: string;
      expectedTargetType?: string;
      expectedTargetId?: string;
    };
    const hasUuid = typeof labourlinkTagUuid === "string" && UUID_RE.test(labourlinkTagUuid);
    const hasHw = typeof ridderHardwareId === "string" && HEX_ID_RE.test(ridderHardwareId);
    if (hasUuid === hasHw) {
      return res.status(400).json({ error: "Exactly one of labourlinkTagUuid or ridderHardwareId is required." });
    }
    if (!isValidTargetType(expectedTargetType) || !isValidTargetId(expectedTargetType, expectedTargetId)) {
      return res.status(400).json({ error: "A valid expectedTargetType and expectedTargetId are required." });
    }

    const identifier = hasUuid
      ? { labourlinkTagUuid: labourlinkTagUuid!.toLowerCase() }
      : { ridderHardwareId: normalizeHardwareId(ridderHardwareId!) };
    const client = await pool.connect();
    try {
      await client.query("begin");
      const current = await findActiveMappingByIdentifier(client, identifier);
      if (!current) {
        await client.query("rollback");
        return res.json({ removed: false, alreadyRemoved: true });
      }
      if (!sameTarget(current, expectedTargetType, expectedTargetId)) {
        await client.query("rollback");
        return res.status(409).json({
          error: `This tag is now assigned to ${current.label}, so it was not removed.`,
          code: "ASSIGNMENT_CHANGED",
          current,
        });
      }
      await deactivateMapping(client, current.id, req.device!.employeeId);
      await client.query("commit");
      res.json({ removed: true, mappingId: current.id });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

export default router;
