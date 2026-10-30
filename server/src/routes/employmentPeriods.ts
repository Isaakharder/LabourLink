// Employment Timeline: the combined timeline/table read endpoint, the
// "Timeline starts" display setting and the period audit history.
// Session-auth surface only (requireAuth/requireRole, same as employees.ts)
// — never touched by mobileEmployees.ts's device-auth router.
//
// Viewing (GET) is Administrator+Manager, matching employees.ts's own GET
// gate. The timeline's dates are edited through PATCH /api/employees/:id
// (Administrator-only, unchanged) — one employee record shared with the
// Employees Directory, see employmentTimelineView.ts. The old per-period
// create/edit/delete endpoints answer 410 (see the bottom of this file).
import { Request, Response, Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { calendarDateInAppTimezone } from "../lib/timezone";
import { getActiveWorkPermitAlerts } from "../lib/workPermits";
import { computeEmploymentStatuses, EmploymentPeriodStatus } from "../lib/employmentPeriods";
import { resolveEmployeeTimeline } from "../lib/employmentTimelineView";
import { getEmploymentTimelineDisplayStart, isValidDisplayStartDate, setEmploymentTimelineDisplayStart } from "../lib/employmentTimelineSettings";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_STATUSES: EmploymentPeriodStatus[] = ["future", "startingSoon", "current", "finishingSoon", "permitExpired", "completed"];

// Query-string array params arrive as either a single string, an array of
// strings (repeated ?x=a&x=b), or undefined — Express/qs's usual shape.
function parseArrayParam(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.split(",").filter(Boolean);
  return [];
}

// -- routes -------------------------------------------------------------

// Combined timeline-graph/table-view read: one row per active employee with
// the three employment dates from the employee record, the server-computed
// bar end/label and status tags — the single dataset the client's graph,
// table and exports all read, so they can never disagree on a value.
// Employment type and work group still come from the employee's latest
// employment_periods row (migration 050): no longer edited from the
// timeline, but shown and filterable, read-only.
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

    // is_active = true is unconditional: deactivated employees are excluded
    // from the graph, table, totals and every export, all of which read here.
    const conditions: string[] = ["e.is_active = true"];
    const params: unknown[] = [];
    if (nationalityFilter.length) {
      params.push(nationalityFilter);
      conditions.push(`e.nationality = any($${params.length}::text[])`);
    }
    if (employeeIdFilter.length) {
      params.push(employeeIdFilter);
      conditions.push(`e.id = any($${params.length}::uuid[])`);
    }

    const { rows } = await pool.query(
      `select e.id, e.first_name, e.last_name, e.nationality, e.job_group, e.is_active,
              e.employee_group_id, eg.name as employee_group_name,
              to_char(e.start_date, 'YYYY-MM-DD') as start_date,
              to_char(e.work_permit_expiry_date, 'YYYY-MM-DD') as work_permit_expiry_date,
              to_char(e.employment_end_date, 'YYYY-MM-DD') as employment_end_date,
              to_char(e.vacation_start_date, 'YYYY-MM-DD') as vacation_start_date,
              to_char(e.vacation_end_date, 'YYYY-MM-DD') as vacation_end_date,
              lp.employment_type, lp.work_group
       from employees e
       left join employee_groups eg on eg.id = e.employee_group_id
       left join lateral (
         select p.employment_type, p.work_group
         from employee_employment_periods p
         where p.employee_id = e.id
         order by p.start_date desc, p.created_at desc
         limit 1
       ) lp on true
       where ${conditions.join(" and ")}
       order by e.first_name, e.last_name, e.id`,
      params
    );
    if (rows.length === 0) return res.json({ employees: [] });

    const alerts = await getActiveWorkPermitAlerts(pool, today);
    const alertByEmployee = new Map(alerts.map((a) => [a.employeeId, a]));

    const employees = rows
      .map((e) => {
        const resolved = resolveEmployeeTimeline(
          { isActive: e.is_active, startDate: e.start_date, workPermitExpiryDate: e.work_permit_expiry_date, endDifferentDate: e.employment_end_date },
          today
        );
        if (!resolved.included) return null;
        const statuses = e.start_date
          ? computeEmploymentStatuses(
              { startDate: e.start_date, workPermitExpiryDate: e.work_permit_expiry_date, endDifferentDate: e.employment_end_date },
              today
            )
          : [];

        if (workGroupFilter.length && !workGroupFilter.includes(e.work_group ?? "Unspecified")) return null;
        if (employmentTypeFilter.length && !employmentTypeFilter.includes(e.employment_type ?? "Unspecified")) return null;
        if (statusFilter.length && !statuses.some((s) => statusFilter.includes(s))) return null;

        const alert = alertByEmployee.get(e.id);
        return {
          id: e.id,
          firstName: e.first_name,
          lastName: e.last_name,
          nationality: e.nationality,
          jobGroup: e.job_group,
          employeeGroup: e.employee_group_id ? { id: e.employee_group_id, name: e.employee_group_name } : null,
          isActive: e.is_active,
          employmentStartDate: e.start_date,
          workPermitExpiryDate: e.work_permit_expiry_date,
          endDifferentDate: e.employment_end_date,
          // One planned vacation (069), drawn as an orange overlay on the bar.
          vacationStartDate: e.vacation_start_date,
          vacationEndDate: e.vacation_end_date,
          workPermit: e.work_permit_expiry_date
            ? { expiryDate: e.work_permit_expiry_date, remainingDays: alert?.remainingDays ?? null, severity: alert?.severity ?? null }
            : null,
          employmentType: e.employment_type,
          workGroup: e.work_group,
          // False when there's no Employment Start Date to draw from — the
          // client renders a flagged placeholder row instead of a bar.
          hasUsableDates: resolved.hasUsableDates,
          timelineEndDate: resolved.bar?.endDate ?? null,
          timelineEndSource: resolved.bar?.endSource ?? null,
          timelineLabel: resolved.bar?.label ?? null,
          statuses,
          // Always empty: periods are no longer the timeline's source. Kept so
          // a desktop page still running the previous version renders an
          // empty graph instead of failing on a missing field.
          periods: [],
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    res.json({ employees });
  })
);

// -- "Timeline starts" org setting --------------------------------------
// A display-only cutoff for the default Fit-all graph range (see
// employmentTimelineSettings.ts's own header comment) — never touches
// employees.start_date or any employment_periods row. Same GET-broader/
// PATCH-stricter role split as the rest of this router and as
// dashboard.ts's own /org-settings endpoints.
router.get(
  "/settings/display-start",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const displayStart = await getEmploymentTimelineDisplayStart();
    res.json({ displayStart });
  })
);

router.patch(
  "/settings/display-start",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { displayStart } = (req.body ?? {}) as { displayStart?: string | null };
    const value = displayStart === undefined ? null : displayStart;
    if (!isValidDisplayStartDate(value)) {
      return res.status(400).json({ error: "displayStart must be a YYYY-MM-DD date string, or null to reset to the earliest employee start" });
    }
    await setEmploymentTimelineDisplayStart(value, req.employee!.id);
    res.json({ displayStart: value });
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

// The timeline's dates moved onto the employee record (migration 068) and
// are edited through PATCH /api/employees/:id. A desktop page still running
// the previous version may call the old per-period endpoints; they answer
// 410 and change nothing, so a stale page can never write dates the
// timeline no longer reads.
const PERIODS_REPLACED_MESSAGE =
  "Employment periods were replaced by the employee's own employment dates. Refresh LabourLink to continue.";

function periodsReplaced(_req: Request, res: Response) {
  res.status(410).json({ error: PERIODS_REPLACED_MESSAGE, code: "employment_periods_replaced" });
}

router.post("/", requireAuth, periodsReplaced);
router.patch("/:id", requireAuth, periodsReplaced);
router.delete("/:id", requireAuth, periodsReplaced);

export default router;
