import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { sendPinResetEmail } from "../lib/email";
import { hashPin } from "../lib/pin";
import { generateResetToken, hashResetToken, RESET_TOKEN_TTL_MINUTES } from "../lib/resetToken";

const router = Router();

// Identical wording regardless of whether the email matched — distinguishing
// the two responses would turn this endpoint into an account-enumeration
// oracle.
const GENERIC_REQUEST_MESSAGE = "If that email is registered, a reset link has been sent.";

router.post(
  "/request",
  asyncHandler(async (req, res) => {
    const { email: rawEmail } = req.body as { email?: string };
    if (!rawEmail) {
      return res.status(400).json({ error: "Email is required" });
    }
    const email = rawEmail.trim().toLowerCase();

    const { rows } = await pool.query(
      `select id, first_name from employees
       where lower(trim(email)) = $1 and is_active = true and settings_pin_hash is not null`,
      [email]
    );
    const employee = rows[0];

    if (!employee) {
      return res.json({ message: GENERIC_REQUEST_MESSAGE });
    }

    const { token, tokenHash } = generateResetToken();
    const client = await pool.connect();
    try {
      await client.query("begin");
      // A fresh click supersedes any earlier still-pending link for this
      // employee rather than piling up (see idx_..._one_pending_per_employee).
      await client.query(
        `update password_reset_requests set status = 'expired'
         where employee_id = $1 and status = 'pending'`,
        [employee.id]
      );
      await client.query(
        `insert into password_reset_requests (employee_id, token_hash, expires_at)
         values ($1, $2, now() + interval '${RESET_TOKEN_TTL_MINUTES} minutes')`,
        [employee.id, tokenHash]
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const resetUrl = `${process.env.WEB_APP_URL}/reset-pin?token=${token}`;
    try {
      await sendPinResetEmail(email, employee.first_name, resetUrl);
    } catch (err) {
      // Logged, not surfaced — surfacing email-infra failures to the client
      // would itself leak whether the email matched an employee.
      console.error("[password-reset] failed to send reset email:", err);
    }

    res.json({ message: GENERIC_REQUEST_MESSAGE });
  })
);

router.post(
  "/confirm",
  asyncHandler(async (req, res) => {
    const { token, pin } = req.body as { token?: string; pin?: string };
    if (!token || !pin) {
      return res.status(400).json({ error: "Token and PIN are required" });
    }
    // Same validation convention as createAdmin.ts.
    if (!/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: "PIN must be 4-8 digits" });
    }

    const tokenHash = hashResetToken(token);
    const client = await pool.connect();
    try {
      await client.query("begin");

      const reqRow = await client.query(
        `select id, employee_id from password_reset_requests
         where token_hash = $1 and status = 'pending' and expires_at > now()
         for update`,
        [tokenHash]
      );
      if (!reqRow.rows[0]) {
        await client.query("rollback");
        return res.status(400).json({ error: "This reset link is invalid or has expired" });
      }
      const { id: requestId, employee_id: employeeId } = reqRow.rows[0];

      const pinHash = await hashPin(pin);
      await client.query(
        `update employees set settings_pin_hash = $1, updated_at = now() where id = $2`,
        [pinHash, employeeId]
      );
      await client.query(
        `update password_reset_requests set status = 'used', used_at = now() where id = $1`,
        [requestId]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ message: "PIN reset successfully. You can now log in." });
  })
);

export default router;
