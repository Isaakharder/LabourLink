// App-store reviewer access on the DEMO instance: reviewer codes (create /
// revoke / rotate through the real CLI), multi-device pairing, and the full
// mobile workflow a reviewer goes through, end to end over HTTP.
//
// Writes reviewer devices/employees into the database it runs against, so it
// refuses unless that database is a seeded demo instance on this machine:
//   LABOURLINK_DEMO_INSTANCE=true npm run demo:seed     (once, local demo DB)
//   DATABASE_URL=<local demo db> npm run test:reviewer-pairing
import "dotenv/config";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import path from "path";
import { pool } from "../db";
import { hasDemoInstanceMarker } from "../lib/demoInstance";
import mobileEmployeesRouter from "./mobileEmployees";
import mobileMessagesRouter from "./mobileMessages";
import mobileStatsRouter from "./mobileStats";
import mobileTimeRouter from "./mobileTime";
import nfcTagsRouter from "./nfcTags";
import pairingRouter from "./pairing";
import reviewerPairingRouter, { _resetReviewerThrottleForTests, REVIEWER_WELCOME_MESSAGE } from "./reviewerPairing";

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

const SERVER_ROOT = path.join(__dirname, "..", "..");

function credentialsCli(...args: string[]): string {
  return execFileSync(process.execPath, ["-r", "ts-node/register", "src/cli/reviewerCredentials.ts", ...args], {
    cwd: SERVER_ROOT,
    env: process.env,
    encoding: "utf8",
  });
}

function createCode(label: string, maxDevices?: number): { id: string; code: string } {
  const out = credentialsCli("create", label, ...(maxDevices ? ["--max-devices", String(maxDevices)] : []));
  const id = /id: '([0-9a-f-]{36})'/.exec(out)?.[1];
  const code = /^\s+(DEMO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m.exec(out)?.[1];
  if (!id || !code) throw new Error(`Could not parse CLI output:\n${out}`);
  return { id, code };
}

async function main() {
  const dbHost = new URL(process.env.DATABASE_URL ?? "postgres://invalid").hostname;
  if (!["127.0.0.1", "localhost"].includes(dbHost) || !(await hasDemoInstanceMarker(pool))) {
    throw new Error("Refusing to run: DATABASE_URL must be a seeded demo instance on this machine (see header).");
  }

  const app = express();
  app.use(express.json());
  app.use("/api/pairing", pairingRouter);
  app.use("/api/pairing", reviewerPairingRouter);
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/mobile", mobileMessagesRouter);
  app.use("/api/mobile/employees", mobileEmployeesRouter);
  app.use("/api/mobile", mobileStatsRouter);
  app.use("/api/mobile/tags", nfcTagsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, p: string, body?: unknown, deviceId?: string) {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...(deviceId ? { "X-Device-Id": deviceId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  const redeem = (deviceIdentifier: string, code: string) => call("POST", "/api/pairing/reviewer", { deviceIdentifier, code });

  try {
    // ---- Gate: without the demo flag the endpoint does not exist ---------
    delete process.env.LABOURLINK_DEMO_INSTANCE;
    const gated = await redeem(`qa-reviewer-gated-${randomUUID()}`, "DEMO-AAAA-BBBB-CCCC");
    check(gated.status === 404, "flag off: POST /api/pairing/reviewer is 404", gated);
    process.env.LABOURLINK_DEMO_INSTANCE = "true";
    const target = await call("GET", "/api/pairing/reviewer-target");
    check(target.status === 404, "a demo instance never advertises a reviewer target", target);

    // ---- Bad input / bad codes ------------------------------------------
    const noCode = await call("POST", "/api/pairing/reviewer", { deviceIdentifier: `qa-reviewer-${randomUUID()}` });
    check(noCode.status === 400, "missing code: 400", noCode);
    const wrong = await redeem(`qa-reviewer-${randomUUID()}`, "DEMO-ZZZZ-ZZZZ-ZZZZ");
    check(wrong.status === 401 && wrong.body?.code === "INVALID_REVIEWER_CODE", "unknown code: 401 INVALID_REVIEWER_CODE", wrong);

    // ---- A code pairs several devices, each with its own reviewer ---------
    const cred = createCode(`QA reviewer ${Date.now()}`, 3);
    const deviceA = `qa-reviewer-A-${randomUUID()}`;
    const deviceB = `qa-reviewer-B-${randomUUID()}`;
    const a = await redeem(deviceA, cred.code.toLowerCase().replace(/-/g, " ")); // typed loosely on a phone
    check(a.status === 200 && a.body?.paired === true, "device A pairs with the code (case/space-insensitive)", a);
    const aAgain = await redeem(deviceA, cred.code);
    check(
      aAgain.status === 200 && aAgain.body?.employee?.lastName === a.body?.employee?.lastName,
      "re-entering the code on the same device is idempotent (same reviewer)",
      aAgain
    );
    const b = await redeem(deviceB, cred.code);
    check(b.status === 200 && b.body?.employee?.lastName !== a.body?.employee?.lastName, "device B gets its own reviewer", b);

    const meA = await call("GET", "/api/mobile/me", undefined, deviceA);
    const meB = await call("GET", "/api/mobile/me", undefined, deviceB);
    check(meA.status === 200 && meB.status === 200, "both devices are authorized at the same time", { meA, meB });
    const roles = await pool.query(
      `select e.employee_number, sr.name as role, e.email, e.settings_pin_hash
       from devices d join device_assignments da on da.device_id = d.id and da.unassigned_at is null
       join employees e on e.id = da.employee_id join security_roles sr on sr.id = e.security_role_id
       where d.device_identifier = any($1)`,
      [[deviceA, deviceB]]
    );
    check(
      roles.rows.length === 2 &&
        roles.rows.every((r) => /^REV-\d{4}$/.test(r.employee_number) && r.role === "Administrator" && !r.email && !r.settings_pin_hash),
      "reviewers are fictional REV-#### Administrators with no email or PIN (no web login)",
      roles.rows
    );

    // ---- Full reviewer workflow on device A --------------------------------
    const activities = await call("GET", "/api/mobile/activities", undefined, deviceA);
    const acts: any[] = activities.body?.activities ?? [];
    const picking = acts.find((x) => x.name === "Picking");
    const pruning = acts.find((x) => x.name === "Pruning");
    const cleaning = acts.find((x) => x.name === "Cleaning");
    check(acts.length === 5 && picking && pruning && cleaning, "reviewer sees the 5 demo jobs", acts.map((x) => x.name));
    const rows = await call("GET", "/api/mobile/greenhouse-rows", undefined, deviceA);
    const firstRow = rows.body?.lands?.[0]?.phases?.[0]?.rows?.[0] ?? rows.body?.[0]?.phases?.[0]?.rows?.[0];
    const carriers = await call("GET", "/api/mobile/carriers", undefined, deviceA);
    const firstCarrier = (carriers.body?.carriers ?? carriers.body)?.[0];
    check(Boolean(firstRow?.id) && Boolean(firstCarrier?.id), "demo rows and carts are available", { rows: rows.body, carriers: carriers.body });

    const rowQ = picking.questions.find((q: any) => q.questionType === "greenhouse_row");
    const cartQ = picking.questions.find((q: any) => q.questionType === "carrier");
    const pruneRowQ = pruning.questions.find((q: any) => q.questionType === "greenhouse_row");
    const t0 = Date.now() - 4 * 60 * 60 * 1000;
    const t = (min: number) => new Date(t0 + min * 60000).toISOString();
    const events = [
      {
        clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: t(0),
        activityId: picking.id, greenhouseRowId: firstRow.id, carrierId: firstCarrier.id,
        answers: {
          [rowQ.id]: { questionId: rowQ.id, questionType: "greenhouse_row", greenhouseRowId: firstRow.id },
          [cartQ.id]: { questionId: cartQ.id, questionType: "carrier", carrierId: firstCarrier.id },
        },
      },
      {
        clientEventId: randomUUID(), deviceSeq: 2, eventType: "activity_switch", occurredAtUtc: t(45),
        activityId: pruning.id, greenhouseRowId: firstRow.id,
        answers: { [pruneRowQ.id]: { questionId: pruneRowQ.id, questionType: "greenhouse_row", greenhouseRowId: firstRow.id } },
      },
      { clientEventId: randomUUID(), deviceSeq: 3, eventType: "break_start", occurredAtUtc: t(90) },
      { clientEventId: randomUUID(), deviceSeq: 4, eventType: "break_end", occurredAtUtc: t(105) },
      { clientEventId: randomUUID(), deviceSeq: 5, eventType: "activity_switch", occurredAtUtc: t(150), activityId: cleaning.id, answers: null },
      { clientEventId: randomUUID(), deviceSeq: 6, eventType: "end_day", occurredAtUtc: t(200) },
    ];
    const sync = await call("POST", "/api/mobile/sync/events", { events }, deviceA);
    const statuses = (sync.body?.results ?? []).map((r: any) => r.status);
    check(
      sync.status === 200 && statuses.length === 6 && statuses.every((s: string) => s === "accepted"),
      "start work, switch jobs, break, switch again, end day: all 6 events accepted",
      sync.body
    );
    const entries = await pool.query(
      `select te.entry_type, a.name as activity from time_entries te
       join device_assignments da on da.employee_id = te.employee_id and da.unassigned_at is null
       join devices d on d.id = da.device_id and d.device_identifier = $1
       left join activities a on a.id = te.activity_id
       where te.deleted_at is null order by te.started_at`,
      [deviceA]
    );
    check(
      entries.rows.some((r) => r.activity === "Picking") &&
        entries.rows.some((r) => r.activity === "Pruning") &&
        entries.rows.some((r) => r.activity === "Cleaning") &&
        entries.rows.some((r) => r.entry_type === "break"),
      "time entries recorded for Picking, Pruning, Cleaning and a break",
      entries.rows
    );

    const stats = await call("GET", "/api/mobile/stats", undefined, deviceA);
    check(stats.status === 200, "stats screen loads", stats);
    const outstanding = await call("GET", "/api/mobile/messages/outstanding", undefined, deviceA);
    const welcome = (outstanding.body?.messages ?? []).find((m: any) => (m.messageText ?? m.message_text) === REVIEWER_WELCOME_MESSAGE);
    check(Boolean(welcome), "the reviewer has a welcome message to acknowledge", outstanding.body);
    if (welcome) {
      const ack = await call("POST", `/api/mobile/messages/${welcome.recipientId ?? welcome.id}/acknowledge`, {}, deviceA);
      check(ack.status === 200 || ack.status === 204, "acknowledging the message works", ack);
    }
    const live = await call("GET", "/api/mobile/employees/live", undefined, deviceA);
    check(live.status === 200, "Administrator Tools > Employees loads", live);
    const recipients = await call("GET", "/api/mobile/messages/recipients", undefined, deviceA);
    check(recipients.status === 200, "Administrator Tools > Messages recipient list loads", recipients);
    const mappings = await call("GET", "/api/mobile/tags/mappings", undefined, deviceA);
    check(mappings.status === 200, "NFC tag mappings load", mappings);

    // ---- Device limit -------------------------------------------------------
    await redeem(`qa-reviewer-C-${randomUUID()}`, cred.code);
    const overLimit = await redeem(`qa-reviewer-D-${randomUUID()}`, cred.code);
    check(overLimit.status === 403 && overLimit.body?.code === "REVIEWER_CODE_DEVICE_LIMIT", "4th device over a 3-device code: 403", overLimit);

    // ---- Rotate: old code stops, new code works, paired devices keep working
    const rotated = credentialsCli("rotate", cred.id);
    const newCode = /^\s+(DEMO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m.exec(rotated)?.[1];
    check(Boolean(newCode) && newCode !== cred.code, "rotate prints a new code", rotated);
    const oldAfterRotate = await redeem(`qa-reviewer-E-${randomUUID()}`, cred.code);
    check(oldAfterRotate.status === 401, "old code no longer pairs after rotate", oldAfterRotate);
    const deviceF = `qa-reviewer-F-${randomUUID()}`;
    const newWorks = await redeem(deviceF, newCode!);
    check(newWorks.status === 200, "new code pairs a device", newWorks);
    const aStill = await call("GET", "/api/mobile/me", undefined, deviceA);
    check(aStill.status === 200, "rotate keeps already-paired devices working", aStill);

    // ---- Revoke: code stops and its devices are deactivated -----------------
    const newId = /id: '([0-9a-f-]{36})'/.exec(rotated)?.[1]!;
    credentialsCli("revoke", newId);
    const fAfterRevoke = await call("GET", "/api/mobile/me", undefined, deviceF);
    check(fAfterRevoke.status === 401 && fAfterRevoke.body?.code === "DEVICE_INACTIVE", "revoke deactivates the devices that code paired", fAfterRevoke);
    const fRepair = await redeem(deviceF, newCode!);
    check(fRepair.status === 401, "revoked code cannot re-pair", fRepair);
    const list = credentialsCli("list");
    check(list.includes(cred.id) && list.includes(newId), "list shows both credentials", list);

    // ---- Normal pairing still behaves as before on this instance ------------
    const normal = await call("POST", "/api/pairing/request", { deviceIdentifier: `qa-reviewer-normal-${randomUUID()}` });
    const expiresInMin = (new Date(normal.body?.expiresAt).getTime() - Date.now()) / 60000;
    check(
      normal.status === 200 && /^\d{6}$/.test(normal.body?.pairingCode) && expiresInMin > 9 && expiresInMin <= 10.1,
      "normal pairing still issues a 6-digit code that expires in 10 minutes",
      normal
    );

    // ---- Throttle -------------------------------------------------------------
    _resetReviewerThrottleForTests();
    let throttledAt = -1;
    for (let i = 0; i < 35; i++) {
      const r = await redeem(`qa-reviewer-throttle-${randomUUID()}`, `DEMO-WRNG-WRNG-${String(i).padStart(4, "0")}`);
      if (r.status === 429) {
        throttledAt = i;
        break;
      }
    }
    check(throttledAt === 30, "the 31st wrong code within a minute is throttled (429)", { throttledAt });
    _resetReviewerThrottleForTests();
  } finally {
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
