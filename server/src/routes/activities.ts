import { PoolClient } from "pg";
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUESTION_TYPES = ["greenhouse_row", "carrier"] as const;
type QuestionType = (typeof QUESTION_TYPES)[number];

const DENSITY_SOURCES = ["plants", "stems"] as const;
type DensitySource = (typeof DENSITY_SOURCES)[number];
const DEFAULT_LABEL: Record<QuestionType, string> = {
  greenhouse_row: "Where?",
  carrier: "Which Carrier?",
};

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
  // Which row density (plant_densities.type, see 023/024) this activity's
  // calculated speed is driven by — null means no calculated speed at all,
  // just the configured normalSpeed above. Never linked to a specific
  // density record: resolved per-row at work-entry time (mobileTime.ts).
  densitySource: DensitySource | null;
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

  let densitySource: DensitySource | null = null;
  if (body.densitySource !== undefined && body.densitySource !== null && body.densitySource !== "") {
    if (!DENSITY_SOURCES.includes(body.densitySource as DensitySource)) {
      errors.densitySource = "Density source must be 'plants' or 'stems'";
    } else {
      densitySource = body.densitySource as DensitySource;
    }
  }

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
      densitySource,
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

  if ("densitySource" in body) {
    if (body.densitySource === null || body.densitySource === "") {
      data.densitySource = null;
    } else if (!DENSITY_SOURCES.includes(body.densitySource as DensitySource)) {
      errors.densitySource = "Density source must be 'plants' or 'stems'";
    } else {
      data.densitySource = body.densitySource as DensitySource;
    }
  }

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

// ---------------------------------------------------------------------------
// Ordered questions — shared by POST/PATCH /api/activities (the create/edit
// modal's own "Questions" section) and PUT /:id/questions (the standalone
// "Activity Questions" button's editor). One validate function, one upsert
// function: both entry points end up calling exactly the same code, per the
// "do not maintain two separate implementations" requirement.
// ---------------------------------------------------------------------------

interface QuestionInput {
  // Present and matching an existing active row on this activity -> update
  // that row in place. Absent, or not a match, -> insert a new row (using
  // this id if it's a validly-formed one — the client always generates a
  // real uuid for new rows too, matching BreakProfileEditor's convention).
  id: string | null;
  questionType: QuestionType;
  label: string;
  isRequired: boolean;
}

// Validates a full ordered question list: each entry has a supported type
// and non-empty label, and — "duplicate question types may be rejected for
// now unless there is a clear use case" — no two entries share a type,
// since asking "Where?" twice for the same activity has no defined meaning
// yet. An empty array is valid (zero questions).
function validateQuestions(raw: unknown): { error: string } | { questions: QuestionInput[] } {
  if (raw === undefined) return { questions: [] };
  if (!Array.isArray(raw)) return { error: "Questions must be a list" };

  const questions: QuestionInput[] = [];
  const seenTypes = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const q = (raw[i] ?? {}) as Record<string, unknown>;
    const questionType = q.questionType as string;
    if (!QUESTION_TYPES.includes(questionType as QuestionType)) {
      return { error: `Question ${i + 1}: unsupported question type` };
    }
    if (seenTypes.has(questionType)) {
      return { error: `Question ${i + 1}: this activity already has a question of this type` };
    }
    seenTypes.add(questionType);

    const label = trimOrNull(q.label as string) || DEFAULT_LABEL[questionType as QuestionType];
    const id = typeof q.id === "string" && UUID_RE.test(q.id) ? q.id : null;

    questions.push({
      id,
      questionType: questionType as QuestionType,
      label,
      isRequired: q.isRequired === undefined ? true : Boolean(q.isRequired),
    });
  }

  return { questions };
}

// Same upsert-by-id + soft-deactivate shape as break_profiles.ts's
// upsertItems — see that function's comment for why a blind
// delete-then-reinsert isn't used: a future generic answer-history table
// could reference activity_questions.id, and hard-deleting a question that
// already has answers recorded against it would orphan them.
async function upsertQuestions(client: PoolClient, activityId: string, questions: QuestionInput[]) {
  const { rows: currentRows } = await client.query(
    `select id from activity_questions where activity_id = $1 and is_active = true`,
    [activityId]
  );
  const currentIds = new Set(currentRows.map((r) => r.id as string));
  const keptIds = new Set<string>();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q.id && currentIds.has(q.id)) {
      keptIds.add(q.id);
      await client.query(
        `update activity_questions
         set question_type = $1, label = $2, is_required = $3, sort_order = $4, updated_at = now()
         where id = $5`,
        [q.questionType, q.label, q.isRequired, i, q.id]
      );
    } else {
      const { rows } = await client.query(
        `insert into activity_questions (id, activity_id, question_type, label, is_required, sort_order)
         values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6)
         returning id`,
        [q.id, activityId, q.questionType, q.label, q.isRequired, i]
      );
      keptIds.add(rows[0].id as string);
    }
  }

  const removedIds = [...currentIds].filter((id) => !keptIds.has(id));
  if (removedIds.length) {
    await client.query(`update activity_questions set is_active = false, updated_at = now() where id = any($1::uuid[])`, [
      removedIds,
    ]);
  }
}

const SELECT_COLUMNS = `
  a.id, a.name, a.normal_speed, a.speed_unit, a.minimum_duration_minutes,
  a.is_active, a.sort_order, a.updated_at, a.density_source,
  coalesce(grp.assigned_group_count, 0) as assigned_group_count,
  coalesce(q.questions, '[]'::json) as questions
`;

// Both child rowsets are pulled in via LATERAL, each already collapsed to
// at most one row per activity by its own aggregate — unlike a plain JOIN
// to activity_group_activities (which would fan out and require a GROUP
// BY), this needs no GROUP BY at all. That matters here specifically
// because json_agg produces a plain `json` value, and plain `json` has no
// equality operator for Postgres to GROUP BY on (jsonb would; json
// wouldn't) — a GROUP BY on this shape would fail outright, not just be
// redundant.
const FROM_JOINS = `
  from activities a
  left join lateral (
    select count(*) as assigned_group_count
    from activity_group_activities aga
    where aga.activity_id = a.id
  ) grp on true
  left join lateral (
    select json_agg(json_build_object(
             'id', aq.id,
             'questionType', aq.question_type,
             'label', aq.label,
             'isRequired', aq.is_required,
             'sortOrder', aq.sort_order
           ) order by aq.sort_order) as questions
    from activity_questions aq
    where aq.activity_id = a.id and aq.is_active = true
  ) q on true
`;

const GROUP_BY = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeActivity(row: any) {
  return {
    id: row.id,
    name: row.name,
    normalSpeed: row.normal_speed !== null ? Number(row.normal_speed) : null,
    speedUnit: row.speed_unit,
    minimumDurationMinutes: row.minimum_duration_minutes,
    isActive: row.is_active,
    densitySource: row.density_source,
    assignedGroupCount: Number(row.assigned_group_count),
    updatedAt: row.updated_at,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    questions: (row.questions as any[]).map((q) => ({
      id: q.id,
      questionType: q.questionType as QuestionType,
      label: q.label as string,
      isRequired: q.isRequired as boolean,
      sortOrder: q.sortOrder as number,
    })),
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

    const { rows } = await pool.query(`select ${SELECT_COLUMNS} ${FROM_JOINS} where a.id = $1 ${GROUP_BY}`, [id]);
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
    const questionsResult = validateQuestions(req.body?.questions);
    const errors: Record<string, string> = "errors" in result ? result.errors : {};
    if ("error" in questionsResult) errors.questions = questionsResult.error;
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const d = (result as { data: ActivityFields }).data;
    const questions = (questionsResult as { questions: QuestionInput[] }).questions;

    const client = await pool.connect();
    try {
      await client.query("begin");

      let activityId: string;
      try {
        const { rows } = await client.query(
          `insert into activities (name, normal_speed, speed_unit, minimum_duration_minutes, is_active, density_source)
           values ($1, $2, $3, $4, $5, $6)
           returning id`,
          [d.name, d.normalSpeed, d.speedUnit, d.minimumDurationMinutes, d.isActive, d.densitySource]
        );
        activityId = rows[0].id;
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === "23505") {
          await client.query("rollback");
          const field = duplicateFieldFromConstraint(pgErr.constraint);
          if (field === "name") {
            return res.status(409).json({ errors: { name: "An activity with this name already exists" } });
          }
          return res.status(409).json({ error: "Duplicate value" });
        }
        throw err;
      }

      await upsertQuestions(client, activityId, questions);

      await client.query("commit");

      const { rows: full } = await pool.query(`select ${SELECT_COLUMNS} ${FROM_JOINS} where a.id = $1 ${GROUP_BY}`, [
        activityId,
      ]);
      res.status(201).json({ activity: serializeActivity(full[0]) });
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
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity id" });

    const result = validateUpdate(req.body ?? {});
    const hasQuestions = "questions" in (req.body ?? {});
    const questionsResult = hasQuestions ? validateQuestions(req.body.questions) : null;
    const errors: Record<string, string> = "errors" in result ? result.errors : {};
    if (questionsResult && "error" in questionsResult) errors.questions = questionsResult.error;
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const d = (result as { data: Partial<ActivityFields> }).data;

    const columnMap: Record<keyof ActivityFields, string> = {
      name: "name",
      normalSpeed: "normal_speed",
      speedUnit: "speed_unit",
      minimumDurationMinutes: "minimum_duration_minutes",
      isActive: "is_active",
      densitySource: "density_source",
    };

    const keys = Object.keys(d) as (keyof ActivityFields)[];
    if (keys.length === 0 && !hasQuestions) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      if (keys.length > 0) {
        const setClauses = keys.map((k, i) => `${columnMap[k]} = $${i + 1}`);
        const values = keys.map((k) => d[k]);
        setClauses.push("updated_at = now()");

        try {
          values.push(id);
          const { rows } = await client.query(
            `update activities set ${setClauses.join(", ")} where id = $${keys.length + 1} returning id`,
            values
          );
          if (!rows[0]) {
            await client.query("rollback");
            return res.status(404).json({ error: "Activity not found" });
          }
        } catch (err) {
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === "23505") {
            await client.query("rollback");
            const field = duplicateFieldFromConstraint(pgErr.constraint);
            if (field === "name") {
              return res.status(409).json({ errors: { name: "An activity with this name already exists" } });
            }
            return res.status(409).json({ error: "Duplicate value" });
          }
          throw err;
        }
      } else {
        const exists = await client.query("select id from activities where id = $1", [id]);
        if (!exists.rows[0]) {
          await client.query("rollback");
          return res.status(404).json({ error: "Activity not found" });
        }
      }

      // questions absent from the body means "leave the question list
      // untouched" — e.g. a plain active/inactive toggle from the table's
      // Activate/Deactivate button shouldn't require resending every
      // question. Present (including an empty array, meaning "no
      // questions") replaces the list, reconciled by id via upsertQuestions.
      if (hasQuestions) {
        await upsertQuestions(client, id, (questionsResult as { questions: QuestionInput[] }).questions);
      }

      await client.query("commit");

      const { rows: full } = await pool.query(`select ${SELECT_COLUMNS} ${FROM_JOINS} where a.id = $1 ${GROUP_BY}`, [
        id,
      ]);
      res.json({ activity: serializeActivity(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

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
      `select id, activity_id, question_type, label, is_required, sort_order
       from activity_questions where activity_id = $1 and is_active = true
       order by sort_order`,
      [id]
    );
    res.json({
      questions: rows.map((r) => ({
        id: r.id,
        questionType: r.question_type as QuestionType,
        label: r.label as string,
        isRequired: r.is_required as boolean,
        sortOrder: r.sort_order as number,
      })),
    });
  })
);

// Standalone "Activity Questions" button's editor — same validate/upsert
// code as POST/PATCH /api/activities above, just scoped to only the
// question list (the rest of the activity's fields are untouched).
router.put(
  "/:id/questions",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity id" });

    const activity = await pool.query("select id from activities where id = $1", [id]);
    if (!activity.rows[0]) return res.status(404).json({ error: "Activity not found" });

    const questionsResult = validateQuestions(req.body?.questions ?? []);
    if ("error" in questionsResult) return res.status(400).json({ error: questionsResult.error });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await upsertQuestions(client, id, questionsResult.questions);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `select id, activity_id, question_type, label, is_required, sort_order
       from activity_questions where activity_id = $1 and is_active = true
       order by sort_order`,
      [id]
    );
    res.json({
      questions: rows.map((r) => ({
        id: r.id,
        questionType: r.question_type as QuestionType,
        label: r.label as string,
        isRequired: r.is_required as boolean,
        sortOrder: r.sort_order as number,
      })),
    });
  })
);

export default router;
