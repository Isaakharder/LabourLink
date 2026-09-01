import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice, requireDeviceRole } from "../middleware/device";
import { getCurrentWeekBoundsUtc, calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { getActivityDensityAttribution } from "../lib/reportQueries";
import { getCarrierCompletionAttribution } from "../lib/carrierCompletionAttribution";
import { aggregateDensitySpeed } from "../lib/densitySpeed";
import { groupIntoActivityRuns, RunSegment } from "../lib/activityRuns";
import { getSignedPhotoUrls } from "../lib/storage";

const router = Router();
router.use(asyncHandler(requireDevice));

// Same floor and same rationale as dashboard.ts's MIN_SPEED_DURATION_SECONDS
// (which this constant intentionally mirrors exactly): below this much
// attributed weekly duration, a ratio-of-sums speed is still mathematically
// defined but not something a LIVE screen should ever display as a rate — a
// few seconds of work with a stray quantity attributed can render as a
// wildly noisy number (e.g. "14,000/hour"). This screen is exactly the kind
// of live, at-a-glance view that reasoning warns about, so it gets the same
// floor rather than Reports/mobile Stats' floor-less historical behavior.
const MIN_SPEED_DURATION_SECONDS = 15 * 60;

// -----------------------------------------------------------------------
// GET /live — the mobile Employees screen's one aggregated feed: every
// currently clocked-in employee (working OR on break), across every
// activity, regardless of Dashboard's admin-curated activity selection.
//
// Deliberately NOT built on top of dashboard.ts's /cards — that query joins
// dashboard_activities (the Dashboard's own "which activities show a card"
// config), which would silently hide anyone doing an activity the Dashboard
// isn't configured to show, and it never looks at break entries at all.
// Everything else here reuses the exact same shared, batched (never
// per-employee) building blocks dashboard.ts already established:
// groupIntoActivityRuns for true run-start time, getActivityDensityAttribution/
// getCarrierCompletionAttribution + aggregateDensitySpeed for weekly speed
// (same functions Inputs/Reports/mobile Stats/Dashboard all funnel through),
// getCurrentWeekBoundsUtc for the org-timezone week boundary, and
// getSignedPhotoUrls for photos.
// -----------------------------------------------------------------------
router.get(
  "/live",
  requireDeviceRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const { weekStart, weekEnd, start: weekStartUtc, end: weekEndUtc } = await getCurrentWeekBoundsUtc();

    const { rows: workRows } = await pool.query(
      `select te.id as time_entry_id, te.employee_id, te.activity_id, te.started_at,
              te.greenhouse_row_id, te.carrier_id,
              e.first_name, e.last_name, e.profile_photo_path,
              a.name as activity_name, a.density_source, a.speed_unit,
              gr.row_number, gp.name as phase_name,
              c.name as carrier_name
       from time_entries te
       join activities a on a.id = te.activity_id and a.is_active = true
       join employees e on e.id = te.employee_id and e.is_active = true
       left join greenhouse_rows gr on gr.id = te.greenhouse_row_id
       left join greenhouse_phases gp on gp.id = gr.phase_id
       left join carriers c on c.id = te.carrier_id
       where te.entry_type = 'work' and te.ended_at is null and te.deleted_at is null`
    );

    // On-break employees are entirely absent from the query above
    // (entry_type = 'work' only) — a break row itself carries no
    // activity/location (chk_time_entries_activity_matches_type forces
    // activity_id null on breaks), so it's read separately here.
    const { rows: breakRows } = await pool.query(
      `select te.id as time_entry_id, te.employee_id, te.started_at, te.is_paid,
              e.first_name, e.last_name, e.profile_photo_path,
              bpi.name as break_type_name
       from time_entries te
       join employees e on e.id = te.employee_id and e.is_active = true
       left join break_profile_items bpi on bpi.id = te.break_profile_item_id
       where te.entry_type = 'break' and te.ended_at is null and te.deleted_at is null`
    );

    if (workRows.length === 0 && breakRows.length === 0) {
      return res.json({ weekStart, weekEnd, generatedAt: new Date().toISOString(), employees: [] });
    }

    const workingEmployeeIds = [...new Set(workRows.map((r) => r.employee_id as string))];

    // --- Run-start-time fix for working employees — see dashboard.ts's
    // /cards for the full rationale: a break-split visit's open SEGMENT
    // started_at understates the RUN's true elapsed time. Batched once for
    // every working employee (today's segments only — daily cutoff
    // guarantees a run can't span into a prior day). ---
    const today = calendarDateInAppTimezone(new Date());
    const { start: dayStart, end: dayEnd } = getDayBoundsUtc(today);
    const { rows: todayRows } =
      workingEmployeeIds.length === 0
        ? { rows: [] as never[] }
        : await pool.query(
            `select id, employee_id, entry_type, activity_id, started_at, ended_at,
                    greenhouse_row_id, carrier_id, density_type, density_count_per_row
             from time_entries
             where employee_id = any($1::uuid[]) and started_at >= $2 and started_at < $3 and deleted_at is null
             order by employee_id, started_at asc`,
            [workingEmployeeIds, dayStart, dayEnd]
          );
    const todayByEmployee = new Map<string, typeof todayRows>();
    for (const r of todayRows) {
      const list = todayByEmployee.get(r.employee_id) ?? [];
      list.push(r);
      todayByEmployee.set(r.employee_id, list);
    }
    const runStartByEmployee = new Map<string, string>();
    for (const [employeeId, rows] of todayByEmployee) {
      const segments: RunSegment[] = rows.map((r) => ({
        id: r.id,
        entry_type: r.entry_type,
        activity_id: r.activity_id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        greenhouse_row_id: r.greenhouse_row_id,
        carrier_id: r.carrier_id,
        density_type: r.density_type,
        density_count_per_row: r.density_count_per_row,
        // Not needed here — only rowCompletionCandidates.ts's cross-day
        // visit-root resolution consults this field.
        rollover_of_entry_id: null,
      }));
      const { runs } = groupIntoActivityRuns(segments);
      const openRun = runs.find((r) => r.isOpen);
      if (openRun) runStartByEmployee.set(employeeId, openRun.startedAt.toISOString());
    }

    // --- Resuming activity for on-break employees — the exact race-free
    // boundary match mobileTime.ts's serializeStatus uses for a single
    // employee (ended_at = the open break's own started_at), batched here
    // across every on-break employee at once via paired unnest arrays
    // instead of one query per employee. Returns nothing for an employee
    // whose most recent work segment doesn't end exactly at this break's
    // start (e.g. the break was manually backdated) — left null rather than
    // guessed, per the "do not guess" requirement. ---
    const resumeByEmployee = new Map<
      string,
      { activityId: string; activityName: string; rowNumber: number | null; phaseName: string | null; carrierName: string | null }
    >();
    if (breakRows.length > 0) {
      const breakEmployeeIds = breakRows.map((r) => r.employee_id as string);
      const breakStartedAts = breakRows.map((r) => r.started_at);
      const { rows: resumeRows } = await pool.query(
        `with open_breaks(employee_id, break_started_at) as (
           select unnest($1::uuid[]), unnest($2::timestamptz[])
         )
         select ob.employee_id, te.activity_id, a.name as activity_name,
                gr.row_number, gp.name as phase_name, c.name as carrier_name
         from open_breaks ob
         join time_entries te
           on te.employee_id = ob.employee_id and te.entry_type = 'work' and te.deleted_at is null
           and te.ended_at = ob.break_started_at
         join activities a on a.id = te.activity_id
         left join greenhouse_rows gr on gr.id = te.greenhouse_row_id
         left join greenhouse_phases gp on gp.id = gr.phase_id
         left join carriers c on c.id = te.carrier_id`,
        [breakEmployeeIds, breakStartedAts]
      );
      for (const r of resumeRows) {
        resumeByEmployee.set(r.employee_id, {
          activityId: r.activity_id,
          activityName: r.activity_name,
          rowNumber: r.row_number,
          phaseName: r.phase_name,
          carrierName: r.carrier_name,
        });
      }
    }

    // --- Weekly speed for working employees — split by whether the
    // activity actually has a measurable speed concept at all.
    // density_source set => row/stem (speed_unit is server-enforced to
    // match, see activities.ts's DENSITY_SPEED_UNIT). density_source null
    // but speed_unit set => a manually-configured rate (picking/bins today,
    // kg/hour later once real weight data exists) — still resolved through
    // getCarrierCompletionAttribution, the same function dashboard.ts's
    // "picking" cards use. Neither set => the activity has no speed concept
    // at all (e.g. a plain non-quantified task) — "No speed metric",
    // skipped entirely rather than run through an attribution query that
    // could only ever return null. ---
    const rowStemRows = workRows.filter((r) => r.density_source != null);
    const pickingRows = workRows.filter((r) => r.density_source == null && r.speed_unit != null);
    const noMetricEmployeeIds = new Set(
      workRows.filter((r) => r.density_source == null && r.speed_unit == null).map((r) => r.employee_id as string)
    );

    const speedByEmployee = new Map<string, number | null>();

    for (const activityId of new Set(rowStemRows.map((r) => r.activity_id as string))) {
      const attribution = await getActivityDensityAttribution(activityId, weekStartUtc, weekEndUtc);
      for (const r of rowStemRows.filter((row) => row.activity_id === activityId)) {
        const totals = attribution.byEmployee.get(r.employee_id);
        speedByEmployee.set(
          r.employee_id,
          totals && totals.durationSeconds >= MIN_SPEED_DURATION_SECONDS
            ? aggregateDensitySpeed([{ quantityPerRow: totals.quantity, durationSeconds: totals.durationSeconds }])
            : null
        );
      }
    }

    for (const activityId of new Set(pickingRows.map((r) => r.activity_id as string))) {
      const attribution = await getCarrierCompletionAttribution(activityId, weekStartUtc, weekEndUtc);
      for (const r of pickingRows.filter((row) => row.activity_id === activityId)) {
        const totals = attribution.byEmployee.get(r.employee_id);
        speedByEmployee.set(
          r.employee_id,
          totals && totals.durationSeconds >= MIN_SPEED_DURATION_SECONDS
            ? aggregateDensitySpeed([{ quantityPerRow: totals.quantity, durationSeconds: totals.durationSeconds }])
            : null
        );
      }
    }

    // --- Photos: one batched signed-URL call across BOTH working and
    // on-break employees, never per-employee. ---
    const photoPaths = [
      ...new Set(
        [...workRows, ...breakRows].filter((r) => r.profile_photo_path).map((r) => r.profile_photo_path as string)
      ),
    ];
    const photoUrlByPath = await getSignedPhotoUrls(photoPaths);
    function photoUrlFor(row: { profile_photo_path: string | null }): string | null {
      return row.profile_photo_path ? photoUrlByPath.get(row.profile_photo_path) ?? null : null;
    }

    const workingCards = workRows.map((r) => {
      const employeeId = r.employee_id as string;
      const hasMetric = !noMetricEmployeeIds.has(employeeId);
      const speedValue = hasMetric ? speedByEmployee.get(employeeId) ?? null : null;
      const locationType = r.greenhouse_row_id ? "row" : r.carrier_id ? "carrier" : "none";
      return {
        employeeId,
        employeeFirstName: r.first_name as string,
        employeeLastName: r.last_name as string,
        photoUrl: photoUrlFor(r),
        status: "working" as const,
        statusSince: runStartByEmployee.get(employeeId) ?? new Date(r.started_at).toISOString(),
        activityId: r.activity_id as string,
        activityName: r.activity_name as string,
        locationType,
        rowLabel: r.phase_name && r.row_number != null ? `${r.phase_name} · Row ${r.row_number}` : null,
        carrierName: r.carrier_name ?? null,
        speedValue,
        speedUnit: hasMetric ? (r.speed_unit as string | null) : null,
        speedState: !hasMetric ? ("no_metric" as const) : speedValue == null ? ("not_enough_data" as const) : ("ok" as const),
        breakType: null,
        resumingActivityName: null,
      };
    });

    const breakCards = breakRows.map((r) => {
      const resume = resumeByEmployee.get(r.employee_id as string);
      return {
        employeeId: r.employee_id as string,
        employeeFirstName: r.first_name as string,
        employeeLastName: r.last_name as string,
        photoUrl: photoUrlFor(r),
        status: "on_break" as const,
        statusSince: new Date(r.started_at).toISOString(),
        activityId: null,
        activityName: null,
        locationType: "none" as const,
        rowLabel: null,
        carrierName: null,
        speedValue: null,
        speedUnit: null,
        speedState: "ok" as const,
        // A break profile item with no name (an unscheduled manual break)
        // is genuinely untyped — "Break" is the honest label, not a guess.
        breakType: r.break_type_name ?? "Break",
        resumingActivityName: resume?.activityName ?? null,
      };
    });

    // Working first, then on break, then alphabetically within each group —
    // exactly the ordering the mobile Employees screen requires.
    const employees = [...workingCards, ...breakCards].sort((a, b) => {
      if (a.status !== b.status) return a.status === "working" ? -1 : 1;
      const nameA = `${a.employeeFirstName} ${a.employeeLastName}`.toLowerCase();
      const nameB = `${b.employeeFirstName} ${b.employeeLastName}`.toLowerCase();
      return nameA.localeCompare(nameB);
    });

    res.json({ weekStart, weekEnd, generatedAt: new Date().toISOString(), employees });
  })
);

export default router;
