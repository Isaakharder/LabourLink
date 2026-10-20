// Read-only endpoints for external systems that pull LabourLink data over
// plain HTTP with a machine credential (see server/src/middleware/
// integrationAuth.ts) instead of a human session or a paired device. Only
// consumer: Productive TV, an external Windows PC that folds LabourLink
// employees into its own Pruning slide (a Winding & Pruning stems/hour
// ranking) alongside its existing Ridder Productive data, and shows a
// Picking Peppers stems/hour ranking on its Picking slide.
import { Request, Response, Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireIntegrationToken } from "../middleware/integrationAuth";
import { getActivityReportData, getActivityReportDataWithAttribution } from "../lib/reportQueries";
import { aggregateDensitySpeed } from "../lib/densitySpeed";
import { APP_TIMEZONE, inclusiveDayCount } from "../lib/timezone";
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
// Same fixed-business-name convention, for Productive TV's Picking slide.
export const PICKING_ACTIVITY_NAME = "Picking Peppers";
const REQUIRED_DENSITY_SOURCE = "stems";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Shared request validation for every productive-tv endpoint. Sends the 400
// and returns null on a bad range; returns the validated range otherwise.
function validateRange(query: unknown, res: Response): { from: string; to: string } | null {
  const { from, to } = query as { from?: string; to?: string };
  if (!isValidDate(from) || !isValidDate(to)) {
    res.status(400).json({ error: "A valid from and to date (YYYY-MM-DD) are required" });
    return null;
  }
  if (from > to) {
    res.status(400).json({ error: "from must not be after to" });
    return null;
  }
  // Same cap greenhouse-live/greenhouse-displays enforce on any
  // repeatedly-polled, caller-supplied date range — Productive TV refreshes
  // every TV independently on a timer, so an unbounded range here isn't a
  // one-off slow request, it's a standing load.
  if (inclusiveDayCount(from, to) > MAX_DATE_RANGE_DAYS) {
    res.status(400).json({ error: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` });
    return null;
  }
  return { from, to };
}

// Looks up one fixed-name activity and requires it to be active and
// configured with density_source = 'stems'. Sends a 503 (a configuration
// problem, never "no work") and returns null otherwise. `reason` is a
// stable machine-readable code so Productive TV can tell the operator
// exactly which setting is missing instead of a generic failure.
async function loadStemsActivity(name: string, res: Response): Promise<{ id: string; name: string } | null> {
  // activities.name is globally unique (both a plain `unique` constraint
  // and the normalized activities_name_normalized_key index), so this can
  // only ever return zero or one row — never an ambiguous match.
  const { rows: activityRows } = await pool.query(
    `select id, name, is_active, density_source from activities where lower(trim(name)) = lower(trim($1))`,
    [name]
  );
  const activity = activityRows[0];
  if (!activity) {
    console.error(`[integrations] "${name}" activity is not configured in this LabourLink instance`);
    res.status(503).json({ error: `The "${name}" activity is not configured`, reason: "activity_missing" });
    return null;
  }
  if (!activity.is_active) {
    console.error(`[integrations] "${name}" activity (${activity.id}) exists but is not active`);
    res.status(503).json({ error: `The "${name}" activity is not active`, reason: "activity_inactive" });
    return null;
  }
  if (activity.density_source !== REQUIRED_DENSITY_SOURCE) {
    console.error(
      `[integrations] "${name}" activity (${activity.id}) has density_source=${activity.density_source ?? "null"}, expected "${REQUIRED_DENSITY_SOURCE}"`
    );
    res.status(503).json({
      error: `The "${name}" activity is not configured for ${REQUIRED_DENSITY_SOURCE} (found: ${activity.density_source ?? "none"})`,
      reason: "density_source_not_stems",
    });
    return null;
  }
  return { id: activity.id, name: activity.name };
}

// Identical concurrent requests (same endpoint, activity and range) share
// one in-flight computation instead of each running the full report. Every
// TV polls on its own timer, and a client that gives up and retries would
// otherwise start a second copy while the first is still running; Express
// never cancels a handler when its client disconnects. The entry is dropped
// as soon as the computation settles, so this is never a cache: every
// request gets a result computed after it arrived or while it was waiting.
const inFlight = new Map<string, Promise<unknown>>();
function sharedInFlight<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = compute().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// True once the client has closed the connection. Checked right before the
// expensive report work starts, so a request the TV has already abandoned
// doesn't still run a whole report against the shared DB pool.
function clientGone(req: Request): boolean {
  return req.socket.destroyed;
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
    const range = validateRange(req.query, res);
    if (!range) return;
    const { from, to } = range;

    const activity = await loadStemsActivity(PRUNING_ACTIVITY_NAME, res);
    if (!activity) return;

    if (clientGone(req)) return;

    // One call returns both the report and the exact attribution it was
    // built from: getActivityDensityAttribution(activity.id, start, end)
    // over the same getRangeBoundsUtc(from, to) bounds, unfiltered. This
    // endpoint used to compute that attribution a second time alongside
    // the report.
    const result = await sharedInFlight(`pruning:${activity.id}:${from}:${to}`, () =>
      getActivityReportDataWithAttribution(activity.id, from, to)
    );

    // Can only be null if the activity vanished between the lookup above
    // and this call — defensive, not a realistic runtime path since it was
    // just confirmed to exist by id.
    if (!result) {
      return res.status(503).json({ error: `The "${PRUNING_ACTIVITY_NAME}" activity is not configured` });
    }
    const { data: reportData, attribution } = result;

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

// GET /api/integrations/productive-tv/picking-speed?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-employee Picking Peppers stems/hour, taken verbatim from the Activity
// Report's own per-employee range totals (getActivityReportData's
// employeeTotals) — the exact figure a Picking Peppers Activity Report shows
// for the same range, never a second calculation:
//
//   numerator   quantityWorked — stems attributed by
//               getActivityDensityAttribution: each confirmed row completion
//               counts its frozen stems-per-row once (split by duration when
//               several employees share it), a not-yet-completed visit
//               counts only when it's the sole unambiguous candidate for its
//               row cycle, and open visits / ambiguous rows / completions
//               straddling the range edge count nothing. Deleted entries and
//               reopened completions never count.
//   denominator workSeconds ("Activity Hours") — this employee's own
//               finished Picking Peppers work entries only; breaks are
//               separate entries and never included.
//
// Unlike pruning-speed (whose denominator is the attributed duration only),
// this divides by full Activity Hours because that is what the Picking
// report itself shows. Only works when Picking Peppers has
// density_source = 'stems': stems are frozen onto each work entry when it
// opens (resolveDensitySnapshot), so without a stems density source there
// is no stem quantity at all and this answers 503 density_source_not_stems
// rather than falling back to bins or any estimate.
//
// Employees with Picking hours but no calculable speed are never returned
// with a zero; they're only counted in employeesWithoutSpeed so the TV can
// say so.
router.get(
  "/productive-tv/picking-speed",
  asyncHandler(requireIntegrationToken),
  asyncHandler(async (req, res) => {
    const range = validateRange(req.query, res);
    if (!range) return;
    const { from, to } = range;

    const activity = await loadStemsActivity(PICKING_ACTIVITY_NAME, res);
    if (!activity) return;

    if (clientGone(req)) return;

    const reportData = await sharedInFlight(`picking:${activity.id}:${from}:${to}`, () => getActivityReportData(activity.id, from, to));
    if (!reportData) {
      return res.status(503).json({ error: `The "${PICKING_ACTIVITY_NAME}" activity is not configured`, reason: "activity_missing" });
    }

    let employeesWithoutSpeed = 0;
    const employees = reportData.employeeTotals
      .map((total) => {
        const speed = total.averageSpeed;
        if (speed == null || !(speed > 0) || total.quantityWorked == null || total.workSeconds <= 0) {
          employeesWithoutSpeed++;
          return null;
        }
        return {
          employeeId: total.employeeId,
          employeeName: total.employeeName,
          stemsPerHour: round2(speed),
          stemsCounted: total.quantityWorked,
          activityHours: round2(total.workSeconds / 3600),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

    res.json({
      unit: "stems_per_hour",
      range: { from, to, timezone: APP_TIMEZONE },
      activity: { id: activity.id, name: activity.name },
      employees,
      employeesWithoutSpeed,
    });
  })
);

export default router;
