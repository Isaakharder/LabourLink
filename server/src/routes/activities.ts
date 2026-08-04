import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function duplicateFieldFromConstraint(constraint?: string): string | null {
  if (constraint === "activities_name_key" || constraint === "activities_name_normalized_key") {
    return "name";
  }
  return null;
}

interface ActivityFields {
  name: string;
  normalSpeed: number | null;
  speedUnit: string | null;
  minimumDurationMinutes: number;
  isActive: boolean;
}

function validateCreate(body: Record<string, unknown>):
  | { errors: Record<string, string> }
  | { data: ActivityFields } {
  const errors: Record<string, string> = {};

  const name = trimOrNull(body.name);
  if (!name) errors.name = "Activity name is required";

  let normalSpeed: number | null = null;
  if (body.normalSpeed !== undefined && body.normalSpeed !== null && body.normalSpeed !== "") {
    const n = Number(body.normalSpeed);
    if (!Number.isFinite(n) || n <= 0) {
      errors.normalSpeed = "Normal speed must be greater than 0";
    } else {
      normalSpeed = n;
    }
  }

  const speedUnit = trimOrNull(body.speedUnit as string);

  let minimumDurationMinutes = 0;
  if (body.minimumDurationMinutes === undefined || body.minimumDurationMinutes === null || body.minimumDurationMinutes === "") {
    errors.minimumDurationMinutes = "Minimum duration is required";
  } else {
    const n = Number(body.minimumDurationMinutes);
    if (!Number.isInteger(n) || n < 0) {
      errors.minimumDurationMinutes = "Minimum duration must be zero or greater";
    } else {
      minimumDurationMinutes = n;
    }
  }

  if (Object.keys(errors).length) return { errors };

  return {
    data: {
      name: name!,
      normalSpeed,
      speedUnit,
      minimumDurationMinutes,
      isActive: body.isActive === undefined ? true : Boolean(body.isActive),
    },
  };
}

function validateUpdate(body: Record<string, unknown>):
  | { errors: Record<string, string> }
  | { data: Partial<ActivityFields> } {
  const errors: Record<string, string> = {};
  const data: Partial<ActivityFields> = {};

  if ("name" in body) {
    const v = trimOrNull(body.name);
    if (!v) errors.name = "Activity name is required";
    else data.name = v;
  }

  if ("normalSpeed" in body) {
    if (body.normalSpeed === null || body.normalSpeed === "") {
      data.normalSpeed = null;
    } else {
      const n = Number(body.normalSpeed);
      if (!Number.isFinite(n) || n <= 0) {
        errors.normalSpeed = "Normal speed must be greater than 0";
      } else {
        data.normalSpeed = n;
      }
    }
  }

  if ("speedUnit" in body) data.speedUnit = trimOrNull(body.speedUnit as string);

  if ("minimumDurationMinutes" in body) {
    const n = Number(body.minimumDurationMinutes);
    if (!Number.isInteger(n) || n < 0) {
      errors.minimumDurationMinutes = "Minimum duration must be zero or greater";
    } else {
      data.minimumDurationMinutes = n;
    }
  }

  if ("isActive" in body) data.isActive = Boolean(body.isActive);

  if (Object.keys(errors).length) return { errors };
  return { data };
}

const SELECT_COLUMNS = `
  a.id, a.name, a.normal_speed, a.speed_unit, a.minimum_duration_minutes,
  a.is_active, a.sort_order, a.updated_at,
  count(aga.activity_group_id) as assigned_group_count,
  aq.id as question_id, aq.question_type, aq.label as question_label, aq.is_required as question_required
`;

const FROM_JOINS = `
  from activities a
  left join activity_group_activities aga on aga.activity_id = a.id
  left join activity_questions aq on aq.activity_id = a.id
`;

// activity_questions.activity_id is unique (see 014_activity_questions.sql),
// so joining it never fans out a.id's rows the way activity_group_activities
// does — grouping by its columns too (alongside a.id) just satisfies
// Postgres's "every selected column must be grouped or aggregated" rule
// without changing result cardinality.
const GROUP_BY = `group by a.id, aq.id, aq.question_type, aq.label, aq.is_required`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeActivity(row: any) {
  return {
    id: row.id,
    name: row.name,
    normalSpeed: row.normal_speed !== null ? Number(row.normal_speed) : null,
    speedUnit: row.speed_unit,
    minimumDurationMinutes: row.minimum_duration_minutes,
    isActive: row.is_active,
    assignedGroupCount: Number(row.assigned_group_count),
    updatedAt: row.updated_at,
    question: row.question_id
      ? {
          type: row.question_type as "greenhouse_row",
          label: row.question_label as string,
          isRequired: row.question_required as boolean,
        }
      : null,
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

    if (status === "active") conditions.push("a.is_active = true");
    else if (status === "inactive") conditions.push("a.is_active = false");

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`lower(a.name) like $${params.length}`);
    }

    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const { rows } = await pool.query(
      `select ${SELECT_COLUMNS} ${FROM_JOINS} ${where} ${GROUP_BY} order by a.sort_order, a.name`,
      params
    );

    res.json({ activities: rows.map(serializeActivity) });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity id" });

    const { rows } = await pool.query(
      `select ${SELECT_COLUMNS} ${FROM_JOINS} where a.id = $1 ${GROUP_BY}`,
      [id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Activity not found" });
    res.json({ activity: serializeActivity(row) });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const result = validateCreate(req.body ?? {});
    if ("errors" in result) return res.status(400).json({ errors: result.errors });
    const d = result.data;

    try {
      const { rows } = await pool.query(
        `insert into activities (name, normal_speed, speed_unit, minimum_duration_minutes, is_active)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [d.name, d.normalSpeed, d.speedUnit, d.minimumDurationMinutes, d.isActive]
      );

      const { rows: full } = await pool.query(
        `select ${SELECT_COLUMNS} ${FROM_JOINS} where a.id = $1 ${GROUP_BY}`,
        [rows[0].id]
      );
      res.status(201).json({ activity: serializeActivity(full[0]) });
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505") {
        const field = duplicateFieldFromConstraint(pgErr.constraint);
        if (field === "name") {
          return res.status(409).json({ errors: { name: "An activity with this name already exists" } });
        }
        return res.status(409).json({ error: "Duplicate value" });
      }
      throw err;
    }
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity id" });

    const result = validateUpdate(req.body ?? {});
    if ("errors" in result) return res.status(400).json({ errors: result.errors });
    const d = result.data;

    const columnMap: Record<keyof ActivityFields, string> = {
      name: "name",
      normalSpeed: "normal_speed",
      speedUnit: "speed_unit",
      minimumDurationMinutes: "minimum_duration_minutes",
      isActive: "is_active",
    };

    const keys = Object.keys(d) as (keyof ActivityFields)[];
    if (keys.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const setClauses = keys.map((k, i) => `${columnMap[k]} = $${i + 1}`);
    const values = keys.map((k) => d[k]);
    setClauses.push("updated_at = now()");

    try {
      const { rows } = await pool.query(
        `update activities set ${setClauses.join(", ")} where id = $${keys.length + 1} returning id`,
        [...values, id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Activity not found" });

      const { rows: full } = await pool.query(
        `select ${SELECT_COLUMNS} ${FROM_JOINS} where a.id = $1 ${GROUP_BY}`,
        [id]
      );
      res.json({ activity: serializeActivity(full[0]) });
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505") {
        const field = duplicateFieldFromConstraint(pgErr.constraint);
        if (field === "name") {
          return res.status(409).json({ errors: { name: "An activity with this name already exists" } });
        }
        return res.status(409).json({ error: "Duplicate value" });
      }
      throw err;
    }
  })
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeQuestion(row: any) {
  return {
    id: row.id,
    activityId: row.activity_id,
    questionType: row.question_type as "greenhouse_row",
    label: row.label as string,
    isRequired: row.is_required as boolean,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/:id/questions",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity id" });

    const activity = await pool.query("select id from activities where id = $1", [id]);
    if (!activity.rows[0]) return res.status(404).json({ error: "Activity not found" });

    const { rows } = await pool.query(
      "select id, activity_id, question_type, label, is_required, updated_at from activity_questions where activity_id = $1",
      [id]
    );
    res.json({ question: rows[0] ? serializeQuestion(rows[0]) : null });
  })
);

router.put(
  "/:id/questions",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity id" });

    const activity = await pool.query("select id from activities where id = $1", [id]);
    if (!activity.rows[0]) return res.status(404).json({ error: "Activity not found" });

    const body = (req.body ?? {}) as { enabled?: boolean; label?: string; isRequired?: boolean };

    if (!body.enabled) {
      await pool.query("delete from activity_questions where activity_id = $1", [id]);
      return res.json({ question: null });
    }

    const label = trimOrNull(body.label) || "Where?";
    const isRequired = body.isRequired === undefined ? true : Boolean(body.isRequired);

    const { rows } = await pool.query(
      `insert into activity_questions (activity_id, question_type, label, is_required)
       values ($1, 'greenhouse_row', $2, $3)
       on conflict (activity_id) do update
         set label = excluded.label, is_required = excluded.is_required, updated_at = now()
       returning id, activity_id, question_type, label, is_required, updated_at`,
      [id, label, isRequired]
    );
    res.json({ question: serializeQuestion(rows[0]) });
  })
);

export default router;
