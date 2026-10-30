import { CookieOptions, NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db";
import { ACCESS_TOKEN_TTL_SECONDS, renewWebSession, sessionClock } from "../lib/webSessions";
import { AuthEmployee } from "../types/express";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set");
}

export const SESSION_COOKIE = "labourlink_session";
// The long-lived half of a sign-in (see lib/webSessions.ts). Scoped to /api
// so it is only ever sent to the API — every API call goes through /api,
// including via web/serve-static.js's same-origin proxy.
export const REFRESH_COOKIE = "labourlink_refresh";
const REFRESH_COOKIE_PATH = "/api";

const isProduction = process.env.NODE_ENV === "production";

// Web and API are deployed as separate Railway services on separate
// subdomains, making every request cross-site. sameSite: "lax" only rides
// along on top-level navigations, not on credentialed fetch() calls across
// origins — it would silently drop the session cookie on every request. In
// production we need "none" (which itself requires secure: true). Locally,
// where both run on localhost, "lax" is fine and avoids needing HTTPS in dev.
//
// This is a secondary line of defense only — the primary one is staying
// same-origin in the first place (see web/serve-static.js's proxy and
// web/src/lib/api.ts's resolveApiUrl()). sameSite: "none" cookies are still
// subject to Safari's full third-party cookie blocking (ITP) when a request
// actually is cross-site, which is silent (no error, the Set-Cookie is just
// never stored) — see README's Railway deploy notes for the config mistake
// that reintroduces that cross-site request in production.
export function getSessionCookieOptions(isProd: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
  };
}

const sessionCookieOptions: CookieOptions = getSessionCookieOptions(isProduction);
const refreshCookieOptions: CookieOptions = { ...sessionCookieOptions, path: REFRESH_COOKIE_PATH };

// `sessionId` ties the access token to its web_sessions row (absent only on
// pre-066 tokens, which simply run out). `expiresInSeconds` exists for long-running
// test scripts that mint one token up front; the app always uses the default.
export function signSession(
  employee: AuthEmployee,
  opts: { sessionId?: string; expiresInSeconds?: number } = {}
): string {
  const payload: AuthEmployee & { sid?: string; iat: number } = {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    securityRole: employee.securityRole,
    teamRole: employee.teamRole,
    iat: Math.floor(sessionClock.now() / 1000),
  };
  if (opts.sessionId) payload.sid = opts.sessionId;
  return jwt.sign(payload, JWT_SECRET as string, { expiresIn: opts.expiresInSeconds ?? ACCESS_TOKEN_TTL_SECONDS });
}

export function setSessionCookies(
  res: Response,
  access: { token: string },
  refresh?: { token: string; maxAgeMs: number }
): void {
  res.cookie(SESSION_COOKIE, access.token, { ...sessionCookieOptions, maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000 });
  if (refresh) res.cookie(REFRESH_COOKIE, refresh.token, { ...refreshCookieOptions, maxAge: refresh.maxAgeMs });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
}

// The access token's claims, or null if it is missing, forged or expired.
// `ignoreExpiration` is only for sign-out, which revokes the session an
// expired token still names.
export function verifyAccessToken(
  token: string | undefined,
  opts: { ignoreExpiration?: boolean } = {}
): (AuthEmployee & { sid?: string }) | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET as string, {
      clockTimestamp: Math.floor(sessionClock.now() / 1000),
      ignoreExpiration: opts.ignoreExpiration ?? false,
    }) as AuthEmployee & { sid?: string };
    return payload;
  } catch {
    return null;
  }
}

function toAuthEmployee(p: AuthEmployee): AuthEmployee {
  return { id: p.id, firstName: p.firstName, lastName: p.lastName, securityRole: p.securityRole, teamRole: p.teamRole };
}

// A valid access token passes straight through with no database work. Once
// it has expired (or its cookie has aged out), the refresh cookie silently
// renews it — so a sign-in survives overnight, browser restarts and any
// number of tabs. A bare 401 (no `code`) still means "signed out" to the
// web client (web/src/lib/api.ts's onSessionExpired), so it is only sent
// when there is genuinely nothing to renew from. A database failure during
// renewal is a 503: the client keeps the user signed in and retries.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const accessToken: string | undefined = req.cookies?.[SESSION_COOKIE];
  const claims = verifyAccessToken(accessToken);
  if (claims) {
    req.employee = toAuthEmployee(claims);
    return next();
  }

  const refreshToken: string | undefined = req.cookies?.[REFRESH_COOKIE];
  if (!refreshToken) {
    return res.status(401).json({ error: accessToken ? "Session expired or invalid" : "Not authenticated" });
  }

  renewWebSession(pool, refreshToken).then(
    (renewed) => {
      if (!renewed) {
        clearSessionCookies(res);
        return res.status(401).json({ error: "Session expired or invalid" });
      }
      setSessionCookies(
        res,
        { token: signSession(renewed.employee, { sessionId: renewed.sessionId }) },
        { token: refreshToken, maxAgeMs: renewed.refreshCookieMaxAgeMs }
      );
      req.employee = renewed.employee;
      next();
    },
    (err) => {
      console.error("[auth] session renewal failed:", err instanceof Error ? err.message : err);
      res.status(503).json({ error: "Service temporarily unavailable" });
    }
  );
}

export function requireRole(...allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.employee) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!allowed.includes(req.employee.securityRole)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
