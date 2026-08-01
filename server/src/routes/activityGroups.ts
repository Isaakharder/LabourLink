import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { addEmployeeToActivityGroup, removeEmployeeFromActivityGroup } from "../lib/activityGroupAssignment";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function duplicateFieldFromConstraint(constraint?: string): string | null {
  if (constraint === "activity_groups_name_key" || constraint === "activity_groups_name_normalized_key") {
    return "name";
  }
  return null;
}

// Validates a client-supplied activityIds array: must be a non-empty array
// of UUID strings, deduped, each referencing a real activities row. Returns
// the deduped id list on success.
async function validateActivityIds(raw: unknown): Promise<{ error: string } | { activityIds: string[] }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "At least one activity is required" };
  }
  const ids = [...new Set(raw)];
  if (!ids.every((id) => typeof id === "string" && UUID_RE.test(id))) {
    return { error: "One or more selected activities are invalid" };
  }
  const { rows } = await pool.query("select id from activities where id = any($1::uuid[])", [ids]);
  if (rows.length !== ids.length) {
    return { error: "One or more selected activities are invalid" };
  }
  return { activityIds: ids as string[] };
}

const LIST_SELECT = `
  select ag.id, ag.name, ag.description, ag.is_active, ag.created_at, ag.updated_at,
         coalesce(act.activities, '[]'::json) as activities,
         coalesce(act.activity_count, 0) as activity_count,
         coalesce(emp.employee_count, 0) as assigned_employee_count
  from activity_groups ag
  left join lateral (
    select json_agg(json_build_object('id', a.id, 'name', a.name, 'isActive', a.is_active)
                     order by a.sort_order, a.name) as activities,
           count(*) as activity_count
    from activity_group_activities aga
    join activities a on a.id = aga.activity_id
    where aga.activity_group_id = ag.id
  ) act on true
  left join lateral (
    select count(*) as employee_count
    from employee_activity_group_assignments eaga
    where eaga.activity_group_id = ag.id and eaga.unassigned_at is null
  ) emp on true
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeGroup(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    activities: row.activities,
    activityCount: Number(row.activity_count),
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

    if (status === "active") conditions.push("ag.is_active = true");
    else if (status === "inactive") conditions.push("ag.is_active = false");

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`lower(ag.name) like $${params.length}`);
    }

    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const { rows } = await pool.query(`${LIST_SELECT} ${where} order by ag.name`, params);
    res.json({ activityGroups: rows.map(serializeGroup) });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity group id" });

    const { rows } = await pool.query(`${LIST_SELECT} where ag.id = $1`, [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Activity group not found" });

    const { rows: employeeRows } = await pool.query(
      `select e.id, e.first_name, e.last_name
       from employee_activity_group_assignments eaga
       join employees e on e.id = eaga.employee_id
       where eaga.activity_group_id = $1 and eaga.unassigned_at is null
       order by e.first_name, e.last_name`,
      [id]
    );

    res.json({
      activityGroup: {
        ...serializeGroup(row),
        assignedEmployees: employeeRows.map((r) => ({
          id: r.id,
          firstName: r.first_name,
          lastName: r.last_name,
        })),
      },
    });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const name = trimOrNull(req.body?.name);
    const errors: Record<string, string> = {};
    if (!name) errors.name = "Group name is required";

    const activityIdsResult = await validateActivityIds(req.body?.activityIds);
    if ("error" in activityIdsResult) errors.activityIds = activityIdsResult.error;

    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const activityIds = (activityIdsResult as { activityIds: string[] }).activityIds;

    const description = trimOrNull(req.body?.description);
    const isActive = req.body?.isActive === undefined ? true : Boolean(req.body.isActive);

    const client = await pool.connect();
    try {
      await client.query("begin");

      let groupId: string;
      try {
        const { rows } = await client.query(
          `insert into activity_groups (name, description, is_active) values ($1, $2, $3) returning id`,
          [name, description, isActive]
        );
        groupId = rows[0].id;
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === "23505" && duplicateFieldFromConstraint(pgErr.constraint) === "name") {
          await client.query("rollback");
          return res.status(409).json({ errors: { name: "An activity group with this name already exists" } });
        }
        throw err;
      }

      await client.query(
        `insert into activity_group_activities (activity_group_id, activity_id)
         select $1, unnest($2::uuid[])
         on conflict (activity_group_id, activity_id) do nothing`,
        [groupId, activityIds]
      );

      await client.query("commit");

      const { rows: full } = await pool.query(`${LIST_SELECT} where ag.id = $1`, [groupId]);
      res.status(201).json({ activityGroup: serializeGroup(full[0]) });
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
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity group id" });

    const body = req.body ?? {};
    const errors: Record<string, string> = {};

    let name: string | null | undefined;
    if ("name" in body) {
      name = trimOrNull(body.name);
      if (!name) errors.name = "Group name is required";
    }

    let activityIds: string[] | undefined;
    if ("activityIds" in body) {
      const result = await validateActivityIds(body.activityIds);
      if ("error" in result) errors.activityIds = result.error;
      else activityIds = result.activityIds;
    }

    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const columns: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      values.push(name);
      columns.push(`name = $${values.length}`);
    }
    if ("description" in body) {
      values.push(trimOrNull(body.description));
      columns.push(`description = $${values.length}`);
    }
    const deactivating = "isActive" in body && body.isActive === false;
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
          `update activity_groups set ${columns.join(", ")} where id = $${values.length} returning id`,
          values
        );
        if (!rows[0]) {
          await client.query("rollback");
          return res.status(404).json({ error: "Activity group not found" });
        }
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === "23505" && duplicateFieldFromConstraint(pgErr.constraint) === "name") {
          await client.query("rollback");
          return res.status(409).json({ errors: { name: "An activity group with this name already exists" } });
        }
        throw err;
      }

      if (activityIds) {
        await client.query(`delete from activity_group_activities where activity_group_id = $1`, [id]);
        await client.query(
          `insert into activity_group_activities (activity_group_id, activity_id)
           select $1, unnest($2::uuid[])
           on conflict (activity_group_id, activity_id) do nothing`,
          [id, activityIds]
        );
      }

      // Deactivating a group cuts off access immediately and keeps the
      // Employees list honest (never shows a dead group as "current") —
      // see plan decision #1. History is preserved: the row is closed, not
      // deleted. Unconditional on the new value (not a before/after
      // transition check), matching employees.ts's own deactivation cascade.
      if (deactivating) {
        await client.query(
          `update employee_activity_group_assignments set unassigned_at = now()
           where activity_group_id = $1 and unassigned_at is null`,
          [id]
        );
      }

      await client.query("commit");

      const { rows: full } = await pool.query(`${LIST_SELECT} where ag.id = $1`, [id]);
      res.json({ activityGroup: serializeGroup(full[0]) });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.post(
  "/:id/assign-employees",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity group id" });

    const groupRow = await pool.query("select is_active from activity_groups where id = $1", [id]);
    if (!groupRow.rows[0]) return res.status(404).json({ error: "Activity group not found" });
    if (!groupRow.rows[0].is_active) {
      return res.status(400).json({ error: "Cannot assign employees to an inactive activity group" });
    }

    const raw = req.body?.employeeIds;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ error: "At least one employeeId is required" });
    }
    const employeeIds = [...new Set(raw)];
    if (!employeeIds.every((eid) => typeof eid === "string" && UUID_RE.test(eid))) {
      return res.status(400).json({ error: "One or more employeeIds are invalid" });
    }

    const validEmployees = await pool.query(
      "select id from employees where id = any($1::uuid[]) and is_active = true",
      [employeeIds]
    );
    if (validEmployees.rows.length !== employeeIds.length) {
      return res.status(400).json({ error: "One or more employeeIds are invalid or inactive" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const employeeId of employeeIds as string[]) {
        await addEmployeeToActivityGroup(client, employeeId, id, req.employee!.id);
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const { rows: full } = await pool.query(`${LIST_SELECT} where ag.id = $1`, [id]);
    const { rows: employeeRows } = await pool.query(
      `select e.id, e.first_name, e.last_name
       from employee_activity_group_assignments eaga
       join employees e on e.id = eaga.employee_id
       where eaga.activity_group_id = $1 and eaga.unassigned_at is null
       order by e.first_name, e.last_name`,
      [id]
    );
    res.json({
      activityGroup: {
        ...serializeGroup(full[0]),
        assignedEmployees: employeeRows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name })),
      },
    });
  })
);

router.delete(
  "/:id/employees/:employeeId",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id, employeeId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const groupCheck = await pool.query("select id from activity_groups where id = $1", [id]);
    if (!groupCheck.rows[0]) return res.status(404).json({ error: "Activity group not found" });

    await removeEmployeeFromActivityGroup(pool, employeeId, id);
    res.status(204).send();
  })
);

export default router;
