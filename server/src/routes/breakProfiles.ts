import { PoolClient } from "pg";
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  isRoundingDirection,
  isValidRoundingIntervalMinutes,
  MAX_ROUNDING_INTERVAL_MINUTES,
  MIN_ROUNDING_INTERVAL_MINUTES,
  RoundingDirection,
} from "../lib/workStartRounding";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function duplicateFieldFromConstraint(constraint?: string): string | null {
  if (constraint === "break_profiles_name_key" || constraint === "break_profiles_name_normalized_key") {
    return "name";
  }
  return null;
}

// "HH:MM" or "HH:MM:SS" -> normalized "HH:MM:SS", or null if not a valid
// time-of-day string.
function normalizeTime(v: unknown): string | null {
  if (typeof v !== "string" || !TIME_RE.test(v)) return null;
  return v.length === 5 ? `${v}:00` : v;
}

interface ItemInput {
  // Present and matching an existing active row on this profile -> update
  // that row in place. Absent, or not a match, -> insert a new row (using
  // this id if it's a validly-formed one — the client always generates a
  // real uuid for new rows too, see BreakProfileEditor's blankItem()).
  id: string | null;
  name: string | null;
  startTime: string;
  endTime: string;
  isPaid: boolean;
  fixedBreak: boolean;
  autoAdd: boolean;
  fixedStartWindowMinutes: number;
  fixedEndWindowMinutes: number;
}

// Validates a full scheduled-break list: at least one row, each with a
// valid start/end (end after start), no duplicate identical (start, end)
// pairs within the submitted set. Overlap between rows is intentionally not
// rejected here — the desktop builder only warns about it; profiles with
// overlapping items are a legitimate (if unusual) configuration.
function validateItems(raw: unknown): { error: string } | { items: ItemInput[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "At least one scheduled break is required" };
  }

  const items: ItemInput[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const it = (raw[i] ?? {}) as Record<string, unknown>;
    const startTime = normalizeTime(it.startTime);
    const endTime = normalizeTime(it.endTime);
    if (!startTime || !endTime) {
      return { error: `Scheduled break ${i + 1}: a valid start and end time are required` };
    }
    if (endTime <= startTime) {
      return { error: `Scheduled break ${i + 1}: end time must be after start time` };
    }

    const key = `${startTime}-${endTime}`;
    if (seen.has(key)) {
      return { error: `Scheduled break ${i + 1}: duplicate schedule (same start and end time as another row)` };
    }
    seen.add(key);

    const fixedStartWindowMinutes =
      it.fixedStartWindowMinutes != null ? Number(it.fixedStartWindowMinutes) : 10;
    const fixedEndWindowMinutes = it.fixedEndWindowMinutes != null ? Number(it.fixedEndWindowMinutes) : 10;
    if (!Number.isInteger(fixedStartWindowMinutes) || fixedStartWindowMinutes < 0) {
      return { error: `Scheduled break ${i + 1}: fixed start window must be a non-negative whole number` };
    }
    if (!Number.isInteger(fixedEndWindowMinutes) || fixedEndWindowMinutes < 0) {
      return { error: `Scheduled break ${i + 1}: fixed end window must be a non-negative whole number` };
    }

    const id = typeof it.id === "string" && UUID_RE.test(it.id) ? it.id : null;

    items.push({
      id,
      name: trimOrNull(it.name as string),
      startTime,
      endTime,
      isPaid: Boolean(it.isPaid),
      fixedBreak: Boolean(it.fixedBreak),
      autoAdd: Boolean(it.autoAdd),
      fixedStartWindowMinutes,
      fixedEndWindowMinutes,
    });
  }

  return { items };
}

// Upserts the submitted schedule by id instead of replacing it wholesale:
// time_entries.break_profile_item_id references this table with no ON
// DELETE action, so a blind delete-all-then-reinsert (the pattern used for
// plain join tables like activity_group_activities) would throw a foreign
// key violation on every edit after the first break has ever been recorded
// against any item in the profile. Existing rows keep their id (and so stay
// valid FK targets for history already recorded against them); anything
// dropped from the submitted set is soft-deactivated, never hard-deleted.
//
// Note: the (break_profile_id, start_time, end_time) uniqueness is a plain
// (non-deferrable) partial unique index — Postgres has no deferrable
// partial-unique-constraint form — so an edit that swaps two existing rows'
// times exactly (not just reorders them) can transiently collide mid-loop
// and fail with a 23505 the admin would need to retry in two steps. Not
// worth engineering around for how rarely that exact edit pattern happens.
async function upsertItems(client: PoolClient, breakProfileId: string, items: ItemInput[]) {
  const { rows: currentRows } = await client.query(
    `select id from break_profile_items where break_profile_id = $1 and is_active = true`,
    [breakProfileId]
  );
  const currentIds = new Set(currentRows.map((r) => r.id as string));
  const keptIds = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.id && currentIds.has(it.id)) {
      keptIds.add(it.id);
      await client.query(
        `update break_profile_items
         set name = $1, start_time = $2, end_time = $3, is_paid = $4, fixed_break = $5, auto_add = $6,
             fixed_start_window_minutes = $7, fixed_end_window_minutes = $8, sort_order = $9, updated_at = now()
         where id = $10`,
        [
          it.name,
          it.startTime,
          it.endTime,
          it.isPaid,
          it.fixedBreak,
          it.autoAdd,
          it.fixedStartWindowMinutes,
          it.fixedEndWindowMinutes,
          i,
          it.id,
        ]
      );
    } else {
      const { rows } = await client.query(
        `insert into break_profile_items
           (id, break_profile_id, name, start_time, end_time, is_paid, fixed_break, auto_add,
            fixed_start_window_minutes, fixed_end_window_minutes, sort_order)
         values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id`,
        [
          it.id,
          breakProfileId,
          it.name,
          it.startTime,
          it.endTime,
          it.isPaid,
          it.fixedBreak,
          it.autoAdd,
          it.fixedStartWindowMinutes,
          it.fixedEndWindowMinutes,
          i,
        ]
      );
      keptIds.add(rows[0].id as string);
    }
  }

  const removedIds = [...currentIds].filter((id) => !keptIds.has(id));
  if (removedIds.length) {
    await client.query(
      `update break_profile_items set is_active = false, updated_at = now() where id = any($1::uuid[])`,
      [removedIds]
    );
  }
}

const LIST_SELECT = `
  select bp.id, bp.name, bp.description, bp.is_active, bp.created_at, bp.updated_at,
         bp.work_start_rounding_enabled, bp.work_start_rounding_direction,
         bp.work_start_rounding_interval_minutes,
         bp.work_end_rounding_enabled, bp.work_end_rounding_direction,
         bp.work_end_rounding_interval_minutes,
         coalesce(items.items, '[]'::json) as items,
         coalesce(items.item_count, 0) as item_count,
         coalesce(emp.employee_count, 0) as assigned_employee_count
  from break_profiles bp
  left join lateral (
    select json_agg(json_build_object(
             'id', bpi.id,
             'name', bpi.name,
             'startTime', to_char(bpi.start_time, 'HH24:MI:SS'),
             'endTime', to_char(bpi.end_time, 'HH24:MI:SS'),
             'isPaid', bpi.is_paid,
             'fixedBreak', bpi.fixed_break,
             'autoAdd', bpi.auto_add,
             'fixedStartWindowMinutes', bpi.fixed_start_window_minutes,
             'fixedEndWindowMinutes', bpi.fixed_end_window_minutes,
             'sortOrder', bpi.sort_order,
             'durationSeconds', extract(epoch from (bpi.end_time - bpi.start_time))::int
           ) order by bpi.sort_order) as items,
           count(*) as item_count
    from break_profile_items bpi
    where bpi.break_profile_id = bp.id and bpi.is_active = true
  ) items on true
  left join lateral (
    select count(*) as employee_count
    from employees e
    where e.break_profile_id = bp.id
  ) emp on true
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeBreakProfile(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    workStartRoundingEnabled: row.work_start_rounding_enabled,
    workStartRoundingDirection: row.work_start_rounding_direction,
    workStartRoundingIntervalMinutes: row.work_start_rounding_interval_minutes,
    workEndRoundingEnabled: row.work_end_rounding_enabled,
    workEndRoundingDirection: row.work_end_rounding_direction,
    workEndRoundingIntervalMinutes: row.work_end_rounding_interval_minutes,
    items: row.items,
    itemCount: Number(row.item_count),
    assignedEmployeeCount: Number(row.assigned_employee_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const search = trimOrNull(req.query.search as string);
    const status = (req.query.status as string) || "all";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status === "active") conditions.push("bp.is_active = true");
    else if (status === "inactive") conditions.push("bp.is_active = false");

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`lower(bp.name) like $${params.length}`);
    }

    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const { rows } = await pool.query(`${LIST_SELECT} ${where} order by bp.name`, params);
    res.json({ breakProfiles: rows.map(serializeBreakProfile) });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid break profile id" });

    const { rows } = await pool.query(`${LIST_SELECT} where bp.id = $1`, [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Break profile not found" });

    res.json({ breakProfile: serializeBreakProfile(row) });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const name = trimOrNull(req.body?.name);
    const errors: Record<string, string> = {};
    if (!name) errors.name = "Profile name is required";

    const itemsResult = validateItems(req.body?.items);
    if ("error" in itemsResult) errors.items = itemsResult.error;

    // Work-start rounding — optional on create, same "absent means use the
    // column default" convention as isActive below. Whenever a direction or
    // interval IS supplied, it's validated the same way regardless of
    // whether rounding is actually enabled — an admin can save a chosen
    // direction/interval before flipping the enabled switch on without
    // losing them, so an invalid one is always rejected, not silently
    // ignored just because rounding is currently off.
    const rawDirection = req.body?.workStartRoundingDirection;
    if (rawDirection !== undefined && !isRoundingDirection(rawDirection)) {
      errors.workStartRoundingDirection = "Direction must be 'clockwise' or 'counter_clockwise'";
    }
    const workStartRoundingDirection: RoundingDirection = isRoundingDirection(rawDirection) ? rawDirection : "clockwise";

    const rawInterval = req.body?.workStartRoundingIntervalMinutes;
    let workStartRoundingIntervalMinutes = 5;
    if (rawInterval !== undefined) {
      const n = Number(rawInterval);
      if (!isValidRoundingIntervalMinutes(n)) {
        errors.workStartRoundingIntervalMinutes = `Interval must be a whole number of minutes between ${MIN_ROUNDING_INTERVAL_MINUTES} and ${MAX_ROUNDING_INTERVAL_MINUTES}`;
      } else {
        workStartRoundingIntervalMinutes = n;
      }
    }

    // Work-end rounding — independent of work-start rounding above (its own
    // enabled/direction/interval, never coupled), same optional-on-create
    // and "validate whenever supplied, regardless of whether enabled"
    // conventions.
    const rawEndDirection = req.body?.workEndRoundingDirection;
    if (rawEndDirection !== undefined && !isRoundingDirection(rawEndDirection)) {
      errors.workEndRoundingDirection = "Direction must be 'clockwise' or 'counter_clockwise'";
    }
    const workEndRoundingDirection: RoundingDirection = isRoundingDirection(rawEndDirection) ? rawEndDirection : "clockwise";

    const rawEndInterval = req.body?.workEndRoundingIntervalMinutes;
    let workEndRoundingIntervalMinutes = 5;
    if (rawEndInterval !== undefined) {
      const n = Number(rawEndInterval);
      if (!isValidRoundingIntervalMinutes(n)) {
        errors.workEndRoundingIntervalMinutes = `Interval must be a whole number of minutes between ${MIN_ROUNDING_INTERVAL_MINUTES} and ${MAX_ROUNDING_INTERVAL_MINUTES}`;
      } else {
        workEndRoundingIntervalMinutes = n;
      }
    }

    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const items = (itemsResult as { items: ItemInput[] }).items;

    const description = trimOrNull(req.body?.description);
    const isActive = req.body?.isActive === undefined ? true : Boolean(req.body.isActive);
    const workStartRoundingEnabled = Boolean(req.body?.workStartRoundingEnabled);
    const workEndRoundingEnabled = Boolean(req.body?.workEndRoundingEnabled);

    const client = await pool.connect();
    try {
      await client.query("begin");

      let profileId: string;
      try {
        const { rows } = await client.query(
          `insert into break_profiles
             (name, description, is_active, work_start_rounding_enabled,
              work_start_rounding_direction, work_start_rounding_interval_minutes,
              work_end_rounding_enabled, work_end_rounding_direction, work_end_rounding_interval_minutes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            name,
            description,
            isActive,
            workStartRoundingEnabled,
            workStartRoundingDirection,
            workStartRoundingIntervalMinutes,
            workEndRoundingEnabled,
            workEndRoundingDirection,
            workEndRoundingIntervalMinutes,
          ]
        );
        profileId = rows[0].id;
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === "23505" && duplicateFieldFromConstraint(pgErr.constraint) === "name") {
          await client.query("rollback");
          return res.status(409).json({ errors: { name: "A break profile with this name already exists" } });
        }
        throw err;
      }

      await upsertItems(client, profileId, items);

      await client.query("commit");

      const { rows: full } = await pool.query(`${LIST_SELECT} where bp.id = $1`, [profileId]);
      res.status(201).json({ breakProfile: serializeBreakProfile(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid break profile id" });

    const body = req.body ?? {};
    const errors: Record<string, string> = {};

    let name: string | null | undefined;
    if ("name" in body) {
      name = trimOrNull(body.name);
      if (!name) errors.name = "Profile name is required";
    }

    let items: ItemInput[] | undefined;
    if ("items" in body) {
      const result = validateItems(body.items);
      if ("error" in result) errors.items = result.error;
      else items = result.items;
    }

    // Work-start rounding — each of the three fields is independently
    // optional, same "if present in body, validate and apply; if absent,
    // leave the existing column untouched" convention as description/
    // isActive below (the desktop editor always sends all three together,
    // but the route itself doesn't require that).
    let workStartRoundingDirection: RoundingDirection | undefined;
    if ("workStartRoundingDirection" in body) {
      if (!isRoundingDirection(body.workStartRoundingDirection)) {
        errors.workStartRoundingDirection = "Direction must be 'clockwise' or 'counter_clockwise'";
      } else {
        workStartRoundingDirection = body.workStartRoundingDirection;
      }
    }
    let workStartRoundingIntervalMinutes: number | undefined;
    if ("workStartRoundingIntervalMinutes" in body) {
      const n = Number(body.workStartRoundingIntervalMinutes);
      if (!isValidRoundingIntervalMinutes(n)) {
        errors.workStartRoundingIntervalMinutes = `Interval must be a whole number of minutes between ${MIN_ROUNDING_INTERVAL_MINUTES} and ${MAX_ROUNDING_INTERVAL_MINUTES}`;
      } else {
        workStartRoundingIntervalMinutes = n;
      }
    }

    // Work-end rounding — each field independently optional, same
    // "present in body -> validate and apply; absent -> leave the existing
    // column untouched" convention as work-start rounding above. Never
    // coupled to it: an admin can change one without the other.
    let workEndRoundingDirection: RoundingDirection | undefined;
    if ("workEndRoundingDirection" in body) {
      if (!isRoundingDirection(body.workEndRoundingDirection)) {
        errors.workEndRoundingDirection = "Direction must be 'clockwise' or 'counter_clockwise'";
      } else {
        workEndRoundingDirection = body.workEndRoundingDirection;
      }
    }
    let workEndRoundingIntervalMinutes: number | undefined;
    if ("workEndRoundingIntervalMinutes" in body) {
      const n = Number(body.workEndRoundingIntervalMinutes);
      if (!isValidRoundingIntervalMinutes(n)) {
        errors.workEndRoundingIntervalMinutes = `Interval must be a whole number of minutes between ${MIN_ROUNDING_INTERVAL_MINUTES} and ${MAX_ROUNDING_INTERVAL_MINUTES}`;
      } else {
        workEndRoundingIntervalMinutes = n;
      }
    }

    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const columns: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      values.push(name);
      columns.push(`name = $${values.length}`);
    }
    if ("workStartRoundingEnabled" in body) {
      values.push(Boolean(body.workStartRoundingEnabled));
      columns.push(`work_start_rounding_enabled = $${values.length}`);
    }
    if (workStartRoundingDirection !== undefined) {
      values.push(workStartRoundingDirection);
      columns.push(`work_start_rounding_direction = $${values.length}`);
    }
    if (workStartRoundingIntervalMinutes !== undefined) {
      values.push(workStartRoundingIntervalMinutes);
      columns.push(`work_start_rounding_interval_minutes = $${values.length}`);
    }
    if ("workEndRoundingEnabled" in body) {
      values.push(Boolean(body.workEndRoundingEnabled));
      columns.push(`work_end_rounding_enabled = $${values.length}`);
    }
    if (workEndRoundingDirection !== undefined) {
      values.push(workEndRoundingDirection);
      columns.push(`work_end_rounding_direction = $${values.length}`);
    }
    if (workEndRoundingIntervalMinutes !== undefined) {
      values.push(workEndRoundingIntervalMinutes);
      columns.push(`work_end_rounding_interval_minutes = $${values.length}`);
    }
    if ("description" in body) {
      values.push(trimOrNull(body.description));
      columns.push(`description = $${values.length}`);
    }
    if ("isActive" in body) {
      values.push(Boolean(body.isActive));
      columns.push(`is_active = $${values.length}`);
    }
    columns.push("updated_at = now()");

    const client = await pool.connect();
    try {
      await client.query("begin");

      try {
        values.push(id);
        const { rows } = await client.query(
          `update break_profiles set ${columns.join(", ")} where id = $${values.length} returning id`,
          values
        );
        if (!rows[0]) {
          await client.query("rollback");
          return res.status(404).json({ error: "Break profile not found" });
        }
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === "23505" && duplicateFieldFromConstraint(pgErr.constraint) === "name") {
          await client.query("rollback");
          return res.status(409).json({ errors: { name: "A break profile with this name already exists" } });
        }
        throw err;
      }

      // items absent from the body means "leave the schedule untouched" —
      // e.g. a plain active/inactive toggle shouldn't require resending
      // every row. Present means the submitted list becomes the new
      // schedule, reconciled by id via upsertItems (see its own comment for
      // why this can't be a blind delete-then-reinsert like
      // activity_group_activities in activityGroups.ts).
      if (items) {
        await upsertItems(client, id, items);
      }

      await client.query("commit");

      const { rows: full } = await pool.query(`${LIST_SELECT} where bp.id = $1`, [id]);
      res.json({ breakProfile: serializeBreakProfile(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

export default router;
