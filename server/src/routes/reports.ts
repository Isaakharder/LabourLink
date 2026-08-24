import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getActivityReportData, getPayrollReportData } from "../lib/reportQueries";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Matches the app's existing desktop role convention: Administrator/Manager
// can already view Greenhouse (App.tsx) and edit Inputs (EDIT_ROLES there
// also includes Supervisor, but reports carry no per-employee correction
// workflow, so Supervisor is left out here — nothing in the brief asks for
// it, and it's easy to add later if that changes).
const VIEW_ROLES = ["Administrator", "Manager"];
const MANAGE_ROLES = ["Administrator"];

const ACTIVITY_METRICS = [
  "employee",
  "activity",
  "speed",
  "speedUnit",
  "paidTime",
  "workTime",
  "breakTime",
  "rows",
  "rowsCompleted",
  "quantityWorked",
  "startTime",
  "endTime",
  "totalHours",
  "averageSpeed",
  "date",
] as const;

const PAYROLL_METRICS = [
  "employee",
  "date",
  "workStart",
  "workEnd",
  "paidTime",
  "workTime",
  "breakTime",
  "unpaidTime",
  "totalHours",
  "daysWorked",
  "activityBreakdown",
  "weeklyTotals",
] as const;

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// Validates a JSON body array of employee ids (POST/PATCH) — the
// employee-select dropdown always sends a real JSON array, never a
// comma-separated string.
function parseEmployeeIdsArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value)];
  if (!ids.every((id): id is string => typeof id === "string" && UUID_RE.test(id))) return null;
  return ids as string[];
}

interface EmployeeSelectionInput {
  employeeSelectionMode?: unknown;
  employeeIds?: unknown;
}

// Validates a {employeeSelectionMode, employeeIds} pair as a unit — both
// fields are only ever written together (see POST/PATCH below), so a
// 'selected' mode can never be persisted without its own valid, non-empty,
// real-employee id list, and an 'all' mode never carries a stale list. Every
// id is checked against the employees table here — this app has no
// multi-tenant organization concept (see 001_initial_schema.sql; every
// employee belongs to the single org this deployment runs), so "belongs to
// the report's organization" is enforced as "is a real employee id in this
// system", which is the closest meaningful equivalent and is what rejects a
// foreign/garbage id.
async function resolveEmployeeSelection(
  input: EmployeeSelectionInput
): Promise<{ mode: "all" | "selected"; ids: string[] } | { error: string }> {
  const mode = input.employeeSelectionMode;
  if (mode !== "all" && mode !== "selected") {
    return { error: "employeeSelectionMode must be 'all' or 'selected'" };
  }
  if (mode === "all") {
    return { mode: "all", ids: [] };
  }
  const ids = parseEmployeeIdsArray(input.employeeIds);
  if (!ids) return { error: "employeeIds must be an array of valid employee ids" };
  if (ids.length === 0) return { error: "At least one employee must be selected" };

  const { rows } = await pool.query("select id from employees where id = any($1::uuid[])", [ids]);
  if (rows.length !== ids.length) {
    return { error: "One or more selected employees could not be found" };
  }
  return { mode: "selected", ids };
}

function validateMetrics(reportType: "activity" | "payroll", metrics: unknown): string[] | null {
  if (!Array.isArray(metrics) || metrics.length === 0) return null;
  const allowed = reportType === "activity" ? ACTIVITY_METRICS : PAYROLL_METRICS;
  const deduped = [...new Set(metrics)];
  if (!deduped.every((m) => typeof m === "string" && (allowed as readonly string[]).includes(m))) return null;
  return deduped as string[];
}

function serializeSummary(row: {
  id: string;
  name: string;
  report_type: string;
  activity_id: string | null;
  activity_name: string | null;
  updated_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    reportType: row.report_type,
    activity: row.activity_id ? { id: row.activity_id, name: row.activity_name } : null,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/",
  requireAuth,
  requireRole(...VIEW_ROLES),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select sr.id, sr.name, sr.report_type, sr.activity_id, a.name as activity_name, sr.updated_at
       from saved_reports sr
       left join activities a on a.id = sr.activity_id
       order by sr.updated_at desc`
    );
    res.json({ reports: rows.map(serializeSummary) });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid report id" });

    const { rows } = await pool.query(
      `select sr.id, sr.name, sr.report_type, sr.activity_id, a.name as activity_name,
              sr.configuration, sr.employee_selection_mode, sr.employee_ids, sr.created_at, sr.updated_at
       from saved_reports sr
       left join activities a on a.id = sr.activity_id
       where sr.id = $1`,
      [id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Report not found" });

    res.json({
      report: {
        id: row.id,
        name: row.name,
        reportType: row.report_type,
        activity: row.activity_id ? { id: row.activity_id, name: row.activity_name } : null,
        configuration: row.configuration,
        employeeSelectionMode: row.employee_selection_mode,
        employeeIds: row.employee_ids,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole(...MANAGE_ROLES),
  asyncHandler(async (req, res) => {
    const { name, reportType, activityId, metrics, employeeSelectionMode, employeeIds } = req.body as {
      name?: string;
      reportType?: string;
      activityId?: string | null;
      metrics?: unknown;
      employeeSelectionMode?: unknown;
      employeeIds?: unknown;
    };

    const trimmedName = trimOrNull(name);
    const errors: Record<string, string> = {};
    if (!trimmedName) errors.name = "Report name is required";
    if (reportType !== "activity" && reportType !== "payroll") {
      errors.reportType = "Report type must be Activity or Payroll";
    }
    let resolvedActivityId: string | null = null;
    if (reportType === "activity") {
      if (!activityId || !UUID_RE.test(activityId)) {
        errors.activityId = "An activity is required for an Activity Report";
      } else {
        resolvedActivityId = activityId;
      }
    }
    const validMetrics = reportType === "activity" || reportType === "payroll" ? validateMetrics(reportType, metrics) : null;
    if (!validMetrics) errors.metrics = "At least one valid metric must be selected";

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: "Invalid report", errors });
    }

    // Every new report defaults to "all" employees unless the caller
    // explicitly requests otherwise — matches the column default new
    // report rows would get anyway (046_saved_reports_employee_selection.sql),
    // made explicit here so a caller that DOES send a selection at create
    // time gets it validated the same way PATCH does.
    const employeeSelection =
      employeeSelectionMode !== undefined || employeeIds !== undefined
        ? await resolveEmployeeSelection({ employeeSelectionMode, employeeIds })
        : ({ mode: "all" as const, ids: [] as string[] });
    if ("error" in employeeSelection) {
      return res.status(400).json({ error: "Invalid report", errors: { employeeIds: employeeSelection.error } });
    }

    if (resolvedActivityId) {
      const activityCheck = await pool.query("select id from activities where id = $1", [resolvedActivityId]);
      if (!activityCheck.rows[0]) {
        return res.status(400).json({ error: "Invalid report", errors: { activityId: "Activity not found" } });
      }
    }

    const { rows } = await pool.query(
      `insert into saved_reports (name, report_type, activity_id, configuration, employee_selection_mode, employee_ids, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        trimmedName,
        reportType,
        resolvedActivityId,
        JSON.stringify({ metrics: validMetrics }),
        employeeSelection.mode,
        employeeSelection.ids,
        req.employee!.id,
      ]
    );
    res.status(201).json({ id: rows[0].id });
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole(...MANAGE_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid report id" });

    const existingRes = await pool.query("select report_type, configuration from saved_reports where id = $1", [id]);
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: "Report not found" });

    const { name, activityId, metrics, lastDateRange, employeeSelectionMode, employeeIds } = req.body as {
      name?: string;
      activityId?: string | null;
      metrics?: unknown;
      lastDateRange?: { start?: string; end?: string } | null;
      employeeSelectionMode?: unknown;
      employeeIds?: unknown;
    };

    const updates: string[] = [];
    const params: unknown[] = [];

    if (name !== undefined) {
      const trimmedName = trimOrNull(name);
      if (!trimmedName) return res.status(400).json({ error: "Invalid report", errors: { name: "Report name is required" } });
      params.push(trimmedName);
      updates.push(`name = $${params.length}`);
    }

    if (existing.report_type === "activity" && activityId !== undefined) {
      if (!activityId || !UUID_RE.test(activityId)) {
        return res.status(400).json({ error: "Invalid report", errors: { activityId: "A valid activity is required" } });
      }
      const activityCheck = await pool.query("select id from activities where id = $1", [activityId]);
      if (!activityCheck.rows[0]) {
        return res.status(400).json({ error: "Invalid report", errors: { activityId: "Activity not found" } });
      }
      params.push(activityId);
      updates.push(`activity_id = $${params.length}`);
    }

    let nextConfiguration = existing.configuration as { metrics?: string[]; lastDateRange?: { start: string; end: string } };
    if (metrics !== undefined) {
      const validMetrics = validateMetrics(existing.report_type as "activity" | "payroll", metrics);
      if (!validMetrics) {
        return res.status(400).json({ error: "Invalid report", errors: { metrics: "At least one valid metric must be selected" } });
      }
      nextConfiguration = { ...nextConfiguration, metrics: validMetrics };
    }
    if (lastDateRange !== undefined) {
      if (lastDateRange === null) {
        const { lastDateRange: _drop, ...rest } = nextConfiguration;
        void _drop;
        nextConfiguration = rest;
      } else if (isValidDate(lastDateRange.start) && isValidDate(lastDateRange.end)) {
        nextConfiguration = { ...nextConfiguration, lastDateRange: { start: lastDateRange.start, end: lastDateRange.end } };
      } else {
        return res.status(400).json({ error: "Invalid report", errors: { lastDateRange: "A valid start and end date are required" } });
      }
    }
    if (metrics !== undefined || lastDateRange !== undefined) {
      params.push(JSON.stringify(nextConfiguration));
      updates.push(`configuration = $${params.length}`);
    }

    // Written together as a pair, never independently — a lone
    // employeeIds with no mode (or vice versa) is a client bug, not a
    // partial update to accept; see resolveEmployeeSelection's comment.
    if (employeeSelectionMode !== undefined || employeeIds !== undefined) {
      const employeeSelection = await resolveEmployeeSelection({ employeeSelectionMode, employeeIds });
      if ("error" in employeeSelection) {
        return res.status(400).json({ error: "Invalid report", errors: { employeeIds: employeeSelection.error } });
      }
      params.push(employeeSelection.mode);
      updates.push(`employee_selection_mode = $${params.length}`);
      params.push(employeeSelection.ids);
      updates.push(`employee_ids = $${params.length}`);
    }

    if (updates.length === 0) return res.json({ ok: true });

    updates.push(`updated_at = now()`);
    params.push(id);
    await pool.query(`update saved_reports set ${updates.join(", ")} where id = $${params.length}`, params);

    res.json({ ok: true });
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole(...MANAGE_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid report id" });

    const { rowCount } = await pool.query("delete from saved_reports where id = $1", [id]);
    if (!rowCount) return res.status(404).json({ error: "Report not found" });
    res.status(204).send();
  })
);

router.get(
  "/:id/data",
  requireAuth,
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid report id" });

    const { start, end } = req.query as { start?: string; end?: string };
    if (!isValidDate(start) || !isValidDate(end)) {
      return res.status(400).json({ error: "A valid start and end date (YYYY-MM-DD) are required" });
    }
    if (start > end) {
      return res.status(400).json({ error: "start must not be after end" });
    }

    const reportRes = await pool.query(
      "select report_type, activity_id, employee_selection_mode, employee_ids from saved_reports where id = $1",
      [id]
    );
    const report = reportRes.rows[0];
    if (!report) return res.status(404).json({ error: "Report not found" });

    // The employee filter always comes from THIS report's own saved
    // definition, never from the request — a client-supplied employeeIds
    // query param was the pre-persistence design (component state only,
    // reset on every page load) and is deliberately no longer accepted
    // here: trusting a client-sent id list would let a request for one
    // report's data apply a different report's (or an arbitrary) selection,
    // and would let screen/print/CSV/PDF silently disagree with what's
    // actually saved. This is also what makes screen, print, CSV, and PDF
    // export automatically consistent — they all fetch from this same
    // endpoint, so there is exactly one place employee filtering happens.
    const employeeIdsFilter = report.employee_selection_mode === "selected" ? (report.employee_ids as string[]) : undefined;

    if (report.report_type === "activity") {
      const data = await getActivityReportData(report.activity_id, start, end, { employeeIds: employeeIdsFilter });
      if (!data) return res.status(404).json({ error: "The activity this report was saved with no longer exists" });
      return res.json({ data });
    }

    const data = await getPayrollReportData(start, end, { employeeIds: employeeIdsFilter });
    res.json({ data });
  })
);

export default router;
