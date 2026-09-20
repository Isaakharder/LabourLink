// requireAuth/signSession never touch the database, so this runs against a
// real HTTP server but with no DATABASE_URL required — same "real HTTP, no
// mocking" convention as the DB-backed route tests, just without the DB.
//
// Covers the desktop stale-auth investigation: every 401 requireAuth emits
// must have no `code` field (see web/src/lib/api.ts's onSessionExpired,
// which relies on exactly that to tell "the session died" apart from a
// coded device-auth rejection), and must actually cover both the "no
// cookie at all" and "cookie present but invalid/expired" cases with
// distinct messages.
//
// Run with: npm run test:auth-middleware
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-auth-middleware-test";

import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { AddressInfo } from "net";
import { requireAuth, requireRole, signSession, SESSION_COOKIE } from "./auth";
import { AuthEmployee } from "../types/express";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

async function main() {
  const app = express();
  app.use(cookieParser());
  app.get("/protected", requireAuth, (req, res) => res.json({ employee: req.employee }));
  app.get(
    "/admin-only",
    requireAuth,
    requireRole("Administrator"),
    (_req, res) => res.json({ ok: true })
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(path: string, cookieValue?: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      headers: cookieValue ? { Cookie: `${SESSION_COOKIE}=${cookieValue}` } : {},
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const employee: AuthEmployee = {
    id: "emp-1",
    firstName: "Isaak",
    lastName: "Harder",
    securityRole: "Administrator",
    teamRole: "Team Member",
  };

  try {
    // No cookie at all — the normal "never logged in" / cookie never
    // stored (e.g. Safari ITP dropped it) case.
    {
      const { status, body } = await call("/protected");
      check(status === 401, "no cookie -> 401", { status });
      check(body.error === "Not authenticated", "no cookie -> 'Not authenticated' message", body);
      check(body.code === undefined, "no cookie -> no `code` field (must read as session-type, not device-type)", body);
    }

    // A syntactically invalid token (never a real cookie value, but also
    // covers "cookie present but garbage").
    {
      const { status, body } = await call("/protected", "not-a-real-jwt");
      check(status === 401, "malformed token -> 401", { status });
      check(body.error === "Session expired or invalid", "malformed token -> distinct message", body);
      check(body.code === undefined, "malformed token -> no `code` field", body);
    }

    // A validly-signed but expired token — the actual "12h session ran out
    // mid-use" case this investigation is about.
    {
      const expired = jwt.sign(employee, process.env.JWT_SECRET as string, { expiresIn: -10 });
      const { status, body } = await call("/protected", expired);
      check(status === 401, "expired token -> 401", { status });
      check(body.error === "Session expired or invalid", "expired token -> 'Session expired or invalid'", body);
      check(body.code === undefined, "expired token -> no `code` field", body);
    }

    // A token signed with a different secret (can't happen from this app's
    // own signSession, but proves requireAuth actually verifies rather than
    // just decoding).
    {
      const forged = jwt.sign(employee, "wrong-secret", { expiresIn: "12h" });
      const { status, body } = await call("/protected", forged);
      check(status === 401, "wrong-secret token -> 401", { status });
      check(body.error === "Session expired or invalid", "wrong-secret token -> rejected as invalid", body);
    }

    // The happy path: a real signSession()-issued token round-trips through
    // requireAuth and populates req.employee.
    {
      const token = signSession(employee);
      const { status, body } = await call("/protected", token);
      check(status === 200, "valid session -> 200", { status });
      check(body.employee?.id === employee.id, "valid session -> req.employee populated", body);
    }

    // requireRole: insufficient permissions is a 403, never a 401 — must
    // never be confused with a dead session by the client's global
    // session-expired handling.
    {
      const nonAdmin = signSession({ ...employee, securityRole: "Employee" });
      const { status, body } = await call("/admin-only", nonAdmin);
      check(status === 403, "wrong role -> 403, not 401", { status });
      check(body.error === "Insufficient permissions", "wrong role -> permissions message", body);
    }
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
