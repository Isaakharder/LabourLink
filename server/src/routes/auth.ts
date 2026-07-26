import { CookieOptions, Router } from "express";
import { pool } from "../db";
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

router.post("/login", async (req, res) => {
  const { email, pin } = req.body as { email?: string; pin?: string };

  if (!email || !pin) {
    return res.status(400).json({ error: "Email and PIN are required" });
  }

  const { rows } = await pool.query(
    `select e.id, e.first_name, e.last_name, e.settings_pin_hash, e.is_active,
            sr.name as security_role, tr.name as team_role
     from employees e
     join security_roles sr on sr.id = e.security_role_id
     join team_roles tr on tr.id = e.team_role_id
     where lower(e.email) = lower($1)`,
    [email]
  );

  const employee = rows[0];
  if (!employee || !employee.is_active) {
    return res.status(401).json({ error: "Invalid email or PIN" });
  }

  const valid = await verifyPin(pin, employee.settings_pin_hash);
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

  res.json({ employee: session });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  res.status(204).send();
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ employee: req.employee });
});

export default router;
