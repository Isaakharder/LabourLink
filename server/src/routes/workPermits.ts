// Work-permit alert actions (Acknowledge/Renewed/Cancel alert) and history
// — deliberately separate from employees.ts's general edit routes, which
// are Administrator-only. These three actions (plus viewing history) are
// explicitly open to Manager too, per the brief: "Only Administrators and
// Managers may view or act on Work Permit Alerts," enforced here
// server-side (requireRole), not only by hiding buttons in the UI.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  acknowledgeWorkPermitAlert,
  cancelWorkPermitAlert,
  getWorkPermitStatus,
  recordWorkPermitHistory,
} from "../lib/workPermits";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WORK_PERMIT_ROLES = ["Administrator", "Manager"];

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

async function loadCurrentExpiry(employeeId: string): Promise<{ id: string; expiryDate: string | null } | null> {
  const { rows } = await pool.query(
    `select id, to_char(work_permit_expiry_date, 'YYYY-MM-DD') as expiry_date
     from employees where id = $1`,
    [employeeId]
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, expiryDate: row.expiry_date };
}

router.post(
  "/:id/acknowledge",
  requireAuth,
  requireRole(...WORK_PERMIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const employee = await loadCurrentExpiry(id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    if (!employee.expiryDate) return res.status(409).json({ error: "This employee has no work permit expiry date on file" });

    const result = await acknowledgeWorkPermitAlert(pool, id, employee.expiryDate, req.employee!.id);
    res.json({
      id: result.id,
      expiryDate: employee.expiryDate,
      acknowledgedAt: result.acknowledgedAt,
      acknowledgedBy: result.acknowledgedBy,
    });
  })
);

router.post(
  "/:id/renew",
  requireAuth,
  requireRole(...WORK_PERMIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const { newExpiryDate, reason } = req.body as { newExpiryDate?: unknown; reason?: unknown };
    if (!isValidDate(newExpiryDate)) {
      return res.status(400).json({ error: "A valid newExpiryDate is required" });
    }
    const trimmedReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;

    const employee = await loadCurrentExpiry(id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    if (!employee.expiryDate) {
      return res.status(409).json({ error: "This employee has no current work permit expiry date to renew" });
    }
    // Renewed specifically must move the date forward — this is the one
    // path with that requirement; ordinary profile editing (employees.ts)
    // deliberately allows a correction in either direction.
    if (newExpiryDate <= employee.expiryDate) {
      return res.status(422).json({ error: "The new expiry date must be later than the current expiry date" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`update employees set work_permit_expiry_date = $1 where id = $2`, [newExpiryDate, id]);
      await recordWorkPermitHistory(client, id, employee.expiryDate, newExpiryDate, req.employee!.id, trimmedReason);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true, previousExpiryDate: employee.expiryDate, newExpiryDate });
  })
);

router.post(
  "/:id/cancel-alert",
  requireAuth,
  requireRole(...WORK_PERMIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const { reason } = req.body as { reason?: unknown };
    const trimmedReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;

    const employee = await loadCurrentExpiry(id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    if (!employee.expiryDate) return res.status(409).json({ error: "This employee has no work permit expiry date on file" });

    await cancelWorkPermitAlert(pool, id, employee.expiryDate, req.employee!.id, trimmedReason);
    res.json({ ok: true, expiryDate: employee.expiryDate });
  })
);

// The employee profile's compact status line ("Valid until…" / "Alert
// acknowledged until…" / "Expired") — separate from the full history list
// below, and from the Dashboard's alert list (which only ever includes
// employees currently inside their notification window); this reflects a
// single employee's current state regardless of whether they're in that
// window yet.
router.get(
  "/:id/status",
  requireAuth,
  requireRole(...WORK_PERMIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const employee = await loadCurrentExpiry(id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const status = await getWorkPermitStatus(pool, id);
    res.json(status);
  })
);

router.get(
  "/:id/history",
  requireAuth,
  requireRole(...WORK_PERMIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const { rows } = await pool.query(
      `select h.id,
              to_char(h.old_expiry_date, 'YYYY-MM-DD') as old_expiry_date,
              to_char(h.new_expiry_date, 'YYYY-MM-DD') as new_expiry_date,
              h.changed_at, h.reason,
              e.first_name as changed_by_first_name, e.last_name as changed_by_last_name
       from employee_work_permit_history h
       join employees e on e.id = h.changed_by_employee_id
       where h.employee_id = $1
       order by h.changed_at desc`,
      [id]
    );
    res.json({
      history: rows.map((r) => ({
        id: r.id,
        oldExpiryDate: r.old_expiry_date,
        newExpiryDate: r.new_expiry_date,
        changedAt: r.changed_at,
        reason: r.reason,
        changedBy: `${r.changed_by_first_name} ${r.changed_by_last_name}`,
      })),
    });
  })
);

export default router;
