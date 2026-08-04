import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { generateDisplayKey } from "../lib/displayToken";
import { calendarDateInAppTimezone, inclusiveDayCount } from "../lib/timezone";
import { MAX_DATE_RANGE_DAYS } from "./greenhouseLive";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
         gd.is_active, gd.updated_at
  from greenhouse_displays gd
  join greenhouse_lands gl on gl.id = gd.land_id
  left join activities a on a.id = gd.activity_id
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeDisplay(row: any) {
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
  };
}

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`${DISPLAY_SELECT} order by gd.name`);
    res.json({ displays: rows.map(serializeDisplay) });
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
      `insert into greenhouse_displays (name, display_key_hash, land_id, date_start, date_end)
       values ($1, $2, $3, $4, $4)
       returning id`,
      [trimmedName, tokenHash, landId, today]
    );

    const { rows } = await pool.query(`${DISPLAY_SELECT} where gd.id = $1`, [insert.rows[0].id]);
    // token appears in this response body once — never logged, never
    // persisted, never returned by any other route (see displayToken.ts).
    res.status(201).json({ display: serializeDisplay(rows[0]), token });
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
      "update greenhouse_displays set display_key_hash = $1 where id = $2 returning id",
      [tokenHash, id]
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

    const { landId, activityId, dateStart, dateEnd } = req.body as {
      landId?: string;
      activityId?: string | null;
      dateStart?: string;
      dateEnd?: string;
    };

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

    const land = await pool.query("select id from greenhouse_lands where id = $1", [landId]);
    if (!land.rows[0]) return res.status(400).json({ error: "Land not found" });
    if (activityId) {
      const activity = await pool.query("select id from activities where id = $1", [activityId]);
      if (!activity.rows[0]) return res.status(400).json({ error: "Activity not found" });
    }

    const { rows } = await pool.query(
      `update greenhouse_displays
       set land_id = $1, activity_id = $2, date_start = $3, date_end = $4,
           updated_by_employee_id = $5, updated_at = now()
       where id = $6
       returning id`,
      [landId, activityId ?? null, dateStart, dateEnd, req.employee!.id, id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Display not found" });

    const { rows: full } = await pool.query(`${DISPLAY_SELECT} where gd.id = $1`, [id]);
    res.json({ display: serializeDisplay(full[0]) });
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
    res.json({ display: serializeDisplay(full[0]) });
  })
);

export default router;
