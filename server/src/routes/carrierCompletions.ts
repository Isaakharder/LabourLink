// Confirms one or more work segments as representing one completed bin —
// the carrier-scoped mirror of rowCompletions.ts. Unlike a row completion
// there is no density/quantity to validate consistency on: only that every
// selected entry is an active, completed work entry sharing the same
// carrier_id and not already claimed by another completion.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getCarriersWithPendingWork, getUnresolvedRunsForCarrier } from "../lib/carrierCompletionCandidates";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every unresolved (not yet part of a confirmed carrier_completions record)
// run touching this carrier, across every employee — powers the Dashboard's
// bin-completion review modal.
router.get(
  "/candidates",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const carrierId = req.query.carrierId as string | undefined;
    if (!carrierId || !UUID_RE.test(carrierId)) {
      return res.status(400).json({ error: "A valid carrierId is required" });
    }
    const candidates = await getUnresolvedRunsForCarrier(carrierId);
    res.json({ candidates });
  })
);

// Every carrier with at least one segment not yet resolved into a
// completion, scoped to the given activity ids (the Dashboard's currently-
// configured "picking" card-type activities) — lets the review panel offer
// "which bins need attention" without the admin already knowing a carrier id.
router.get(
  "/pending",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const raw = req.query.activityIds;
    const activityIds = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : []).filter(
      (id): id is string => typeof id === "string" && UUID_RE.test(id)
    );
    const pending = await getCarriersWithPendingWork(activityIds);
    res.json({ pending });
  })
);

// Confirms one or more runs as representing the same completed bin.
// Selecting a single run and combining it is the supported way to record
// "this is deliberately its own completion" — same convention as
// POST /api/row-completions.
router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const raw = req.body?.timeEntryIds;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ error: "At least one timeEntryId is required" });
    }
    const timeEntryIds = [...new Set(raw)];
    if (!timeEntryIds.every((id) => typeof id === "string" && UUID_RE.test(id))) {
      return res.status(400).json({ error: "One or more timeEntryIds are invalid" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const { rows } = await client.query(
        `select te.id, te.entry_type, te.deleted_at, te.ended_at, te.carrier_id,
                ccs.time_entry_id as already_completed
         from time_entries te
         left join carrier_completion_segments ccs on ccs.time_entry_id = te.id
         where te.id = any($1::uuid[])`,
        [timeEntryIds]
      );
      if (rows.length !== timeEntryIds.length) {
        await client.query("rollback");
        return res.status(400).json({ error: "One or more time entries were not found" });
      }
      for (const r of rows) {
        if (r.entry_type !== "work" || r.deleted_at !== null) {
          await client.query("rollback");
          return res.status(400).json({ error: "Only active work entries can be combined" });
        }
        if (r.ended_at === null) {
          await client.query("rollback");
          return res.status(400).json({ error: "An in-progress entry cannot be combined into a completed bin" });
        }
        if (!r.carrier_id) {
          await client.query("rollback");
          return res.status(400).json({ error: "One or more entries have no carrier assigned" });
        }
        if (r.already_completed) {
          await client.query("rollback");
          return res.status(409).json({ error: "One or more entries already belong to a completed bin" });
        }
      }
      const first = rows[0];
      const consistent = rows.every((r) => r.carrier_id === first.carrier_id);
      if (!consistent) {
        await client.query("rollback");
        return res.status(400).json({ error: "Selected entries do not all refer to the same carrier" });
      }

      const { rows: created } = await client.query(
        `insert into carrier_completions (carrier_id, confirmed_by_employee_id)
         values ($1, $2)
         returning id, carrier_id, completed_at`,
        [first.carrier_id, req.employee!.id]
      );
      const completion = created[0];

      await client.query(
        `insert into carrier_completion_segments (time_entry_id, carrier_completion_id)
         select unnest($1::uuid[]), $2`,
        [timeEntryIds, completion.id]
      );

      await client.query("commit");
      res.status(201).json({
        carrierCompletion: {
          id: completion.id,
          carrierId: completion.carrier_id,
          completedAt: completion.completed_at,
          segmentCount: timeEntryIds.length,
        },
      });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

export default router;
