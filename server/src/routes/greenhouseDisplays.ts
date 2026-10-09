import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { generateDisplayKey } from "../lib/displayToken";
import { calendarDateInAppTimezone, inclusiveDayCount } from "../lib/timezone";
import { isMapDatePreset, isReportWeek, MapDatePreset, resolveMapPreset, resolveReportingPeriod } from "../lib/displayPeriods";
import { MAX_DATE_RANGE_DAYS } from "./greenhouseLive";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_ROTATIONS = new Set([0, 90, 180, 270]);

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// date_start/date_end are `date` columns — cast to text so node-postgres
// never hands back a JS Date object in their place (see displayAuth.ts's
// identical note; same precedent as scheduled_break_date elsewhere).
const DISPLAY_SELECT = `
  select gd.id, gd.name, gd.land_id, gl.name as land_name,
         gd.activity_id, a.name as activity_name,
         to_char(gd.date_start, 'YYYY-MM-DD') as date_start,
         to_char(gd.date_end, 'YYYY-MM-DD') as date_end,
         gd.is_active, gd.updated_at, gd.rotation_degrees, gd.display_key_plaintext,
         gd.map_date_preset, gd.report_week, gd.report_include_today, gd.map_slide_seconds
  from greenhouse_displays gd
  join greenhouse_lands gl on gl.id = gd.land_id
  left join activities a on a.id = gd.activity_id
`;

// includeToken is false for anyone who isn't an Administrator — the same
// role gate already required to generate/regenerate a link in the first
// place (see requireRole below), so a Manager can see a display's config
// via GET / but never its TV link (036_greenhouse_display_key_plaintext.sql
// — display_key_plaintext is otherwise the raw, still-usable-forever token,
// not something to leak to a role that can't act on it anyway).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeDisplay(row: any, includeToken: boolean) {
  // A relative preset (059_display_slideshow.sql) advances on its own; the
  // stored dates are only what it resolved to at the last publish.
  const effective = row.map_date_preset
    ? resolveMapPreset(row.map_date_preset as MapDatePreset, calendarDateInAppTimezone(new Date()))
    : { dateStart: row.date_start, dateEnd: row.date_end };
  return {
    id: row.id,
    name: row.name,
    landId: row.land_id,
    landName: row.land_name,
    activityId: row.activity_id,
    activityName: row.activity_name,
    dateStart: row.date_start,
    dateEnd: row.date_end,
    isActive: row.is_active,
    updatedAt: row.updated_at,
    rotationDegrees: row.rotation_degrees,
    // null = fixed dates (every display published before presets existed).
    datePreset: (row.map_date_preset as MapDatePreset | null) ?? null,
    effectiveDateStart: effective.dateStart,
    effectiveDateEnd: effective.dateEnd,
    reportWeek: row.report_week,
    reportIncludeToday: row.report_include_today,
    mapSlideSeconds: row.map_slide_seconds,
    // null both when this display predates display_key_plaintext existing
    // (regenerate to get a retrievable one) and whenever includeToken is
    // false — the client only ever renders/copies a full URL built from
    // this, never the bare token on its own.
    tvToken: includeToken ? (row.display_key_plaintext as string | null) : null,
  };
}

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const includeToken = req.employee!.securityRole === "Administrator";
    const { rows } = await pool.query(`${DISPLAY_SELECT} order by gd.name`);
    res.json({ displays: rows.map((r) => serializeDisplay(r, includeToken)) });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { name, landId } = req.body as { name?: string; landId?: string };
    const trimmedName = trimOrNull(name);
    if (!trimmedName) return res.status(400).json({ error: "A display name is required" });
    if (!landId || !UUID_RE.test(landId)) return res.status(400).json({ error: "landId is required" });

    const land = await pool.query("select id from greenhouse_lands where id = $1", [landId]);
    if (!land.rows[0]) return res.status(400).json({ error: "Land not found" });

    const { token, tokenHash } = generateDisplayKey();
    const today = calendarDateInAppTimezone(new Date());

    const insert = await pool.query(
      `insert into greenhouse_displays (name, display_key_hash, display_key_plaintext, land_id, date_start, date_end)
       values ($1, $2, $3, $4, $5, $5)
       returning id`,
      [trimmedName, tokenHash, token, landId, today]
    );

    const { rows } = await pool.query(`${DISPLAY_SELECT} where gd.id = $1`, [insert.rows[0].id]);
    // token is also returned as its own top-level field (unchanged shape) —
    // display.tvToken above carries the identical value now that it's
    // persisted, this is just kept for existing callers that only look at
    // `token`.
    res.status(201).json({ display: serializeDisplay(rows[0], true), token });
  })
);

router.post(
  "/:id/regenerate-key",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid display id" });

    const { token, tokenHash } = generateDisplayKey();
    const { rows } = await pool.query(
      "update greenhouse_displays set display_key_hash = $1, display_key_plaintext = $2 where id = $3 returning id",
      [tokenHash, token, id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Display not found" });

    // Old URL 404s via requireDisplayKey on its very next poll — deliberate,
    // same fail-closed behavior as deactivating a display.
    res.json({ token });
  })
);

router.put(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid display id" });

    const { landId, activityId, rotationDegrees, datePreset } = req.body as {
      landId?: string;
      activityId?: string | null;
      rotationDegrees?: number;
      datePreset?: string | null;
    };
    let { dateStart, dateEnd } = req.body as { dateStart?: string; dateEnd?: string };

    // No preset (absent or null, including any office page from before
    // presets existed) publishes exactly the dates sent, as fixed dates. A
    // preset stores the dates it resolves to today, and the TV re-resolves
    // it on every poll.
    if (datePreset !== undefined && datePreset !== null && !isMapDatePreset(datePreset)) {
      return res.status(400).json({ error: "Invalid datePreset" });
    }
    const preset: MapDatePreset | null = isMapDatePreset(datePreset) ? datePreset : null;
    if (preset) {
      ({ dateStart, dateEnd } = resolveMapPreset(preset, calendarDateInAppTimezone(new Date())));
    }

    if (!landId || !UUID_RE.test(landId)) return res.status(400).json({ error: "landId is required" });
    if (activityId !== null && activityId !== undefined && !UUID_RE.test(activityId)) {
      return res.status(400).json({ error: "Invalid activityId" });
    }
    if (!isValidDate(dateStart) || !isValidDate(dateEnd)) {
      return res.status(400).json({ error: "A valid dateStart and dateEnd are required" });
    }
    if (dateEnd < dateStart) {
      return res.status(400).json({ error: "dateEnd must not be before dateStart" });
    }
    if (inclusiveDayCount(dateStart, dateEnd) > MAX_DATE_RANGE_DAYS) {
      return res.status(400).json({ error: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` });
    }
    const resolvedRotation = rotationDegrees ?? 0;
    if (!ALLOWED_ROTATIONS.has(resolvedRotation)) {
      return res.status(400).json({ error: "rotationDegrees must be 0, 90, 180, or 270" });
    }

    const land = await pool.query("select id from greenhouse_lands where id = $1", [landId]);
    if (!land.rows[0]) return res.status(400).json({ error: "Land not found" });
    if (activityId) {
      const activity = await pool.query("select id from activities where id = $1", [activityId]);
      if (!activity.rows[0]) return res.status(400).json({ error: "Activity not found" });
    }

    const { rows } = await pool.query(
      `update greenhouse_displays
       set land_id = $1, activity_id = $2, date_start = $3, date_end = $4,
           rotation_degrees = $5, updated_by_employee_id = $6, updated_at = now(),
           map_date_preset = $8
       where id = $7
       returning id`,
      [landId, activityId ?? null, dateStart, dateEnd, resolvedRotation, req.employee!.id, id, preset]
    );
    if (!rows[0]) return res.status(404).json({ error: "Display not found" });

    const { rows: full } = await pool.query(`${DISPLAY_SELECT} where gd.id = $1`, [id]);
    res.json({ display: serializeDisplay(full[0], req.employee!.securityRole === "Administrator") });
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid display id" });

    const { isActive } = req.body as { isActive?: boolean };
    if (typeof isActive !== "boolean") return res.status(400).json({ error: "isActive is required" });

    const { rows } = await pool.query(
      "update greenhouse_displays set is_active = $1, updated_at = now() where id = $2 returning id",
      [isActive, id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Display not found" });

    const { rows: full } = await pool.query(`${DISPLAY_SELECT} where gd.id = $1`, [id]);
    res.json({ display: serializeDisplay(full[0], true) });
  })
);

// --- Slideshow settings (059_display_slideshow.sql), per display ---------
//
// One entry per ACTIVE activity, whether or not it has a settings row yet: a
// missing row means "not sent to this TV", with the target defaulting to the
// activity's own normal speed. Same roles as publishing the map (PUT /:id).

const MAX_SLIDE_SECONDS = 600;

async function loadSlidesConfig(displayId: string) {
  const { rows: d } = await pool.query(
    `select id, report_week, report_include_today, map_slide_seconds from greenhouse_displays where id = $1`,
    [displayId]
  );
  if (!d[0]) return null;
  const { rows } = await pool.query(
    `select a.id, a.name, a.speed_unit, a.density_source, a.normal_speed,
            coalesce(s.send_to_tv, false) as send_to_tv, s.target_override,
            coalesce(s.minimum_activity_hours, 0) as minimum_activity_hours,
            s.top_n, coalesce(s.slide_seconds, 15) as slide_seconds
     from activities a
     left join greenhouse_display_activity_slides s on s.activity_id = a.id and s.display_id = $1
     where a.is_active = true
     order by a.sort_order, lower(a.name)`,
    [displayId]
  );
  const today = calendarDateInAppTimezone(new Date());
  return {
    reportWeek: d[0].report_week,
    reportIncludeToday: d[0].report_include_today,
    mapSlideSeconds: d[0].map_slide_seconds,
    period: resolveReportingPeriod(d[0].report_week, d[0].report_include_today, today),
    activities: rows.map((r) => ({
      activityId: r.id,
      name: r.name,
      speedUnit: r.speed_unit,
      densitySource: r.density_source,
      normalSpeed: r.normal_speed != null ? Number(r.normal_speed) : null,
      sendToTv: r.send_to_tv,
      targetOverride: r.target_override != null ? Number(r.target_override) : null,
      minimumActivityHours: Number(r.minimum_activity_hours),
      topN: r.top_n,
      slideSeconds: r.slide_seconds,
    })),
  };
}

router.get(
  "/:id/slides-config",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid display id" });
    const config = await loadSlidesConfig(id);
    if (!config) return res.status(404).json({ error: "Display not found" });
    res.json(config);
  })
);

interface SlideSettingInput {
  activityId?: unknown;
  sendToTv?: unknown;
  targetOverride?: unknown;
  minimumActivityHours?: unknown;
  topN?: unknown;
  slideSeconds?: unknown;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isWholeInRange(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

router.put(
  "/:id/slides-config",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid display id" });
    const { reportWeek, reportIncludeToday, mapSlideSeconds, activities } = req.body as {
      reportWeek?: unknown;
      reportIncludeToday?: unknown;
      mapSlideSeconds?: unknown;
      activities?: SlideSettingInput[];
    };
    if (!isReportWeek(reportWeek)) return res.status(400).json({ error: "reportWeek must be this_week or last_week" });
    if (typeof reportIncludeToday !== "boolean") return res.status(400).json({ error: "reportIncludeToday is required" });
    if (!isWholeInRange(mapSlideSeconds, 5, MAX_SLIDE_SECONDS)) {
      return res.status(400).json({ error: `Map slide duration must be 5–${MAX_SLIDE_SECONDS} seconds` });
    }
    if (!Array.isArray(activities)) return res.status(400).json({ error: "activities must be a list" });

    const settings: {
      activityId: string;
      sendToTv: boolean;
      targetOverride: number | null;
      minimumActivityHours: number;
      topN: number | null;
      slideSeconds: number;
    }[] = [];
    for (const a of activities) {
      if (typeof a.activityId !== "string" || !UUID_RE.test(a.activityId)) return res.status(400).json({ error: "Invalid activityId" });
      if (typeof a.sendToTv !== "boolean") return res.status(400).json({ error: "sendToTv is required" });
      if (a.targetOverride != null && (!isFiniteNumber(a.targetOverride) || a.targetOverride <= 0)) {
        return res.status(400).json({ error: "Target must be a positive number, or empty to use the activity's normal speed" });
      }
      if (!isFiniteNumber(a.minimumActivityHours) || a.minimumActivityHours < 0 || a.minimumActivityHours > 168) {
        return res.status(400).json({ error: "Minimum activity hours must be between 0 and 168" });
      }
      if (a.topN != null && !isWholeInRange(a.topN, 1, 200)) {
        return res.status(400).json({ error: "Top N must be a whole number from 1 to 200, or empty for All" });
      }
      if (!isWholeInRange(a.slideSeconds, 5, MAX_SLIDE_SECONDS)) {
        return res.status(400).json({ error: `Slide duration must be 5–${MAX_SLIDE_SECONDS} seconds` });
      }
      settings.push({
        activityId: a.activityId,
        sendToTv: a.sendToTv,
        targetOverride: (a.targetOverride as number | null | undefined) ?? null,
        minimumActivityHours: a.minimumActivityHours,
        topN: (a.topN as number | null | undefined) ?? null,
        slideSeconds: a.slideSeconds,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query(
        `update greenhouse_displays
         set report_week = $1, report_include_today = $2, map_slide_seconds = $3,
             updated_by_employee_id = $4, updated_at = now()
         where id = $5 returning id`,
        [reportWeek, reportIncludeToday, mapSlideSeconds, req.employee!.id, id]
      );
      if (!updated.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Display not found" });
      }
      const ids = [...new Set(settings.map((x) => x.activityId))];
      if (ids.length) {
        const known = await client.query(`select id from activities where id = any($1::uuid[])`, [ids]);
        if (known.rows.length !== ids.length) {
          await client.query("rollback");
          return res.status(400).json({ error: "Activity not found" });
        }
      }
      for (const x of settings) {
        await client.query(
          `insert into greenhouse_display_activity_slides
             (display_id, activity_id, send_to_tv, target_override, minimum_activity_hours, top_n, slide_seconds,
              updated_by_employee_id, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, now())
           on conflict (display_id, activity_id) do update set
             send_to_tv = excluded.send_to_tv, target_override = excluded.target_override,
             minimum_activity_hours = excluded.minimum_activity_hours, top_n = excluded.top_n,
             slide_seconds = excluded.slide_seconds, updated_by_employee_id = excluded.updated_by_employee_id,
             updated_at = now()`,
          [id, x.activityId, x.sendToTv, x.targetOverride, x.minimumActivityHours, x.topN, x.slideSeconds, req.employee!.id]
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    res.json(await loadSlidesConfig(id));
  })
);

export default router;
