// Activity/question/row/carrier selection rules shared between the mobile
// employee-facing flow (server/src/routes/mobileTime.ts) and the desktop
// administrator manual-entry flow (server/src/routes/inputs.ts's POST
// /activities and /work-start). Extracted so both call the exact same
// validation instead of the admin path re-deriving a "close enough" second
// implementation — the risk with two independent copies of "which
// activities can this employee log, and what do its questions require" is
// that they drift, and an admin-created entry could end up valid by one
// set of rules but not the other.
import { Pool, PoolClient } from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Either a plain pool connection or a client already inside a transaction —
// every function here just needs `.query()`, so callers can pass whichever
// they already have (mobileTime.ts's openEntry runs inside a transaction;
// the admin GET endpoints below don't need one).
type Queryable = Pick<Pool | PoolClient, "query">;

export interface ActivityQuestionOption {
  id: string;
  questionType: "greenhouse_row" | "carrier";
  label: string;
  isRequired: boolean;
}

export interface EmployeeActivityOption {
  id: string;
  name: string;
  normalSpeed: number | null;
  speedUnit: string | null;
  questions: ActivityQuestionOption[];
}

// Every active activity in one of the employee's currently active group
// assignments, each with its own ordered question list — the complete set
// a picker (mobile or admin) should offer, and the complete set the server
// treats as "this employee may legitimately log this." An employee (or a
// day being backfilled for one) with no active group assignment gets an
// empty list, never a fallback to "every activity" — the group assignment
// is what defines "available," not just "exists."
export async function loadEmployeeActivitiesWithQuestions(
  db: Queryable,
  employeeId: string
): Promise<{ activities: EmployeeActivityOption[]; activityGroups: { id: string; name: string }[] }> {
  const groupRows = await db.query(
    `select ag.id, ag.name
     from employee_activity_group_assignments eaga
     join activity_groups ag on ag.id = eaga.activity_group_id and ag.is_active = true
     where eaga.employee_id = $1 and eaga.unassigned_at is null
     order by ag.name`,
    [employeeId]
  );
  const groups = groupRows.rows as { id: string; name: string }[];
  if (groups.length === 0) {
    return { activities: [], activityGroups: [] };
  }

  const { rows } = await db.query(
    `select a.id, a.name, a.normal_speed, a.speed_unit, a.sort_order,
            coalesce(q.questions, '[]'::json) as questions
     from (
       select distinct aga.activity_id
       from activity_group_activities aga
       where aga.activity_group_id = any($1::uuid[])
     ) x
     join activities a on a.id = x.activity_id and a.is_active = true
     left join lateral (
       select json_agg(json_build_object(
                'id', aq.id, 'questionType', aq.question_type,
                'label', aq.label, 'isRequired', aq.is_required
              ) order by aq.sort_order) as questions
       from activity_questions aq
       where aq.activity_id = a.id and aq.is_active = true
     ) q on true
     order by a.sort_order, a.name`,
    [groups.map((g) => g.id)]
  );

  return {
    // pg returns numeric columns as strings — cast explicitly, same as
    // server/src/routes/activities.ts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activities: (rows as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      normalSpeed: r.normal_speed !== null ? Number(r.normal_speed) : null,
      speedUnit: r.speed_unit,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      questions: (r.questions as any[]).map((q) => ({
        id: q.id,
        questionType: q.questionType as "greenhouse_row" | "carrier",
        label: q.label as string,
        isRequired: q.isRequired as boolean,
      })),
    })),
    activityGroups: groups.map((g) => ({ id: g.id, name: g.name })),
  };
}

export interface AnswerInput {
  questionId?: string;
  greenhouseRowId?: string;
  carrierId?: string;
}

export type ActivityAnswerValidation =
  | { ok: true; validatedRowId: string | null; validatedCarrierId: string | null }
  | { ok: false; error: string };

// The complete "is this a legitimate log for this employee, with a fully
// answered question set" check — activity must be active and in one of the
// employee's active group assignments (a client-supplied activityId is
// never trusted just because a picker offered it), every required question
// answered, every answered row/carrier a real active one. Identical rules
// for a mobile work-start/activity-change and an admin-created entry.
export async function validateActivityAndAnswers(
  db: Queryable,
  activityId: string,
  employeeId: string,
  answers: AnswerInput[] | undefined
): Promise<ActivityAnswerValidation> {
  if (!activityId || !UUID_RE.test(activityId)) {
    return { ok: false, error: "A valid activityId is required" };
  }

  const activityCheck = await db.query(
    `select a.id
     from activities a
     join activity_group_activities aga on aga.activity_id = a.id
     join employee_activity_group_assignments eaga
       on eaga.activity_group_id = aga.activity_group_id
      and eaga.employee_id = $2
      and eaga.unassigned_at is null
     join activity_groups ag on ag.id = aga.activity_group_id and ag.is_active = true
     where a.id = $1 and a.is_active = true`,
    [activityId, employeeId]
  );
  if (!activityCheck.rows[0]) {
    return { ok: false, error: "activityId is not available to this employee" };
  }

  const questionsRes = await db.query(
    `select id, question_type, is_required from activity_questions
     where activity_id = $1 and is_active = true
     order by sort_order`,
    [activityId]
  );
  const questions = questionsRes.rows as { id: string; question_type: "greenhouse_row" | "carrier"; is_required: boolean }[];

  const answersArray = Array.isArray(answers) ? answers : [];
  const validQuestionIds = new Set(questions.map((q) => q.id));
  for (const a of answersArray) {
    if (!a || typeof a.questionId !== "string" || !validQuestionIds.has(a.questionId)) {
      return { ok: false, error: "One or more answers do not match a configured question for this activity" };
    }
  }
  const answersByQuestionId = new Map(answersArray.map((a) => [a.questionId as string, a]));

  let validatedRowId: string | null = null;
  let validatedCarrierId: string | null = null;

  for (const q of questions) {
    const answer = answersByQuestionId.get(q.id);

    if (q.question_type === "greenhouse_row") {
      const rowId = answer?.greenhouseRowId;
      if (!rowId) {
        if (q.is_required) return { ok: false, error: "greenhouseRowId is required for this activity" };
        continue;
      }
      if (typeof rowId !== "string" || !UUID_RE.test(rowId)) {
        return { ok: false, error: "Invalid or inactive greenhouseRowId" };
      }
      const rowCheck = await db.query(
        `select gr.id
         from greenhouse_rows gr
         join greenhouse_phases gp on gp.id = gr.phase_id and gp.is_active = true
         where gr.id = $1 and gr.deleted_at is null`,
        [rowId]
      );
      if (!rowCheck.rows[0]) return { ok: false, error: "Invalid or inactive greenhouseRowId" };
      validatedRowId = rowId;
    } else if (q.question_type === "carrier") {
      const carrierId = answer?.carrierId;
      if (!carrierId) {
        if (q.is_required) return { ok: false, error: "carrierId is required for this activity" };
        continue;
      }
      if (typeof carrierId !== "string" || !UUID_RE.test(carrierId)) {
        return { ok: false, error: "Invalid or inactive carrierId" };
      }
      const carrierCheck = await db.query(`select id from carriers where id = $1 and is_active = true`, [carrierId]);
      if (!carrierCheck.rows[0]) return { ok: false, error: "Invalid or inactive carrierId" };
      validatedCarrierId = carrierId;
    }
  }

  return { ok: true, validatedRowId, validatedCarrierId };
}

export interface DensitySnapshot {
  densityType: "plants" | "stems" | null;
  densityCountPerRow: number | null;
}

// Frozen at the moment a work entry is opened — resolved from the row's
// *current* density assignment of the activity's configured density_source,
// never re-read afterward (see 025_activity_density_speed.sql: editing a
// density later must not change an already-recorded run's calculated speed
// on Inputs). Returns nulls when there's no row, or the activity has no
// density source, or the row has no matching density configured.
export async function resolveDensitySnapshot(
  db: Queryable,
  activityId: string,
  greenhouseRowId: string | null
): Promise<DensitySnapshot> {
  if (!greenhouseRowId) return { densityType: null, densityCountPerRow: null };

  const { rows } = await db.query(
    `select pd.type as density_type, pd.count_per_row as density_count_per_row
     from activities a
     left join plant_density_rows pdr
       on pdr.greenhouse_row_id = $2 and pdr.density_type = a.density_source
     left join plant_densities pd on pd.id = pdr.density_id
     where a.id = $1`,
    [activityId, greenhouseRowId]
  );
  const d = rows[0];
  if (d && d.density_type) {
    return { densityType: d.density_type, densityCountPerRow: Number(d.density_count_per_row) };
  }
  return { densityType: null, densityCountPerRow: null };
}

export interface GreenhouseRowOption {
  id: string;
  name: string;
  phases: {
    id: string;
    name: string;
    rows: { id: string; rowNumber: number }[];
  }[];
}

// Active lands/phases/rows, grouped for a picker — the same shape and same
// active-only scope as the mobile row picker (mobileTime.ts's GET
// /greenhouse-rows), reused as-is for the admin picker rather than
// re-querying the same tables a second way.
export async function loadGreenhouseRowOptions(db: Queryable): Promise<GreenhouseRowOption[]> {
  const { rows } = await db.query(
    `select gl.id as land_id, gl.name as land_name, gp.id as phase_id, gp.name as phase_name,
            gp.sort_order, gr.id as row_id, gr.row_number
     from greenhouse_rows gr
     join greenhouse_phases gp on gp.id = gr.phase_id and gp.is_active = true
     join greenhouse_lands gl on gl.id = gp.land_id and gl.is_active = true
     where gr.deleted_at is null
     order by gl.name, gp.sort_order, gp.name, gr.row_number`
  );

  const lands = new Map<string, { id: string; name: string; phases: Map<string, { id: string; name: string; rows: { id: string; rowNumber: number }[] }> }>();
  for (const r of rows) {
    let land = lands.get(r.land_id);
    if (!land) {
      land = { id: r.land_id, name: r.land_name, phases: new Map() };
      lands.set(r.land_id, land);
    }
    let phase = land.phases.get(r.phase_id);
    if (!phase) {
      phase = { id: r.phase_id, name: r.phase_name, rows: [] };
      land.phases.set(r.phase_id, phase);
    }
    phase.rows.push({ id: r.row_id, rowNumber: r.row_number });
  }

  return Array.from(lands.values()).map((l) => ({
    id: l.id,
    name: l.name,
    phases: Array.from(l.phases.values()),
  }));
}

// Active carriers for a picker — same shape/scope as mobileTime.ts's GET
// /carriers, reused as-is.
export async function loadCarrierOptions(db: Queryable): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query(`select id, name from carriers where is_active = true order by name`);
  return rows;
}
