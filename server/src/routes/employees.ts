import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

// Only consumer today is the Setup page's device-assignment dropdown, which
// is itself Administrator/Manager-only — match that here rather than
// exposing the employee list to every logged-in role.
router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select id, first_name, last_name from employees
       where is_active = true
       order by first_name, last_name`
    );
    res.json({ employees: rows });
  })
);

export default router;
