import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getUnresolvedRunsForRow, getUnresolvedRunsForRows } from "../lib/rowCompletionCandidates";
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

// Applies the bulk review's chosen actions in one request, ALL OR NOTHING.
//
// History (2026-10-10 production incident): this used to commit each group
// in its own transaction, and each completion re-read its row's whole visit
// history (~1.3s per group). A Railway deploy restarted the API part-way
// through an 8-group batch: six groups were saved, two weren't, and the
// browser only got Railway's own error page ("Request failed") — with no way
// to tell what had been saved. Now:
//
//   1. Every submitted group is checked first against the server's own
//      grouping for the date (the client's grouping is never trusted):
//        ready         still pending, same visits, action supported;
//        alreadySaved  no longer pending because its visits are already
//                      completed exactly as this action would have done it
//                      (a retry after a lost response, or after the old
//                      partial save) — reported as saved, never redone;
//        stale/invalid anything else (resolved differently, visits changed,
//                      action no longer supported).
//   2. If any group is stale/invalid, NOTHING is written: 409
//      BULK_REVIEW_STALE with a per-group status, so the client can drop just
//      those groups and keep every other selection.
//   3. Otherwise every ready group is applied in ONE transaction through
//      createRowCompletion (the same validation the individual Combine uses:
//      cycle, whole-visit, density, already-completed), with the window and
//      candidate visits loaded once for the batch. Any failure — expected
//      refusal, unexpected error, or the process dying — rolls the whole
//      batch back. The row_completion_segments primary key still makes a
//      concurrent duplicate submission fail instead of double-counting.
//   Every response says whether anything was saved (`saved`).
type BulkGroupStatus = "ready" | "alreadySaved" | "stale" | "invalid";

const STALE_GROUP_MESSAGE = "This group no longer needs review — it was resolved or changed after the review was opened.";

router.post(
  "/bulk-review",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const date = req.body?.date;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required", saved: false });
    }
    const raw = req.body?.groups;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BULK_GROUPS) {
      return res.status(400).json({ error: `Between 1 and ${MAX_BULK_GROUPS} groups are required`, saved: false });
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
      return res.status(400).json({ error: "One or more groups are invalid — nothing was saved.", saved: false });
    }
    if (new Set(submitted.map((g) => g.groupId)).size !== submitted.length) {
      return res.status(400).json({ error: "A group was submitted more than once — nothing was saved.", saved: false });
    }
    const groups = submitted as { groupId: string; action: "merge" | "separate"; visits: string[][] }[];
    const allSegmentIds = groups.flatMap((g) => g.visits.flat());
    if (new Set(allSegmentIds).size !== allSegmentIds.length) {
      return res.status(400).json({ error: "The same entry appears in more than one selected group — nothing was saved.", saved: false });
    }

    const windowDays = await getRowReviewWindowDays();
    const serverGroups = new Map((await getSpeedReviewGroups({ date, windowDays })).map((g) => [g.id, g]));
    const visitSetKey = (visits: string[][]) =>
      visits
        .map((v) => [...v].sort().join(","))
        .sort()
        .join("|");

    // Existing completions for every submitted entry, for the alreadySaved test.
    const { rows: existingRows } = await pool.query(
      `select time_entry_id, row_completion_id from row_completion_segments where time_entry_id = any($1::uuid[])`,
      [allSegmentIds]
    );
    const completionByEntry = new Map<string, string>(existingRows.map((r) => [r.time_entry_id, r.row_completion_id]));
    const completionSegments = new Map<string, Set<string>>();
    if (existingRows.length > 0) {
      const { rows } = await pool.query(
        `select time_entry_id, row_completion_id from row_completion_segments where row_completion_id = any($1::uuid[])`,
        [[...new Set(existingRows.map((r) => r.row_completion_id))]]
      );
      for (const r of rows) {
        const set = completionSegments.get(r.row_completion_id) ?? new Set<string>();
        set.add(r.time_entry_id);
        completionSegments.set(r.row_completion_id, set);
      }
    }
    const sameSet = (a: Set<string> | undefined, b: string[]) => !!a && a.size === b.length && b.every((id) => a.has(id));
    // True when the visits are already completed exactly as `action` would.
    function alreadyAppliedAs(action: "merge" | "separate", visits: string[][]): boolean {
      if (action === "merge") {
        const all = visits.flat();
        const ids = new Set(all.map((id) => completionByEntry.get(id)));
        if (ids.size !== 1 || ids.has(undefined)) return false;
        return sameSet(completionSegments.get([...ids][0]!), all);
      }
      const used = new Set<string>();
      for (const v of visits) {
        const ids = new Set(v.map((id) => completionByEntry.get(id)));
        if (ids.size !== 1 || ids.has(undefined)) return false;
        const id = [...ids][0]!;
        if (used.has(id) || !sameSet(completionSegments.get(id), v)) return false;
        used.add(id);
      }
      return true;
    }

    const classified = groups.map((g) => {
      const group = serverGroups.get(g.groupId);
      if (!group) {
        return alreadyAppliedAs(g.action, g.visits)
          ? { g, status: "alreadySaved" as BulkGroupStatus }
          : { g, status: "stale" as BulkGroupStatus, error: STALE_GROUP_MESSAGE };
      }
      if (visitSetKey(g.visits) !== visitSetKey(group.visits.map((v) => v.segmentIds))) {
        return {
          g,
          status: "stale" as BulkGroupStatus,
          error: "This group's visits changed after the review was opened — reopen the review to see the current entries.",
        };
      }
      const action = group.actions[g.action];
      if (!action.available) {
        return { g, status: "invalid" as BulkGroupStatus, error: action.unavailableReason ?? "This action isn't available for this group." };
      }
      return { g, status: "ready" as BulkGroupStatus, group };
    });

    const blocked = classified.filter((c) => c.status === "stale" || c.status === "invalid");
    if (blocked.length > 0) {
      return res.status(409).json({
        code: "BULK_REVIEW_STALE",
        saved: false,
        error: `${blocked.length} of ${groups.length} selected group${groups.length === 1 ? "" : "s"} changed after the review was opened, so nothing was saved. Those groups are marked below; apply again to save the rest.`,
        results: classified.map((c) =>
          c.status === "stale" || c.status === "invalid"
            ? { groupId: c.g.groupId, ok: false, status: c.status, error: c.error }
            : { groupId: c.g.groupId, ok: false, status: c.status }
        ),
      });
    }

    const ready = classified.filter((c) => c.status === "ready");
    const completionIdsByGroup = new Map<string, string[]>();
    if (ready.length > 0) {
      // Candidate visits for every row+activity+density in the batch, loaded
      // once from committed state (what each createRowCompletion would
      // otherwise re-read on its own).
      const keys = ready.map((c) => ({
        greenhouseRowId: c.group!.greenhouseRowId,
        activityId: c.group!.activityId,
        densityType: c.group!.densityType,
      }));
      const candidatesByKey = await getUnresolvedRunsForRows(keys, { windowDays });

      const client = await pool.connect();
      let current: (typeof ready)[number] | null = null;
      try {
        await client.query("begin");
        for (const c of ready) {
          current = c;
          const candidates =
            candidatesByKey.get(`${c.group!.greenhouseRowId}:${c.group!.activityId}:${c.group!.densityType}`) ?? [];
          const opts = { windowDays, candidates };
          const ids: string[] = [];
          if (c.g.action === "merge") {
            ids.push((await createRowCompletion(client, c.group!.visits.flatMap((v) => v.segmentIds), req.employee!.id, opts)).id);
          } else {
            for (const v of c.group!.visits) ids.push((await createRowCompletion(client, v.segmentIds, req.employee!.id, opts)).id);
          }
          completionIdsByGroup.set(c.g.groupId, ids);
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        const label = current ? `${current.group!.employeeName} — ${current.group!.rowLabel}` : "a group";
        const results = classified.map((c) => ({
          groupId: c.g.groupId,
          ok: false,
          status: c.status,
          ...(c === current ? { error: err instanceof RowCompletionError ? err.message : "Unexpected error saving this group." } : {}),
        }));
        if (err instanceof RowCompletionError) {
          return res.status(err.status === 409 ? 409 : 400).json({
            code: "BULK_REVIEW_FAILED",
            saved: false,
            error: `Couldn't save ${label}: ${err.message} Nothing was saved — all selected groups are still pending.`,
            results,
          });
        }
        console.error(`[row-completions] bulk review failed on group ${current?.g.groupId ?? "?"}:`, err);
        return res.status(500).json({
          code: "BULK_REVIEW_FAILED",
          saved: false,
          error: "Unexpected error while saving — nothing was saved and all selected groups are still pending. Retrying is safe.",
          results,
        });
      } finally {
        client.release();
      }
    }

    res.json({
      saved: true,
      results: classified.map((c) =>
        c.status === "alreadySaved"
          ? { groupId: c.g.groupId, ok: true, alreadySaved: true }
          : { groupId: c.g.groupId, ok: true, completionIds: completionIdsByGroup.get(c.g.groupId) ?? [] }
      ),
    });
  })
);

export default router;
