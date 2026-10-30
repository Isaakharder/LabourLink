// Real-HTTP-against-real-database coverage for desktop sign-in lifetime
// (lib/webSessions.ts, middleware/auth.ts's silent renewal, routes/auth.ts).
// The bug: a sign-in was one 12-hour JWT cookie with no renewal, so the
// office app was always back on the login screen the next morning.
//
// Time is advanced by replacing Date.now (which both jsonwebtoken and
// sessionClock read), so "overnight", "a week" and "a month" take
// milliseconds. A small cookie jar stands in for the browser: it honours
// Max-Age against that same clock, Path, and deletion, and "restarting the
// browser" drops every cookie that has no Max-Age/Expires, as a real browser
// does.
//
// Run with: npm run test:auth-web-sessions
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { hashPin } from "../lib/pin";
import { generateResetToken } from "../lib/resetToken";
import authRouter from "./auth";
import employeesRouter from "./employees";
import passwordResetRouter from "./passwordReset";

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

const realDateNow = Date.now;
let clockOffsetMs = 0;
Date.now = () => realDateNow() + clockOffsetMs;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
function advance(ms: number) {
  clockOffsetMs += ms;
}

interface StoredCookie {
  value: string;
  path: string;
  expiresAt: number | null; // null = session cookie (gone on browser restart)
}

// One browser profile: every tab shares it, like a real cookie store.
class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  store(setCookieHeaders: string[]) {
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(";").map((p) => p.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = decodeURIComponent(pair.slice(eq + 1));
      let path = "/";
      let expiresAt: number | null = null;
      for (const attr of attrs) {
        const [k, v] = attr.split("=");
        const key = k.toLowerCase();
        if (key === "path") path = v;
        else if (key === "max-age") expiresAt = Date.now() + Number(v) * 1000;
        else if (key === "expires" && expiresAt === null) expiresAt = new Date(v).getTime();
      }
      if (expiresAt !== null && expiresAt <= Date.now()) this.cookies.delete(name);
      else this.cookies.set(name, { value, path, expiresAt });
    }
  }

  header(path: string): string {
    const now = Date.now();
    return [...this.cookies.entries()]
      .filter(([, c]) => (c.expiresAt === null || c.expiresAt > now) && path.startsWith(c.path))
      .map(([name, c]) => `${name}=${encodeURIComponent(c.value)}`)
      .join("; ");
  }

  get(name: string): StoredCookie | undefined {
    return this.cookies.get(name);
  }

  set(name: string, cookie: StoredCookie) {
    this.cookies.set(name, cookie);
  }

  restartBrowser() {
    for (const [name, c] of this.cookies) if (c.expiresAt === null) this.cookies.delete(name);
  }
}

const RUN_ID = Date.now();

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  app.use("/api/employees", employeesRouter);
  app.use("/api/password-reset", passwordResetRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(jar: CookieJar, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const cookie = jar.header(path);
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    jar.store(res.headers.getSetCookie());
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  }

  const employeeIds: string[] = [];
  const PIN = "4826";

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const pinHash = await hashPin(PIN);

    async function makeEmployee(label: string, role: string): Promise<{ id: string; email: string }> {
      const email = `qa-web-session-${label.toLowerCase()}-${RUN_ID}@test.local`;
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [`Session ${label} ${RUN_ID}`, email, await roleId(role), teamRoleId, pinHash]
        )
      ).rows[0].id;
      employeeIds.push(id);
      return { id, email };
    }

    async function signIn(jar: CookieJar, email: string) {
      const res = await call(jar, "POST", "/api/auth/login", { email, pin: PIN });
      check(res.status === 200, `sign-in ${email} -> 200`, res);
      return res;
    }

    // =====================================================================
    // 1) The reported bug: signed in during the day, still signed in the
    //    next morning — across a browser restart — as the same employee.
    // =====================================================================
    {
      const manager = await makeEmployee("Morning", "Manager");
      const jar = new CookieJar();
      await signIn(jar, manager.email);

      const access = jar.get("labourlink_session");
      const refresh = jar.get("labourlink_refresh");
      check(!!access, "sign-in sets the access cookie");
      check(!!refresh, "sign-in sets a refresh cookie", { refresh });
      check(refresh?.path === "/api", "refresh cookie is scoped to /api", refresh);
      check(
        !!access?.expiresAt && access.expiresAt - Date.now() <= 15 * MINUTE,
        "access cookie is short-lived (no long-lived access token)",
        { minutes: access?.expiresAt ? (access.expiresAt - Date.now()) / MINUTE : null }
      );

      // Access token expiry mid-day: renewed silently on the next request.
      advance(11 * MINUTE);
      const midday = await call(jar, "GET", "/api/auth/me");
      check(midday.status === 200, "11 min later (access token expired) -> still signed in", midday);
      check(
        (jar.get("labourlink_session")?.expiresAt ?? 0) > Date.now(),
        "the expired access token was silently replaced"
      );

      // Overnight with the browser closed (and no network traffic at all).
      advance(16 * HOUR);
      jar.restartBrowser();
      const morning = await call(jar, "GET", "/api/auth/me");
      check(morning.status === 200, "next morning after a browser restart -> still signed in", morning);
      check(morning.body?.employee?.id === manager.id, "restored as the same employee", morning.body);
      check(morning.body?.employee?.securityRole === "Manager", "restored with the same role", morning.body);
      check(
        morning.body?.employee && !("iat" in morning.body.employee) && !("sid" in morning.body.employee),
        "/me exposes the employee only, no token internals",
        morning.body
      );

      // A normal working week, plus a weekend away: at least 7 days.
      for (let day = 1; day <= 8; day++) {
        advance(day === 6 ? 3 * DAY : DAY);
        jar.restartBrowser();
        const res = await call(jar, "GET", "/api/auth/me");
        check(res.status === 200, `day ${day} of daily use -> still signed in`, res);
      }
    }

    // =====================================================================
    // 2) Several tabs: they share one cookie store and all renew at once
    //    after the access token expires. None of them signs the others out.
    // =====================================================================
    {
      const user = await makeEmployee("Tabs", "Administrator");
      const jar = new CookieJar();
      await signIn(jar, user.email);
      advance(30 * MINUTE);
      const results = await Promise.all(Array.from({ length: 6 }, () => call(jar, "GET", "/api/auth/me")));
      check(results.every((r) => r.status === 200), "6 tabs renewing simultaneously -> all 200", results.map((r) => r.status));
      advance(30 * MINUTE);
      const after = await call(jar, "GET", "/api/auth/me");
      check(after.status === 200, "after the simultaneous renewal the session still works", after);
    }

    // =====================================================================
    // 3) Explicit sign-out removes the session for good — even if a copy of
    //    the old refresh token is replayed later.
    // =====================================================================
    {
      const user = await makeEmployee("SignOut", "Administrator");
      const jar = new CookieJar();
      await signIn(jar, user.email);
      const savedRefresh = jar.get("labourlink_refresh")!;
      const out = await call(jar, "POST", "/api/auth/logout");
      check(out.status === 204, "sign-out -> 204", out);
      check(!jar.get("labourlink_session") && !jar.get("labourlink_refresh"), "sign-out clears both cookies");
      const me = await call(jar, "GET", "/api/auth/me");
      check(me.status === 401, "after sign-out -> 401", me);

      const thief = new CookieJar();
      thief.set("labourlink_refresh", savedRefresh);
      const replay = await call(thief, "GET", "/api/auth/me");
      check(replay.status === 401, "replaying a signed-out refresh token -> 401", replay);
      check(replay.body?.code === undefined, "the 401 has no code (reads as signed out on the web client)", replay.body);

      // Sign-out with an already-expired access token still revokes.
      const jar2 = new CookieJar();
      await signIn(jar2, user.email);
      const saved2 = jar2.get("labourlink_refresh")!;
      advance(20 * MINUTE);
      const out2 = await call(jar2, "POST", "/api/auth/logout");
      check(out2.status === 204, "sign-out with an expired access token -> 204", out2);
      const thief2 = new CookieJar();
      thief2.set("labourlink_refresh", saved2);
      check((await call(thief2, "GET", "/api/auth/me")).status === 401, "...and that session is revoked too");
    }

    // =====================================================================
    // 4) Revoked or invalid sessions are not authorized.
    // =====================================================================
    {
      // A refresh token the server never issued.
      const forged = new CookieJar();
      forged.set("labourlink_refresh", { value: "not-a-real-token", path: "/api", expiresAt: null });
      const res = await call(forged, "GET", "/api/auth/me");
      check(res.status === 401, "unknown refresh token -> 401", res);
      check(!forged.get("labourlink_refresh"), "an unusable refresh cookie is cleared");

      // Deactivated through the Employees page: every browser is signed out.
      const admin = await makeEmployee("Admin", "Administrator");
      const target = await makeEmployee("Deactivated", "Manager");
      const adminJar = new CookieJar();
      await signIn(adminJar, admin.email);
      const targetJar = new CookieJar();
      await signIn(targetJar, target.email);
      const patch = await call(adminJar, "PATCH", `/api/employees/${target.id}`, { isActive: false });
      check(patch.status === 200, "admin deactivates the employee -> 200", patch.status);
      const revoked = (
        await pool.query(`select count(*)::int as n from web_sessions where employee_id = $1 and revoked_at is null`, [target.id])
      ).rows[0].n;
      check(revoked === 0, "deactivation revokes the employee's sessions", { live: revoked });
      advance(11 * MINUTE);
      check((await call(targetJar, "GET", "/api/auth/me")).status === 401, "deactivated employee -> 401 once the access token lapses");

      // Deactivated directly in the database (no revoke ran): renewal still refuses.
      const direct = await makeEmployee("DirectInactive", "Manager");
      const directJar = new CookieJar();
      await signIn(directJar, direct.email);
      await pool.query(`update employees set is_active = false where id = $1`, [direct.id]);
      advance(11 * MINUTE);
      check((await call(directJar, "GET", "/api/auth/me")).status === 401, "inactive employee cannot renew");
      const reason = (await pool.query(`select revoked_reason from web_sessions where employee_id = $1`, [direct.id])).rows[0];
      check(reason?.revoked_reason === "employee_inactive", "...and the refused session is revoked", reason);

      // A role change is picked up at the next renewal.
      const promoted = await makeEmployee("Promoted", "Employee");
      const promotedJar = new CookieJar();
      await signIn(promotedJar, promoted.email);
      await pool.query(`update employees set security_role_id = $2 where id = $1`, [promoted.id, await roleId("Manager")]);
      advance(11 * MINUTE);
      const me = await call(promotedJar, "GET", "/api/auth/me");
      check(me.body?.employee?.securityRole === "Manager", "renewal picks up the current role", me.body);

      // A PIN reset signs the employee out everywhere.
      const resetUser = await makeEmployee("PinReset", "Manager");
      const resetJar = new CookieJar();
      await signIn(resetJar, resetUser.email);
      const { token, tokenHash } = generateResetToken();
      await pool.query(
        `insert into password_reset_requests (employee_id, token_hash, expires_at) values ($1, $2, now() + interval '30 minutes')`,
        [resetUser.id, tokenHash]
      );
      const confirm = await call(new CookieJar(), "POST", "/api/password-reset/confirm", { token, pin: "9137" });
      check(confirm.status === 200, "PIN reset -> 200", confirm);
      advance(11 * MINUTE);
      check((await call(resetJar, "GET", "/api/auth/me")).status === 401, "PIN reset signs out existing browsers");
    }

    // =====================================================================
    // 5) Lifetime limits: an unused sign-in lapses after 14 idle days, and
    //    any sign-in ends 30 days after it was made.
    // =====================================================================
    {
      const user = await makeEmployee("Idle", "Manager");
      const idleJar = new CookieJar();
      await signIn(idleJar, user.email);
      advance(13 * DAY);
      check((await call(idleJar, "GET", "/api/auth/me")).status === 200, "13 idle days -> still signed in");
      advance(15 * DAY);
      check((await call(idleJar, "GET", "/api/auth/me")).status === 401, "15 idle days after last use -> signed out");

      const daily = new CookieJar();
      await signIn(daily, user.email);
      let lastOk = 0;
      for (let day = 1; day <= 31; day++) {
        advance(DAY);
        if ((await call(daily, "GET", "/api/auth/me")).status === 200) lastOk = day;
      }
      check(lastOk === 29, "daily use: signed in through day 29, out by day 31 (30-day cap)", { lastOk });
    }

    // =====================================================================
    // 6) The database being unreachable during renewal is "try again"
    //    (503), never "signed out" (401) — the overnight outage case.
    // =====================================================================
    {
      const user = await makeEmployee("DbDown", "Manager");
      const jar = new CookieJar();
      await signIn(jar, user.email);
      advance(16 * HOUR);
      const realQuery = pool.query.bind(pool);
      (pool as unknown as { query: unknown }).query = () => Promise.reject(new Error("connect ETIMEDOUT"));
      let down;
      try {
        down = await call(jar, "GET", "/api/auth/me");
      } finally {
        (pool as unknown as { query: unknown }).query = realQuery;
      }
      check(down.status === 503, "database unreachable during renewal -> 503, not 401", down);
      check(!!jar.get("labourlink_refresh"), "...and the refresh cookie is kept");
      const back = await call(jar, "GET", "/api/auth/me");
      check(back.status === 200, "once the database is back -> signed in again, no login needed", back);
    }
  } finally {
    Date.now = realDateNow;
    if (employeeIds.length > 0) {
      await pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
    }
    server.close();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
