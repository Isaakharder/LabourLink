import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { pool } from "../db";
import { hasDemoInstanceMarker } from "../lib/demoInstance";
import mobileTimeRouter from "./mobileTime";
import reviewerPairingRouter from "./reviewerPairing";

// A phone that already has event history (it was paired to production
// first) keeps its device identifier and local device_seq counter when a
// reviewer access code moves it to the demo instance. Reviewer pairing
// creates a new demo device expecting seq 1, so before the fix every event
// came back sequence_gap forever. The demo now adopts the first pending seq
// as the baseline for a reviewer-paired device with no recorded events —
// and nothing else changes.
//
// Writes reviewer devices/employees, so it refuses unless DATABASE_URL is a
// seeded demo instance on this machine:
//   LABOURLINK_DEMO_INSTANCE=true npm run demo:seed     (once, local demo DB)
//   DATABASE_URL=<local demo db> npm run test:reviewer-sync-baseline

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

function createCode(): { id: string; code: string } {
  const out = execFileSync(process.execPath, ["-r", "ts-node/register", "src/cli/reviewerCredentials.ts", "create", "QA sync baseline"], {
    cwd: SERVER_ROOT,
    env: process.env,
    encoding: "utf8",
  });
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
  process.env.LABOURLINK_DEMO_INSTANCE = "true";

  const app = express();
  app.use(express.json());
  app.use("/api/pairing", reviewerPairingRouter);
  app.use("/api/mobile", mobileTimeRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function redeem(deviceIdentifier: string, code: string) {
    const res = await fetch(`${BASE}/api/pairing/reviewer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceIdentifier, code }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function sync(deviceIdentifier: string, events: unknown[]) {
    const res = await fetch(`${BASE}/api/mobile/sync/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify({ events }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  async function watermark(deviceIdentifier: string): Promise<number | null> {
    const { rows } = await pool.query(
      `select s.last_processed_seq from device_sync_state s join devices d on d.id = s.device_id where d.device_identifier = $1`,
      [deviceIdentifier]
    );
    return rows[0] ? Number(rows[0].last_processed_seq) : null;
  }
  const statuses = (r: { body: any }) => (r.body?.results ?? []).map((x: { status: string }) => x.status);

  // An activity reviewers can start that asks no questions (e.g. Cleaning).
  const activityId: string = (
    await pool.query(
      `select a.id from activities a
       where a.is_active and not exists (select 1 from activity_questions q where q.activity_id = a.id)
       order by a.name limit 1`
    )
  ).rows[0].id;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  const work = (seq: number, minutesAgo: number) => ({
    clientEventId: randomUUID(),
    deviceSeq: seq,
    eventType: "work_start",
    occurredAtUtc: t(minutesAgo),
    activityId,
    answers: null,
  });
  const endDay = (seq: number, minutesAgo: number) => ({ clientEventId: randomUUID(), deviceSeq: seq, eventType: "end_day", occurredAtUtc: t(minutesAgo) });

  const credential = createCode();
  const created: string[] = [];
  const id = (label: string) => {
    const v = `qa-sync-baseline-${label}-${randomUUID()}`;
    created.push(v);
    return v;
  };

  try {
    // 1. The reported case: phone previously used elsewhere, first demo event is seq 13.
    const phone = id("phone");
    check((await redeem(phone, credential.code)).status === 200, "reviewer code pairs the phone");
    const firstBatch = [work(13, 30), endDay(14, 20)];
    const r1 = await sync(phone, firstBatch);
    check(r1.status === 200 && statuses(r1).join() === "accepted,accepted", "seq 13/14 accepted on a fresh reviewer device", r1.body);
    check((await watermark(phone)) === 14, "watermark advanced to 14", await watermark(phone));
    const r1Replay = await sync(phone, firstBatch);
    check(statuses(r1Replay).join() === "duplicate,duplicate", "replay of the same events is duplicate", r1Replay.body);
    const { rows: entries } = await pool.query(
      `select count(*)::int as n from time_entries te join devices d on d.id = te.device_id where d.device_identifier = $1`,
      [phone]
    );
    check(entries[0].n === 1, "the work was recorded as one time entry", entries[0]);

    // 2. Once a device has history, a real gap is still a gap.
    const r2 = await sync(phone, [work(20, 10)]);
    check(statuses(r2).join() === "sequence_gap", "later gap on the same device stays sequence_gap", r2.body);
    check(r2.body?.results?.[0]?.detail?.expectedDeviceSeq === 15, "expected seq is 15", r2.body?.results?.[0]?.detail);

    // 3. A fresh reviewer device starting at 1 is unaffected.
    const fresh = id("fresh");
    check((await redeem(fresh, credential.code)).status === 200, "second reviewer device pairs");
    const r3 = await sync(fresh, [work(1, 30)]);
    check(statuses(r3).join() === "accepted" && (await watermark(fresh)) === 1, "fresh reviewer device: seq 1 accepted normally", r3.body);

    // 4. A non-reviewer device on the demo keeps strict sequencing.
    const plain = id("plain");
    const employeeId: string = (
      await pool.query(`select e.id from employees e where e.is_active and e.employee_number not like 'REV-%' order by e.created_at limit 1`)
    ).rows[0].id;
    const deviceRow = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, 'QA plain', true) returning id`, [plain])
    ).rows[0].id;
    // An employee can hold one active device at a time — borrow nobody's: use a throwaway assignment check.
    const busy = await pool.query(`select 1 from device_assignments where employee_id = $1 and unassigned_at is null`, [employeeId]);
    if (busy.rowCount === 0) {
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRow, employeeId]);
      const r4 = await sync(plain, [work(5, 30)]);
      check(statuses(r4).join() === "sequence_gap", "non-reviewer demo device starting at 5: still sequence_gap", r4.body);
    } else {
      console.log("(skipped non-reviewer case: seeded employee already has an active device)");
    }

    // 5. Without LABOURLINK_DEMO_INSTANCE (production) nothing changes.
    process.env.LABOURLINK_DEMO_INSTANCE = "false";
    const prodLike = id("prodlike");
    process.env.LABOURLINK_DEMO_INSTANCE = "true";
    check((await redeem(prodLike, credential.code)).status === 200, "third reviewer device pairs");
    process.env.LABOURLINK_DEMO_INSTANCE = "false";
    const r5 = await sync(prodLike, [work(13, 30)]);
    process.env.LABOURLINK_DEMO_INSTANCE = "true";
    check(statuses(r5).join() === "sequence_gap" && (await watermark(prodLike)) === 0, "not a demo instance: strict sequencing unchanged", r5.body);
  } finally {
    server.close();
    const { rows } = await pool.query(`select id from devices where device_identifier = any($1::text[])`, [created]);
    const deviceIds = rows.map((r) => r.id);
    const { rows: emps } = await pool.query(
      `select employee_id from device_assignments where device_id = any($1::uuid[])`,
      [deviceIds]
    );
    const reviewerEmployeeIds = (
      await pool.query(`select id from employees where id = any($1::uuid[]) and employee_number like 'REV-%'`, [emps.map((e) => e.employee_id)])
    ).rows.map((r) => r.id);
    await pool.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
    await pool.query(`delete from time_entries where device_id = any($1::uuid[])`, [deviceIds]);
    await pool.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
    await pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
    await pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
    await pool.query(`delete from employee_message_recipients where employee_id = any($1::uuid[])`, [reviewerEmployeeIds]);
    await pool.query(`delete from employee_activity_group_assignments where employee_id = any($1::uuid[])`, [reviewerEmployeeIds]);
    await pool.query(`delete from employees where id = any($1::uuid[])`, [reviewerEmployeeIds]).catch(() => {});
    await pool.query(`update reviewer_pairing_credentials set revoked_at = now() where id = $1`, [credential.id]);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
