import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { verifyPin } from "../lib/pin";
import {
  clearSessionCookies,
  getSessionCookieOptions,
  REFRESH_COOKIE,
  requireAuth,
  SESSION_COOKIE,
  setSessionCookies,
  signSession,
  verifyAccessToken,
} from "../middleware/auth";
import { createWebSession, revokeWebSession, revokeWebSessionByToken } from "../lib/webSessions";

const router = Router();

// Moved to middleware/auth.ts (requireAuth now sets cookies too when it
// silently renews a session); re-exported for auth.sessionCookie.test.ts.
export { getSessionCookieOptions };

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

  let created;
  try {
    created = await createWebSession(pool, employee.id);
  } catch (err) {
    console.error(
      "[login] FAILED at step 7 (create session):",
      err instanceof Error ? err.message : err
    );
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  setSessionCookies(
    res,
    { token: signSession(session, { sessionId: created.sessionId }) },
    { token: created.refreshToken, maxAgeMs: created.refreshCookieMaxAgeMs }
  );
  console.log("[login] 7. Session created");

  res.json({ employee: session });
  console.log("[login] 8. Response sent");
}));

// Never 401s: signing out must work with an expired access token. The row is
// revoked by whichever handle the browser still has — the refresh token, or
// the session id inside a (possibly expired) access token. If the database
// can't be reached the cookies are kept and the 503 tells the web client to
// retry (it has already dropped the signed-in state locally — see
// AuthContext's pending sign-out), so the row is never left live with no
// one able to revoke it.
router.post("/logout", asyncHandler(async (req, res) => {
  const refreshToken: string | undefined = req.cookies?.[REFRESH_COOKIE];
  const sessionId = verifyAccessToken(req.cookies?.[SESSION_COOKIE], { ignoreExpiration: true })?.sid;
  try {
    if (refreshToken) await revokeWebSessionByToken(pool, refreshToken, "signed_out");
    if (sessionId) await revokeWebSession(pool, sessionId, "signed_out");
  } catch (err) {
    console.error("[logout] session revoke failed:", err instanceof Error ? err.message : err);
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  clearSessionCookies(res);
  res.status(204).send();
}));

router.get("/me", requireAuth, (req, res) => {
  res.json({ employee: req.employee });
});

export default router;
