// Employee-facing weekly speed performance for the mobile Stats tab. Identity
// comes exclusively from req.device (see middleware/device.ts) — the phone
// never supplies an employeeId, so there is no way to request another
// employee's figures.
//
// Reuses the exact same building blocks the desktop Activity Report uses —
// getActivityDensityAttribution for row-completion/unresolved-run selection
// and aggregateDensitySpeed for the ratio-of-sums weekly speed — rather than
// introducing a second speed formula. See reportQueries.ts's file header.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice } from "../middleware/device";
import { addDaysToDateStr, getCurrentWeekBoundsUtc, getRangeBoundsUtc } from "../lib/timezone";
import { getActivityDensityAttribution } from "../lib/reportQueries";
import { aggregateDensitySpeed } from "../lib/densitySpeed";

const router = Router();
router.use(asyncHandler(requireDevice));

const WEEKS_SHOWN = 4;

interface WeekActivityStat {
  activityId: string;
  activityName: string;
  speedUnit: string | null;
  totalQuantity: number;
  totalDurationSeconds: number;
  averageSpeed: number;
}

interface WeekStat {
  offset: number; // 0 = current week, 1 = last week, ... newest first
  weekStart: string; // YYYY-MM-DD, Monday
  weekEnd: string; // YYYY-MM-DD, Sunday
  activities: WeekActivityStat[];
}

router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const employeeId = req.device!.employeeId;

    // Monday-start week, the one shared canonical "current week" definition
    // (server/src/lib/timezone.ts's getCurrentWeekBoundsUtc) also used by
    // the Dashboard — so this can never silently drift from another page's
    // week boundaries.
    const { weekStart: currentWeekStart } = await getCurrentWeekBoundsUtc();

    const weekBounds = Array.from({ length: WEEKS_SHOWN }, (_, offset) => {
      const weekStart = addDaysToDateStr(currentWeekStart, -7 * offset);
      const weekEnd = addDaysToDateStr(weekStart, 6);
      const { start, end } = getRangeBoundsUtc(weekStart, weekEnd);
      return { offset, weekStart, weekEnd, start, end };
    });
    const rangeStart = weekBounds[weekBounds.length - 1].start;
    const rangeEnd = weekBounds[0].end;

    // Only activities this employee actually has density-tracked work
    // entries for in the window — density_type is only ever populated when
    // the activity had density_source configured at the moment the entry
    // was opened (see mobileTime.ts's openEntry), so this is exactly "has a
    // meaningful speed configuration AND was actually worked."
    const { rows: candidateRows } = await pool.query(
      `select distinct te.activity_id
       from time_entries te
       join activities a on a.id = te.activity_id and a.density_source is not null
       where te.employee_id = $1 and te.entry_type = 'work' and te.deleted_at is null
         and te.density_type is not null
         and te.started_at >= $2 and te.started_at < $3`,
      [employeeId, rangeStart, rangeEnd]
    );
    const candidateActivityIds: string[] = candidateRows.map((r) => r.activity_id);

    const weeks: WeekStat[] = weekBounds.map(({ offset, weekStart, weekEnd }) => ({
      offset,
      weekStart,
      weekEnd,
      activities: [],
    }));

    if (candidateActivityIds.length > 0) {
      const { rows: activityRows } = await pool.query(
        `select id, name, speed_unit from activities where id = any($1::uuid[])`,
        [candidateActivityIds]
      );
      const activityMeta = new Map(activityRows.map((r) => [r.id as string, { name: r.name as string, speedUnit: r.speed_unit as string | null }]));

      // One attribution call per activity PER WEEK, each scoped to that
      // week's own [start, end) — deliberately not one 4-week call bucketed
      // afterward by calendar day. attribution.byEmployee (the whole-range
      // ratio-of-sums total) is what Reports' own Grand Total shows for a
      // range and is the only figure that still counts a completion/run
      // whose segments cross a calendar-day boundary within the range;
      // attribution.byEmployeeDay excludes those entirely (see
      // reportQueries.ts), so bucketing a wider call by day would silently
      // drop real quantity a same-week, cross-midnight completion earned —
      // a discrepancy from what Reports itself would show for that week.
      for (const activityId of candidateActivityIds) {
        const meta = activityMeta.get(activityId);
        if (!meta) continue;

        for (const bounds of weekBounds) {
          const attribution = await getActivityDensityAttribution(activityId, bounds.start, bounds.end);
          const totals = attribution.byEmployee.get(employeeId);
          if (!totals || totals.quantity <= 0 || totals.durationSeconds <= 0) continue;
          const averageSpeed = aggregateDensitySpeed([
            { quantityPerRow: totals.quantity, durationSeconds: totals.durationSeconds },
          ]);
          if (averageSpeed == null) continue;
          weeks[bounds.offset].activities.push({
            activityId,
            activityName: meta.name,
            speedUnit: meta.speedUnit,
            totalQuantity: totals.quantity,
            totalDurationSeconds: totals.durationSeconds,
            averageSpeed,
          });
        }
      }
    }

    res.json({ employeeId, weeks });
  })
);

export default router;
