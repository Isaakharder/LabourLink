import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getSignedPhotoUrl, getSignedPhotoUrls } from "../lib/storage";
import { calendarDateInAppTimezone, getDayBoundsUtc, APP_TIMEZONE } from "../lib/timezone";
import { groupIntoActivityRuns, RunSegment } from "../lib/activityRuns";
import { reconcileEmployeeBreaks } from "../lib/breakReconciliation";
import { reconcileMidnightRollover } from "../lib/midnightRollover";
import { aggregateDensitySpeed } from "../lib/densitySpeed";
import { computeWorkdayTotals, WorkdayBoundaryEntry } from "../lib/workdayTotals";
import { getRolloverPriorDurationSeconds, getUnresolvedRunsForRows } from "../lib/rowCompletionCandidates";
import {
  loadCarrierOptions,
  loadEmployeeActivitiesWithQuestions,
  loadGreenhouseRowOptions,
  resolveDensitySnapshot,
  validateActivityAndAnswers,
} from "../lib/activitySelection";
import {
  describeConflict,
  findOverlappingEntry,
  lockEmployeeForManualEntry,
  planActivityInsertion,
  planBreakInsertion,
  BreakInsertionPlan,
} from "../lib/manualTimeEntries";
import { PoolClient } from "pg";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EDIT_ROLES = ["Administrator", "Manager", "Supervisor"];

// Same minimum as the existing deletion-reason requirement (POST
// .../delete below) — one consistent bar for "a real reason was typed,"
// not a stricter one just because this is newer.
const MIN_REASON_LENGTH = 3;

function isValidReason(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= MIN_REASON_LENGTH;
}

// Corrections (end-time, break start/end, work-start below) no longer
// collect a typed reason from the caller — the Inputs page's "Reason for
// correction" modal was removed. The audit trail requirement (schema and
// downstream reporting both still expect a non-empty reason on every
// time_entry_corrections row) is preserved by always writing this fixed,
// server-generated string instead of trusting client-supplied text.
// Deletion (POST .../delete below, both activity-run and break) is a
// separate, unrelated flow from the corrections above, but neither the
// Inputs page's activity-log nor break deletion modal collects a typed
// reason from the caller anymore (confirmation only) — both use this same
// "fixed, server-generated string" approach instead.
const AUTO_CORRECTION_REASON = "Time corrected from Inputs page";
const ACTIVITY_LOG_DELETION_REASON = "Activity log deleted from Inputs page";
const BREAK_DELETION_REASON = "Break deleted from Inputs page";
// A work entry a manually-added break turned out to completely cover (see
// planBreakInsertion) is removed the same way any other admin-initiated
// deletion is — this is that deletion's fixed, server-generated reason,
// same "system-generated string, not trusted client text" convention as
// AUTO_CORRECTION_REASON/BREAK_DELETION_REASON above.
const BREAK_SPLIT_DELETION_REASON = "Removed — fully covered by a manually added break";
// POST /breaks (below) no longer collects a typed reason from the caller —
// the Add Break modal's "Reason" field was removed. Same "fixed,
// server-generated string" convention as AUTO_CORRECTION_REASON and the
// others above, so the audit trail (creation_reason is still non-null on
// every row) is preserved without trusting client-supplied text.
const BREAK_MANUAL_ADD_REASON = "Break manually added from Inputs page.";
// PATCH /breaks/:id (below) reuses planBreakInsertion's own trim/split/
// delete classification against the CORRECTED [start, end) range — these
// mirror BREAK_SPLIT_DELETION_REASON/BREAK_MANUAL_ADD_REASON above with
// wording specific to a correction rather than a new break, so an admin
// reading the audit trail can tell which action actually caused a given
// row's trim/split/deletion.
const BREAK_CORRECTION_SPLIT_DELETION_REASON = "Removed — fully covered by a corrected break";
const BREAK_CORRECTION_SPLIT_REASON = "Activity continuation created by a break correction";

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// Picker data for the Add work start / Add activity modals — the exact
// same employee-scoped activities+questions shape and rules the mobile app
// itself uses (activitySelection.ts), just reached with admin auth instead
// of a paired device. Deliberately scoped to the employee's own active
// group assignments, not every activity that exists: an administrator can
// still only manually log what that employee was actually authorized to
// do, keeping a manually-added entry indistinguishable in meaning from one
// the employee could have logged themselves.
router.get(
  "/employee-activities",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const employeeId = req.query.employeeId as string | undefined;
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    res.json(await loadEmployeeActivitiesWithQuestions(pool, employeeId));
  })
);

// Row/carrier picker data for the same modals — identical shape/scope to
// the mobile pickers (activitySelection.ts), reached with admin auth.
router.get(
  "/greenhouse-rows",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (_req, res) => {
    res.json({ lands: await loadGreenhouseRowOptions(pool) });
  })
);

router.get(
  "/carriers",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (_req, res) => {
    res.json({ carriers: await loadCarrierOptions(pool) });
  })
);

// Break-type picker data for the Add break modal — the employee's own
// assigned break profile's active scheduled items, the same set a phone's
// fixed-break match would consider (mobileTime.ts's loadActiveFixedItems).
// A dedicated endpoint rather than reusing GET /api/break-profiles/:id:
// that route is Administrator/Manager only, while a Supervisor can edit
// Inputs (EDIT_ROLES) and still needs this picker.
router.get(
  "/employee-break-items",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const employeeId = req.query.employeeId as string | undefined;
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    const empRes = await pool.query(
      `select bp.id, bp.name
       from employees e
       join break_profiles bp on bp.id = e.break_profile_id and bp.is_active = true
       where e.id = $1`,
      [employeeId]
    );
    const profile = empRes.rows[0];
    if (!profile) {
      return res.json({ breakProfile: null, items: [] });
    }
    const { rows } = await pool.query(
      `select id, name, to_char(start_time, 'HH24:MI:SS') as start_time,
              to_char(end_time, 'HH24:MI:SS') as end_time, is_paid
       from break_profile_items
       where break_profile_id = $1 and is_active = true
       order by sort_order`,
      [profile.id]
    );
    res.json({
      breakProfile: { id: profile.id, name: profile.name },
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        startTime: r.start_time,
        endTime: r.end_time,
        isPaid: r.is_paid,
      })),
    });
  })
);

// Supervisor can't call GET /api/employees (Administrator/Manager only,
// and it returns far more PII than a picker needs) — this is a minimal,
// purpose-built list for the Inputs page's employee panel.
//
// Scoped to the selected date's actual time-entry data, not is_active —
// deliberately NOT the same "active employees" list GET /api/employees
// returns. Real incident this fixes: an admin reviewing a past date saw
// every currently-active employee, including ones who never worked that
// day, mixed in with (and outnumbering) the ones who actually had logs to
// review; a since-deactivated employee who genuinely worked the selected
// day disappeared from the list entirely, hiding real history behind their
// current status. "Has at least one non-deleted time_entries row that day"
// (open work, open break, or a completed entry — entry_type doesn't matter,
// any of them means the employee showed up) is the only test now: is_active
// plays no part, so a deactivated employee with logs on this date stays
// visible, and an active employee with none for this date does not appear.
router.get(
  "/employees",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const date = req.query.date as string | undefined;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }
    const search = trimOrNull(req.query.search as string);
    const { start, end } = getDayBoundsUtc(date);
    const params: unknown[] = [start, end];
    const conditions = [
      `exists (
         select 1 from time_entries te
         where te.employee_id = e.id
           and te.started_at >= $1 and te.started_at < $2
           and te.deleted_at is null
       )`,
    ];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`lower(e.first_name || ' ' || e.last_name) like $${params.length}`);
    }

    const { rows } = await pool.query(
      `select e.id, e.first_name, e.last_name, e.profile_photo_path
       from employees e
       where ${conditions.join(" and ")}
       order by e.first_name, e.last_name`,
      params
    );

    const photoPaths = rows.filter((r) => r.profile_photo_path).map((r) => r.profile_photo_path);
    const urlMap = await getSignedPhotoUrls(photoPaths);

    res.json({
      employees: rows.map((r) => ({
        id: r.id,
        firstName: r.first_name,
        lastName: r.last_name,
        photoUrl: r.profile_photo_path ? urlMap.get(r.profile_photo_path) ?? null : null,
      })),
    });
  })
);

router.get(
  "/daily",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const __t0 = Date.now();
    const employeeId = req.query.employeeId as string | undefined;
    const date = req.query.date as string | undefined;
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }

    // is_active/break_profile_id are selected here (not just the fields
    // this response itself needs) so reconcileEmployeeBreaks below can
    // reuse this same row instead of re-querying the employee a few
    // milliseconds later for the identical two columns — see its own
    // KnownEmployeeBreakInfo comment.
    const empRes = await pool.query(
      "select id, first_name, last_name, profile_photo_path, is_active, break_profile_id from employees where id = $1",
      [employeeId]
    );
    const employee = empRes.rows[0];
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    // Signing the employee's photo URL is a real external Supabase Storage
    // API call (getSignedPhotoUrl — cached, but still a real request on a
    // cache miss) with no dependency on anything below: kicked off now, in
    // parallel with reconciliation and every query that follows, and only
    // awaited once when the response is finally assembled. Previously this
    // ran strictly after everything else, adding its full latency on top
    // instead of overlapping it — see the Inputs employee-switch
    // performance investigation.
    const photoUrlPromise = employee.profile_photo_path ? getSignedPhotoUrl(employee.profile_photo_path) : null;

    // Roll a still-open entry forward across any local midnight(s) it's
    // behind on before break reconciliation (which reasons about "today")
    // or the main time_entries query below runs — see midnightRollover.ts.
    // Deliberately scoped to viewing TODAY specifically, not "any date <=
    // today" (unlike reconcileEmployeeBreaks below, which legitimately
    // reconciles whichever day is being viewed): reconcileMidnightRollover
    // operates on whatever is GLOBALLY currently open for this employee,
    // not on the viewed date, so running it while an admin reviews an
    // unrelated old date would silently mutate the employee's live status
    // as a side effect of looking at old history — a surprising effect
    // with no real benefit, since the mobile app's own GET /me already
    // reconciles current status on every request regardless. Only viewing
    // today gets the extra request-time nudge here, matching what an admin
    // watching a live/current day would actually expect.
    const todayLocalForRollover = calendarDateInAppTimezone(new Date());
    if (date === todayLocalForRollover) {
      await reconcileMidnightRollover(employeeId);
    }

    // Reconcile scheduled breaks the employee worked straight through before
    // reading the day back — never for a future date (nothing to reconcile
    // yet, and reconcileEmployeeBreaks would just no-op on future-dated
    // items anyway, but skipping avoids the wasted round trip). Must
    // complete (and its own commit land) strictly BEFORE the main
    // time_entries query below runs — reconciliation can itself insert/split
    // time_entries rows, and this response has to reflect whatever it just
    // created, so this is deliberately awaited here rather than run
    // concurrently with the query that follows it.
    if (date <= calendarDateInAppTimezone(new Date())) {
      await reconcileEmployeeBreaks(employeeId, date, {
        isActive: employee.is_active,
        breakProfileId: employee.break_profile_id,
      });
    }
    console.log(`[timing] daily reconcile+empRes done: ${Date.now() - __t0}ms`);

    const { start, end } = getDayBoundsUtc(date);
    // Not filtered on activities.is_active — activities are never
    // hard-deleted, only deactivated, so filtering here would silently hide
    // legitimate history against a since-deactivated activity.
    // Not filtered on greenhouse_rows.deleted_at/greenhouse_phases.is_active
    // either — same "history always resolves" convention as the
    // unfiltered activities join above.
    const { rows: entryRows } = await pool.query(
      `select te.id, te.entry_type, te.activity_id, te.started_at, te.ended_at,
              te.break_profile_item_id, te.source, te.is_paid, te.greenhouse_row_id, te.carrier_id,
              te.auto_closed_at, te.density_type, te.density_count_per_row, te.actual_started_at,
              te.actual_ended_at, te.created_by_employee_id, te.creation_reason, te.rollover_of_entry_id,
              cb.first_name as created_by_first_name, cb.last_name as created_by_last_name,
              a.name as activity_name, a.normal_speed, a.speed_unit, a.density_source,
              bpi.name as break_item_name,
              gr.row_number, gphase.name as row_phase_name,
              c.name as carrier_name
       from time_entries te
       left join activities a on a.id = te.activity_id
       left join break_profile_items bpi on bpi.id = te.break_profile_item_id
       left join greenhouse_rows gr on gr.id = te.greenhouse_row_id
       left join greenhouse_phases gphase on gphase.id = gr.phase_id
       left join carriers c on c.id = te.carrier_id
       left join employees cb on cb.id = te.created_by_employee_id
       where te.employee_id = $1 and te.started_at >= $2 and te.started_at < $3 and te.deleted_at is null
       order by te.started_at asc`,
      [employeeId, start, end]
    );
    console.log(`[timing] daily entryRows fetch: ${Date.now() - __t0}ms (${entryRows.length} rows)`);

    // Provenance evidence for the "Corrected" badge (distinct from
    // "Rounded" — see workdayTotals.ts's header comment on the Reynaldo
    // bug this whole file's investigation started from). A correction
    // route (PATCH .../end-time, the automatic run-extension after a
    // deletion, etc.) always nulls actual_started_at/actual_ended_at once
    // it overwrites a boundary — correctly stops a stale "Rounded" badge
    // from pointing at a tap time that no longer describes anything — but
    // that must never mean the fact "an administrator/the system corrected
    // this" is lost entirely: time_entry_corrections already keeps that
    // full audit trail forever, just not previously surfaced here. Keyed by
    // `${time_entry_id}:${field_name}`, most-recent correction only (a
    // field corrected more than once still just shows as "Corrected" once,
    // from its latest old value) — same "own the audit trail, not just a
    // symptom flag" reasoning actual_started_at/actual_ended_at already
    // used for Rounded.
    const entryIds = entryRows.map((r) => r.id);
    const correctedFromMap = new Map<string, string>();
    if (entryIds.length > 0) {
      const { rows: correctionRows } = await pool.query(
        `select distinct on (time_entry_id, field_name) time_entry_id, field_name, old_value
         from time_entry_corrections
         where time_entry_id = any($1::uuid[]) and field_name in ('started_at', 'ended_at')
         order by time_entry_id, field_name, changed_at desc`,
        [entryIds]
      );
      for (const c of correctionRows) {
        correctedFromMap.set(`${c.time_entry_id}:${c.field_name}`, c.old_value);
      }
    }

    const segments: RunSegment[] = entryRows.map((r) => ({
      id: r.id,
      entry_type: r.entry_type,
      activity_id: r.activity_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      greenhouse_row_id: r.greenhouse_row_id,
      carrier_id: r.carrier_id,
      density_type: r.density_type,
      density_count_per_row: r.density_count_per_row,
      rollover_of_entry_id: r.rollover_of_entry_id,
    }));
    const { runs, breaks } = groupIntoActivityRuns(segments);

    const activityMeta = new Map<
      string,
      { name: string; normalSpeed: string | null; speedUnit: string | null; densitySource: "plants" | "stems" | null }
    >();
    const rowMeta = new Map<string, { rowNumber: number; phaseName: string }>();
    const carrierMeta = new Map<string, string>();
    // Keyed by the individual time_entries row id (not a grouped run id) —
    // a run's own `id` is its last underlying segment's id (see
    // activityRuns.ts), which is exactly what's looked up below, so this
    // needs no involvement from the grouping logic itself.
    const autoClosedMeta = new Map<string, boolean>();
    // Same per-segment-id keying and the same accepted limitation as
    // autoClosedMeta above: a multi-segment run only ever surfaces this for
    // its *last* segment (the one run.id resolves to) — the only segment a
    // Finish Work tap could ever have closed anyway, since only the
    // currently-open entry is ever eligible for work-end rounding.
    const endedAtOriginalMeta = new Map<string, string>();
    // Same per-segment-id keying and the same accepted limitation as
    // autoClosedMeta above: a multi-segment run only ever surfaces this for
    // its *last* segment (the one run.id resolves to). A break is always a
    // single segment (groupIntoActivityRuns never merges breaks), so this
    // ambiguity never applies there.
    const manualEntryMeta = new Map<
      string,
      { createdByEmployeeId: string; createdByName: string; creationReason: string }
    >();
    // Unclassified/legacy breaks (is_paid null, recorded before this column
    // existed) are bucketed as unpaid — a break must be explicitly marked
    // paid to count as paid, nothing is inferred from duration or time.
    const breakMeta = new Map<
      string,
      {
        name: string | null;
        isPaid: boolean | null;
        source: "manual" | "auto";
        breakProfileItemId: string | null;
        // The employee's original Start/End Break tap timestamps, only
        // present when break rounding (or a fixed-item schedule match)
        // actually applied to this break (see 037_break_rounding.sql and
        // mobileTime.ts's break/start and break/end routes) — same "only
        // shown when it differs from the effective value" convention as
        // workStartOriginalTime/endedAtOriginalTime below.
        startedAtOriginal: string | null;
        endedAtOriginal: string | null;
      }
    >();
    for (const r of entryRows) {
      autoClosedMeta.set(r.id, r.auto_closed_at !== null);
      if (r.actual_ended_at) {
        endedAtOriginalMeta.set(r.id, r.actual_ended_at);
      }
      if (r.created_by_employee_id) {
        manualEntryMeta.set(r.id, {
          createdByEmployeeId: r.created_by_employee_id,
          createdByName: `${r.created_by_first_name} ${r.created_by_last_name}`,
          creationReason: r.creation_reason,
        });
      }
      if (r.activity_id && !activityMeta.has(r.activity_id)) {
        activityMeta.set(r.activity_id, {
          name: r.activity_name,
          normalSpeed: r.normal_speed,
          speedUnit: r.speed_unit,
          densitySource: r.density_source,
        });
      }
      if (r.greenhouse_row_id && !rowMeta.has(r.greenhouse_row_id)) {
        rowMeta.set(r.greenhouse_row_id, { rowNumber: r.row_number, phaseName: r.row_phase_name });
      }
      if (r.carrier_id && !carrierMeta.has(r.carrier_id)) {
        carrierMeta.set(r.carrier_id, r.carrier_name);
      }
      if (r.entry_type === "break") {
        breakMeta.set(r.id, {
          name: r.break_item_name ?? null,
          isPaid: r.is_paid,
          source: r.source,
          breakProfileItemId: r.break_profile_item_id,
          startedAtOriginal: r.actual_started_at ?? null,
          endedAtOriginal: r.actual_ended_at ?? null,
        });
      }
    }

    // Density-based speed (see 025_activity_density_speed.sql /
    // 026_row_completions.sql). A run's row quantity only ever counts
    // toward speed in one of two ways:
    //
    //  1. Its segments already belong to a confirmed row_completions record
    //     — the completion's own frozen quantity_per_row counts exactly
    //     once, and its duration is the sum of *every* linked segment
    //     across every day/employee it spans, not just today's. The same
    //     resulting speed is shown on every run belonging to that
    //     completion, on every day it touches.
    //  2. It's the *only* not-yet-completed run anywhere for that row+type
    //     (checked via getUnresolvedRunsForRows) — unambiguous, so it
    //     auto-counts exactly like the original (pre-row-completions)
    //     behavior, no admin action required.
    //
    // Anything else — 2+ not-yet-completed runs sharing a row+type — is
    // "unresolved": excluded from both sides of the ratio (never counted as
    // zero-quantity time) until an admin combines them via
    // POST /api/row-completions, since blindly counting every visit would
    // inflate quantity the moment a row is revisited (the bug this
    // migration fixes). This never affects non-density activities or
    // density-eligible runs whose row simply has no matching density at
    // all (those stay blank exactly as before, unrelated to ambiguity).
    const densityEligibleRuns = runs.filter((r) => r.densityCountPerRow != null);
    const runById = new Map(runs.map((r) => [r.id, r]));

    const allSegmentIds = densityEligibleRuns.flatMap((r) => r.segmentIds);
    const segmentCompletionMap = new Map<string, string>();
    if (allSegmentIds.length > 0) {
      const { rows: segRows } = await pool.query(
        `select time_entry_id, row_completion_id from row_completion_segments where time_entry_id = any($1::uuid[])`,
        [allSegmentIds]
      );
      for (const s of segRows) segmentCompletionMap.set(s.time_entry_id, s.row_completion_id);
    }

    const runCompletionId = new Map<string, string>();
    const completionIdsNeeded = new Set<string>();
    for (const r of densityEligibleRuns) {
      const completionId = r.segmentIds.map((id) => segmentCompletionMap.get(id)).find((id) => id !== undefined);
      if (completionId) {
        runCompletionId.set(r.id, completionId);
        completionIdsNeeded.add(completionId);
      }
    }

    // A run linked via splitByDensityChangeFromRunId (activityRuns.ts) is
    // the SAME physical visit as its immediately preceding run, just frozen
    // under a different density_type — never an independent row+type
    // occurrence. Walk back to the visit's true origin so quantity/duration
    // attribution (and ambiguity checking) uses that ONE original frozen
    // type, never awarding one physical row's completion to two different
    // density types. Stops at a completion-linked run — a confirmed
    // row_completions record is always authoritative on its own, never
    // silently folded into another chain.
    function visitRoot(run: (typeof runs)[number]): (typeof runs)[number] {
      let cur = run;
      const seen = new Set<string>();
      while (cur.splitByDensityChangeFromRunId && !seen.has(cur.id)) {
        seen.add(cur.id);
        const prior = runById.get(cur.splitByDensityChangeFromRunId);
        if (!prior || prior.densityCountPerRow == null || runCompletionId.has(prior.id)) break;
        cur = prior;
      }
      return cur;
    }

    const visitRootByRunId = new Map<string, string>();
    const chainDurationByRootId = new Map<string, number>();
    for (const r of densityEligibleRuns) {
      if (runCompletionId.has(r.id)) continue;
      const root = visitRoot(r);
      visitRootByRunId.set(r.id, root.id);
      chainDurationByRootId.set(root.id, (chainDurationByRootId.get(root.id) ?? 0) + r.durationSeconds);
    }

    // unresolvedPairs only needs runCompletionId (already known above), so
    // it's built up front rather than after completionTotals — nothing
    // below it depends on completionTotals at all (see the Promise.all
    // just below: the two queries this section needs are independent of
    // each other, both only depending on runCompletionId/densityEligibleRuns
    // computed above, never on one another's result). Keyed by each run's
    // VISIT ROOT, not the run's own row/type — a later segment of a
    // density-type-split visit must never contribute its own (spurious)
    // key here, or it would be checked for ambiguity under the wrong type.
    // Also keyed by activityId — two different activities sharing a row and
    // density type are independent ambiguity groups, never checked or
    // combined together (see rowCompletionCandidates.ts / 045_row_completion_
    // activity_id.sql).
    const unresolvedPairs = new Map<
      string,
      { greenhouseRowId: string; activityId: string; densityType: "plants" | "stems" }
    >();
    for (const r of densityEligibleRuns) {
      if (runCompletionId.has(r.id)) continue;
      const root = runById.get(visitRootByRunId.get(r.id)!)!;
      const key = `${root.greenhouseRowId}:${root.activityId}:${root.densityType}`;
      if (!unresolvedPairs.has(key)) {
        unresolvedPairs.set(key, {
          greenhouseRowId: root.greenhouseRowId!,
          activityId: root.activityId,
          densityType: root.densityType as "plants" | "stems",
        });
      }
    }

    // Proven independent (see comment above) — run concurrently rather than
    // one after the other. The ambiguity check itself is one single batched
    // getUnresolvedRunsForRows call for every unresolved pair at once (not
    // one getUnresolvedRunsForRow call per pair) — see that function's own
    // comment for the N+1 this fixes: on a real busy day (14 unresolved
    // row+activity+density pairs, one employee), the old per-pair loop
    // redundantly re-fetched that SAME employee's whole day 14 times over,
    // and GET /daily took ~5.6s; batched, it's one round trip regardless of
    // how many pairs this day has.
    const [completionTotals, ambiguousPairKeys] = await Promise.all([
      (async () => {
        const map = new Map<string, { quantity: number; durationSeconds: number; segmentCount: number }>();
        if (completionIdsNeeded.size > 0) {
          const { rows: compRows } = await pool.query(
            `select rc.id, rc.quantity_per_row, count(*) as segment_count,
                    sum(extract(epoch from (te.ended_at - te.started_at))) as total_duration_seconds
             from row_completions rc
             join row_completion_segments rcs on rcs.row_completion_id = rc.id
             join time_entries te on te.id = rcs.time_entry_id
             where rc.id = any($1::uuid[])
             group by rc.id, rc.quantity_per_row`,
            [[...completionIdsNeeded]]
          );
          for (const c of compRows) {
            map.set(c.id, {
              quantity: Number(c.quantity_per_row),
              durationSeconds: Number(c.total_duration_seconds),
              segmentCount: Number(c.segment_count),
            });
          }
        }
        return map;
      })(),
      (async () => {
        const keys = new Set<string>();
        const candidatesByKey = await getUnresolvedRunsForRows(
          [...unresolvedPairs.values()].map((pair) => ({
            greenhouseRowId: pair.greenhouseRowId,
            activityId: pair.activityId,
            densityType: pair.densityType,
          }))
        );
        for (const key of unresolvedPairs.keys()) {
          if ((candidatesByKey.get(key)?.length ?? 0) > 1) keys.add(key);
        }
        return keys;
      })(),
    ]);

    const speedByCompletionId = new Map<string, number | null>();
    for (const [id, totals] of completionTotals) {
      speedByCompletionId.set(
        id,
        aggregateDensitySpeed([{ quantityPerRow: totals.quantity, durationSeconds: totals.durationSeconds }])
      );
    }

    // Rule 2 (see comment above densityEligibleRuns): a not-yet-completed
    // run that's the sole candidate for its row+type auto-counts using ITS
    // OWN quantity/duration — never pooled with any other run, even other
    // runs on the same activity. Two different physical rows finishing in
    // different amounts of time must show two different speeds; the
    // ratio-of-sums rule (sum quantities, sum durations, divide once) only
    // applies *within* a single run's own segments (already handled by
    // groupIntoActivityRuns merging same-row-same-density-type segments into
    // one run — see activityRuns.ts), *within* one density-type-split
    // visit's whole chain (visitRoot above), or within a single
    // row_completions record's linked segments (the completionId branch
    // below) — never across multiple distinct runs/rows/visits. Keyed by
    // each run's visit root — every member of a split chain shares the same
    // ambiguity verdict as its root, so a "Needs review" badge (or its
    // absence) is always consistent across the whole visit.
    const isUnresolvedByRunId = new Map<string, boolean>();
    for (const r of densityEligibleRuns) {
      if (runCompletionId.has(r.id)) continue;
      const root = runById.get(visitRootByRunId.get(r.id)!)!;
      const key = `${root.greenhouseRowId}:${root.activityId}:${root.densityType}`;
      if (ambiguousPairKeys.has(key)) {
        isUnresolvedByRunId.set(r.id, true);
      }
    }

    // One combined speed per visit root — its OWN quantity_per_row (a
    // physical row's density is counted exactly once, never once per
    // density-type-split segment) divided by the chain's SUMMED duration
    // across every segment that visit touched. A standalone run (no split
    // chain) is trivially its own root with a "chain" of just itself, so
    // this is also the single source of per-run speed math below — no
    // separate standalone-case calculation needed.
    // A root whose OWN first segment is a midnight-rollover continuation
    // (see activityRuns.ts) began on an earlier calendar day this query
    // never fetched — chainDurationByRootId above only has TODAY's slice of
    // what may be a longer visit. getUnresolvedRunsForRows (ambiguousPairKeys,
    // above) already correctly treats the whole cross-day chain as one
    // candidate; this fills in the matching missing duration so the speed
    // shown here divides the row's full frozen quantity by the visit's FULL
    // elapsed time, not just today's partial slice, which would otherwise
    // silently overstate speed for any row whose visit happened to span a
    // midnight.
    for (const rootId of chainDurationByRootId.keys()) {
      const root = runById.get(rootId)!;
      if (!root.rolloverContinuationFromEntryId) continue;
      const priorSeconds = await getRolloverPriorDurationSeconds(root.rolloverContinuationFromEntryId);
      chainDurationByRootId.set(rootId, chainDurationByRootId.get(rootId)! + priorSeconds);
    }

    const speedByRootId = new Map<string, number | null>();
    for (const [rootId, durationSeconds] of chainDurationByRootId) {
      const root = runById.get(rootId)!;
      const key = `${root.greenhouseRowId}:${root.activityId}:${root.densityType}`;
      if (ambiguousPairKeys.has(key)) continue;
      speedByRootId.set(rootId, aggregateDensitySpeed([{ quantityPerRow: root.densityCountPerRow!, durationSeconds }]));
    }

    const canEditRole = EDIT_ROLES.includes(req.employee!.securityRole);
    const workStart = entryRows.find((r) => r.entry_type === "work");

    // The authoritative workday total — see workdayTotals.ts's own header
    // for the full reasoning (the Reynaldo Dela Cruz Aug 17 bug: a ~68s
    // transition gap between two activities, no break recorded across it,
    // was silently excluded from Worked under the old "sum of work-entry
    // durations" formula). Built directly from entryRows (every non-deleted
    // entry this day, work AND break) rather than from `runs`/`breaks`
    // above — those are already grouped into activity runs, which is the
    // wrong grain for a whole-day span calculation and would need
    // unpacking back into raw boundaries anyway.
    const workdayEntries: WorkdayBoundaryEntry[] = entryRows.map((r) => ({
      entryType: r.entry_type,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      isPaid: r.is_paid,
    }));
    const workdayTotals = computeWorkdayTotals(workdayEntries);
    const totalWorkedSeconds = Math.round(workdayTotals.workedSeconds);
    const totalBreakSeconds = Math.round(workdayTotals.breakSeconds);
    const totalPaidBreakSeconds = Math.round(workdayTotals.paidBreakSeconds);
    const totalUnpaidBreakSeconds = Math.round(workdayTotals.unpaidBreakSeconds);

    const photoUrl = await photoUrlPromise;
    console.log(`[timing] daily total (before res.json): ${Date.now() - __t0}ms`);

    res.json({
      employee: {
        id: employee.id,
        firstName: employee.first_name,
        lastName: employee.last_name,
        photoUrl,
      },
      date,
      workStartTime: workStart ? workStart.started_at : null,
      // The employee's original button-press timestamp, only present when
      // work-start rounding actually applied to this entry (see
      // server/src/lib/workStartRounding.ts and mobileTime.ts's POST
      // /time-entries/work) — null for every entry recorded before this
      // feature existed, for any entry rounding was never enabled for, and
      // for an exact-boundary tap that rounding left unchanged... except
      // that last case still gets actual_started_at set (equal to
      // workStartTime) so "rounding was active for this entry" stays a
      // simple non-null check independent of whether it happened to change
      // anything. The desktop Inputs UI only actually surfaces this when it
      // differs from workStartTime (see WorkdayDetailsCard).
      workStartOriginalTime: workStart?.actual_started_at ?? null,
      // Present when the work-start entry's own started_at was set by an
      // administrator/system correction (PATCH .../work-start, or the
      // automatic backward-extension after deleting a preceding bad entry)
      // rather than a genuine phone tap — see correctedFromMap's own
      // comment above. Mutually exclusive with workStartOriginalTime in
      // practice: a correction always nulls actual_started_at when it
      // overwrites this field, so at most one of the two is ever non-null
      // for the same entry.
      workStartCorrectedFrom: workStart ? correctedFromMap.get(`${workStart.id}:started_at`) ?? null : null,
      // Direct from the work-start row itself, not derived through the
      // runs array — a work-start that happens to be the first segment of
      // a multi-segment run wouldn't reliably surface here otherwise (see
      // manualEntryMeta's own "keyed by last segment" comment above).
      workStartManualEntry:
        workStart?.created_by_employee_id
          ? {
              createdByEmployeeId: workStart.created_by_employee_id,
              createdByName: `${workStart.created_by_first_name} ${workStart.created_by_last_name}`,
              creationReason: workStart.creation_reason,
            }
          : null,
      runs: runs.map((r) => {
        const meta = activityMeta.get(r.activityId);
        const row = r.greenhouseRowId ? rowMeta.get(r.greenhouseRowId) : undefined;
        const carrierName = r.carrierId ? carrierMeta.get(r.carrierId) : undefined;

        const completionId = runCompletionId.get(r.id);
        const isUnresolved = isUnresolvedByRunId.get(r.id) ?? false;
        let calculatedSpeed: number | null = null;
        let rowCompletion: { id: string; quantityPerRow: number; segmentCount: number } | null = null;
        const rootRunId = visitRootByRunId.get(r.id);
        const rootRun = rootRunId ? runById.get(rootRunId) : undefined;
        if (completionId) {
          const totals = completionTotals.get(completionId);
          calculatedSpeed = speedByCompletionId.get(completionId) ?? null;
          if (totals) {
            rowCompletion = { id: completionId, quantityPerRow: totals.quantity, segmentCount: totals.segmentCount };
          }
        } else if (meta?.densitySource && !isUnresolved && r.densityCountPerRow != null && rootRunId) {
          // This run's visit root's combined quantity/duration — see the
          // comment above isUnresolvedByRunId/speedByRootId for why this
          // must never pool across independent runs/rows, but MUST combine
          // every segment of one density-type-split visit into a single
          // number (never award that row's density independently to each
          // side of the split).
          calculatedSpeed = speedByRootId.get(rootRunId) ?? null;
        }
        // Unit follows the run's VISIT ROOT's frozen densityType — not this
        // run's own (which, for a later segment of a density-type-split
        // visit, is the spurious post-config-change type being corrected
        // away from here), and not the activity's current speedUnit, which
        // can independently disagree once an admin edits the activity's
        // density_source/speed_unit after this run was recorded (same
        // divergence documented above for densityType vs.
        // activityDensitySource). normalSpeedPerHour above is intentionally
        // different: it's a static current-config target, not a historical
        // measurement, so it keeps using meta.speedUnit as-is.
        const effectiveDensityType = rootRun?.densityType ?? r.densityType;
        const calculatedSpeedUnit =
          effectiveDensityType === "plants" ? "plants/hour" : effectiveDensityType === "stems" ? "stems/hour" : meta?.speedUnit ?? null;

        return {
          id: r.id,
          activityId: r.activityId,
          // pg returns numeric columns as strings — cast explicitly, same
          // as server/src/routes/activities.ts.
          activityName: meta?.name ?? "Unknown activity",
          normalSpeedPerHour:
            meta?.normalSpeed != null ? { value: Number(meta.normalSpeed), unit: meta.speedUnit } : null,
          activityDensitySource: meta?.densitySource ?? null,
          // The run's OWN frozen density type (from time_entries.density_type,
          // set once when the entry was opened) — deliberately distinct from
          // activityDensitySource above, which is the activity's CURRENT,
          // live density_source. isUnresolvedRowCompletion is computed from
          // THIS frozen value (see unresolvedPairs/ambiguousPairKeys above),
          // so any caller that needs to re-query the same ambiguity (e.g.
          // opening the review modal) must use densityType here, never
          // activityDensitySource — if an activity's density_source is ever
          // edited after a run was recorded, the two can genuinely disagree,
          // and querying with the wrong one silently finds zero candidates
          // for a row the badge just said was ambiguous.
          densityType: r.densityType,
          calculatedSpeedPerHour:
            calculatedSpeed != null ? { value: calculatedSpeed, unit: calculatedSpeedUnit } : null,
          isUnresolvedRowCompletion: isUnresolved,
          rowCompletion,
          segmentIds: r.segmentIds,
          durationSeconds: Math.round(r.durationSeconds),
          startedAt: r.startedAt,
          currentSegmentStartedAt: r.currentSegmentStartedAt,
          endedAt: r.endedAt,
          // The employee's original Finish Work button-press timestamp,
          // only present when work-end rounding actually applied to this
          // run's last segment (see workStartRounding.ts's roundWorkEnd
          // and mobileTime.ts's POST /time-entries/end-day) — null for
          // every run not closed by a genuine Finish Work tap (an activity
          // change, a break starting, or a manual Inputs correction all
          // close a segment without ever touching actual_ended_at) and for
          // any Finish Work tap where rounding was disabled. Same "still
          // set even on an exact-boundary tap that rounding left
          // unchanged" convention as workStartOriginalTime — the desktop
          // Inputs UI only surfaces this when it differs from endedAt (see
          // ActivityLogsCard).
          endedAtOriginalTime: endedAtOriginalMeta.get(r.id) ?? null,
          // Present when this run's own end time (a run's id is always its
          // *last* segment's id — see the comment on autoClosed below) was
          // set by an administrator/system correction rather than a
          // genuine Finish Work tap — see correctedFromMap's own comment
          // above. Mutually exclusive with endedAtOriginalTime: a
          // correction always nulls actual_ended_at when it overwrites
          // this field.
          endedAtCorrectedFrom: correctedFromMap.get(`${r.id}:ended_at`) ?? null,
          isOpen: r.isOpen,
          canEdit: canEditRole && !r.isOpen,
          row: row ? { id: r.greenhouseRowId, label: `${row.phaseName} · Row ${row.rowNumber}` } : null,
          carrier: carrierName ? { id: r.carrierId, name: carrierName } : null,
          // A run's own id is its last segment's id — exactly the row
          // whose end time is displayed/editable here, so this is a
          // direct lookup, not something groupIntoActivityRuns needs to
          // carry through itself.
          autoClosed: autoClosedMeta.get(r.id) ?? false,
          // Non-null only for a run whose *last* segment was created via
          // Add work start/Add activity (see manualEntryMeta's own comment
          // for why only the last segment of a multi-segment run can ever
          // carry this).
          manualEntry: manualEntryMeta.get(r.id) ?? null,
        };
      }),
      breaks: breaks.map((b) => {
        const meta = breakMeta.get(b.id);
        return {
          id: b.id,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          // The employee's original Start Break / End Break button-press
          // timestamps, only present when break rounding or a fixed-item
          // schedule match actually applied (see breakMeta above) — the
          // desktop Inputs UI only surfaces these when they differ from
          // startedAt/endedAt (see WorkdayDetailsCard).
          startedAtOriginalTime: meta?.startedAtOriginal ?? null,
          endedAtOriginalTime: meta?.endedAtOriginal ?? null,
          // Present when this boundary was set by an administrator/system
          // correction rather than a genuine phone tap — see
          // correctedFromMap's own comment above. A break is always a
          // single segment, so b.id is unambiguous for both fields (unlike
          // a run, which needs its first vs. last segment). Mutually
          // exclusive with the OriginalTime fields above for the same
          // reason as workStartCorrectedFrom.
          startedAtCorrectedFrom: correctedFromMap.get(`${b.id}:started_at`) ?? null,
          endedAtCorrectedFrom: correctedFromMap.get(`${b.id}:ended_at`) ?? null,
          durationSeconds: b.endedAt ? Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 1000) : 0,
          name: meta?.name ?? null,
          isPaid: meta?.isPaid ?? null,
          source: meta?.source ?? "manual",
          breakProfileItemId: meta?.breakProfileItemId ?? null,
          autoClosed: autoClosedMeta.get(b.id) ?? false,
          // A break is always a single segment, so unlike a run's
          // manualEntry above, this is never ambiguous.
          manualEntry: manualEntryMeta.get(b.id) ?? null,
          // Same rule as an activity run: role-gated, and only once it's
          // closed — an open break can't be edited or deleted from here.
          canEdit: canEditRole && b.endedAt !== null,
        };
      }),
      totals: {
        workedSeconds: totalWorkedSeconds,
        breakSeconds: totalBreakSeconds,
        paidBreakSeconds: totalPaidBreakSeconds,
        unpaidBreakSeconds: totalUnpaidBreakSeconds,
      },
      canEdit: canEditRole,
    });
  })
);

// Creates a brand-new work-start entry for a day that doesn't have one yet
// — distinct from PATCH /work-start below, which only ever corrects the
// time of an *existing* one. Requires an activity (and its questions, row,
// carrier — identical rules to a mobile work start, see
// activitySelection.ts) even though the modal is framed as "just" a
// start time: every work-type time_entries row needs one
// (chk_time_entries_activity_matches_type), and every other place in this
// app that reasons about "what did the employee do" — activity grouping,
// speed, reports — depends on it being real. The created entry is always
// open (no end time): this is a backfilled "the employee has been working
// since this time," the same shape a phone tap produces, just entered by
// an administrator instead. Work-start rounding (see workStartRounding.ts)
// deliberately never applies here — the administrator's entered time is
// the exact time recorded, matching every other manual Inputs correction.
router.post(
  "/work-start",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { employeeId, date, activityId, answers, startTime, reason } = req.body as {
      employeeId?: string;
      date?: string;
      activityId?: string;
      answers?: { questionId?: string; greenhouseRowId?: string; carrierId?: string }[];
      startTime?: string;
      reason?: string;
    };
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }
    if (!isValidReason(reason)) {
      return res.status(400).json({ error: `A reason of at least ${MIN_REASON_LENGTH} characters is required` });
    }
    if (!startTime || isNaN(Date.parse(startTime))) {
      return res.status(400).json({ error: "A valid startTime is required" });
    }
    const start = new Date(startTime);
    if (calendarDateInAppTimezone(start) !== date) {
      return res.status(422).json({ error: "The work-start time must be on the selected date" });
    }

    const empCheck = await pool.query("select id from employees where id = $1 and is_active = true", [employeeId]);
    if (!empCheck.rows[0]) return res.status(404).json({ error: "Employee not found or inactive" });

    const validation = await validateActivityAndAnswers(pool, activityId ?? "", employeeId, answers);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await lockEmployeeForManualEntry(client, employeeId);

      // Re-checked here, inside the per-employee lock, not just trusted
      // from whatever GET /daily last showed the admin — "only one work
      // start may exist" must hold even against a concurrent request.
      const { start: dayStart, end: dayEnd } = getDayBoundsUtc(date);
      const existing = await client.query(
        `select id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and started_at >= $2 and started_at < $3
         limit 1`,
        [employeeId, dayStart, dayEnd]
      );
      if (existing.rows[0]) {
        await client.query("rollback");
        return res.status(409).json({
          error:
            "A work start already exists for this day. Edit the existing work-start time instead of adding a new one.",
        });
      }

      const conflict = await findOverlappingEntry(client, employeeId, start, null);
      if (conflict) {
        await client.query("rollback");
        return res
          .status(409)
          .json({ error: `This start time conflicts with ${describeConflict(conflict)}. Resolve it first.` });
      }

      const { densityType, densityCountPerRow } = await resolveDensitySnapshot(
        client,
        activityId as string,
        validation.validatedRowId
      );

      await client.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source,
            greenhouse_row_id, carrier_id, density_type, density_count_per_row,
            created_by_employee_id, creation_reason)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, 'manual', $4, $5, $6, $7, $8, $9)`,
        [
          employeeId,
          activityId,
          start,
          validation.validatedRowId,
          validation.validatedCarrierId,
          densityType,
          densityCountPerRow,
          req.employee!.id,
          reason.trim(),
        ]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ ok: true });
  })
);

router.patch(
  "/work-start",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { employeeId, date, newStartTime } = req.body as {
      employeeId?: string;
      date?: string;
      newStartTime?: string;
    };
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }
    if (!newStartTime || isNaN(Date.parse(newStartTime))) {
      return res.status(400).json({ error: "A valid newStartTime is required" });
    }
    const newStart = new Date(newStartTime);

    if (calendarDateInAppTimezone(newStart) !== date) {
      return res.status(422).json({ error: "The corrected start time must be on the selected date" });
    }

    const { start, end } = getDayBoundsUtc(date);

    const client = await pool.connect();
    try {
      await client.query("begin");

      // Server-derived, never a client-supplied entry id: "Work start time"
      // means the start of the employee's earliest non-deleted work entry
      // for the selected day, re-found and locked here the same way GET
      // /daily itself would identify it — the request only ever carries
      // employeeId/date/newStartTime.
      const targetRes = await client.query(
        `select id, employee_id, started_at, ended_at from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and started_at >= $2 and started_at < $3
         order by started_at asc
         limit 1
         for update`,
        [employeeId, start, end]
      );
      const target = targetRes.rows[0];
      if (!target) {
        await client.query("rollback");
        return res.status(404).json({ error: "No work entry found for this employee on this date" });
      }

      const oldStart = new Date(target.started_at);
      if (newStart.getTime() === oldStart.getTime()) {
        // No-op: nothing changed, nothing to validate further or audit.
        await client.query("commit");
        return res.json({ ok: true });
      }

      // Every check below is done in one query, entirely server-side
      // against this row's own live, full microsecond-precision values —
      // never a JS Date round-trip of a previously-fetched column, which
      // node-postgres truncates to millisecond precision (same fix already
      // applied throughout this file's other correction routes; see the
      // extensive comments on the break-correction route above).
      //
      // The overlap check is bounded by the entry's own ORIGINAL
      // started_at, not by its end (with a now()-if-open fallback, as an
      // earlier version of this query did). Moving started_at *later* only
      // shrinks the entry and can never create a new overlap, so the only
      // territory that ever needs checking is [newStart, original
      // started_at) — the sliver being newly claimed when moving earlier.
      // Bounding by end-or-now() instead was a real bug: whenever the
      // target happened to be the currently *open* entry, the bound
      // collapsed to now(), and the query would then match essentially the
      // employee's entire past history (anything with started_at < now())
      // as a false "previous entry." Using the target's own fixed,
      // non-null original start avoids that failure mode entirely, and
      // also naturally excludes the target row itself (an entry's own
      // started_at is never < its own started_at).
      const checkRes = await client.query(
        `select
           (t.ended_at is not null and $2::timestamptz >= t.ended_at) as start_after_end,
           (t.ended_at is null and $2::timestamptz > now()) as future_while_open,
           exists (
             select 1 from time_entries o
             where o.employee_id = t.employee_id and o.deleted_at is null and o.id <> t.id
               and o.started_at < t.started_at
               and (o.ended_at is null or o.ended_at > $2::timestamptz)
           ) as overlaps_previous
         from time_entries t
         where t.id = $1`,
        [target.id, newStart]
      );
      const checks = checkRes.rows[0];

      if (checks.start_after_end) {
        await client.query("rollback");
        return res.status(422).json({ error: "Start time must be before the activity's end time" });
      }
      // The entry is still open (in progress) — pushing its started_at
      // into the future would corrupt it: an in-progress entry whose clock
      // hasn't started yet breaks its own live timer and every duration
      // computed from it. Same protection the break correction route above
      // already applies to a still-open following entry.
      if (checks.future_while_open) {
        await client.query("rollback");
        return res
          .status(422)
          .json({ error: "Start time cannot be in the future while the activity is still in progress" });
      }
      if (checks.overlaps_previous) {
        await client.query("rollback");
        return res.status(409).json({ error: "Corrected start time overlaps a previous entry" });
      }

      // A real correction supersedes any prior automatic/rounded placeholder
      // the same way the end-time correction route above already clears
      // actual_ended_at: if this row's started_at was previously set by a
      // rounded Clock In tap, that original tap time no longer describes
      // anything about the new, administratively-set start time, so a stale
      // "Rounded" badge should no longer show against it.
      await client.query(
        "update time_entries set started_at = $1, actual_started_at = null where id = $2",
        [newStart, target.id]
      );
      await client.query(
        `insert into time_entry_corrections
           (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, $3, 'started_at', $4, $5, $6)`,
        [
          target.id,
          target.employee_id,
          req.employee!.id,
          oldStart.toISOString(),
          newStart.toISOString(),
          AUTO_CORRECTION_REASON,
        ]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  })
);

router.patch(
  "/activity-runs/:id/end-time",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity run id" });

    const { endTime } = req.body as { endTime?: string };
    if (!endTime || isNaN(Date.parse(endTime))) {
      return res.status(400).json({ error: "A valid endTime is required" });
    }
    const newEndedAt = new Date(endTime);

    const client = await pool.connect();
    try {
      await client.query("begin");

      // Locked first — always the chronologically-earlier row versus the
      // "next entry" lock below, so two concurrent corrections can never
      // deadlock against each other over lock order.
      const targetRes = await client.query(
        "select id, employee_id, entry_type, started_at, ended_at from time_entries where id = $1 and deleted_at is null for update",
        [id]
      );
      const target = targetRes.rows[0];
      if (!target) {
        await client.query("rollback");
        return res.status(404).json({ error: "Activity run not found" });
      }
      if (target.entry_type !== "work" || target.ended_at === null) {
        await client.query("rollback");
        return res.status(409).json({ error: "Only a completed work entry can be corrected" });
      }

      const targetStartedAt = new Date(target.started_at);
      const targetEndedAt = new Date(target.ended_at);

      if (calendarDateInAppTimezone(targetStartedAt) !== calendarDateInAppTimezone(newEndedAt)) {
        await client.query("rollback");
        return res.status(422).json({ error: "The corrected end time must be on the same date as the activity" });
      }
      if (newEndedAt.getTime() <= targetStartedAt.getTime()) {
        await client.query("rollback");
        return res.status(422).json({ error: "End time must be after the activity's start time" });
      }

      // Compares against the target row's own started_at via a subquery on
      // its id, not by passing target.started_at (a JS Date) back in as a
      // parameter — node-postgres's timestamptz parser only holds
      // millisecond precision, while Postgres stores microseconds, so a
      // round-tripped Date can be *earlier* than the row's true stored
      // value. That previously let this row match its own "next entry"
      // lookup (its true started_at was > the truncated parameter),
      // corrupting the overlap check below. Same class of bug, same fix
      // pattern already used in mobileTime.ts's previousActivity lookup:
      // let Postgres compare its own stored values directly.
      const nextRes = await client.query(
        `select started_at from time_entries
         where employee_id = $1
           and deleted_at is null
           and started_at > (select started_at from time_entries where id = $2)
         order by started_at asc limit 1
         for update`,
        [target.employee_id, id]
      );
      const next = nextRes.rows[0];
      // Equality with the next entry's start is allowed — that's the exact
      // boundary-match convention this app already uses elsewhere
      // (openEntry/accumulateChainSeconds) for "genuinely contiguous," and
      // repairing a chain back into that valid state is the whole point of
      // a correction. Only strictly overlapping past it is rejected.
      if (next && newEndedAt.getTime() > new Date(next.started_at).getTime()) {
        await client.query("rollback");
        return res.status(409).json({ error: "Corrected end time overlaps the next activity or break" });
      }

      // A real correction supersedes any daily-cutoff placeholder this row
      // may have been left with — the displayed end time is now a genuine
      // one, not the automatic 23:59:59 stand-in, so the "Auto-closed"
      // indicator no longer applies. Same reasoning for actual_ended_at: if
      // this row was previously closed by a rounded Finish Work tap, that
      // original tap time no longer describes anything about the new,
      // administratively-set end time — leaving it would show a stale
      // "Rounded" badge pointing at a timestamp unrelated to what's
      // actually stored now (see ActivityLogsCard's own display logic).
      await client.query(
        "update time_entries set ended_at = $1, auto_closed_at = null, actual_ended_at = null where id = $2",
        [newEndedAt, id]
      );
      await client.query(
        `insert into time_entry_corrections
           (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, $3, 'ended_at', $4, $5, $6)`,
        [id, target.employee_id, req.employee!.id, targetEndedAt.toISOString(), newEndedAt.toISOString(), AUTO_CORRECTION_REASON]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  })
);

router.post(
  "/activity-runs/:id/delete",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity run id" });

    // No typed reason collected from the caller here — see
    // ACTIVITY_LOG_DELETION_REASON's own comment above.
    const trimmedReason = ACTIVITY_LOG_DELETION_REASON;

    // Unlocked peek: the client only ever knows a run by its last segment's
    // id (ActivityRun.id — see activityRuns.ts), never the full set of
    // underlying time_entries rows a multi-fragment run is made of. Re-derive
    // that set the same way GET /daily does (regroup that employee's whole
    // day), then lock and delete every segment together.
    const peek = await pool.query(
      `select employee_id, entry_type, started_at, ended_at, deleted_at from time_entries where id = $1`,
      [id]
    );
    const peekRow = peek.rows[0];
    if (!peekRow || peekRow.deleted_at) {
      return res.status(404).json({ error: "Activity log not found" });
    }
    if (peekRow.entry_type !== "work") {
      return res.status(409).json({ error: "Only a work activity log can be deleted" });
    }
    if (peekRow.ended_at === null) {
      return res.status(409).json({ error: "An in-progress activity cannot be deleted from this screen" });
    }

    const dateStr = calendarDateInAppTimezone(new Date(peekRow.started_at));
    const { start, end } = getDayBoundsUtc(dateStr);
    const dayRows = await pool.query(
      `select id, entry_type, activity_id, started_at, ended_at, greenhouse_row_id, carrier_id
       from time_entries
       where employee_id = $1 and started_at >= $2 and started_at < $3 and deleted_at is null
       order by started_at asc`,
      [peekRow.employee_id, start, end]
    );
    const segments: RunSegment[] = dayRows.rows.map((r) => ({
      id: r.id,
      entry_type: r.entry_type,
      activity_id: r.activity_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      greenhouse_row_id: r.greenhouse_row_id,
      carrier_id: r.carrier_id,
      // Not selected above — this endpoint only needs run boundaries/ids to
      // locate and delete the right segments, never density figures.
      density_type: null,
      density_count_per_row: null,
      // Not needed here — only rowCompletionCandidates.ts's cross-day
      // visit-root resolution consults this field.
      rollover_of_entry_id: null,
    }));
    const { runs } = groupIntoActivityRuns(segments);
    const run = runs.find((r) => r.id === id);
    if (!run || run.isOpen) {
      return res.status(409).json({ error: "An in-progress activity cannot be deleted from this screen" });
    }

    // segmentIds is already in started_at-ascending order (groupIntoActivityRuns
    // builds it by iterating entries in that order) — locking in that same
    // order keeps this consistent with every other place in this file that
    // might lock more than one time_entries row, so nothing here can
    // deadlock against a concurrent correction or another deletion.
    const segmentIds = run.segmentIds;

    const client = await pool.connect();
    try {
      await client.query("begin");

      for (const segId of segmentIds) {
        const r = await client.query(
          `select id from time_entries where id = $1 and deleted_at is null and entry_type = 'work' for update`,
          [segId]
        );
        if (!r.rows[0]) {
          // A segment of this run was deleted or changed by someone else
          // since it was loaded — bail out rather than deleting a partial,
          // now-inconsistent subset of the run.
          await client.query("rollback");
          return res
            .status(409)
            .json({ error: "This activity log changed since it was loaded — please refresh and try again" });
        }
      }

      // Find the entry immediately following the deleted run, within this
      // same employee/workday — locked here (not just inferred from the
      // unlocked dayRows/runs computed above) so a concurrent change can't
      // be missed. Bounded by the run's own last segment's *stored*
      // ended_at via a subquery rather than a JS Date round-trip of it (same
      // precision reasoning as the end-time correction route above). Lock
      // order stays ascending by time (segments first, this row after — it's
      // chronologically >= all of them), consistent with every other
      // multi-row lock in this file, so this can't deadlock against a
      // concurrent correction or another deletion.
      const nextRes = await client.query(
        `select id, entry_type, started_at from time_entries
         where employee_id = $1 and deleted_at is null
           and started_at >= (select ended_at from time_entries where id = $2)
           and started_at < $3
         order by started_at asc
         limit 1
         for update`,
        [peekRow.employee_id, segmentIds[segmentIds.length - 1], end]
      );
      const next = nextRes.rows[0];
      // Only a work entry directly following the deleted run absorbs the
      // deleted interval, by extending backward to the deleted run's
      // original start. "Work start" is nothing but "the earliest surviving
      // work entry for the day" (see GET /daily above), so this is also
      // exactly what keeps it unchanged when the deleted run was itself the
      // day's first activity. A break is a protected workday boundary and is
      // never extended across or modified; if there's no next entry at all
      // within the day, there's nothing to extend either way.
      const shouldExtend = next && next.entry_type === "work";

      await client.query(
        `update time_entries
         set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = $2
         where id = any($3::uuid[])`,
        [req.employee!.id, trimmedReason, segmentIds]
      );

      if (shouldExtend) {
        // Written via a subquery on the deleted run's first segment id, not
        // the JS Date already on `run` from the earlier unlocked query — same
        // full-precision-write reasoning as every other correction route in
        // this file. actual_started_at is cleared for the same reason a real
        // correction always clears it elsewhere (PATCH /work-start above):
        // the entry's original tap time no longer describes anything about
        // its new, extended start. Works identically whether `next` is
        // completed or still in progress — only started_at is touched.
        await client.query(
          `update time_entries
           set started_at = (select started_at from time_entries where id = $1), actual_started_at = null
           where id = $2`,
          [segmentIds[0], next.id]
        );
        await client.query(
          `insert into time_entry_corrections
             (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
           values ($1, $2, $3, 'started_at', $4, $5, $6)`,
          [
            next.id,
            peekRow.employee_id,
            req.employee!.id,
            new Date(next.started_at).toISOString(),
            run.startedAt.toISOString(),
            AUTO_CORRECTION_REASON,
          ]
        );
      }

      await client.query(
        `insert into time_entry_deletions
           (employee_id, deleted_by_employee_id, deletion_type, affected_time_entry_ids, reason)
         values ($1, $2, 'activity_run', $3, $4)`,
        [peekRow.employee_id, req.employee!.id, segmentIds, trimmedReason]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  })
);

// Creates a new activity log anywhere in the day — before, between, or
// after existing entries — unlike POST /work-start above, which only ever
// applies to a currently-blank day. Reuses the identical activity/question/
// row/carrier rules (activitySelection.ts) a mobile activity start or
// change uses; the only genuinely new logic here is resolving the new
// entry's [startTime, endTime) against anything that already exists.
//
// For a BOUNDED entry (endTime given — the common case), an admin's manual
// activity is authoritative for the exact range they typed: if it lands at
// the START or END of an existing entry, that boundary is trimmed to make
// room (see planActivityInsertion in manualTimeEntries.ts) rather than
// rejecting the request — this is what lets an admin backdate a forgotten
// work start and then log what the employee was actually doing before
// their real first activity's original start, without first having to
// manually shrink that activity themselves. A break entry fully inside the
// new range is left untouched (breaks are never trimmed or moved). Only a
// case that would require SPLITTING an existing entry (the new range sits
// entirely inside it) or silently DELETING one (the new range completely
// covers it) is still rejected — this endpoint only ever trims one
// boundary of one entry, it never splits or removes one.
//
// An OPEN-ENDED entry (no endTime — a currently-in-progress activity) keeps
// the simpler behavior: any overlap at all is rejected, unchanged.
router.post(
  "/activities",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { employeeId, date, activityId, answers, startTime, endTime, reason } = req.body as {
      employeeId?: string;
      date?: string;
      activityId?: string;
      answers?: { questionId?: string; greenhouseRowId?: string; carrierId?: string }[];
      startTime?: string;
      // Absent/null creates a currently-in-progress (open) entry — allowed
      // only when nothing else exists at or after startTime (checked
      // below), the same "at most one open entry" invariant the mobile app
      // maintains via its own single-open-row unique index.
      endTime?: string | null;
      reason?: string;
    };
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }
    if (!isValidReason(reason)) {
      return res.status(400).json({ error: `A reason of at least ${MIN_REASON_LENGTH} characters is required` });
    }
    if (!startTime || isNaN(Date.parse(startTime))) {
      return res.status(400).json({ error: "A valid startTime is required" });
    }
    const start = new Date(startTime);
    if (calendarDateInAppTimezone(start) !== date) {
      return res.status(422).json({ error: "The start time must be on the selected date" });
    }

    let end: Date | null = null;
    if (endTime !== undefined && endTime !== null && endTime !== "") {
      if (isNaN(Date.parse(endTime))) {
        return res.status(400).json({ error: "A valid endTime is required, or leave it blank for an in-progress activity" });
      }
      end = new Date(endTime);
      if (end.getTime() <= start.getTime()) {
        return res.status(422).json({ error: "End time must be after start time" });
      }
      if (calendarDateInAppTimezone(end) !== date) {
        return res.status(422).json({ error: "The end time must be on the same date as the start time" });
      }
    }

    const empCheck = await pool.query("select id from employees where id = $1 and is_active = true", [employeeId]);
    if (!empCheck.rows[0]) return res.status(404).json({ error: "Employee not found or inactive" });

    const validation = await validateActivityAndAnswers(pool, activityId ?? "", employeeId, answers);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await lockEmployeeForManualEntry(client, employeeId);

      if (end) {
        // Bounded entry — resolve boundary overlaps by trimming, only
        // reject a case that would need a split or a silent delete (see
        // planActivityInsertion's own comment).
        const plan = await planActivityInsertion(client, employeeId, start, end);
        if (!plan.ok) {
          await client.query("rollback");
          return res.status(409).json({ error: plan.error });
        }
        for (const trim of plan.trims) {
          await client.query(`update time_entries set ${trim.field} = $1 where id = $2`, [trim.newValue, trim.id]);
          await client.query(
            `insert into time_entry_corrections
               (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              trim.id,
              employeeId,
              req.employee!.id,
              trim.field,
              trim.oldValue.toISOString(),
              trim.newValue.toISOString(),
              AUTO_CORRECTION_REASON,
            ]
          );
        }
      } else {
        // Open-ended (in-progress) entry — any overlap at all is rejected,
        // same as before; trimming an entry to make room for an activity
        // with no known end time isn't something this endpoint attempts.
        const conflict = await findOverlappingEntry(client, employeeId, start, end);
        if (conflict) {
          await client.query("rollback");
          return res.status(409).json({
            error: `An in-progress entry can't be created — it would conflict with ${describeConflict(conflict)}. Resolve the existing entry first.`,
          });
        }
      }

      const { densityType, densityCountPerRow } = await resolveDensitySnapshot(
        client,
        activityId as string,
        validation.validatedRowId
      );

      await client.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
            greenhouse_row_id, carrier_id, density_type, density_count_per_row,
            created_by_employee_id, creation_reason)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7, $8, $9, $10)`,
        [
          employeeId,
          activityId,
          start,
          end,
          validation.validatedRowId,
          validation.validatedCarrierId,
          densityType,
          densityCountPerRow,
          req.employee!.id,
          reason.trim(),
        ]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ ok: true });
  })
);

// Creates a new break, using the exact same model a phone-recorded break
// uses (entry_type = 'break', activity_id null, is_paid/break_profile_item_id
// set the same way — see mobileTime.ts's break/start) so it flows through
// every existing calculation (paid/unpaid totals, reconciliation) with no
// special-casing. `breakProfileItemId` ties it to one of the employee's
// assigned break profile's scheduled items (is_paid is taken from that
// item, never trusted from the client); omitting it creates a "Custom"
// break not tied to any scheduled item, whose paid/unpaid status the
// administrator sets directly.
router.post(
  "/breaks",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { employeeId, date, breakProfileItemId, isPaid, startTime, endTime } = req.body as {
      employeeId?: string;
      date?: string;
      breakProfileItemId?: string | null;
      isPaid?: boolean;
      startTime?: string;
      endTime?: string;
    };
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }
    if (!startTime || isNaN(Date.parse(startTime)) || !endTime || isNaN(Date.parse(endTime))) {
      return res.status(400).json({ error: "A valid startTime and endTime are required" });
    }
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (end.getTime() <= start.getTime()) {
      return res.status(422).json({ error: "End time must be after start time" });
    }
    if (calendarDateInAppTimezone(start) !== date || calendarDateInAppTimezone(end) !== date) {
      return res.status(422).json({ error: "The break's start and end time must be on the selected date" });
    }

    const empRes = await pool.query(
      "select id, break_profile_id from employees where id = $1 and is_active = true",
      [employeeId]
    );
    const employee = empRes.rows[0];
    if (!employee) return res.status(404).json({ error: "Employee not found or inactive" });

    // Resolved paid/unpaid status — from the chosen scheduled item when one
    // is given (never trusting a client-supplied isPaid alongside it), or
    // directly from the request for a Custom break.
    let resolvedIsPaid: boolean;
    let validatedItemId: string | null = null;
    if (breakProfileItemId) {
      if (!UUID_RE.test(breakProfileItemId)) {
        return res.status(400).json({ error: "Invalid breakProfileItemId" });
      }
      // Must belong to the employee's own currently-assigned profile — not
      // just any profile's item — same as how a mobile fixed-break match
      // only ever considers the employee's own assigned profile
      // (mobileTime.ts's loadActiveFixedItems).
      const itemRes = await pool.query(
        `select bpi.id, bpi.is_paid
         from break_profile_items bpi
         join break_profiles bp on bp.id = bpi.break_profile_id and bp.is_active = true
         where bpi.id = $1 and bpi.is_active = true and bpi.break_profile_id = $2`,
        [breakProfileItemId, employee.break_profile_id]
      );
      if (!itemRes.rows[0]) {
        return res.status(400).json({ error: "This break type is not on the employee's assigned break profile" });
      }
      resolvedIsPaid = itemRes.rows[0].is_paid;
      validatedItemId = breakProfileItemId;
    } else {
      if (typeof isPaid !== "boolean") {
        return res.status(400).json({ error: "isPaid is required for a custom break" });
      }
      resolvedIsPaid = isPaid;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await lockEmployeeForManualEntry(client, employeeId);

      // Resolves any work entry(s) the requested range overlaps into
      // trims/splits/deletions instead of rejecting outright — see
      // planBreakInsertion's own comment. Still rejects an overlap with an
      // existing break or an open-ended work entry, unchanged from before.
      const plan = await planBreakInsertion(client, employeeId, start, end);
      if (!plan.ok) {
        await client.query("rollback");
        return res.status(409).json({ error: plan.error });
      }

      for (const trim of plan.trims) {
        await client.query(`update time_entries set ${trim.field} = $1 where id = $2`, [trim.newValue, trim.id]);
        await client.query(
          `insert into time_entry_corrections
             (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            trim.id,
            employeeId,
            req.employee!.id,
            trim.field,
            trim.oldValue.toISOString(),
            trim.newValue.toISOString(),
            AUTO_CORRECTION_REASON,
          ]
        );
      }

      for (const del of plan.deletions) {
        await client.query(
          `update time_entries set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = $2 where id = $3`,
          [req.employee!.id, BREAK_SPLIT_DELETION_REASON, del.id]
        );
        await client.query(
          `insert into time_entry_deletions
             (employee_id, deleted_by_employee_id, deletion_type, affected_time_entry_ids, reason)
           values ($1, $2, 'activity_run', $3, $4)`,
          [employeeId, req.employee!.id, [del.id], BREAK_SPLIT_DELETION_REASON]
        );
      }

      // The continuation entry's creation reason mirrors the break's own —
      // the split exists BECAUSE of this break, so "why was this second
      // half created" and "why was this break added" are the same answer —
      // both now the same fixed, server-generated string.
      for (const cont of plan.continuations) {
        await client.query(
          `insert into time_entries
             (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
              greenhouse_row_id, carrier_id, density_type, density_count_per_row,
              created_by_employee_id, creation_reason)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', $6, $7, $8, $9, $10, $11)`,
          [
            employeeId,
            cont.deviceId,
            cont.activityId,
            cont.startedAt,
            cont.endedAt,
            cont.greenhouseRowId,
            cont.carrierId,
            cont.densityType,
            cont.densityCountPerRow,
            req.employee!.id,
            BREAK_MANUAL_ADD_REASON,
          ]
        );
      }

      await client.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source,
            break_profile_item_id, scheduled_break_date, is_paid,
            created_by_employee_id, creation_reason)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual', $4, $5, $6, $7, $8)`,
        [employeeId, start, end, validatedItemId, date, resolvedIsPaid, req.employee!.id, BREAK_MANUAL_ADD_REASON]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ ok: true });
  })
);

interface BreakCorrectionPlanOk {
  ok: true;
  breakId: string;
  employeeId: string;
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  startChanged: boolean;
  endChanged: boolean;
  trims: Extract<BreakInsertionPlan, { ok: true }>["trims"];
  continuations: Extract<BreakInsertionPlan, { ok: true }>["continuations"];
  deletions: Extract<BreakInsertionPlan, { ok: true }>["deletions"];
}
type BreakCorrectionPlanResult = BreakCorrectionPlanOk | { ok: false; status: number; error: string };

// Shared by PATCH /breaks/:id (applies the plan) and POST
// /breaks/:id/correction-preview (describes it, then always rolls back) —
// having exactly one function compute what a correction WOULD do is what
// guarantees the preview the admin sees before Save can never disagree
// with what Save actually does.
//
// Reuses planBreakInsertion — the same trim/split/delete classification
// POST /breaks (Add Break) already uses — against the break's CORRECTED
// [newStart, newEnd) range, with the break's own row excluded from its own
// overlap check (planBreakInsertion's excludeEntryId). This is what
// replaces the old single-adjacent-entry-only reattachment logic: any
// number of work entries the corrected range now reaches into are each
// individually trimmed, split, or (if entirely covered) soft-deleted,
// exactly like a brand-new break would resolve against the same schedule.
// A shrinking correction naturally touches nothing — the work entries that
// used to sit at the OLD, wider boundary were already trimmed away from it
// by whatever action produced that boundary; nothing here ever GROWS an
// existing entry, so shortening a break can never invent work time.
//
// Caller must run this inside a transaction, immediately after
// lockEmployeeForManualEntry(client, <the break's own employee_id>) — this
// function (via planBreakInsertion) takes `for update` locks on every row
// it examines, including the break's own.
async function computeBreakCorrectionPlan(
  client: PoolClient,
  breakId: string,
  startTime: string | undefined,
  endTime: string | undefined
): Promise<BreakCorrectionPlanResult> {
  if (startTime === undefined && endTime === undefined) {
    return { ok: false, status: 400, error: "startTime and/or endTime is required" };
  }
  if (startTime !== undefined && (typeof startTime !== "string" || isNaN(Date.parse(startTime)))) {
    return { ok: false, status: 400, error: "A valid startTime is required" };
  }
  if (endTime !== undefined && (typeof endTime !== "string" || isNaN(Date.parse(endTime)))) {
    return { ok: false, status: 400, error: "A valid endTime is required" };
  }

  const targetRes = await client.query(
    `select id, employee_id, entry_type, started_at, ended_at, deleted_at
     from time_entries where id = $1 for update`,
    [breakId]
  );
  const target = targetRes.rows[0];
  if (!target || target.deleted_at) return { ok: false, status: 404, error: "Break not found" };
  if (target.entry_type !== "break") return { ok: false, status: 409, error: "Only a break can be corrected here" };
  if (target.ended_at === null) return { ok: false, status: 409, error: "An in-progress break cannot be corrected here" };

  const oldStart = new Date(target.started_at);
  const oldEnd = new Date(target.ended_at);
  const newStart = startTime !== undefined ? new Date(startTime) : oldStart;
  const newEnd = endTime !== undefined ? new Date(endTime) : oldEnd;

  if (newStart.getTime() >= newEnd.getTime()) {
    return { ok: false, status: 422, error: "Start time must be before end time" };
  }
  if (
    calendarDateInAppTimezone(oldStart) !== calendarDateInAppTimezone(newStart) ||
    calendarDateInAppTimezone(oldStart) !== calendarDateInAppTimezone(newEnd)
  ) {
    return { ok: false, status: 422, error: "The corrected times must stay on the same date as the break" };
  }

  // Excludes this break's own (not-yet-updated) row from its own overlap
  // check — without this, a break being corrected would always appear to
  // conflict with itself. Any OTHER break found overlapping [newStart,
  // newEnd) still rejects outright (planBreakInsertion never merges two
  // breaks), and any open-ended work entry overlapping it also still
  // rejects — both unchanged from before.
  const plan = await planBreakInsertion(client, target.employee_id, newStart, newEnd, breakId);
  if (!plan.ok) {
    return { ok: false, status: 409, error: plan.error };
  }

  return {
    ok: true,
    breakId: target.id,
    employeeId: target.employee_id,
    oldStart,
    oldEnd,
    newStart,
    newEnd,
    startChanged: newStart.getTime() !== oldStart.getTime(),
    endChanged: newEnd.getTime() !== oldEnd.getTime(),
    trims: plan.trims,
    continuations: plan.continuations,
    deletions: plan.deletions,
  };
}

router.patch(
  "/breaks/:id",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid break id" });
    const { startTime, endTime } = req.body as { startTime?: string; endTime?: string };

    const client = await pool.connect();
    try {
      await client.query("begin");

      // The advisory employee lock must be taken before ANY row lock
      // (including computeBreakCorrectionPlan's own, via
      // planBreakInsertion) — same ordering every other manual-entry
      // mutation in this file uses (POST /breaks, POST /activities), so a
      // concurrent Add Break / Add Activity / break correction for the
      // same employee can never race past each other's overlap checks.
      // Unlocked peek first, purely to learn which employee to lock —
      // re-validated for real inside computeBreakCorrectionPlan's own
      // `for update` read.
      const ownerPeek = await client.query(`select employee_id from time_entries where id = $1`, [id]);
      if (!ownerPeek.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Break not found" });
      }
      await lockEmployeeForManualEntry(client, ownerPeek.rows[0].employee_id);

      const planResult = await computeBreakCorrectionPlan(client, id, startTime, endTime);
      if (!planResult.ok) {
        await client.query("rollback");
        return res.status(planResult.status).json({ error: planResult.error });
      }
      const { employeeId, oldStart, oldEnd, newStart, newEnd, startChanged, endChanged, trims, continuations, deletions } =
        planResult;

      const auditInsert = (entryId: string, field: "started_at" | "ended_at", oldVal: Date, newVal: Date) =>
        client.query(
          `insert into time_entry_corrections
             (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [entryId, employeeId, req.employee!.id, field, oldVal.toISOString(), newVal.toISOString(), AUTO_CORRECTION_REASON]
        );

      // Trims — each clears its OWN changed boundary's actual_* value too
      // (same "an admin correction supersedes rounding/schedule-match
      // evidence" reasoning the break's own update below already applies,
      // and every other correction route in this file already applies to
      // itself) — a work entry trimmed as a side effect of this break
      // correction is exact-administrator-entered from that moment on,
      // not still carrying stale evidence for a "Rounded" badge that no
      // longer describes its new boundary.
      for (const trim of trims) {
        const actualColumn = trim.field === "started_at" ? "actual_started_at" : "actual_ended_at";
        await client.query(`update time_entries set ${trim.field} = $1, ${actualColumn} = null where id = $2`, [
          trim.newValue,
          trim.id,
        ]);
        await auditInsert(trim.id, trim.field, trim.oldValue, trim.newValue);
      }

      // Fully-covered work entries — soft-deleted with the same audit
      // convention every other admin-initiated deletion in this file uses.
      for (const del of deletions) {
        await client.query(
          `update time_entries set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = $2 where id = $3`,
          [req.employee!.id, BREAK_CORRECTION_SPLIT_DELETION_REASON, del.id]
        );
        await client.query(
          `insert into time_entry_deletions
             (employee_id, deleted_by_employee_id, deletion_type, affected_time_entry_ids, reason)
           values ($1, $2, 'activity_run', $3, $4)`,
          [employeeId, req.employee!.id, [del.id], BREAK_CORRECTION_SPLIT_DELETION_REASON]
        );
      }

      // Split continuations — the "resumes after the break" second half,
      // preserving activity/row/carrier/density/device exactly as the
      // original entry had them (see BreakSplitContinuation's own
      // comment), attributed to this correction.
      for (const cont of continuations) {
        await client.query(
          `insert into time_entries
             (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
              greenhouse_row_id, carrier_id, density_type, density_count_per_row,
              created_by_employee_id, creation_reason)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', $6, $7, $8, $9, $10, $11)`,
          [
            employeeId,
            cont.deviceId,
            cont.activityId,
            cont.startedAt,
            cont.endedAt,
            cont.greenhouseRowId,
            cont.carrierId,
            cont.densityType,
            cont.densityCountPerRow,
            req.employee!.id,
            BREAK_CORRECTION_SPLIT_REASON,
          ]
        );
      }

      // The break's own row — exact administrator-entered times, never
      // rounded (auto_closed_at and whichever actual_* side actually
      // changed are cleared, same as before), so it now displays
      // "Corrected," not a stale "Rounded."
      await client.query(
        `update time_entries
         set started_at = $1, ended_at = $2, auto_closed_at = null,
             actual_started_at = case when $4 then null else actual_started_at end,
             actual_ended_at = case when $5 then null else actual_ended_at end
         where id = $3`,
        [newStart, newEnd, id, startChanged, endChanged]
      );
      if (startChanged) await auditInsert(id, "started_at", oldStart, newStart);
      if (endChanged) await auditInsert(id, "ended_at", oldEnd, newEnd);

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  })
);

// "This correction will shorten Winding & Pruning from 3:12 PM to 3:00 PM
// and remove 12 minutes from worked time." — one sentence per affected
// work entry, built from the exact same plan PATCH /breaks/:id would
// apply (computeBreakCorrectionPlan), inside a transaction that's ALWAYS
// rolled back (this never writes anything) so the modal's preview can
// never drift from what Save actually does. Locks the same rows the real
// PATCH would, briefly, purely to get a consistent read — never held past
// this request.
router.post(
  "/breaks/:id/correction-preview",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid break id" });
    const { startTime, endTime } = req.body as { startTime?: string; endTime?: string };

    const client = await pool.connect();
    try {
      await client.query("begin");
      const ownerPeek = await client.query(`select employee_id from time_entries where id = $1`, [id]);
      if (!ownerPeek.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Break not found" });
      }
      await lockEmployeeForManualEntry(client, ownerPeek.rows[0].employee_id);

      const planResult = await computeBreakCorrectionPlan(client, id, startTime, endTime);
      if (!planResult.ok) {
        await client.query("rollback");
        return res.status(planResult.status).json({ error: planResult.error });
      }

      // Activity names for every trimmed/deleted row (continuations
      // already carry activityId directly) — one extra read-only query,
      // never blocking on anything this transaction doesn't already hold.
      const affectedIds = [...planResult.trims.map((t) => t.id), ...planResult.deletions.map((d) => d.id)];
      const nameByEntryId = new Map<string, string>();
      if (affectedIds.length > 0) {
        const { rows } = await client.query(
          `select te.id, a.name from time_entries te join activities a on a.id = te.activity_id where te.id = any($1::uuid[])`,
          [affectedIds]
        );
        for (const r of rows) nameByEntryId.set(r.id, r.name);
      }
      const activityNameById = new Map<string, string>();
      if (planResult.continuations.length > 0) {
        const { rows } = await client.query(`select id, name from activities where id = any($1::uuid[])`, [
          [...new Set(planResult.continuations.map((c) => c.activityId))],
        ]);
        for (const r of rows) activityNameById.set(r.id, r.name);
      }

      // Minute precision (no seconds) — a natural-language preview
      // sentence, not the precise-to-the-second display elsewhere on the
      // page. Reuses formatTimeInAppTimezone's own APP_TIMEZONE default
      // implicitly by not overriding it.
      const fmt = (d: Date) =>
        new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: APP_TIMEZONE }).format(d);

      const messages: string[] = [];
      let workedSecondsRemoved = 0;
      for (const trim of planResult.trims) {
        const name = nameByEntryId.get(trim.id) ?? "this activity";
        const removedMinutes = Math.abs(trim.newValue.getTime() - trim.oldValue.getTime()) / 60000;
        workedSecondsRemoved += Math.abs(trim.newValue.getTime() - trim.oldValue.getTime()) / 1000;
        if (trim.field === "ended_at") {
          messages.push(
            `This correction will shorten ${name} from ${fmt(trim.oldValue)} to ${fmt(trim.newValue)} and remove ${Math.round(removedMinutes)} minutes from worked time.`
          );
        } else {
          messages.push(
            `This correction will move the start of ${name} from ${fmt(trim.oldValue)} to ${fmt(trim.newValue)} and remove ${Math.round(removedMinutes)} minutes from worked time.`
          );
        }
      }
      for (const cont of planResult.continuations) {
        // A continuation always accompanies exactly one trim on the same
        // original entry — its own duration is given back out of that
        // trim's naive delta above, so workedSecondsRemoved is corrected
        // here to reflect only the portion the break genuinely covers
        // (see this function's own header comment for the derivation).
        workedSecondsRemoved -= (cont.endedAt.getTime() - cont.startedAt.getTime()) / 1000;
        const name = activityNameById.get(cont.activityId) ?? "this activity";
        messages.push(`${name} will resume at ${fmt(cont.startedAt)} after the break, ending at ${fmt(cont.endedAt)}.`);
      }
      for (const del of planResult.deletions) {
        const name = nameByEntryId.get(del.id) ?? "this activity";
        const removedMinutes = (del.endedAt.getTime() - del.startedAt.getTime()) / 60000;
        workedSecondsRemoved += (del.endedAt.getTime() - del.startedAt.getTime()) / 1000;
        messages.push(
          `This correction will remove the entire ${name} entry from ${fmt(del.startedAt)} to ${fmt(del.endedAt)} (${Math.round(removedMinutes)} minutes) — it's fully covered by the corrected break.`
        );
      }

      const breakMillisDelta =
        planResult.newEnd.getTime() - planResult.newStart.getTime() - (planResult.oldEnd.getTime() - planResult.oldStart.getTime());

      await client.query("rollback");
      res.json({
        messages,
        workedMinutesRemoved: Math.round(workedSecondsRemoved / 60),
        breakMinutesDelta: Math.round(breakMillisDelta / 60000),
        trimCount: planResult.trims.length,
        deletionCount: planResult.deletions.length,
        splitCount: planResult.continuations.length,
      });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

router.post(
  "/breaks/:id/delete",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid break id" });

    // No typed reason collected from the caller here — see
    // BREAK_DELETION_REASON's own comment above.
    const trimmedReason = BREAK_DELETION_REASON;

    const client = await pool.connect();
    try {
      await client.query("begin");

      const peek = await client.query(
        `select employee_id, entry_type, started_at, ended_at, deleted_at,
                break_profile_item_id, to_char(scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date, source
         from time_entries where id = $1`,
        [id]
      );
      const peekRow = peek.rows[0];
      if (!peekRow || peekRow.deleted_at) {
        await client.query("rollback");
        return res.status(404).json({ error: "Break not found" });
      }
      if (peekRow.entry_type !== "break") {
        await client.query("rollback");
        return res.status(409).json({ error: "Only a break can be deleted here" });
      }
      if (peekRow.ended_at === null) {
        await client.query("rollback");
        return res.status(409).json({ error: "An in-progress break cannot be deleted from this screen" });
      }

      // Subquery-based comparison, not a round-tripped Date parameter — see
      // the identical fix (and its rationale) in the PATCH handler above.
      const precedingPeek = await client.query(
        `select id, activity_id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and ended_at = (select started_at from time_entries where id = $2)`,
        [peekRow.employee_id, id]
      );
      const followingPeek = await client.query(
        `select id, activity_id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and started_at = (select ended_at from time_entries where id = $2)`,
        [peekRow.employee_id, id]
      );

      // Different activities on either side: never guess how to bridge the
      // gap — reject and ask the supervisor to correct the adjacent
      // activity's times (or delete one of them) first.
      if (
        precedingPeek.rows[0] &&
        followingPeek.rows[0] &&
        precedingPeek.rows[0].activity_id !== followingPeek.rows[0].activity_id
      ) {
        await client.query("rollback");
        return res.status(409).json({
          error:
            "This break sits between two different activities and can't be safely removed automatically. " +
            "Correct the adjacent activity's times first, or delete one of them, before removing this break.",
        });
      }

      // Chronological lock order (see the PATCH handler above for why).
      let preceding: { id: string } | null = null;
      if (precedingPeek.rows[0]) {
        const r = await client.query(`select id from time_entries where id = $1 and deleted_at is null for update`, [
          precedingPeek.rows[0].id,
        ]);
        preceding = r.rows[0] ?? null;
      }

      const targetRes = await client.query(
        `select id, employee_id, ended_at from time_entries
         where id = $1 and entry_type = 'break' and deleted_at is null for update`,
        [id]
      );
      const target = targetRes.rows[0];
      if (!target || target.ended_at === null) {
        await client.query("rollback");
        return res
          .status(409)
          .json({ error: "This break changed since it was loaded — please refresh and try again" });
      }

      let following: { id: string } | null = null;
      if (followingPeek.rows[0]) {
        const r = await client.query(`select id from time_entries where id = $1 and deleted_at is null for update`, [
          followingPeek.rows[0].id,
        ]);
        following = r.rows[0] ?? null;
      }

      // Reconnect only when both sides survived the lock and are still the
      // same activity — extend the preceding entry to meet the following
      // one exactly, the reverse of how reconcileEmployeeBreaks shrinks a
      // work entry to carve an auto-added break out of it. A break at the
      // start or end of the day (only one side, or neither) is just
      // deleted outright: there's nothing to reconnect, and — deliberately
      // — the single remaining neighbor's own boundary is left untouched
      // rather than guessed at (see report for this chosen behavior).
      if (preceding && following) {
        // Set via a subquery on the break's own id rather than passing
        // target.ended_at back in as a parameter, so preceding.ended_at
        // ends up bit-identical to the value following.started_at already
        // holds (same precision reasoning as the lookups above) instead of
        // a millisecond-truncated copy of it.
        await client.query(
          `update time_entries set ended_at = (select ended_at from time_entries where id = $1), auto_closed_at = null where id = $2`,
          [id, preceding.id]
        );
        await client.query(
          `insert into time_entry_corrections
             (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
           values ($1, $2, $3, 'ended_at', $4, $5, $6)`,
          [
            preceding.id,
            peekRow.employee_id,
            req.employee!.id,
            new Date(peekRow.started_at).toISOString(),
            new Date(target.ended_at).toISOString(),
            trimmedReason,
          ]
        );
      }

      await client.query(
        `update time_entries
         set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = $2
         where id = $3`,
        [req.employee!.id, trimmedReason, id]
      );
      await client.query(
        `insert into time_entry_deletions
           (employee_id, deleted_by_employee_id, deletion_type, affected_time_entry_ids, reason)
         values ($1, $2, 'break', $3, $4)`,
        [peekRow.employee_id, req.employee!.id, [id], trimmedReason]
      );

      // Suppress reconciliation from recreating this break on the next
      // status fetch or Inputs load — for ANY break tied to a scheduled
      // item, not just ones recorded with source='auto'. A manual break
      // that landed inside a fixed item's grace window (mobileTime.ts's
      // break/start) is tagged with the same break_profile_item_id/
      // scheduled_break_date, and the reconnect step just above can
      // re-merge the surrounding work entries back into a single span that
      // fully covers the scheduled window again — at which point
      // reconcileEmployeeBreaks would see that window as unaccounted-for
      // and re-add it (as a new 'auto' entry) unless suppressed here.
      // Freeform manual breaks (no break_profile_item_id at all) never
      // match reconciliation's schedule-driven checks in the first place,
      // so they correctly never need a row here.
      if (peekRow.break_profile_item_id && peekRow.scheduled_break_date) {
        await client.query(
          `insert into break_schedule_exceptions
             (employee_id, break_profile_item_id, scheduled_date, reason, created_by_employee_id)
           values ($1, $2, $3, $4, $5)
           on conflict (employee_id, break_profile_item_id, scheduled_date) do nothing`,
          [peekRow.employee_id, peekRow.break_profile_item_id, peekRow.scheduled_break_date, trimmedReason, req.employee!.id]
        );
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  })
);

export default router;
