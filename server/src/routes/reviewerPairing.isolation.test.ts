// Cross-instance isolation for app-store reviewer access. Builds two fresh,
// throwaway databases on the LOCAL Postgres server from DATABASE_URL — a
// demo instance and a "production-like" instance holding stand-in "real"
// records — runs the real API (src/index.ts) against each, and proves:
//   - the production-like API never redeems reviewer codes, even when
//     misconfigured with LABOURLINK_DEMO_INSTANCE=true;
//   - demo devices can't reach production-like data and vice versa;
//   - nothing a reviewer does changes production-like records;
//   - normal pairing (code + admin approval) and employee login still work;
//   - the seed and credential tools refuse to touch a non-demo database.
// Both databases are dropped at the end.
//
// Run with: npm run test:reviewer-isolation   (local DATABASE_URL only)
import "dotenv/config";
import bcrypt from "bcryptjs";
import { ChildProcess, execFileSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { Client } from "pg";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 2000) : "");
  }
}

const SERVER_ROOT = path.join(__dirname, "..", "..");
const RUN = Date.now();
const DEMO_DB = `labourlink_iso_demo_${RUN}`;
const PROD_DB = `labourlink_iso_prod_${RUN}`;
const PROD_MARKER = "Prodlike"; // last name on every production-like person

function dbUrl(name: string): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${name}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: dbUrl("postgres") });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function runTs(script: string, env: Record<string, string>, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["-r", "ts-node/register", script, ...args], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

async function startApi(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(port), CORS_ORIGIN: "https://localhost", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return child;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`API on port ${port} did not start:\n${log}`);
}

async function call(base: string, method: string, p: string, opts: { body?: unknown; device?: string; cookie?: string } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.device ? { "X-Device-Id": opts.device } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, setCookie: res.headers.get("set-cookie") };
}

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "postgres://invalid").hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error("Refusing to run: DATABASE_URL must point at a local Postgres server.");
  }

  const children: ChildProcess[] = [];
  await admin(async (c) => {
    await c.query(`create database ${DEMO_DB}`);
    await c.query(`create database ${PROD_DB}`);
  });

  try {
    for (const db of [DEMO_DB, PROD_DB]) {
      const m = runTs("src/migrate.ts", { DATABASE_URL: dbUrl(db) });
      if (m.code !== 0) throw new Error(`migrate ${db} failed:\n${m.out}`);
    }

    // ---- Production-like instance: stand-in "real" records ----------------
    const prod = new Client({ connectionString: dbUrl(PROD_DB) });
    await prod.connect();
    const pinHash = await bcrypt.hash("4321", 10);
    const adminRow = await prod.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash)
       values ('Pat', $1, 'pat@prodlike.test', (select id from security_roles where name='Administrator'),
               (select id from team_roles where name='Team Member'), $2) returning id`,
      [PROD_MARKER, pinHash]
    );
    const workerRow = await prod.query(
      `insert into employees (first_name, last_name, security_role_id, team_role_id)
       values ('Robin', $1, (select id from security_roles where name='Employee'),
               (select id from team_roles where name='Team Member')) returning id`,
      [PROD_MARKER]
    );
    const prodGroup = await prod.query(`insert into activity_groups (name) values ('Prodlike Crew') returning id`);
    const prodActivity = await prod.query(`insert into activities (name) values ('Prodlike Harvest') returning id`);
    await prod.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [
      prodGroup.rows[0].id,
      prodActivity.rows[0].id,
    ]);
    await prod.query(
      `insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $3), ($2, $3)`,
      [adminRow.rows[0].id, workerRow.rows[0].id, prodGroup.rows[0].id]
    );
    const prodDevice = `iso-prod-device-${randomUUID()}`;
    const dev = await prod.query(
      `insert into devices (device_identifier, device_name, date_paired) values ($1, 'Prodlike phone', now()) returning id`,
      [prodDevice]
    );
    await prod.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [dev.rows[0].id, workerRow.rows[0].id]);
    const msg = await prod.query(
      `insert into employee_messages (message_text, created_by_employee_id) values ('Prodlike private message', $1) returning id`,
      [adminRow.rows[0].id]
    );
    await prod.query(`insert into employee_message_recipients (message_id, employee_id) values ($1, $2)`, [
      msg.rows[0].id,
      workerRow.rows[0].id,
    ]);

    const countProd = async () =>
      (
        await prod.query(
          `select (select count(*) from employees)::int as employees, (select count(*) from devices)::int as devices,
                  (select count(*) from time_entries)::int as time_entries, (select count(*) from mobile_time_events)::int as events,
                  (select count(*) from employee_messages)::int as messages, (select count(*) from pairing_requests)::int as pairing_requests`
        )
      ).rows[0];

    // ---- Tools refuse to touch a non-demo database ------------------------
    const seedProd = runTs("src/cli/seedDemoInstance.ts", { DATABASE_URL: dbUrl(PROD_DB), LABOURLINK_DEMO_INSTANCE: "true" });
    check(seedProd.code !== 0 && /already has 2 employee/.test(seedProd.out), "demo:seed refuses a database that has employees", seedProd);
    const credProd = runTs("src/cli/reviewerCredentials.ts", { DATABASE_URL: dbUrl(PROD_DB) }, ["create", "x"]);
    check(credProd.code !== 0 && /not a LabourLink demo instance/.test(credProd.out), "reviewer:credentials refuses a non-demo database", credProd);

    // ---- Demo instance -------------------------------------------------------
    const seed = runTs("src/cli/seedDemoInstance.ts", { DATABASE_URL: dbUrl(DEMO_DB), LABOURLINK_DEMO_INSTANCE: "true" });
    check(seed.code === 0, "demo:seed seeds the empty demo database", seed);
    const created = runTs("src/cli/reviewerCredentials.ts", { DATABASE_URL: dbUrl(DEMO_DB) }, ["create", "Isolation test"]);
    const code = /^\s+(DEMO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m.exec(created.out)?.[1];
    if (!code) throw new Error(`no code:\n${created.out}`);

    const PROD_PORT = 4810;
    const DEMO_PORT = 4811;
    const MISCONFIGURED_PORT = 4812;
    children.push(await startApi(PROD_PORT, { DATABASE_URL: dbUrl(PROD_DB), JWT_SECRET: `prod-${randomUUID()}`, DEMO_API_URL: "https://demo-api.example.test" }));
    children.push(await startApi(DEMO_PORT, { DATABASE_URL: dbUrl(DEMO_DB), JWT_SECRET: `demo-${randomUUID()}`, LABOURLINK_DEMO_INSTANCE: "true" }));
    // A production server wrongly started with the demo flag: still refuses,
    // because its database has no demo_instance row.
    children.push(await startApi(MISCONFIGURED_PORT, { DATABASE_URL: dbUrl(PROD_DB), JWT_SECRET: `prod2-${randomUUID()}`, LABOURLINK_DEMO_INSTANCE: "true" }));
    const PROD = `http://127.0.0.1:${PROD_PORT}`;
    const DEMO = `http://127.0.0.1:${DEMO_PORT}`;
    const MISCONFIGURED = `http://127.0.0.1:${MISCONFIGURED_PORT}`;

    const before = await countProd();

    const target = await call(PROD, "GET", "/api/pairing/reviewer-target");
    check(target.status === 200 && target.body?.apiUrl === "https://demo-api.example.test", "production tells the app where the demo API is", target);
    const demoTarget = await call(DEMO, "GET", "/api/pairing/reviewer-target");
    check(demoTarget.status === 404, "the demo instance does not advertise a target", demoTarget);

    const reviewerDevice = `iso-reviewer-${randomUUID()}`;
    const onProd = await call(PROD, "POST", "/api/pairing/reviewer", { body: { deviceIdentifier: reviewerDevice, code } });
    check(onProd.status === 404, "production never redeems a reviewer code (endpoint absent)", onProd);
    const onMisconfigured = await call(MISCONFIGURED, "POST", "/api/pairing/reviewer", { body: { deviceIdentifier: reviewerDevice, code } });
    check(onMisconfigured.status === 404, "production DB + demo flag by mistake: still refused (no demo marker)", onMisconfigured);

    const paired = await call(DEMO, "POST", "/api/pairing/reviewer", { body: { deviceIdentifier: reviewerDevice, code } });
    check(paired.status === 200, "reviewer device pairs on the demo instance", paired);
    const secondDevice = `iso-reviewer-2-${randomUUID()}`;
    const paired2 = await call(DEMO, "POST", "/api/pairing/reviewer", { body: { deviceIdentifier: secondDevice, code } });
    check(paired2.status === 200, "a second reviewer device pairs with the same code", paired2);

    // Demo device -> production: unknown device. Production device -> demo: unknown device.
    for (const p of ["/api/mobile/me", "/api/mobile/activities", "/api/mobile/employees/live", "/api/mobile/messages/outstanding"]) {
      const r = await call(PROD, "GET", p, { device: reviewerDevice });
      check(r.status === 401 && r.body?.code === "DEVICE_NOT_FOUND", `demo device is unknown to production: ${p}`, r);
      const r2 = await call(DEMO, "GET", p, { device: prodDevice });
      check(r2.status === 401 && r2.body?.code === "DEVICE_NOT_FOUND", `production device is unknown to the demo: ${p}`, r2);
    }
    const syncOnProd = await call(PROD, "POST", "/api/mobile/sync/events", {
      device: reviewerDevice,
      body: { events: [{ clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: new Date().toISOString(), activityId: prodActivity.rows[0].id }] },
    });
    check(syncOnProd.status === 401, "a demo device cannot write time events to production", syncOnProd);

    // Everything a reviewer can read on the demo instance is demo data.
    const demoReads = [
      "/api/mobile/me", "/api/mobile/activities", "/api/mobile/greenhouse-rows", "/api/mobile/carriers",
      "/api/mobile/employees/live", "/api/mobile/messages/recipients", "/api/mobile/messages/outstanding",
      "/api/mobile/stats", "/api/mobile/tags/mappings",
    ];
    for (const p of demoReads) {
      const r = await call(DEMO, "GET", p, { device: reviewerDevice });
      const text = JSON.stringify(r.body);
      check(r.status === 200 && !text.includes(PROD_MARKER), `demo read has no production-like data: ${p}`, r);
    }

    // A full reviewer day on the demo instance.
    const acts = (await call(DEMO, "GET", "/api/mobile/activities", { device: reviewerDevice })).body.activities as any[];
    const cleaning = acts.find((a) => a.name === "Cleaning");
    const training = acts.find((a) => a.name === "Training");
    const t0 = Date.now() - 3 * 3600_000;
    const t = (m: number) => new Date(t0 + m * 60000).toISOString();
    const day = await call(DEMO, "POST", "/api/mobile/sync/events", {
      device: reviewerDevice,
      body: {
        events: [
          { clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: t(0), activityId: cleaning.id, answers: null },
          { clientEventId: randomUUID(), deviceSeq: 2, eventType: "break_start", occurredAtUtc: t(30) },
          { clientEventId: randomUUID(), deviceSeq: 3, eventType: "break_end", occurredAtUtc: t(45) },
          { clientEventId: randomUUID(), deviceSeq: 4, eventType: "activity_switch", occurredAtUtc: t(60), activityId: training.id, answers: null },
          { clientEventId: randomUUID(), deviceSeq: 5, eventType: "end_day", occurredAtUtc: t(120) },
        ],
      },
    });
    check(day.status === 200 && day.body.results.every((r: any) => r.status === "accepted"), "reviewer workday syncs on the demo instance", day);
    const sent = await call(DEMO, "POST", "/api/mobile/messages/send", {
      device: reviewerDevice,
      body: { messageText: "Reviewer test message", recipientMode: "all", idempotencyKey: randomUUID() },
    });
    check(sent.status === 200 || sent.status === 201, "reviewer can send a message (demo recipients only)", sent);

    const after = await countProd();
    check(JSON.stringify(after) === JSON.stringify(before), "no production-like table changed during reviewer activity", { before, after });

    // ---- Normal pairing + employee access on production still work ---------
    const newPhone = `iso-prod-new-${randomUUID()}`;
    const req = await call(PROD, "POST", "/api/pairing/request", { body: { deviceIdentifier: newPhone } });
    check(req.status === 200 && /^\d{6}$/.test(req.body?.pairingCode), "normal pairing issues a 6-digit code", req);
    const login = await call(PROD, "POST", "/api/auth/login", { body: { email: "pat@prodlike.test", pin: "4321" } });
    check(login.status === 200 && Boolean(login.setCookie), "employee login with email + PIN works", { status: login.status });
    const badLogin = await call(PROD, "POST", "/api/auth/login", { body: { email: "pat@prodlike.test", pin: "0000" } });
    check(badLogin.status === 401, "wrong PIN is still rejected", badLogin);
    const cookie = (login.setCookie ?? "").split(";")[0];
    const pending = await call(PROD, "GET", "/api/devices/pairing-requests", { cookie });
    const reqRow = (pending.body ?? []).find?.((r: any) => (r.pairing_code ?? r.pairingCode) === req.body.pairingCode);
    const approve = await call(PROD, "POST", `/api/devices/pairing-requests/${reqRow?.id ?? req.body.requestId}/approve`, {
      cookie,
      body: { deviceName: "New phone", employeeId: workerRow.rows[0].id },
    });
    check(approve.status === 200, "admin approves the normal pairing request", approve);
    const status = await call(PROD, "GET", `/api/pairing/status?deviceIdentifier=${encodeURIComponent(newPhone)}`);
    check(status.body?.status === "approved", "the phone sees its pairing approved", status);
    const me = await call(PROD, "GET", "/api/mobile/me", { device: newPhone });
    check(me.status === 200 && JSON.stringify(me.body).includes(PROD_MARKER), "the normally paired phone reaches its own employee", me);
    const unapproved = await call(PROD, "GET", "/api/mobile/me", { device: `iso-unpaired-${randomUUID()}` });
    check(unapproved.status === 401, "an unpaired phone is still rejected", unapproved);
    const expired = await prod.query(
      `insert into pairing_requests (pairing_code, device_identifier, created_at, expires_at)
       values ('765432', $1, now() - interval '20 minutes', now() - interval '10 minutes') returning id`,
      [`iso-expired-${randomUUID()}`]
    );
    const approveExpired = await call(PROD, "POST", `/api/devices/pairing-requests/${expired.rows[0].id}/approve`, {
      cookie,
      body: { deviceName: "Late phone", employeeId: adminRow.rows[0].id },
    });
    check(approveExpired.status === 404, "an expired normal pairing code still cannot be approved", approveExpired);

    await prod.end();
  } finally {
    for (const c of children) c.kill();
    await new Promise((r) => setTimeout(r, 1000));
    await admin(async (c) => {
      for (const db of [DEMO_DB, PROD_DB]) {
        await c.query(`drop database if exists ${db} with (force)`);
      }
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
