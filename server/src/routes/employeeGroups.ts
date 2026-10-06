// Employee Groups (056_employee_groups.sql): named groups that organize the
// employee list. Each employee belongs to at most one (employees.
// employee_group_id; null = Ungrouped). Same permission split as employee
// management itself (routes/employees.ts): Administrators and Managers can
// view, only Administrators can create, rename or delete.
//
// Purely organizational — nothing here (or in assigning a group) touches
// time entries, activity logs, speed calculations, employment periods,
// Job group, Activity Groups or permissions.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 100;
const DUPLICATE_NAME = "An employee group with this name already exists";

function validateName(raw: unknown): { name: string } | { error: string } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { error: "Group name is required" };
  if (name.length > MAX_NAME_LENGTH) return { error: `Group name must be ${MAX_NAME_LENGTH} characters or fewer` };
  return { name };
}

const isDuplicateName = (err: unknown) => {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr.code === "23505" && pgErr.constraint === "employee_groups_name_normalized_key";
};

const LIST_SELECT = `
  select g.id, g.name, g.created_at, g.updated_at,
         count(e.id)::int as employee_count,
         count(e.id) filter (where e.is_active)::int as active_employee_count
  from employee_groups g
  left join employees e on e.employee_group_id = g.id
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeGroup(row: any) {
  return {
    id: row.id,
    name: row.name,
    employeeCount: Number(row.employee_count),
    activeEmployeeCount: Number(row.active_employee_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadGroup(id: string) {
  const { rows } = await pool.query(`${LIST_SELECT} where g.id = $1 group by g.id`, [id]);
  return rows[0] ? serializeGroup(rows[0]) : null;
}

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`${LIST_SELECT} group by g.id order by lower(g.name), g.id`);
    const { rows: ungrouped } = await pool.query(
      `select count(*)::int as n, count(*) filter (where is_active)::int as active from employees where employee_group_id is null`
    );
    res.json({
      groups: rows.map(serializeGroup),
      ungrouped: { employeeCount: ungrouped[0].n, activeEmployeeCount: ungrouped[0].active },
    });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const v = validateName(req.body?.name);
    if ("error" in v) return res.status(400).json({ errors: { name: v.error } });
    try {
      const { rows } = await pool.query(`insert into employee_groups (name) values ($1) returning id`, [v.name]);
      res.status(201).json({ group: await loadGroup(rows[0].id) });
    } catch (err) {
      if (isDuplicateName(err)) return res.status(409).json({ errors: { name: DUPLICATE_NAME } });
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
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee group id" });
    const v = validateName(req.body?.name);
    if ("error" in v) return res.status(400).json({ errors: { name: v.error } });
    try {
      const { rowCount } = await pool.query(`update employee_groups set name = $1, updated_at = now() where id = $2`, [v.name, id]);
      if (!rowCount) return res.status(404).json({ error: "Employee group not found" });
      res.json({ group: await loadGroup(id) });
    } catch (err) {
      if (isDuplicateName(err)) return res.status(409).json({ errors: { name: DUPLICATE_NAME } });
      throw err;
    }
  })
);

// Deletes the group only. Its employees become Ungrouped (the foreign key's
// on delete set null) — no employee is ever deleted or otherwise changed.
router.delete(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee group id" });
    const group = await loadGroup(id);
    if (!group) return res.status(404).json({ error: "Employee group not found" });
    await pool.query(`delete from employee_groups where id = $1`, [id]);
    res.json({ ok: true, ungroupedEmployees: group.employeeCount });
  })
);

export default router;
