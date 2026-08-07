import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getUnresolvedRunsForRow } from "../lib/rowCompletionCandidates";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENSITY_TYPES = new Set(["plants", "stems"]);

// Every unresolved (not yet part of a confirmed row_completions record) run
// touching this row+type, across every employee — powers the review modal
// an admin opens from the "needs review" warning on Inputs.
router.get(
  "/candidates",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const greenhouseRowId = req.query.greenhouseRowId as string | undefined;
    const densityType = req.query.densityType as string | undefined;
    if (!greenhouseRowId || !UUID_RE.test(greenhouseRowId)) {
      return res.status(400).json({ error: "A valid greenhouseRowId is required" });
    }
    if (!densityType || !DENSITY_TYPES.has(densityType)) {
      return res.status(400).json({ error: "densityType must be 'plants' or 'stems'" });
    }

    const candidates = await getUnresolvedRunsForRow(greenhouseRowId, densityType as "plants" | "stems");
    res.json({ candidates });
  })
);

// Confirms one or more runs as representing the same completed physical
// row. Selecting a single run and combining it is the supported way to
// record "these are deliberately separate completions" — it creates a
// size-1 completion for just that run, leaving any other pending run on the
// same row+type to be resolved independently (its own combine, whenever the
// admin gets to it). No merge is ever implied by row id alone.
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
        `select te.id, te.entry_type, te.deleted_at, te.ended_at, te.greenhouse_row_id,
                te.density_type, te.density_count_per_row, rcs.time_entry_id as already_completed
         from time_entries te
         left join row_completion_segments rcs on rcs.time_entry_id = te.id
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
          return res.status(400).json({ error: "An in-progress entry cannot be combined into a completed row" });
        }
        if (!r.density_type || !r.density_count_per_row) {
          await client.query("rollback");
          return res.status(400).json({ error: "One or more entries have no resolvable row density" });
        }
        if (r.already_completed) {
          await client.query("rollback");
          return res.status(409).json({ error: "One or more entries already belong to a completed row" });
        }
      }
      const first = rows[0];
      const consistent = rows.every(
        (r) =>
          r.greenhouse_row_id === first.greenhouse_row_id &&
          r.density_type === first.density_type &&
          Number(r.density_count_per_row) === Number(first.density_count_per_row)
      );
      if (!consistent) {
        await client.query("rollback");
        return res.status(400).json({ error: "Selected entries do not all refer to the same row and density" });
      }

      const { rows: created } = await client.query(
        `insert into row_completions (greenhouse_row_id, density_type, quantity_per_row, confirmed_by_employee_id)
         values ($1, $2, $3, $4)
         returning id, greenhouse_row_id, density_type, quantity_per_row, completed_at`,
        [first.greenhouse_row_id, first.density_type, first.density_count_per_row, req.employee!.id]
      );
      const completion = created[0];

      await client.query(
        `insert into row_completion_segments (time_entry_id, row_completion_id)
         select unnest($1::uuid[]), $2`,
        [timeEntryIds, completion.id]
      );

      await client.query("commit");
      res.status(201).json({
        rowCompletion: {
          id: completion.id,
          greenhouseRowId: completion.greenhouse_row_id,
          densityType: completion.density_type,
          quantityPerRow: Number(completion.quantity_per_row),
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
