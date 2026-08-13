// Integration tests for Greenhouse -> Display's TV link UI backend
// (routes/greenhouseDisplays.ts + displayAuth.ts's TV-facing lookup in
// routes/greenhouseLive.ts): the display's raw token is now persisted
// (display_key_plaintext, 036_greenhouse_display_key_plaintext.sql)
// alongside its existing hash so an Administrator can retrieve/copy it
// again later, not just at the moment it's generated. Same convention as
// carriers.test.ts: real router over real HTTP against the real database,
// signSession() session tokens (requireAuth only checks the JWT signature,
// no DB employee row needed), RUN_ID-suffixed disposable QA fixtures,
// cleanup in a `finally` block regardless of pass/fail.
//
// Covers: create returns a tvToken that's also retrievable on a later GET,
// a Manager (allowed to view displays but not manage TV links) never
// receives it, regenerate mints a genuinely new token and the old one stops
// working on the TV-facing endpoint while the new one works immediately, a
// Manager can't regenerate at all, and a legacy display (hash only, no
// stored plaintext) correctly reports tvToken: null rather than a stale or
// wrong value.
//
// Run with: npm run test:greenhouse-displays
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { hashDisplayKey } from "../lib/displayToken";
import greenhouseDisplaysRouter from "./greenhouseDisplays";
import greenhouseLiveRouter from "./greenhouseLive";

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

const RUN_ID = Date.now();

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/greenhouse/displays", greenhouseDisplaysRouter);
  app.use("/api/greenhouse", greenhouseLiveRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const adminToken = signSession({
    id: randomUUID(),
    firstName: "QA",
    lastName: `Displays Admin ${RUN_ID}`,
    securityRole: "Administrator",
    teamRole: "Team Member",
  });
  const managerToken = signSession({
    id: randomUUID(),
    firstName: "QA",
    lastName: `Displays Manager ${RUN_ID}`,
    securityRole: "Manager",
    teamRole: "Team Member",
  });

  const displayIds: string[] = [];
  let landId!: string;

  try {
    landId = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`,
        [`QA Displays Land ${RUN_ID}`]
      )
    ).rows[0].id;

    // -----------------------------------------------------------------
    // A) creating a display (Administrator) returns a usable token, and
    //    the display object's own tvToken matches it exactly — the two
    //    are never allowed to drift.
    // -----------------------------------------------------------------
    const created = await call("POST", "/api/greenhouse/displays", {
      token: adminToken,
      body: { name: `QA Display ${RUN_ID}`, landId },
    });
    check(created.status === 201 && typeof created.body?.token === "string" && created.body.token.length > 0, "A) create succeeds and returns a token", created.body);
    const displayId = created.body?.display?.id as string;
    if (displayId) displayIds.push(displayId);
    const firstToken = created.body?.token as string;
    check(created.body?.display?.tvToken === firstToken, "B) the created display's own tvToken matches the returned token exactly", created.body);

    // -----------------------------------------------------------------
    // C) the same token is retrievable again on a later GET — the whole
    //    point of this feature (previously only ever returned once).
    // -----------------------------------------------------------------
    const listAfterCreate = await call("GET", "/api/greenhouse/displays", { token: adminToken });
    const foundAsAdmin = listAfterCreate.body?.displays?.find((d: any) => d.id === displayId);
    check(
      listAfterCreate.status === 200 && foundAsAdmin?.tvToken === firstToken,
      "C) an Administrator can retrieve the same TV token again on a later GET /displays",
      foundAsAdmin
    );

    // -----------------------------------------------------------------
    // D) a Manager can see the display (allowed to view/publish) but
    //    never receives its TV token — only Administrator can manage TV
    //    links, so only Administrator ever sees the raw token.
    // -----------------------------------------------------------------
    const listAsManager = await call("GET", "/api/greenhouse/displays", { token: managerToken });
    const foundAsManager = listAsManager.body?.displays?.find((d: any) => d.id === displayId);
    check(
      listAsManager.status === 200 && foundAsManager !== undefined && foundAsManager.tvToken === null,
      "D) a Manager sees the display but its tvToken is always null for them",
      foundAsManager
    );

    // -----------------------------------------------------------------
    // E) the freshly created token actually works on the TV-facing,
    //    token-authed endpoint (no session needed).
    // -----------------------------------------------------------------
    const tvBeforeRegenerate = await call("GET", `/api/greenhouse/display/${firstToken}/state`);
    check(tvBeforeRegenerate.status === 200, "E) the TV endpoint accepts the freshly created token", tvBeforeRegenerate.body);

    // -----------------------------------------------------------------
    // F) a Manager cannot regenerate a TV link at all (Administrator-only).
    // -----------------------------------------------------------------
    const managerRegenerate = await call("POST", `/api/greenhouse/displays/${displayId}/regenerate-key`, {
      token: managerToken,
    });
    check(managerRegenerate.status === 403, "F) a Manager is rejected (403) attempting to regenerate a TV link", managerRegenerate);

    // -----------------------------------------------------------------
    // G) regenerating (Administrator) mints a genuinely different token,
    //    the old one immediately stops working on the TV endpoint, and
    //    the new one works right away — matches the confirmation
    //    dialog's own warning that the old link may go blank until
    //    reopened with the new one.
    // -----------------------------------------------------------------
    const regenerated = await call("POST", `/api/greenhouse/displays/${displayId}/regenerate-key`, { token: adminToken });
    const secondToken = regenerated.body?.token as string;
    check(
      regenerated.status === 200 && typeof secondToken === "string" && secondToken !== firstToken,
      "G) regenerate returns a new, different token",
      regenerated.body
    );

    const tvOldTokenAfterRegenerate = await call("GET", `/api/greenhouse/display/${firstToken}/state`);
    check(tvOldTokenAfterRegenerate.status === 404, "H) the OLD token 404s on the TV endpoint immediately after regenerating", tvOldTokenAfterRegenerate);

    const tvNewTokenAfterRegenerate = await call("GET", `/api/greenhouse/display/${secondToken}/state`);
    check(tvNewTokenAfterRegenerate.status === 200, "I) the NEW token works on the TV endpoint immediately", tvNewTokenAfterRegenerate.body);

    const listAfterRegenerate = await call("GET", "/api/greenhouse/displays", { token: adminToken });
    const foundAfterRegenerate = listAfterRegenerate.body?.displays?.find((d: any) => d.id === displayId);
    check(
      foundAfterRegenerate?.tvToken === secondToken,
      "J) GET /displays now reflects the regenerated token, not the old one — the URL shown in the office is never stale",
      foundAfterRegenerate
    );

    // -----------------------------------------------------------------
    // K) a legacy-style display — a real, currently-working hash but no
    //    stored plaintext (simulating a row created before this column
    //    existed) — reports tvToken: null rather than guessing/exposing
    //    anything, even to an Administrator. Its hash-based TV link still
    //    works exactly as before; only the office-side "show it again"
    //    convenience is unavailable until it's regenerated.
    // -----------------------------------------------------------------
    const legacyToken = randomUUID();
    const legacy = (
      await pool.query(
        `insert into greenhouse_displays (name, display_key_hash, display_key_plaintext, land_id, date_start, date_end)
         values ($1, $2, null, $3, current_date, current_date)
         returning id`,
        [`QA Legacy Display ${RUN_ID}`, hashDisplayKey(legacyToken), landId]
      )
    ).rows[0].id;
    displayIds.push(legacy);

    const listWithLegacy = await call("GET", "/api/greenhouse/displays", { token: adminToken });
    const foundLegacy = listWithLegacy.body?.displays?.find((d: any) => d.id === legacy);
    check(
      foundLegacy !== undefined && foundLegacy.tvToken === null,
      "K) a legacy display (hash only, no stored plaintext) reports tvToken: null even to an Administrator",
      foundLegacy
    );
    const tvLegacyStillWorks = await call("GET", `/api/greenhouse/display/${legacyToken}/state`);
    check(tvLegacyStillWorks.status === 200, "L) the legacy display's original (hash-only) TV link still works — nothing broke by adding this column", tvLegacyStillWorks.body);
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      if (displayIds.length > 0) {
        await client.query(`delete from greenhouse_displays where id = any($1::uuid[])`, [displayIds]);
      }
      await client.query(`delete from greenhouse_displays where name like $1`, [`QA%Display ${RUN_ID}%`]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }

    const leftover = await pool.query(`select count(*) from greenhouse_displays where name like $1`, [`QA%Display ${RUN_ID}%`]);
    check(Number(leftover.rows[0].count) === 0, "M) all QA fixtures cleaned up, none left orphaned");

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
