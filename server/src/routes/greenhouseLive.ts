import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireDisplayKey } from "../middleware/displayAuth";
import { calendarDateInAppTimezone, getRangeBoundsUtc, inclusiveDayCount } from "../lib/timezone";
import { buildLiveLandQuery, redactEmployeeNamesForDisplay, serializeLiveLand } from "../lib/greenhouseLiveState";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Applies to any caller-supplied range (office preview or Save/Publish, see
// greenhouseDisplays.ts's identical constant) — not query-tested beyond
// this, so kept conservative rather than assumed safe.
export const MAX_DATE_RANGE_DAYS = 90;

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// Resolves the office preview's date-range query params, backward compatible
// with the original single `date` param: dateStart/dateEnd win if both are
// valid, else a bare `date` becomes a one-day range, else today/today.
function resolveDateRange(query: Record<string, unknown>): { dateStart: string; dateEnd: string } {
  const dateStart = isValidDate(query.dateStart) ? (query.dateStart as string) : null;
  const dateEnd = isValidDate(query.dateEnd) ? (query.dateEnd as string) : null;
  if (dateStart && dateEnd) return { dateStart, dateEnd };
  if (isValidDate(query.date)) return { dateStart: query.date as string, dateEnd: query.date as string };
  const today = calendarDateInAppTimezone(new Date());
  return { dateStart: today, dateEnd: today };
}

router.get(
  "/live",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const landId = req.query.landId as string | undefined;
    if (!landId || !UUID_RE.test(landId)) {
      return res.status(400).json({ error: "landId is required" });
    }

    const activityId = req.query.activityId as string | undefined;
    if (activityId && !UUID_RE.test(activityId)) {
      return res.status(400).json({ error: "Invalid activityId" });
    }

    const { dateStart, dateEnd } = resolveDateRange(req.query as Record<string, unknown>);
    if (dateEnd < dateStart) {
      return res.status(400).json({ error: "dateEnd must not be before dateStart" });
    }
    if (inclusiveDayCount(dateStart, dateEnd) > MAX_DATE_RANGE_DAYS) {
      return res.status(400).json({ error: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` });
    }
    const { start, end } = getRangeBoundsUtc(dateStart, dateEnd);

    const { sql, values } = buildLiveLandQuery({
      landId,
      rangeStart: start,
      rangeEnd: end,
      activityId: activityId ?? null,
    });
    const { rows } = await pool.query(sql, values);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Land not found" });

    res.json({
      // Kept only when the range is a single day, for callers still reading
      // the original single-date field — dateStart/dateEnd are always
      // present and are what the office page itself now renders from.
      date: dateStart === dateEnd ? dateStart : null,
      dateStart,
      dateEnd,
      activityId: activityId ?? null,
      generatedAt: new Date().toISOString(),
      land: serializeLiveLand(row),
    });
  })
);

// Distinct activities with at least one qualifying (blue-or-green-causing)
// work entry in this land/range — never every activity in the database. The
// office activity dropdown must not offer a choice that would render zero
// rows, so "qualifying" here (open-as-of-range-end OR completed-in-range,
// scoped to active phases) mirrors buildLiveLandQuery's own definition
// exactly.
router.get(
  "/available-activities",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const landId = req.query.landId as string | undefined;
    if (!landId || !UUID_RE.test(landId)) {
      return res.status(400).json({ error: "landId is required" });
    }
    const { dateStart, dateEnd } = resolveDateRange(req.query as Record<string, unknown>);
    if (dateEnd < dateStart) {
      return res.status(400).json({ error: "dateEnd must not be before dateStart" });
    }
    if (inclusiveDayCount(dateStart, dateEnd) > MAX_DATE_RANGE_DAYS) {
      return res.status(400).json({ error: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` });
    }
    const { start, end } = getRangeBoundsUtc(dateStart, dateEnd);

    const { rows } = await pool.query(
      `select distinct a.id, a.name
       from activities a
       where exists (
         select 1
         from time_entries te
         join greenhouse_rows gr on gr.id = te.greenhouse_row_id and gr.deleted_at is null
         join greenhouse_phases gp on gp.id = gr.phase_id and gp.is_active = true
         where gp.land_id = $3
           and te.activity_id = a.id
           and te.entry_type = 'work'
           and te.deleted_at is null
           and (
             (te.ended_at is null and te.started_at < $2)
             or (te.ended_at is not null and te.started_at >= $1 and te.started_at < $2)
           )
       )
       order by a.name`,
      [start, end, landId]
    );
    res.json({ activities: rows.map((r) => ({ id: r.id, name: r.name })) });
  })
);

// TV endpoint — token-authed only, no session. Returns the display's
// published config plus the same live-state shape /live returns, in one
// round trip (configVersion lets the frontend detect a fresh Save/Publish
// without a second poll loop).
router.get(
  "/display/:displayKey/state",
  requireDisplayKey,
  asyncHandler(async (req, res) => {
    const d = req.display!;
    const { start, end } = getRangeBoundsUtc(d.dateStart, d.dateEnd);
    const { sql, values } = buildLiveLandQuery({
      landId: d.landId,
      rangeStart: start,
      rangeEnd: end,
      activityId: d.activityId,
    });
    const { rows } = await pool.query(sql, values);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });

    let activityName: string | null = null;
    if (d.activityId) {
      const a = await pool.query("select name from activities where id = $1", [d.activityId]);
      activityName = a.rows[0]?.name ?? null;
    }

    res.json({
      name: d.name,
      activityId: d.activityId,
      activityName,
      dateStart: d.dateStart,
      dateEnd: d.dateEnd,
      configVersion: d.updatedAt,
      generatedAt: new Date().toISOString(),
      land: redactEmployeeNamesForDisplay(serializeLiveLand(row)),
    });
  })
);

export default router;
