// Employment Timeline: employment-period CRUD + the combined timeline/table
// read endpoint. Session-auth surface only (requireAuth/requireRole, same
// as employees.ts) — never touched by mobileEmployees.ts's device-auth
// router, matching the brief's "never expose HR data to ordinary mobile
// employees."
//
// Viewing (GET) is Administrator+Manager, matching employees.ts's own GET
// gate. Mutating (POST/PATCH/DELETE) and viewing audit history are
// Administrator-only — stricter than viewing the timeline itself, matching
// employees.ts's own POST/PATCH gate and the WORK_PERMIT_ROLES precedent
// for the stricter of two related action sets.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { calendarDateInAppTimezone } from "../lib/timezone";
import { getActiveWorkPermitAlerts } from "../lib/workPermits";
import {
  computePeriodStatuses,
  EMPLOYMENT_TYPES,
  EmploymentPeriodStatus,
  isOverlapViolation,
  recordEmploymentPeriodHistory,
  WORK_GROUPS,
} from "../lib/employmentPeriods";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALL_STATUSES: EmploymentPeriodStatus[] = ["future", "startingSoon", "current", "finishingSoon", "overdue", "completed"];

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// Query-string array params arrive as either a single string, an array of
// strings (repeated ?x=a&x=b), or undefined — Express/qs's usual shape.
function parseArrayParam(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.split(",").filter(Boolean);
  return [];
}

interface PeriodRow {
  id: string;
  employee_id: string;
  start_date: string;
  expected_finish_date: string | null;
  actual_finish_date: string | null;
  employment_type: string | null;
  work_group: string | null;
  work_group_other_description: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function serializePeriod(row: PeriodRow, today: string) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    startDate: row.start_date,
    expectedFinishDate: row.expected_finish_date,
    actualFinishDate: row.actual_finish_date,
    employmentType: row.employment_type,
    workGroup: row.work_group,
    workGroupOtherDescription: row.work_group_other_description,
    notes: row.notes,
    statuses: computePeriodStatuses(
      { startDate: row.start_date, expectedFinishDate: row.expected_finish_date, actualFinishDate: row.actual_finish_date },
      today
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rangesOverlap(aStart: string, aEnd: string | null, bStart: string, bEnd: string | null): boolean {
  const aEndEff = aEnd ?? "9999-12-31";
  const bEndEff = bEnd ?? "9999-12-31";
  return aStart <= bEndEff && bStart <= aEndEff;
}

// -- routes -------------------------------------------------------------

// Combined timeline-graph/table-view read. One row per employee, periods
// nested (each with computed `statuses`) — the single dataset the client's
// graph, table, and export all read from, so they can never disagree on a
// value.
router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const today = calendarDateInAppTimezone(new Date());

    const nationalityFilter = parseArrayParam(req.query.nationality);
    const employeeIdFilter = parseArrayParam(req.query.employeeId).filter((id) => UUID_RE.test(id));
    const workGroupFilter = parseArrayParam(req.query.workGroup);
    const employmentTypeFilter = parseArrayParam(req.query.employmentType);
    const statusFilter = parseArrayParam(req.query.status).filter((s): s is EmploymentPeriodStatus =>
      (ALL_STATUSES as string[]).includes(s)
    );
    const rangeStart = isValidDate(req.query.rangeStart) ? (req.query.rangeStart as string) : null;
    const rangeEnd = isValidDate(req.query.rangeEnd) ? (req.query.rangeEnd as string) : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (nationalityFilter.length) {
      params.push(nationalityFilter);
      conditions.push(`e.nationality = any($${params.length}::text[])`);
    }
    if (employeeIdFilter.length) {
      params.push(employeeIdFilter);
      conditions.push(`e.id = any($${params.length}::uuid[])`);
    }
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

    const { rows: employeeRows } = await pool.query(
      `select e.id, e.first_name, e.last_name, e.nationality, e.job_group, e.is_active,
              to_char(e.work_permit_expiry_date, 'YYYY-MM-DD') as work_permit_expiry_date
       from employees e
       ${where}
       order by e.first_name, e.last_name`,
      params
    );
    if (employeeRows.length === 0) return res.json({ employees: [] });

    const employeeIds = employeeRows.map((r) => r.id);
    const { rows: periodRows } = await pool.query<PeriodRow>(
      `select id, employee_id,
              to_char(start_date, 'YYYY-MM-DD') as start_date,
              to_char(expected_finish_date, 'YYYY-MM-DD') as expected_finish_date,
              to_char(actual_finish_date, 'YYYY-MM-DD') as actual_finish_date,
              employment_type, work_group, work_group_other_description, notes,
              created_at, updated_at
       from employee_employment_periods
       where employee_id = any($1::uuid[])
       order by start_date`,
      [employeeIds]
    );

    const periodsByEmployee = new Map<string, PeriodRow[]>();
    for (const row of periodRows) {
      const list = periodsByEmployee.get(row.employee_id) ?? [];
      list.push(row);
      periodsByEmployee.set(row.employee_id, list);
    }

    const hasWorkGroupFilter = workGroupFilter.length > 0;
    const hasEmploymentTypeFilter = employmentTypeFilter.length > 0;
    const hasStatusFilter = statusFilter.length > 0;
    const hasAnyPeriodFilter = hasWorkGroupFilter || hasEmploymentTypeFilter || hasStatusFilter;

    function periodMatchesFilters(row: PeriodRow): boolean {
      if (hasWorkGroupFilter) {
        const matches = row.work_group ? workGroupFilter.includes(row.work_group) : workGroupFilter.includes("Unspecified");
        if (!matches) return false;
      }
      if (hasEmploymentTypeFilter) {
        const matches = row.employment_type
          ? employmentTypeFilter.includes(row.employment_type)
          : employmentTypeFilter.includes("Unspecified");
        if (!matches) return false;
      }
      if (hasStatusFilter) {
        const statuses = computePeriodStatuses(
          { startDate: row.start_date, expectedFinishDate: row.expected_finish_date, actualFinishDate: row.actual_finish_date },
          today
        );
        if (!statuses.some((s) => statusFilter.includes(s))) return false;
      }
      return true;
    }

    const alerts = await getActiveWorkPermitAlerts(pool, today);
    const alertByEmployee = new Map(alerts.map((a) => [a.employeeId, a]));

    const employees = employeeRows
      .map((e) => {
        const periods = periodsByEmployee.get(e.id) ?? [];
        // Row-visibility rule: qualifies if at least one period satisfies
        // every active period-level filter (a single period must match
        // Work Group AND Employment Type AND Status together — e.g.
        // "Guatemalan + Greenhouse + Seasonal" means one period that is
        // both Greenhouse and Seasonal, on a Guatemalan employee). Once
        // qualified, ALL of the employee's periods render (not just the
        // matching one), so employment history never shows misleading gaps.
        if (hasAnyPeriodFilter && !periods.some(periodMatchesFilters)) return null;

        const visiblePeriods =
          rangeStart || rangeEnd
            ? periods.filter((p) =>
                rangesOverlap(rangeStart ?? "0001-01-01", rangeEnd ?? null, p.start_date, p.actual_finish_date ?? p.expected_finish_date)
              )
            : periods;

        const workPermitExpiryDate: string | null = e.work_permit_expiry_date;
        const alert = alertByEmployee.get(e.id);

        return {
          id: e.id,
          firstName: e.first_name,
          lastName: e.last_name,
          nationality: e.nationality,
          jobGroup: e.job_group,
          isActive: e.is_active,
          workPermit: workPermitExpiryDate
            ? { expiryDate: workPermitExpiryDate, remainingDays: alert?.remainingDays ?? null, severity: alert?.severity ?? null }
            : null,
          periods: visiblePeriods.map((p) => serializePeriod(p, today)),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    res.json({ employees });
  })
);

router.get(
  "/:employeeId/history",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    if (!UUID_RE.test(employeeId)) return res.status(400).json({ error: "Invalid employee id" });

    const { rows } = await pool.query(
      `select h.id, h.employment_period_id, h.change_type, h.old_value, h.new_value, h.changed_at, h.reason,
              e.first_name as changed_by_first_name, e.last_name as changed_by_last_name
       from employee_employment_period_history h
       join employees e on e.id = h.changed_by_employee_id
       where h.employee_id = $1
       order by h.changed_at desc`,
      [employeeId]
    );
    res.json({
      history: rows.map((r) => ({
        id: r.id,
        employmentPeriodId: r.employment_period_id,
        changeType: r.change_type,
        oldValue: r.old_value,
        newValue: r.new_value,
        changedAt: r.changed_at,
        reason: r.reason,
        changedBy: `${r.changed_by_first_name} ${r.changed_by_last_name}`,
      })),
    });
  })
);

interface PeriodPayload {
  employeeId?: unknown;
  startDate?: unknown;
  expectedFinishDate?: unknown;
  actualFinishDate?: unknown;
  employmentType?: unknown;
  workGroup?: unknown;
  workGroupOtherDescription?: unknown;
  notes?: unknown;
}

interface ValidatedPeriodFields {
  startDate?: string;
  expectedFinishDate?: string | null;
  actualFinishDate?: string | null;
  employmentType?: string | null;
  workGroup?: string | null;
  workGroupOtherDescription?: string | null;
  notes?: string | null;
}

// Shared shape-only validation for create (all relevant keys required) and
// update (only keys present in the body are checked) — `requireStartDate`
// distinguishes the two, mirroring employees.ts's validateCreate/
// validateUpdate split.
function validatePeriodFields(
  body: PeriodPayload,
  requireStartDate: boolean
): { errors: Record<string, string> } | { data: ValidatedPeriodFields } {
  const errors: Record<string, string> = {};
  const data: ValidatedPeriodFields = {};

  if (requireStartDate || "startDate" in body) {
    if (!isValidDate(body.startDate)) errors.startDate = "A valid start date is required";
    else data.startDate = body.startDate as string;
  }

  if (requireStartDate || "expectedFinishDate" in body) {
    const raw = body.expectedFinishDate;
    if (raw == null || raw === "") data.expectedFinishDate = null;
    else if (!isValidDate(raw)) errors.expectedFinishDate = "Expected finish date is not a valid date";
    else data.expectedFinishDate = raw as string;
  }

  if (requireStartDate || "actualFinishDate" in body) {
    const raw = body.actualFinishDate;
    if (raw == null || raw === "") data.actualFinishDate = null;
    else if (!isValidDate(raw)) errors.actualFinishDate = "Actual finish date is not a valid date";
    else data.actualFinishDate = raw as string;
  }

  if (requireStartDate || "employmentType" in body) {
    const raw = body.employmentType;
    if (raw == null || raw === "") data.employmentType = null;
    else if (!(EMPLOYMENT_TYPES as readonly string[]).includes(raw as string)) {
      errors.employmentType = `Employment type must be one of: ${EMPLOYMENT_TYPES.join(", ")}`;
    } else data.employmentType = raw as string;
  }

  let workGroupForOtherCheck: string | null | undefined;
  if (requireStartDate || "workGroup" in body) {
    const raw = body.workGroup;
    if (raw == null || raw === "") data.workGroup = null;
    else if (!(WORK_GROUPS as readonly string[]).includes(raw as string)) {
      errors.workGroup = `Work group must be one of: ${WORK_GROUPS.join(", ")}`;
    } else data.workGroup = raw as string;
    workGroupForOtherCheck = data.workGroup;
  }

  if (requireStartDate || "workGroupOtherDescription" in body) {
    const raw = body.workGroupOtherDescription;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    data.workGroupOtherDescription = trimmed ? trimmed : null;
    if (data.workGroupOtherDescription && workGroupForOtherCheck !== "Other" && workGroupForOtherCheck !== undefined) {
      errors.workGroupOtherDescription = "A description is only allowed when Work Group is Other";
    }
  }

  if (requireStartDate || "notes" in body) {
    const raw = body.notes;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    data.notes = trimmed ? trimmed : null;
  }

  if (data.expectedFinishDate != null && data.startDate != null && data.expectedFinishDate < data.startDate) {
    errors.expectedFinishDate = "Expected finish date cannot be before the start date";
  }
  if (data.actualFinishDate != null && data.startDate != null && data.actualFinishDate < data.startDate) {
    errors.actualFinishDate = "Actual finish date cannot be before the start date";
  }

  if (Object.keys(errors).length) return { errors };
  return { data };
}

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as PeriodPayload;
    const employeeId = body.employeeId;
    if (typeof employeeId !== "string" || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }

    const result = validatePeriodFields(body, true);
    if ("errors" in result) return res.status(400).json({ errors: result.errors });
    const d = result.data;

    const empCheck = await pool.query("select id from employees where id = $1", [employeeId]);
    if (!empCheck.rows[0]) return res.status(404).json({ error: "Employee not found" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        `insert into employee_employment_periods
           (employee_id, start_date, expected_finish_date, actual_finish_date,
            employment_type, work_group, work_group_other_description, notes, created_by_employee_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [
          employeeId,
          d.startDate,
          d.expectedFinishDate ?? null,
          d.actualFinishDate ?? null,
          d.employmentType ?? null,
          d.workGroup ?? null,
          d.workGroupOtherDescription ?? null,
          d.notes ?? null,
          req.employee!.id,
        ]
      );
      const created = rows[0];
      await recordEmploymentPeriodHistory(client, {
        employmentPeriodId: created.id,
        employeeId,
        changeType: "created",
        oldValue: null,
        newValue: created,
        changedByEmployeeId: req.employee!.id,
        reason: null,
      });
      await client.query("commit");

      const today = calendarDateInAppTimezone(new Date());
      const { rows: full } = await pool.query<PeriodRow>(
        `select id, employee_id, to_char(start_date, 'YYYY-MM-DD') as start_date,
                to_char(expected_finish_date, 'YYYY-MM-DD') as expected_finish_date,
                to_char(actual_finish_date, 'YYYY-MM-DD') as actual_finish_date,
                employment_type, work_group, work_group_other_description, notes, created_at, updated_at
         from employee_employment_periods where id = $1`,
        [created.id]
      );
      res.status(201).json({ period: serializePeriod(full[0], today) });
    } catch (err) {
      await client.query("rollback");
      if (isOverlapViolation(err)) {
        return res.status(409).json({
          error: "This period overlaps another employment period for this employee. A finish date is the last day worked — the next period must start the day after.",
        });
      }
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
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employment period id" });

    const body = (req.body ?? {}) as PeriodPayload;
    const result = validatePeriodFields(body, false);
    if ("errors" in result) return res.status(400).json({ errors: result.errors });
    const d = result.data;

    const columnMap: Record<keyof ValidatedPeriodFields, string> = {
      startDate: "start_date",
      expectedFinishDate: "expected_finish_date",
      actualFinishDate: "actual_finish_date",
      employmentType: "employment_type",
      workGroup: "work_group",
      workGroupOtherDescription: "work_group_other_description",
      notes: "notes",
    };
    const keys = Object.keys(d) as (keyof ValidatedPeriodFields)[];
    if (keys.length === 0) return res.status(400).json({ error: "No fields to update" });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const currentRes = await client.query("select * from employee_employment_periods where id = $1 for update", [id]);
      if (!currentRes.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Employment period not found" });
      }
      const before = currentRes.rows[0];

      const values = keys.map((k) => d[k]);
      const setClauses = [...keys.map((k, i) => `${columnMap[k]} = $${i + 1}`), "updated_at = now()"];
      const { rows } = await client.query(
        `update employee_employment_periods set ${setClauses.join(", ")} where id = $${values.length + 1} returning *`,
        [...values, id]
      );
      const after = rows[0];

      // No code path in this route ever writes employees.is_active —
      // recording an actual finish, or reaching/setting an expected finish,
      // must not auto-deactivate the employee, clock them out, or touch
      // payroll/time entries. Deactivation stays a fully separate, explicit
      // action on the Employees Directory tab.
      await recordEmploymentPeriodHistory(client, {
        employmentPeriodId: id,
        employeeId: before.employee_id,
        changeType: "updated",
        oldValue: before,
        newValue: after,
        changedByEmployeeId: req.employee!.id,
        reason: null,
      });

      await client.query("commit");

      const today = calendarDateInAppTimezone(new Date());
      const { rows: full } = await pool.query<PeriodRow>(
        `select id, employee_id, to_char(start_date, 'YYYY-MM-DD') as start_date,
                to_char(expected_finish_date, 'YYYY-MM-DD') as expected_finish_date,
                to_char(actual_finish_date, 'YYYY-MM-DD') as actual_finish_date,
                employment_type, work_group, work_group_other_description, notes, created_at, updated_at
         from employee_employment_periods where id = $1`,
        [id]
      );
      res.json({ period: serializePeriod(full[0], today) });
    } catch (err) {
      await client.query("rollback");
      if (isOverlapViolation(err)) {
        return res.status(409).json({
          error: "This period overlaps another employment period for this employee. A finish date is the last day worked — the next period must start the day after.",
        });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employment period id" });

    const { reason } = (req.body ?? {}) as { reason?: unknown };
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";
    if (!trimmedReason) return res.status(400).json({ error: "A reason is required to delete an employment period" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query("delete from employee_employment_periods where id = $1 returning *", [id]);
      if (!rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Employment period not found" });
      }
      const deleted = rows[0];
      await recordEmploymentPeriodHistory(client, {
        employmentPeriodId: null,
        employeeId: deleted.employee_id,
        changeType: "deleted",
        oldValue: deleted,
        newValue: null,
        changedByEmployeeId: req.employee!.id,
        reason: trimmedReason,
      });
      await client.query("commit");
      res.status(204).send();
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

export default router;
