import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getCurrentWeekBoundsUtc, calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { getActivityDensityAttribution } from "../lib/reportQueries";
import { getCarrierCompletionAttribution } from "../lib/carrierCompletionAttribution";
import { getBlockProgressForEmployees, BlockProgress } from "../lib/dashboardBlockProgress";
import { aggregateDensitySpeed } from "../lib/densitySpeed";
import { groupIntoActivityRuns, RunSegment } from "../lib/activityRuns";
import { getSignedPhotoUrls } from "../lib/storage";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Below this much attributed weekly duration, a ratio-of-sums speed is
// still mathematically well-defined but not something a LIVE dashboard
// should ever display as a rate — a few seconds of work with a stray
// quantity attributed can otherwise render as a wildly noisy number (e.g.
// "14,000/hour"), a much more visible failure mode here than the same
// thing would be on a historical Reports page. Reports/mobile Stats don't
// need this floor; this endpoint does.
const MIN_SPEED_DURATION_SECONDS = 15 * 60;

router.get("/", requireAuth, asyncHandler(async (_req, res) => {
  let rows;
  try {
    ({ rows } = await pool.query(`
      select
        (select count(*) from employees where is_active = true) as total_employees,
        (select count(*) from devices where is_active = true) as total_devices,
        (select count(*) from devices d where d.is_active = true
           and exists (
             select 1 from device_assignments da
             where da.device_id = d.id and da.unassigned_at is null
           )) as assigned_devices,
        (select count(*) from devices d where d.is_active = true
           and not exists (
             select 1 from device_assignments da
             where da.device_id = d.id and da.unassigned_at is null
           )) as unassigned_devices,
        (select count(*) from pairing_requests where status = 'pending' and expires_at > now()) as devices_waiting_for_setup
    `));
  } catch (err) {
    console.error(
      "Dashboard database query failed:",
      err instanceof Error ? err.message : err
    );
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }

  const row = rows[0];
  res.json({
    totalEmployees: Number(row.total_employees),
    totalDevices: Number(row.total_devices),
    assignedDevices: Number(row.assigned_devices),
    unassignedDevices: Number(row.unassigned_devices),
    devicesWaitingForSetup: Number(row.devices_waiting_for_setup),
  });
}));

// -----------------------------------------------------------------------
// Dashboard settings: which activities' currently-active employees appear
// as cards on GET /cards below (038_dashboard_activities.sql). The full
// row set of dashboard_activities IS the config — no separate "configured"
// flag. card_type is never stored (see the migration's own comment): it's
// always derived here from activities.density_source at read time, so it
// can never drift from an activity's own live density configuration.
// -----------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveCardType(densitySource: any): "row_stem" | "picking" {
  return densitySource != null ? "row_stem" : "picking";
}

router.get(
  "/settings",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    // Includes an activity that's since been deactivated but is still
    // selected, so it stays visible (and removable) in the editor instead
    // of silently vanishing from the list the moment it's deactivated —
    // GET /cards itself already excludes it from actually rendering a card
    // (its own join requires a.is_active = true).
    const { rows } = await pool.query(
      `select a.id, a.name, a.is_active, a.density_source, (da.activity_id is not null) as selected
       from activities a
       left join dashboard_activities da on da.activity_id = a.id
       where a.is_active = true or da.activity_id is not null
       order by lower(a.name)`
    );
    res.json({
      activities: rows.map((r) => ({
        activityId: r.id,
        activityName: r.name,
        isActive: r.is_active,
        densitySource: r.density_source,
        cardType: deriveCardType(r.density_source),
        selected: r.selected,
      })),
    });
  })
);

router.put(
  "/settings",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const raw = req.body?.activityIds;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "activityIds must be an array" });
    }
    const activityIds = [...new Set(raw)];
    if (!activityIds.every((id) => typeof id === "string" && UUID_RE.test(id))) {
      return res.status(400).json({ error: "One or more activityIds are invalid" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      if (activityIds.length > 0) {
        const { rows: found } = await client.query(
          `select id from activities where id = any($1::uuid[]) and is_active = true`,
          [activityIds]
        );
        if (found.length !== activityIds.length) {
          await client.query("rollback");
          return res.status(400).json({ error: "One or more activities were not found or are inactive" });
        }
      }

      await client.query("delete from dashboard_activities");
      if (activityIds.length > 0) {
        await client.query(
          `insert into dashboard_activities (activity_id, added_by_employee_id)
           select unnest($1::uuid[]), $2`,
          [activityIds, req.employee!.id]
        );
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `select a.id, a.name, a.is_active, a.density_source, (da.activity_id is not null) as selected
       from activities a
       left join dashboard_activities da on da.activity_id = a.id
       where a.is_active = true or da.activity_id is not null
       order by lower(a.name)`
    );
    res.json({
      activities: rows.map((r) => ({
        activityId: r.id,
        activityName: r.name,
        isActive: r.is_active,
        densitySource: r.density_source,
        cardType: deriveCardType(r.density_source),
        selected: r.selected,
      })),
    });
  })
);

// -----------------------------------------------------------------------
// GET /cards — the aggregated employee-card feed the Dashboard page
// renders. One base query for every currently-open work entry on a
// selected activity, then a handful of batched (per-distinct-activity or
// per-distinct-density-type, never per-employee) follow-up queries — see
// each section below for exactly what it reuses.
// -----------------------------------------------------------------------
router.get(
  "/cards",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { weekStart, weekEnd, start: weekStartUtc, end: weekEndUtc } = await getCurrentWeekBoundsUtc();

    const { rows: openRows } = await pool.query(
      `select te.id as time_entry_id, te.employee_id, te.activity_id, te.started_at,
              te.greenhouse_row_id, te.carrier_id,
              e.first_name, e.last_name, e.profile_photo_path,
              a.name as activity_name, a.density_source,
              gr.row_number, gp.name as phase_name,
              c.name as carrier_name
       from time_entries te
       join dashboard_activities da on da.activity_id = te.activity_id
       join activities a on a.id = te.activity_id and a.is_active = true
       join employees e on e.id = te.employee_id and e.is_active = true
       left join greenhouse_rows gr on gr.id = te.greenhouse_row_id
       left join greenhouse_phases gp on gp.id = gr.phase_id
       left join carriers c on c.id = te.carrier_id
       where te.entry_type = 'work' and te.ended_at is null and te.deleted_at is null
       order by lower(a.name), lower(e.first_name), lower(e.last_name)`
    );

    if (openRows.length === 0) {
      return res.json({ weekStart, weekEnd, cards: [] });
    }

    const employeeIds = [...new Set(openRows.map((r) => r.employee_id as string))];

    // --- Run-start-time fix: the currently-open row's own started_at is
    // only the open SEGMENT's start, not the RUN's — a break-split visit
    // (e.g. worked, took a break, resumed the same task) understates
    // elapsed time if read directly off time_entries. Daily cutoff auto-
    // closes any entry at the calendar-day boundary, so a run can never
    // span into a prior day — fetching just today's segments per employee
    // is sufficient to reconstruct it, batched once for every employee
    // here rather than per-card. ---
    const today = calendarDateInAppTimezone(new Date());
    const { start: dayStart, end: dayEnd } = getDayBoundsUtc(today);
    const { rows: todayRows } = await pool.query(
      `select id, employee_id, entry_type, activity_id, started_at, ended_at,
              greenhouse_row_id, carrier_id, density_type, density_count_per_row
       from time_entries
       where employee_id = any($1::uuid[]) and started_at >= $2 and started_at < $3 and deleted_at is null
       order by employee_id, started_at asc`,
      [employeeIds, dayStart, dayEnd]
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
      }));
      const { runs } = groupIntoActivityRuns(segments);
      const openRun = runs.find((r) => r.isOpen);
      if (openRun) runStartByEmployee.set(employeeId, openRun.startedAt.toISOString());
    }

    // --- Split into card types (derived from density_source, never
    // stored) and collect distinct activity ids for each. ---
    const rowStemRows = openRows.filter((r) => r.density_source != null);
    const pickingRows = openRows.filter((r) => r.density_source == null);
    const rowStemActivityIds = [...new Set(rowStemRows.map((r) => r.activity_id as string))];
    const pickingActivityIds = [...new Set(pickingRows.map((r) => r.activity_id as string))];

    // --- Row/stem weekly speed: one getActivityDensityAttribution call
    // per distinct activity (never per employee) — the exact same function
    // Reports/mobile Stats already use. ---
    const rowStemSpeedByEmployee = new Map<string, number | null>();
    for (const activityId of rowStemActivityIds) {
      const attribution = await getActivityDensityAttribution(activityId, weekStartUtc, weekEndUtc);
      for (const r of rowStemRows.filter((row) => row.activity_id === activityId)) {
        const totals = attribution.byEmployee.get(r.employee_id);
        const speed =
          totals && totals.durationSeconds >= MIN_SPEED_DURATION_SECONDS
            ? aggregateDensitySpeed([{ quantityPerRow: totals.quantity, durationSeconds: totals.durationSeconds }])
            : null;
        rowStemSpeedByEmployee.set(r.employee_id, speed);
      }
    }

    // --- Block progress: batched once per distinct density_type present
    // among row/stem cards (never sharing one density_type parameter
    // across employees on different density types, and never per-employee). ---
    const blockProgressByEmployee = new Map<string, BlockProgress>();
    for (const densityType of new Set(rowStemRows.map((r) => r.density_source as "plants" | "stems"))) {
      const employeeIdsForType = rowStemRows
        .filter((r) => r.density_source === densityType)
        .map((r) => r.employee_id as string);
      const progress = await getBlockProgressForEmployees(employeeIdsForType, densityType);
      for (const [employeeId, p] of progress) blockProgressByEmployee.set(employeeId, p);
    }

    // --- Picking bin speed/count: one getCarrierCompletionAttribution call
    // per distinct activity, plus one batched "distinct rows worked this
    // week" query per distinct activity. ---
    const pickingSpeedByEmployee = new Map<string, number | null>();
    const binsCompletedByEmployee = new Map<string, number>();
    const rowsWorkedByEmployee = new Map<string, number>();
    for (const activityId of pickingActivityIds) {
      const attribution = await getCarrierCompletionAttribution(activityId, weekStartUtc, weekEndUtc);
      const employeesOnActivity = pickingRows
        .filter((r) => r.activity_id === activityId)
        .map((r) => r.employee_id as string);
      for (const employeeId of employeesOnActivity) {
        const totals = attribution.byEmployee.get(employeeId);
        const speed =
          totals && totals.durationSeconds >= MIN_SPEED_DURATION_SECONDS
            ? aggregateDensitySpeed([{ quantityPerRow: totals.quantity, durationSeconds: totals.durationSeconds }])
            : null;
        pickingSpeedByEmployee.set(employeeId, speed);
        binsCompletedByEmployee.set(employeeId, totals?.completions ?? 0);
      }

      const { rows: rowsWorkedRows } = await pool.query(
        `select employee_id, count(distinct greenhouse_row_id) as n
         from time_entries
         where activity_id = $1 and employee_id = any($2::uuid[])
           and entry_type = 'work' and deleted_at is null
           and greenhouse_row_id is not null
           and started_at >= $3 and started_at < $4
         group by employee_id`,
        [activityId, employeesOnActivity, weekStartUtc, weekEndUtc]
      );
      for (const r of rowsWorkedRows) rowsWorkedByEmployee.set(r.employee_id, Number(r.n));
    }

    // --- Photos: one batched signed-URL call for every employee, never
    // per-employee. ---
    const photoPaths = [...new Set(openRows.filter((r) => r.profile_photo_path).map((r) => r.profile_photo_path as string))];
    const photoUrlByPath = await getSignedPhotoUrls(photoPaths);

    const cards = openRows.map((r) => {
      const employeeId = r.employee_id as string;
      const base = {
        employeeId,
        employeeFirstName: r.first_name as string,
        employeeLastName: r.last_name as string,
        photoUrl: r.profile_photo_path ? photoUrlByPath.get(r.profile_photo_path) ?? null : null,
        activityId: r.activity_id as string,
        activityName: r.activity_name as string,
        runStartedAt: runStartByEmployee.get(employeeId) ?? new Date(r.started_at).toISOString(),
      };

      if (r.density_source != null) {
        const progress = blockProgressByEmployee.get(employeeId);
        const weeklySpeed = rowStemSpeedByEmployee.get(employeeId) ?? null;
        let block = null;
        if (progress) {
          if (progress.totalRows === 0) {
            block = {
              id: progress.blockId,
              name: progress.blockName,
              totalRows: 0,
              completedRows: 0,
              remainingStems: null,
              rowsMissingDensity: 0,
              projectedHoursRemaining: null,
              status: "no_rows_linked" as const,
            };
          } else if (progress.completedRows >= progress.totalRows) {
            block = {
              id: progress.blockId,
              name: progress.blockName,
              totalRows: progress.totalRows,
              completedRows: progress.completedRows,
              remainingStems: 0,
              rowsMissingDensity: 0,
              projectedHoursRemaining: null,
              status: "complete" as const,
            };
          } else if (progress.remainingStems == null) {
            block = {
              id: progress.blockId,
              name: progress.blockName,
              totalRows: progress.totalRows,
              completedRows: progress.completedRows,
              remainingStems: null,
              rowsMissingDensity: progress.rowsMissingDensity,
              projectedHoursRemaining: null,
              status: "missing_density" as const,
            };
          } else if (weeklySpeed == null || weeklySpeed <= 0) {
            block = {
              id: progress.blockId,
              name: progress.blockName,
              totalRows: progress.totalRows,
              completedRows: progress.completedRows,
              remainingStems: progress.remainingStems,
              rowsMissingDensity: 0,
              projectedHoursRemaining: null,
              status: "not_enough_data" as const,
            };
          } else {
            block = {
              id: progress.blockId,
              name: progress.blockName,
              totalRows: progress.totalRows,
              completedRows: progress.completedRows,
              remainingStems: progress.remainingStems,
              rowsMissingDensity: 0,
              projectedHoursRemaining: progress.remainingStems / weeklySpeed,
              status: "in_progress" as const,
            };
          }
        }
        return {
          ...base,
          cardType: "row_stem" as const,
          densityType: r.density_source as "plants" | "stems",
          rowLabel: r.phase_name ? `${r.phase_name} · Row ${r.row_number}` : null,
          weeklySpeed,
          block,
        };
      }

      return {
        ...base,
        cardType: "picking" as const,
        carrierName: r.carrier_name ?? null,
        weeklySpeed: pickingSpeedByEmployee.get(employeeId) ?? null,
        binsCompletedThisWeek: binsCompletedByEmployee.get(employeeId) ?? 0,
        rowsWorkedThisWeek: rowsWorkedByEmployee.get(employeeId) ?? 0,
      };
    });

    res.json({ weekStart, weekEnd, cards });
  })
);

export default router;
