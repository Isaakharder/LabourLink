import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getUnresolvedRunsForRow } from "../lib/rowCompletionCandidates";
import { createRowCompletion, RowCompletionError } from "../lib/rowCompletionCreate";
import { getSpeedReviewGroups } from "../lib/speedReviewGroups";
import {
  getRowReviewWindowDays,
  isValidRowReviewWindowDays,
  MAX_ROW_REVIEW_WINDOW_DAYS,
  MIN_ROW_REVIEW_WINDOW_DAYS,
  setRowReviewWindowDays,
} from "../lib/rowReviewWindow";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENSITY_TYPES = new Set(["plants", "stems"]);

// Row review window (Setup > Row Review; 057_row_review_window.sql): the
// number of calendar days that separates one row-work cycle from the next.
// Same gate as Setup's other configuration: GET is Administrator/Manager,
// PUT is Administrator-only. Saving takes effect on the next request of
// every consumer (nothing caches it) and regroups only UNRESOLVED visits —
// confirmed completions are never read or changed by it.
router.get(
  "/review-window",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    res.json({ rowReviewWindowDays: await getRowReviewWindowDays() });
  })
);

router.put(
  "/review-window",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { rowReviewWindowDays } = (req.body ?? {}) as { rowReviewWindowDays?: unknown };
    if (!isValidRowReviewWindowDays(rowReviewWindowDays)) {
      return res.status(400).json({
        error: `Row review window must be a whole number of days from ${MIN_ROW_REVIEW_WINDOW_DAYS} to ${MAX_ROW_REVIEW_WINDOW_DAYS}`,
      });
    }
    await setRowReviewWindowDays(rowReviewWindowDays, req.employee!.id);
    res.json({ rowReviewWindowDays });
  })
);

// Every unresolved (not yet part of a confirmed row_completions record) run
// touching this row+activity+type, across every employee — powers the
// review modal an admin opens from the "needs review" warning on Inputs.
// activityId is required, not optional — a row+type pair alone is not a
// complete ambiguity scope (see getUnresolvedRunsForRow's own comment /
// 045_row_completion_activity_id.sql): a different activity sharing this
// row and density type must never appear in this list.
//
// Optional timeEntryId: any segment of the visit the admin opened the
// review from. When given, only the candidates in THAT visit's row-work
// cycle (cut at the Row review window setting) are returned — a
// cycle is the only scope that can ever be combined (see POST below), so
// listing other cycles invites a combine the server will refuse. If the
// segment is no longer part of any unresolved candidate (resolved
// elsewhere since the page loaded), the list is empty, which the modal
// already treats as "this badge is stale".
router.get(
  "/candidates",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const greenhouseRowId = req.query.greenhouseRowId as string | undefined;
    const activityId = req.query.activityId as string | undefined;
    const densityType = req.query.densityType as string | undefined;
    if (!greenhouseRowId || !UUID_RE.test(greenhouseRowId)) {
      return res.status(400).json({ error: "A valid greenhouseRowId is required" });
    }
    if (!activityId || !UUID_RE.test(activityId)) {
      return res.status(400).json({ error: "A valid activityId is required" });
    }
    if (!densityType || !DENSITY_TYPES.has(densityType)) {
      return res.status(400).json({ error: "densityType must be 'plants' or 'stems'" });
    }
    const timeEntryId = req.query.timeEntryId as string | undefined;
    if (timeEntryId !== undefined && !UUID_RE.test(timeEntryId)) {
      return res.status(400).json({ error: "timeEntryId must be a valid id" });
    }

    // windowDays is returned so the modal's explanation names the same
    // window this grouping was cut at.
    const windowDays = await getRowReviewWindowDays();
    const candidates = await getUnresolvedRunsForRow(greenhouseRowId, activityId, densityType as "plants" | "stems", { windowDays });
    if (timeEntryId === undefined) {
      return res.json({ candidates, windowDays });
    }
    const anchor = candidates.find((c) => c.segmentIds.includes(timeEntryId));
    res.json({ candidates: anchor ? candidates.filter((c) => c.cycleIndex === anchor.cycleIndex) : [], windowDays });
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
      const rowCompletion = await createRowCompletion(client, timeEntryIds, req.employee!.id);
      await client.query("commit");
      res.status(201).json({ rowCompletion });
    } catch (err) {
      await client.query("rollback");
      if (err instanceof RowCompletionError) {
        return res.status(err.status).json({ error: err.message });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
const REVIEW_ACTIONS = new Set(["merge", "separate"]);
const MAX_BULK_GROUPS = 500;

// Bulk speed review: every "Needs review" visit on one date, organized into
// proposed review groups (see speedReviewGroups.ts). employeeId scopes it to
// one employee (Inputs "Review speeds"); omitted = every employee
// (Inputs "Review all employees"). Read-only — same roles as /candidates.
router.get(
  "/review-groups",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const date = req.query.date;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }
    const employeeId = req.query.employeeId as string | undefined;
    if (employeeId !== undefined && !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "employeeId must be a valid id" });
    }
    const windowDays = await getRowReviewWindowDays();
    const groups = await getSpeedReviewGroups({ date, employeeId: employeeId ?? null, windowDays });
    res.json({ date, groups, windowDays });
  })
);

// Applies the bulk review's chosen actions in one request. Each group is
// independent: its own transaction, its own success/failure, so one bad
// group never blocks or partially applies another. The server never trusts
// the client's grouping — it rebuilds every group for the date itself and
// refuses any group that no longer exists, whose visits changed since the
// review was loaded, or whose action isn't supported for it; then applies
// the action from its OWN group data through createRowCompletion, the same
// validation the individual Combine uses (cycle, whole-visit, density,
// already-completed). The row_completion_segments primary key also makes a
// duplicate or concurrent submission fail instead of double-counting.
router.post(
  "/bulk-review",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const date = req.body?.date;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }
    const raw = req.body?.groups;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BULK_GROUPS) {
      return res.status(400).json({ error: `Between 1 and ${MAX_BULK_GROUPS} groups are required` });
    }
    const submitted = raw as { groupId?: unknown; action?: unknown; visits?: unknown }[];
    const wellFormed = submitted.every(
      (g) =>
        typeof g?.groupId === "string" &&
        typeof g.action === "string" &&
        REVIEW_ACTIONS.has(g.action) &&
        Array.isArray(g.visits) &&
        g.visits.length > 0 &&
        g.visits.every((v) => Array.isArray(v) && v.length > 0 && v.every((id) => typeof id === "string" && UUID_RE.test(id)))
    );
    if (!wellFormed) {
      return res.status(400).json({ error: "One or more groups are invalid" });
    }
    if (new Set(submitted.map((g) => g.groupId)).size !== submitted.length) {
      return res.status(400).json({ error: "A group was submitted more than once" });
    }

    const serverGroups = new Map((await getSpeedReviewGroups({ date })).map((g) => [g.id, g]));
    const visitSetKey = (visits: string[][]) =>
      visits
        .map((v) => [...v].sort().join(","))
        .sort()
        .join("|");

    const results: { groupId: string; ok: boolean; error?: string; completionIds?: string[] }[] = [];
    for (const g of submitted as { groupId: string; action: "merge" | "separate"; visits: string[][] }[]) {
      const group = serverGroups.get(g.groupId);
      if (!group) {
        results.push({ groupId: g.groupId, ok: false, error: "This group no longer needs review — it was resolved or changed after the review was opened." });
        continue;
      }
      if (visitSetKey(g.visits) !== visitSetKey(group.visits.map((v) => v.segmentIds))) {
        results.push({ groupId: g.groupId, ok: false, error: "This group's visits changed after the review was opened — reopen the review to see the current entries." });
        continue;
      }
      const action = group.actions[g.action];
      if (!action.available) {
        results.push({ groupId: g.groupId, ok: false, error: action.unavailableReason ?? "This action isn't available for this group." });
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        const completionIds: string[] = [];
        if (g.action === "merge") {
          const all = group.visits.flatMap((v) => v.segmentIds);
          completionIds.push((await createRowCompletion(client, all, req.employee!.id)).id);
        } else {
          for (const v of group.visits) completionIds.push((await createRowCompletion(client, v.segmentIds, req.employee!.id)).id);
        }
        await client.query("commit");
        results.push({ groupId: g.groupId, ok: true, completionIds });
      } catch (err) {
        await client.query("rollback");
        if (err instanceof RowCompletionError) {
          results.push({ groupId: g.groupId, ok: false, error: err.message });
        } else {
          console.error(`[row-completions] bulk review group ${g.groupId} failed:`, err);
          results.push({ groupId: g.groupId, ok: false, error: "Unexpected error saving this group — nothing was changed for it." });
        }
      } finally {
        client.release();
      }
    }

    res.json({ results });
  })
);

export default router;
