// A greenhouse WITHOUT LabourLink Scale: no picking-cycle tracking period and
// no weighing station. Normal phone use (start, bin scans, switches, breaks,
// Finish Work, offline batches) must work exactly as before, nothing scale-
// related may be created, phones must not be asked to send bin_rescan, and a
// bin_rescan sent anyway (e.g. an old cached flag) must never disrupt sync.
// Real routers over real HTTP against the real database; cleanup in one
// transaction. Refuses to run if a tracking period exists.
//
// Run with: npm run test:bin-cycles-no-scale
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { sweepPendingWeighings } from "../lib/scaleMatching";
import mobileTimeRouter from "./mobileTime";
import scaleWeighingsRouter from "./scaleWeighings";
import binCyclesRouter from "./binCycles";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}
const RUN_ID = Date.now();
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/scale-weighings", scaleWeighingsRouter);
  app.use("/api/bin-cycles", binCyclesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const carrierIds: string[] = [];
  const activityIds: string[] = [];
  const questionIds: string[] = [];
  try {
    if ((await pool.query(`select 1 from bin_cycle_tracking`)).rows.length) throw new Error("a picking-cycle tracking period exists; this test needs a greenhouse without Scale");
    const counts = async () =>
      (await pool.query(`select (select count(*) from bin_cycles)::int c, (select count(*) from bin_scans)::int s, (select count(*) from bin_cycle_events)::int e`)).rows[0];
    const before = await counts();

    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const adminRoleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
    const pick = (await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [`QA NoScale Picking ${RUN_ID}`])).rows[0].id as string;
    const pack = (await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [`QA NoScale Packing ${RUN_ID}`])).rows[0].id as string;
    activityIds.push(pick, pack);
    const questionId = (await pool.query(`insert into activity_questions (activity_id, question_type, label, is_required, sort_order) values ($1, 'carrier', 'Which bin?', true, 0) returning id`, [pick])).rows[0].id as string;
    questionIds.push(questionId);

    const adminId = (
      await pool.query(`insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active) values ('Adam', $1, $2, $3, $4, true) returning id`, [
        `NoScale ${RUN_ID}`,
        `qa-noscale-adam-${RUN_ID}@test.local`,
        adminRoleId,
        teamRoleId,
      ])
    ).rows[0].id as string;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "Adam", lastName: `NoScale ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    const e = (
      await pool.query(`insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active) values ('Pat', $1, $2, $3, $4, true) returning id`, [
        `NoScale ${RUN_ID}`,
        `qa-noscale-pat-${RUN_ID}@test.local`,
        roleId,
        teamRoleId,
      ])
    ).rows[0].id as string;
    employeeIds.push(e);
    const identifier = randomUUID();
    const d = (await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [identifier, `QA NoScale ${RUN_ID}`])).rows[0].id as string;
    deviceIds.push(d);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [d, e]);
    for (const a of [pick, pack]) await pool.query(`insert into employee_activity_assignments (employee_id, activity_id) values ($1, $2)`, [e, a]);
    const bins: string[] = [];
    for (const n of ["A", "B"]) {
      const id = (await pool.query(`insert into carriers (name) values ($1) returning id`, [`QA NoScale ${RUN_ID} Bin ${n}`])).rows[0].id as string;
      carrierIds.push(id);
      bins.push(id);
    }

    let seq = 0;
    const T = Date.now() - 4 * 60 * MIN;
    const at = (m: number) => new Date(T + m * MIN).toISOString();
    const ev = (eventType: string, m: number, extra: Record<string, unknown> = {}) => ({ clientEventId: randomUUID(), deviceSeq: ++seq, eventType, occurredAtUtc: at(m), ...extra });
    const binChoice = (eventType: string, m: number, carrierId: string) => ev(eventType, m, { activityId: pick, carrierId, answers: [{ questionId, carrierId }] });
    async function sync(events: unknown[]) {
      const res = await fetch(`${BASE}/api/mobile/sync/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": identifier },
        body: JSON.stringify({ events }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    }
    const me = async () => (await fetch(`${BASE}/api/mobile/me`, { headers: { "X-Device-Id": identifier } })).json() as Promise<any>;

    // 1) Phones are not asked to send bin_rescan.
    const m0 = await me();
    check(m0?.features?.binRescan === false, "1) without picking-cycle tracking, /me says binRescan: false", m0?.features);

    // 2) A full offline day in one batch: start on Bin A, switch to Bin B,
    //    break, resume, switch to packing, Finish Work.
    const day = [
      binChoice("work_start", 0, bins[0]),
      binChoice("activity_switch", 40, bins[1]),
      ev("break_start", 60),
      ev("break_end", 75, { activityId: pick, carrierId: bins[1], answers: [{ questionId, carrierId: bins[1] }] }),
      ev("activity_switch", 100, { activityId: pack, answers: [] }),
      ev("end_day", 130),
    ];
    let r = await sync(day);
    check(r.status === 200 && r.body.results.length === 6 && r.body.results.every((x: any) => x.status === "accepted"), "2) a full offline day syncs, every event accepted", r.body);
    const entries = (await pool.query(`select entry_type, carrier_id, activity_id, started_at, ended_at from time_entries where employee_id = $1 and deleted_at is null order by started_at`, [e])).rows;
    const shape = entries.map((x) => [x.entry_type, x.carrier_id === bins[0] ? "A" : x.carrier_id === bins[1] ? "B" : null, x.activity_id === pack ? "pack" : "pick"]);
    check(
      JSON.stringify(shape) === JSON.stringify([["work", "A", "pick"], ["work", "B", "pick"], ["break", null, "pick"], ["work", "B", "pick"], ["work", null, "pack"]]),
      "2) time entries are exactly as before: Bin A, Bin B, break, Bin B, packing",
      shape
    );
    check(entries.every((x) => x.ended_at !== null), "2) Finish Work closed the day");
    const replay = await sync(day);
    check(replay.body.results.every((x: any) => x.status === "duplicate"), "2) re-uploading the same batch is a no-op", replay.body);

    // 3) A bin_rescan sent anyway never disrupts sync.
    await sync([binChoice("work_start", 140, bins[0])]);
    const entriesBefore = (await pool.query(`select id, started_at, ended_at from time_entries where employee_id = $1 order by started_at`, [e])).rows;
    r = await sync([ev("bin_rescan", 150, { activityId: pick, carrierId: bins[0], answers: [{ questionId, carrierId: bins[0] }] }), ev("bin_rescan", 151, { activityId: pick, carrierId: bins[1], answers: [{ questionId, carrierId: bins[1] }] }), binChoice("activity_switch", 160, bins[1]), ev("end_day", 170)]);
    check(r.status === 200, "3) the batch is answered", r.body);
    check(r.body.results[0]?.status === "accepted" && r.body.results[1]?.status === "permanent_conflict", "3) a rescan of the current bin is accepted as a no-op; one of another bin is rejected", r.body.results);
    check(r.body.results[2]?.status === "accepted" && r.body.results[3]?.status === "accepted", "3) events after them still apply (no sync stall)", r.body.results);
    const entriesAfter = (await pool.query(`select id, started_at, ended_at from time_entries where employee_id = $1 order by started_at`, [e])).rows;
    check(entriesAfter.length === entriesBefore.length + 1, "3) the rescans created no time entry (only the switch did)", { before: entriesBefore.length, after: entriesAfter.length });

    // 4) Nothing scale-related was created; the background sweep is a no-op.
    await sleep(500);
    await sweepPendingWeighings();
    const after = await counts();
    check(JSON.stringify(after) === JSON.stringify(before), "4) no picking-cycle rows were created", { before, after });

    // 5) Scale screens' APIs are safe with no station and no cycles.
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${adminToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    const list = await call("GET", "/api/bin-cycles?state=open");
    check(list.status === 200 && list.body.trackingEverStarted === false && list.body.trackingStartedAt === null && list.body.cycles.length === 0, "5) picking cycles: none, tracking never started (the panel stays hidden)", list.body);
    const weighings = await call("GET", "/api/scale-weighings");
    check(weighings.status === 200 && Array.isArray(weighings.body.weighings), "5) the Scale Weighings API answers normally", weighings.status);
    check((await call("POST", `/api/bin-cycles/${randomUUID()}/close`, { requestId: randomUUID(), reason: "none" })).status === 404, "5) closing an unknown cycle: 404");
    check((await call("POST", `/api/bin-cycles/${randomUUID()}/resolve`, { requestId: randomUUID(), employeeId: e, reason: "none" })).status === 404, "5) resolving an unknown cycle: 404");
  } finally {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employee_activity_assignments where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from activity_questions where id = any($1::uuid[])`, [questionIds]);
      await client.query(`delete from activities where id = any($1::uuid[])`, [activityIds]);
      await client.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }
    server.close();
    await pool.end();
  }
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
