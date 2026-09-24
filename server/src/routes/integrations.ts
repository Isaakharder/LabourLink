// Read-only endpoints for external systems that pull LabourLink data over
// plain HTTP with a machine credential (see server/src/middleware/
// integrationAuth.ts) instead of a human session or a paired device. First
// and only consumer: Productive TV, an external Windows PC that folds
// LabourLink employees into its own Pruning slide (a Winding & Pruning
// stems/hour ranking) alongside its existing Ridder Productive data.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireIntegrationToken } from "../middleware/integrationAuth";
import { getActivityDensityAttribution, getActivityReportData } from "../lib/reportQueries";
import { aggregateDensitySpeed } from "../lib/densitySpeed";
import { APP_TIMEZONE, getRangeBoundsUtc, inclusiveDayCount } from "../lib/timezone";
import { MAX_DATE_RANGE_DAYS } from "./greenhouseLive";

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// The one activity this endpoint reports on — a fixed business name, not
// an admin-configurable setting or a request parameter, since there is
// exactly one external consumer (Productive TV's Pruning slide) and one
// activity it maps to. Matched the same case/whitespace-insensitive way
// activities.name's own uniqueness constraint already enforces
// (activities_name_normalized_key, 007_activity_groups.sql), so this can
// never match more than one row even if someone retypes it with different
// casing or stray spaces.
export const PRUNING_ACTIVITY_NAME = "Winding & Pruning";
const REQUIRED_DENSITY_SOURCE = "stems";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// GET /api/integrations/productive-tv/pruning-speed?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-employee Winding & Pruning speed for an inclusive local (APP_TIMEZONE)
// date range, built entirely from the same functions Reports/Dashboard/
// Inputs already use (getActivityDensityAttribution + aggregateDensitySpeed
// for the resolved stems/hour figure, getActivityReportData for the
// employee's full activity hours) — never a separate calculation, so these
// numbers can't silently drift from LabourLink's own screens.
//
// Deliberately does NOT sort, filter by a minimum-hours threshold, or cap
// to a top N — Productive TV owns that logic (its existing "this/last week,
// sorted, top N" selection over Ridder's Oid 4/7/1); this always returns
// every employee with a genuine (non-zero-duration) resolved speed in
// range, so Productive TV's own filtering never operates on a
// LabourLink-side pre-filtered subset. No payroll fields (pay rate, paid/
// unpaid breaks, etc.) are read or returned — only what's needed to render
// a stems/hour bar and apply an hours-based cutoff.
router.get(
  "/productive-tv/pruning-speed",
  // Wrapped the same as the route handler below — requireIntegrationToken
  // is async and Express 4 never catches a rejected promise from
  // middleware on its own (the same reason every async route handler in
  // this codebase goes through asyncHandler); without this, a transient DB
  // error inside the auth check would be an unhandled rejection with no
  // global handler registered in index.ts, capable of crashing the whole
  // process rather than just failing this one request.
  asyncHandler(requireIntegrationToken),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as { from?: string; to?: string };
    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({ error: "A valid from and to date (YYYY-MM-DD) are required" });
    }
    if (from > to) {
      return res.status(400).json({ error: "from must not be after to" });
    }
    // Same cap greenhouse-live/greenhouse-displays enforce on any
    // repeatedly-polled, caller-supplied date range — Productive TV refreshes
    // every TV independently on a timer, so an unbounded range here isn't a
    // one-off slow request, it's a standing load.
    if (inclusiveDayCount(from, to) > MAX_DATE_RANGE_DAYS) {
      return res.status(400).json({ error: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` });
    }

    // activities.name is globally unique (both a plain `unique` constraint
    // and the normalized activities_name_normalized_key index), so this can
    // only ever return zero or one row — never an ambiguous match.
    const { rows: activityRows } = await pool.query(
      `select id, name, is_active, density_source from activities where lower(trim(name)) = lower(trim($1))`,
      [PRUNING_ACTIVITY_NAME]
    );
    const activity = activityRows[0];
    if (!activity) {
      console.error(`[integrations] "${PRUNING_ACTIVITY_NAME}" activity is not configured in this LabourLink instance`);
      return res.status(503).json({ error: `The "${PRUNING_ACTIVITY_NAME}" activity is not configured` });
    }
    if (!activity.is_active) {
      console.error(`[integrations] "${PRUNING_ACTIVITY_NAME}" activity (${activity.id}) exists but is not active`);
      return res.status(503).json({ error: `The "${PRUNING_ACTIVITY_NAME}" activity is not active` });
    }
    if (activity.density_source !== REQUIRED_DENSITY_SOURCE) {
      console.error(
        `[integrations] "${PRUNING_ACTIVITY_NAME}" activity (${activity.id}) has density_source=${activity.density_source ?? "null"}, expected "${REQUIRED_DENSITY_SOURCE}"`
      );
      return res.status(503).json({
        error: `The "${PRUNING_ACTIVITY_NAME}" activity is not configured for ${REQUIRED_DENSITY_SOURCE} (found: ${activity.density_source ?? "none"})`,
      });
    }

    const { start, end } = getRangeBoundsUtc(from, to);
    const [attribution, reportData] = await Promise.all([
      getActivityDensityAttribution(activity.id, start, end),
      getActivityReportData(activity.id, from, to),
    ]);

    // Can only be null if the activity vanished between the lookup above
    // and this call — defensive, not a realistic runtime path since it was
    // just confirmed to exist by id.
    if (!reportData) {
      return res.status(503).json({ error: `The "${PRUNING_ACTIVITY_NAME}" activity is not configured` });
    }

    // getActivityReportData's employeeTotals is the driving list (every
    // employee with ANY work logged against this activity in range,
    // matching Reports); getActivityDensityAttribution supplies the
    // resolved stems/duration for the speed figure. An employee with hours
    // but no resolved quantity (e.g. every touched row still ambiguous, or
    // the whole visit still open) is left out entirely rather than shown
    // with a zero or null speed — "eligible" means a genuine, calculable
    // speed exists.
    const employees = reportData.employeeTotals
      .map((total) => {
        const density = attribution.byEmployee.get(total.employeeId);
        if (!density || density.durationSeconds <= 0) return null;
        const stemsPerHour = aggregateDensitySpeed([
          { quantityPerRow: density.quantity, durationSeconds: density.durationSeconds },
        ]);
        if (stemsPerHour == null) return null;
        return {
          employeeId: total.employeeId,
          employeeName: total.employeeName,
          stemsPerHour: round2(stemsPerHour),
          stemsCounted: density.quantity,
          activityHours: round2(total.workSeconds / 3600),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      // Deterministic ordering only (alphabetical by name) — never a speed
      // ranking. Sorting by speed and picking a top N is Productive TV's
      // own job, over the full list returned here.
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

    res.json({
      unit: "stems_per_hour",
      range: { from, to, timezone: APP_TIMEZONE },
      activity: { id: activity.id, name: activity.name },
      employees,
    });
  })
);

export default router;
