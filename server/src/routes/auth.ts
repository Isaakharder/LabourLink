import { CookieOptions, Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { verifyPin } from "../lib/pin";
import { requireAuth, signSession, SESSION_COOKIE } from "../middleware/auth";

const router = Router();

const isProduction = process.env.NODE_ENV === "production";

// Web and API are deployed as separate Railway services on separate
// subdomains, making every request cross-site. sameSite: "lax" only rides
// along on top-level navigations, not on credentialed fetch() calls across
// origins — it would silently drop the session cookie on every request. In
// production we need "none" (which itself requires secure: true). Locally,
// where both run on localhost, "lax" is fine and avoids needing HTTPS in dev.
const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
};

router.post("/login", asyncHandler(async (req, res) => {
  console.log("[login] 1. Login request received");

  const { email: rawEmail, pin } = req.body as { email?: string; pin?: string };

  if (!rawEmail || !pin) {
    return res.status(400).json({ error: "Email and PIN are required" });
  }

  // Must match the normalization createAdmin.ts applies at insert time —
  // otherwise case/whitespace variants of the same email can diverge.
  const email = rawEmail.trim().toLowerCase();

  // Acquiring a client and running the query are separated into two awaits
  // (rather than the usual pool.query shorthand) specifically so a failure
  // here is diagnosable as "couldn't get a connection" vs "query itself
  // failed" instead of one opaque catch block covering both.
  console.log("[login] 2. Attempting database connection");
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(
      "[login] FAILED at step 2 (acquire connection):",
      err instanceof Error ? err.message : err
    );
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  console.log("[login] 3. Database connection successful");

  let rows;
  try {
    try {
      ({ rows } = await client.query(
        `select e.id, e.first_name, e.last_name, e.settings_pin_hash, e.is_active,
                sr.name as security_role, tr.name as team_role
         from employees e
         join security_roles sr on sr.id = e.security_role_id
         join team_roles tr on tr.id = e.team_role_id
         where lower(trim(e.email)) = $1`,
        [email]
      ));
    } catch (err) {
      console.error(
        "[login] FAILED at step 4 (user lookup query):",
        err instanceof Error ? err.message : err
      );
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }
  } finally {
    client.release();
  }
  console.log("[login] 4. User lookup completed");

  const employee = rows[0];
  console.log(`[login] 5. User found: ${employee ? "yes" : "no"}`);
  // settings_pin_hash is nullable — employees created via the Employees page
  // have no PIN yet (desktop login isn't part of that form) and simply can't
  // log in until one is set some other way.
  if (!employee || !employee.is_active || !employee.settings_pin_hash) {
    return res.status(401).json({ error: "Invalid email or PIN" });
  }

  let valid: boolean;
  try {
    valid = await verifyPin(pin, employee.settings_pin_hash);
  } catch (err) {
    console.error(
      "[login] FAILED at step 6 (bcrypt verification):",
      err instanceof Error ? err.message : err
    );
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  console.log(`[login] 6. Password verification passed: ${valid ? "yes" : "no"}`);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or PIN" });
  }

  const session = {
    id: employee.id,
    firstName: employee.first_name,
    lastName: employee.last_name,
    securityRole: employee.security_role,
    teamRole: employee.team_role,
  };

  const token = signSession(session);
  res.cookie(SESSION_COOKIE, token, {
    ...sessionCookieOptions,
    maxAge: 12 * 60 * 60 * 1000,
  });
  console.log("[login] 7. Session created");

  res.json({ employee: session });
  console.log("[login] 8. Response sent");
}));

router.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  res.status(204).send();
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ employee: req.employee });
});

export default router;
