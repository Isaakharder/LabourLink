// Integration tests for bin picking cycles (074, lib/binCycles.ts): real
// phone sync, station and admin routes over real HTTP against the real
// database, RUN_ID-suffixed disposable fixtures, cleanup in one transaction.
// Turns cycle tracking on for the run (bin_cycle_tracking) and removes it
// afterwards; do not run alongside the other scale suites.
//
// Run with: npm run test:bin-cycles
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { generateIntegrationToken } from "../lib/integrationToken";
import { lockCarrier, sweepPendingWeighings } from "../lib/scaleMatching";
import { placeScans, reconcileBinCyclesLocked } from "../lib/binCycles";
import mobileTimeRouter from "./mobileTime";
import scaleRouter from "./scale";
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
const HOUR = 60 * MIN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Pure placement rule first.
  const g = placeScans(
    [
      { id: "a", employeeId: "e1", occurredAt: 10 },
      { id: "b", employeeId: "e2", occurredAt: 20 },
      { id: "c", employeeId: "e1", occurredAt: 30 },
      { id: "d", employeeId: "e1", occurredAt: 50 },
    ],
    [
      { key: "w1", at: 20 },
      { key: "w2", at: 40 },
    ]
  );
  check(JSON.stringify([...g].map(([k, v]) => [k, v.map((s) => s.id)])) === JSON.stringify([["w1", ["a", "b"]], ["w2", ["c"]], ["open", ["d"]]]), "rule) a scan at the same instant as a weighing belongs to it; later scans stay open", [...g]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/scale", scaleRouter);
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
  const stationIds: string[] = [];
  const activityIds: string[] = [];
  let questionId: string | undefined;
  let trackingInserted = false;

  try {
    if ((await pool.query(`select 1 from bin_cycle_tracking`)).rows.length) throw new Error("bin_cycle_tracking already has a row; refusing to run");
    const NOW = Date.now();
    const T = new Date(NOW - 3 * HOUR).getTime();
    const at = (minutes: number) => new Date(T + minutes * MIN);
    await pool.query(`insert into bin_cycle_tracking (started_at, note) values ($1, 'binCycles.test')`, [new Date(NOW - 30 * HOUR)]);
    trackingInserted = true;

    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const adminRoleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
    const managerRoleId = (await pool.query(`select id from security_roles where name = 'Manager'`)).rows[0].id;

    const pick = (await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [`QA Cycles Picking ${RUN_ID}`])).rows[0].id as string;
    const pack = (await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [`QA Cycles Packing ${RUN_ID}`])).rows[0].id as string;
    activityIds.push(pick, pack);
    questionId = (
      await pool.query(`insert into activity_questions (activity_id, question_type, label, is_required, sort_order) values ($1, 'carrier', 'Which bin?', true, 0) returning id`, [pick])
    ).rows[0].id as string;

    async function staff(first: string, role: "Administrator" | "Manager") {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active) values ($1, $2, $3, $4, $5, true) returning id`,
          [first, `Cy ${RUN_ID}`, `qa-cy-${first.toLowerCase()}-${RUN_ID}@test.local`, role === "Administrator" ? adminRoleId : managerRoleId, teamRoleId]
        )
      ).rows[0].id as string;
      employeeIds.push(id);
      return { id, token: signSession({ id, firstName: first, lastName: `Cy ${RUN_ID}`, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await staff("Adam", "Administrator");
    const manager = await staff("Mona", "Manager");

    interface Phone { employeeId: string; identifier: string; seq: number; working: boolean; name: string }
    async function phone(first: string): Promise<Phone> {
      const e = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active) values ($1, $2, $3, $4, $5, true) returning id`,
          [first, `Cy ${RUN_ID}`, `qa-cy-${first.toLowerCase()}-${RUN_ID}@test.local`, roleId, teamRoleId]
        )
      ).rows[0].id as string;
      employeeIds.push(e);
      const identifier = randomUUID();
      const d = (await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [identifier, `QA Cy ${first} ${RUN_ID}`])).rows[0].id as string;
      deviceIds.push(d);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [d, e]);
      for (const a of [pick, pack]) await pool.query(`insert into employee_activity_assignments (employee_id, activity_id) values ($1, $2)`, [e, a]);
      return { employeeId: e, identifier, seq: 0, working: false, name: `${first} Cy ${RUN_ID}` };
    }
    function ev(p: Phone, eventType: string, when: Date, extra: Record<string, unknown> = {}) {
      p.seq += 1;
      return { clientEventId: randomUUID(), deviceSeq: p.seq, eventType, occurredAtUtc: when.toISOString(), ...extra };
    }
    function scan(p: Phone, carrierId: string, when: Date) {
      const e = ev(p, p.working ? "activity_switch" : "work_start", when, { activityId: pick, carrierId, answers: [{ questionId, carrierId }] });
      p.working = true;
      return e;
    }
    function packing(p: Phone, when: Date) {
      const e = ev(p, p.working ? "activity_switch" : "work_start", when, { activityId: pack, answers: [] });
      p.working = true;
      return e;
    }
    function rescan(p: Phone, carrierId: string, when: Date) {
      return ev(p, "bin_rescan", when, { activityId: pick, carrierId, answers: [{ questionId, carrierId }] });
    }
    function finish(p: Phone, when: Date) {
      p.working = false;
      return ev(p, "end_day", when);
    }
    async function sync(p: Phone, events: unknown[]) {
      const res = await fetch(`${BASE}/api/mobile/sync/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": p.identifier },
        body: JSON.stringify({ events }),
      });
      const body = (await res.json().catch(() => null)) as any;
      return { status: res.status, body };
    }
    async function syncOk(p: Phone, events: unknown[], label: string) {
      const r = await sync(p, events);
      check(r.status === 200 && r.body.results.every((x: any) => x.status === "accepted" || x.status === "duplicate"), `${label}: phone events accepted`, r.body);
      await settle();
      return r;
    }
    // The after-response cycle work runs in the background: wait until no
    // reconcile is still holding a bin lock, then a little more.
    async function settle() {
      await sleep(400);
    }
    async function carrier(label: string) {
      const tag = `${RUN_ID}${carrierIds.length}`.padStart(16, "0");
      const id = (await pool.query(`insert into carriers (name, tare_weight_kg, rfid_tag) values ($1, 154.4, $2) returning id`, [`QA Cy ${RUN_ID} ${label}`, tag])).rows[0].id as string;
      carrierIds.push(id);
      return { id, tag };
    }
    const { token: stationToken, tokenHash } = generateIntegrationToken();
    stationIds.push((await pool.query(`insert into scale_stations (name, token_hash, credits_enabled) values ($1, $2, false) returning id`, [`QA Cy ${RUN_ID}`, tokenHash])).rows[0].id);
    async function weigh(c: { id: string; tag: string }, when: Date, netG = 18_100, stationWeighingId = randomUUID()) {
      const body = { stationWeighingId, carrierId: c.id, rfidTag: c.tag, grossG: 154_400 + netG, tareG: 154_400, netG, weighedAt: when.toISOString(), samplesG: [154_400 + netG] };
      const res = await fetch(`${BASE}/api/scale/weighings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${stationToken}` },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => null)) as any;
      const row = (await pool.query(`select * from scale_weighings where station_weighing_id = $1`, [stationWeighingId])).rows[0];
      return { status: res.status, out, row, stationWeighingId };
    }
    async function cycles(c: { id: string }) {
      return (await pool.query(`select * from bin_cycles where carrier_id = $1 order by opened_at, created_at`, [c.id])).rows;
    }
    async function weighingRow(id: string) {
      return (await pool.query(`select * from scale_weighings where id = $1`, [id])).rows[0];
    }
    async function admin_(method: string, path: string, token: string, body?: unknown) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    }

    const ruben = await phone("Ruben");
    const maria = await phone("Maria");
    const ana = await phone("Ana");
    const sam = await phone("Sam");
    const lea = await phone("Lea");
    const noe = await phone("Noe");
    const rex = await phone("Rex");
    const ola = await phone("Ola");
    const pia = await phone("Pia");
    const tia = await phone("Tia");
    const uma = await phone("Uma");
    const vic = await phone("Vic");
    const wes = await phone("Wes");
    const bin43 = await carrier("Bin 43");
    const bin51 = await carrier("Bin 51");
    const binO = await carrier("Bin O");
    const binP = await carrier("Bin P");
    const binL = await carrier("Bin L");
    const binC = await carrier("Bin C");
    const binN = await carrier("Bin N");
    const binR = await carrier("Bin R");
    const binQ = await carrier("Bin Q");
    const binS = await carrier("Bin S");
    const binU = await carrier("Bin U");
    const binW = await carrier("Bin W");

    // ---------------------------------------------------------------
    // W) The requested workflow, Bin 43
    // ---------------------------------------------------------------
    const r43 = scan(ruben, bin43.id, at(0));
    await syncOk(ruben, [r43], "W1");
    let cy = await cycles(bin43);
    check(cy.length === 1 && cy[0].status === "filling" && cy[0].employee_id === ruben.employeeId, "W1) Ruben scans Bin 43: a new cycle, filling", cy);
    const firstCycleId = cy[0]?.id;

    await syncOk(ruben, [scan(ruben, bin51.id, at(30))], "W3");
    cy = await cycles(bin43);
    check(cy.length === 1 && cy[0].status === "awaiting_weighing" && cy[0].awaiting_since !== null, "W4) Ruben scans Bin 51: Bin 43 awaits weighing", cy);
    check((await cycles(bin51))[0]?.status === "filling", "W3) Bin 51 is filling");

    // A break does not end the bin use.
    await syncOk(ruben, [ev(ruben, "break_start", at(32))], "W break");
    check((await cycles(bin51))[0]?.status === "filling", "W) on a break from Bin 51 it is still filling", await cycles(bin51));
    await syncOk(ruben, [ev(ruben, "break_end", at(34), { activityId: pick, carrierId: bin51.id, answers: [{ questionId, carrierId: bin51.id }] })], "W break end");
    check((await cycles(bin51)).length === 1, "W) resuming after the break is not a new cycle");

    let w = await weigh(bin43, at(40));
    check(w.status === 201 && w.out?.status === "credited" && w.out?.employeeName === ruben.name && w.out?.noPickingCycle === false, "W5) Bin 43 is weighed: credited to Ruben", w.out);
    cy = await cycles(bin43);
    check(cy.length === 1 && cy[0].status === "closed" && cy[0].weighing_id === w.row.id && cy[0].id === firstCycleId, "W6) its cycle is closed by that weighing (same cycle)", cy);
    check(w.row.net_g === 18_100, "W5) net kg recorded against the cycle");
    const w43a = w.row.id;

    w = await weigh(bin43, at(50));
    check(w.out?.status === "pending" && w.out?.noPickingCycle === true && w.row.employee_id === null, "W7) weighed again without a new scan: not credited, no picking cycle", w.out);
    check((await cycles(bin43)).length === 1, "W7) no cycle was created for it");
    const w43b = w.row.id;
    const replay = await weigh(bin43, at(50), 18_100, w.stationWeighingId);
    check(replay.status === 200 && replay.out?.status === "pending" && replay.out?.noPickingCycle === true, "W7) the station's retry gets the same answer", replay.out);
    check((await pool.query(`select count(*)::int as n from scale_weighings where station_weighing_id = $1`, [w.stationWeighingId])).rows[0].n === 1, "W7) a duplicate weighing upload is stored once");

    await syncOk(maria, [scan(maria, bin43.id, at(60))], "W8");
    cy = await cycles(bin43);
    check(cy.length === 2 && cy[1].status === "filling" && cy[1].employee_id === maria.employeeId, "W8) Maria scans Bin 43: a new valid cycle", cy);
    check((await weighingRow(w43b)).status === "pending", "W8) a scan after the re-weigh never credits the re-weigh");

    w = await weigh(bin43, at(70), 20_000);
    check(w.out?.status === "credited" && w.out?.employeeName === maria.name, "W9) Bin 43 weighed for the new cycle: credited to Maria", w.out);
    cy = await cycles(bin43);
    check(cy[1]?.status === "closed" && cy[1]?.weighing_id === w.row.id, "W9) Maria's cycle is closed by it", cy);
    check((await weighingRow(w43a)).employee_id === ruben.employeeId, "W9) Ruben's earlier credit is unchanged");

    // The re-weigh expires after 24 h, never credited.
    {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await lockCarrier(client, bin43.id);
        await reconcileBinCyclesLocked(client, bin43.id, new Date(at(50).getTime() + 25 * HOUR));
        await client.query("commit");
      } finally {
        client.release();
      }
      const x = await weighingRow(w43b);
      check(x.status === "expired" && x.employee_id === null, "W7) after 24 h the re-weigh is expired, never credited", x);
    }

    // ---------------------------------------------------------------
    // D) Duplicate phone uploads never create another credit
    // ---------------------------------------------------------------
    const before = (await pool.query(`select count(*)::int as n from bin_scans where carrier_id = $1`, [bin43.id])).rows[0].n;
    const dupe = await sync(ruben, [r43]);
    await settle();
    check(dupe.status === 200, "D) re-uploading an old phone event is answered", dupe.body);
    check((await pool.query(`select count(*)::int as n from bin_scans where carrier_id = $1`, [bin43.id])).rows[0].n === before, "D) no new scan recorded");
    check((await cycles(bin43)).length === 2 && (await pool.query(`select count(*)::int as n from scale_weighings where carrier_id = $1 and status = 'credited'`, [bin43.id])).rows[0].n === 2, "D) no new cycle or credit");

    // ---------------------------------------------------------------
    // O) A weighing uploaded late after a network outage
    // ---------------------------------------------------------------
    await syncOk(ana, [scan(ana, binO.id, at(0)), scan(ana, binP.id, at(20))], "O ana");
    await syncOk(sam, [scan(sam, binO.id, at(40))], "O sam");
    cy = await cycles(binO);
    check(cy.length === 1 && cy[0].status === "needs_review" && cy[0].employee_id === ana.employeeId, "O) before the late weighing arrives, Sam's scan looks like a conflict; Ana is not replaced", cy);
    const openId = cy[0]?.id;
    w = await weigh(binO, at(30)); // weighed at T+30, uploaded now
    check(w.out?.status === "credited" && w.out?.employeeName === ana.name, "O) the late weighing closes the cycle that was open at its time: Ana", w.out);
    cy = await cycles(binO);
    check(cy.length === 2 && cy[0].id === openId && cy[0].status === "closed" && cy[1].status === "filling" && cy[1].employee_id === sam.employeeId, "O) Sam's scan starts the next cycle", cy);

    // ---------------------------------------------------------------
    // L) Phone scans arriving after the weighing
    // ---------------------------------------------------------------
    w = await weigh(binL, at(10));
    check(w.out?.status === "pending" && w.out?.noPickingCycle === true, "L) weighed before Lea's phone synced: pending", w.out);
    await syncOk(lea, [scan(lea, binL.id, at(0))], "L lea");
    const wl = await weighingRow(w.row.id);
    check(wl.status === "credited" && wl.employee_id === lea.employeeId, "L) Lea's delayed scan (dated before the weighing) credits it", wl);
    cy = await cycles(binL);
    check(cy.length === 1 && cy[0].status === "closed" && cy[0].weighing_id === w.row.id, "L) one cycle, closed by that weighing", cy);
    const wLid = w.row.id;

    // ---------------------------------------------------------------
    // C) Conflicting employees
    // ---------------------------------------------------------------
    await syncOk(ruben, [scan(ruben, binC.id, at(100))], "C ruben");
    await syncOk(maria, [scan(maria, binC.id, at(110))], "C maria");
    cy = await cycles(binC);
    check(cy.length === 1 && cy[0].status === "needs_review" && cy[0].employee_id === ruben.employeeId && /more than one/.test(cy[0].review_reason ?? ""), "C) a second employee's scan: needs review, Ruben not replaced", cy);
    w = await weigh(binC, at(120));
    check(w.out?.status === "needs_review" && w.row.employee_id === null, "C) its weighing: needs review, nobody credited", w.out);
    check((await cycles(binC))[0].status === "closed", "C) the weighing closes the cycle");

    // ---------------------------------------------------------------
    // N) Picked one day, Finish Work, weighed the next day
    // ---------------------------------------------------------------
    const nScan = new Date(NOW - 26 * HOUR);
    await syncOk(noe, [scan(noe, binN.id, nScan), finish(noe, new Date(nScan.getTime() + 20 * MIN))], "N noe");
    cy = await cycles(binN);
    check(cy.length === 1 && cy[0].status === "awaiting_weighing", "N) Finish Work: Noe's bin awaits weighing", cy);
    w = await weigh(binN, new Date(NOW - 1 * HOUR));
    check(w.out?.status === "credited" && w.out?.employeeName === noe.name, "N) weighed the next day: credited to Noe", w.out);

    // ---------------------------------------------------------------
    // V) Voiding never reopens a cycle or creates another credit
    // ---------------------------------------------------------------
    const v = await admin_("POST", `/api/scale-weighings/${wLid}/void`, admin.token, { correctionId: randomUUID(), reason: "QA void" });
    check(v.status === 201 && v.body?.weighing?.status === "voided", "V) Lea's credit is voided", v.body);
    cy = await cycles(binL);
    check(cy.length === 1 && cy[0].status === "closed", "V) its cycle stays closed", cy);
    w = await weigh(binL, at(140));
    check(w.out?.status === "pending" && w.out?.noPickingCycle === true, "V) weighing the bin again without a scan: not credited", w.out);
    check((await cycles(binL)).length === 1, "V) no cycle reopened or created");
    const detail = await admin_("GET", `/api/scale-weighings/${wLid}`, manager.token);
    check(detail.body?.weighing?.pickingCycle?.id === cy[0].id && detail.body?.weighing?.status === "voided", "V) weighing detail shows its picking cycle", detail.body?.weighing?.pickingCycle);
    const detail2 = await admin_("GET", `/api/scale-weighings/${w.row.id}`, manager.token);
    check(detail2.body?.weighing?.pickingCycle === "none", "V) a weighing with no cycle says so", detail2.body?.weighing?.pickingCycle);

    // ---------------------------------------------------------------
    // A) Administrator: close without weighing
    // ---------------------------------------------------------------
    const samCycle = (await cycles(binO))[1];
    const reqId = randomUUID();
    check((await admin_("POST", `/api/bin-cycles/${samCycle.id}/close`, manager.token, { requestId: reqId, reason: "Bin emptied" })).status === 403, "A) only an Administrator may close a cycle");
    check((await admin_("POST", `/api/bin-cycles/${samCycle.id}/close`, admin.token, { requestId: reqId, reason: "" })).status === 400, "A) a reason is required");
    const closed = await admin_("POST", `/api/bin-cycles/${samCycle.id}/close`, admin.token, { requestId: reqId, reason: "Bin emptied without weighing" });
    check(closed.status === 200 && closed.body?.cycle?.status === "closed_unweighed" && closed.body?.replay === false, "A) Sam's open cycle is closed without weighing", closed.body);
    const again = await admin_("POST", `/api/bin-cycles/${samCycle.id}/close`, admin.token, { requestId: reqId, reason: "Bin emptied without weighing" });
    check(again.status === 200 && again.body?.replay === true, "A) the same request again is a replay", again.body);
    check((await admin_("POST", `/api/bin-cycles/${(await cycles(bin51))[0].id}/close`, admin.token, { requestId: reqId, reason: "x x x" })).status === 409, "A) a used request id can't close another cycle");
    check((await admin_("POST", `/api/bin-cycles/${samCycle.id}/close`, admin.token, { requestId: randomUUID(), reason: "again" })).status === 409, "A) a closed cycle can't be closed again");
    w = await weigh(binO, new Date(Date.now() - 2 * MIN));
    check(w.out?.status === "pending" && w.out?.noPickingCycle === true, "A) the bin weighed after the closure is not credited to Sam", w.out);
    const list = await admin_("GET", `/api/bin-cycles?state=recent&carrierId=${binO.id}`, manager.token);
    check(list.status === 200 && list.body.cycles.length === 2 && list.body.trackingStartedAt, "A) cycles are listed for managers", list.body);
    const one = await admin_("GET", `/api/bin-cycles/${samCycle.id}`, manager.token);
    check(one.body?.cycle?.scans?.length === 1 && one.body.cycle.history.some((h: any) => h.kind === "closed_unweighed" && h.actorName), "A) the cycle's scans and audited closure", one.body?.cycle);

    // ---------------------------------------------------------------
    // R) Same employee rescans the same bin after it was weighed
    // ---------------------------------------------------------------
    const me = await fetch(`${BASE}/api/mobile/me`, { headers: { "X-Device-Id": rex.identifier } }).then((r) => r.json() as any);
    check(me?.features?.binRescan === true, "R) the server tells phones it accepts bin_rescan", me?.features);
    await syncOk(rex, [scan(rex, binR.id, at(150))], "R scan");
    w = await weigh(binR, at(160));
    check(w.out?.status === "credited" && w.out?.employeeName === rex.name, "R) Bin R weighed: credited to Rex", w.out);
    const entriesBefore = (await pool.query(`select id, started_at, ended_at, carrier_id from time_entries where employee_id = $1 order by started_at`, [rex.employeeId])).rows;
    const rescanEvent = rescan(rex, binR.id, at(165));
    const rs1 = await sync(rex, [rescanEvent]);
    await settle();
    check(rs1.body?.results?.[0]?.status === "accepted", "R) Rex rescans Bin R without switching: accepted", rs1.body);
    cy = await cycles(binR);
    check(cy.length === 2 && cy[0].status === "closed" && cy[1].status === "filling" && cy[1].employee_id === rex.employeeId, "R) a new cycle opens for the same bin", cy);
    const rs2 = await sync(rex, [rescan(rex, binR.id, at(166))]);
    await settle();
    check(rs2.body?.results?.[0]?.status === "accepted" && (await cycles(binR)).length === 2, "R) rescanning again does not open another cycle", await cycles(binR));
    check((await pool.query(`select count(*)::int as n from bin_scans where cycle_id = $1`, [cy[1].id])).rows[0].n === 2, "R) both rescans are in the one open cycle");
    const entriesAfter = (await pool.query(`select id, started_at, ended_at, carrier_id from time_entries where employee_id = $1 order by started_at`, [rex.employeeId])).rows;
    check(JSON.stringify(entriesAfter) === JSON.stringify(entriesBefore), "R) rescans change no time entry (work time and bin unchanged)", { entriesBefore, entriesAfter });
    w = await weigh(binR, at(175), 21_000);
    check(w.out?.status === "credited" && w.out?.employeeName === rex.name, "R) the next weighing belongs to the new cycle: credited to Rex", w.out);
    cy = await cycles(binR);
    check(cy[1]?.status === "closed" && cy[1]?.weighing_id === w.row.id, "R) the new cycle is closed by it", cy);
    const wrong = await sync(rex, [rescan(rex, binC.id, at(176))]);
    await settle();
    check(wrong.body?.results?.[0]?.status === "permanent_conflict", "R) rescanning a bin Rex is not using is refused", wrong.body);
    check((await pool.query(`select count(*)::int as n from bin_scans where employee_id = $1 and carrier_id = $2`, [rex.employeeId, binC.id])).rows[0].n === 0, "R) and is never a scan");
    const dupRescan = await sync(rex, [rescanEvent]);
    await settle();
    check(dupRescan.body?.results?.[0]?.status === "duplicate" && (await cycles(binR)).length === 2, "R) a re-uploaded rescan creates no cycle", dupRescan.body);

    // ---------------------------------------------------------------
    // Q) Administrator resolution of a needs-review cycle (Bin C)
    // ---------------------------------------------------------------
    const cyC = (await cycles(binC))[0];
    const wC = (await pool.query(`select * from scale_weighings where id = $1`, [cyC.weighing_id])).rows[0];
    check(wC.status === "needs_review", "Q) Bin C's weighing is waiting for review", wC);
    const det = await admin_("GET", `/api/scale-weighings/${wC.id}`, manager.token);
    const pc = det.body?.weighing?.pickingCycle;
    check(pc?.id === cyC.id && pc.scans.length === 2 && new Set(pc.scans.map((x: any) => x.employeeName)).size === 2 && pc.scans.every((x: any) => x.occurredAt), "Q) the detail shows both employees and their scan times", pc);
    const resolveReq = randomUUID();
    const resolveBody = { requestId: resolveReq, employeeId: maria.employeeId, reason: "Maria filled it; Ruben scanned it by mistake" };
    check((await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, manager.token, resolveBody)).status === 403, "Q) only an Administrator may resolve");
    check((await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, { ...resolveBody, reason: "" })).status === 400, "Q) a reason is required");
    check((await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, { ...resolveBody, employeeId: undefined })).status === 400, "Q) an employee must be chosen");
    check((await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, { ...resolveBody, requestId: randomUUID(), employeeId: lea.employeeId })).status === 422, "Q) only an employee who scanned the bin in this cycle");
    const res1 = await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, resolveBody);
    check(res1.status === 200 && res1.body?.replay === false && res1.body?.cycle?.resolution?.employeeName === maria.name, "Q) resolved: Maria", res1.body);
    let wC2 = await weighingRow(wC.id);
    check(wC2.status === "credited" && wC2.employee_id === maria.employeeId, "Q) the weighing is credited to Maria", wC2);
    const cyC2 = (await pool.query(`select * from bin_cycles where id = $1`, [cyC.id])).rows[0];
    check(cyC2.resolved_by_employee_id === admin.id && cyC2.resolution_previous_status === "needs_review" && cyC2.resolution_reason === resolveBody.reason && cyC2.resolved_at, "Q) the cycle records who, when, why and the previous status", cyC2);
    const audit = (await pool.query(`select kind, from_status, to_status, employee_id, actor_employee_id, reason from bin_cycle_events where cycle_id = $1 and kind = 'resolved'`, [cyC.id])).rows;
    check(audit.length === 1 && audit[0].actor_employee_id === admin.id && audit[0].employee_id === maria.employeeId, "Q) the cycle's audit history has the resolution", audit);
    const waudit = (await pool.query(`select * from scale_weighing_events where weighing_id = $1 and kind = 'resolve'`, [wC.id])).rows;
    check(waudit.length === 1 && waudit[0].actor_employee_id === admin.id && waudit[0].from_status === "needs_review" && waudit[0].to_status === "credited", "Q) and so does the weighing's", waudit);
    const again2 = await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, resolveBody);
    check(again2.status === 200 && again2.body?.replay === true, "Q) the same request again is a replay", again2.body);
    check((await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, { ...resolveBody, employeeId: ruben.employeeId })).status === 409, "Q) the same request id for a different employee is refused");
    check((await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, { ...resolveBody, requestId: randomUUID(), employeeId: ruben.employeeId })).status === 409, "Q) a resolved cycle can't be re-resolved");
    check((await pool.query(`select count(*)::int as n from scale_weighings where carrier_id = $1 and status = 'credited'`, [binC.id])).rows[0].n === 1, "Q) exactly one credit");
    // A late scan by another employee, dated inside the cycle, and Pia/Ola on Bin Q.
    await syncOk(pia, [scan(pia, binQ.id, at(130))], "Q pia");
    await syncOk(ola, [scan(ola, binC.id, at(115)), scan(ola, binQ.id, at(135))], "Q ola");
    wC2 = await weighingRow(wC.id);
    check(wC2.status === "credited" && wC2.employee_id === maria.employeeId, "Q) a late phone scan never changes the resolved credit", wC2);
    const lateFlag = (await pool.query(`select kind from scale_weighing_flags where weighing_id = $1 and employee_id = $2`, [wC.id, ola.employeeId])).rows;
    check(lateFlag.length === 1 && lateFlag[0].kind === "late_conflict", "Q) it is flagged as a late conflict", lateFlag);
    await sweepPendingWeighings();
    check((await weighingRow(wC.id)).employee_id === maria.employeeId, "Q) background reconciliation never changes it");
    const cyQ = (await cycles(binQ))[0];
    check(cyQ?.status === "needs_review", "Q) Bin Q: two employees, open, needs review", cyQ);
    check((await admin_("POST", `/api/bin-cycles/${cyQ.id}/resolve`, admin.token, { requestId: randomUUID(), employeeId: pia.employeeId, reason: "too early" })).status === 409, "Q) an unweighed cycle can't be resolved yet");
    const vC = await admin_("POST", `/api/scale-weighings/${wC.id}/void`, admin.token, { correctionId: randomUUID(), reason: "Resolved wrongly" });
    check(vC.status === 201 && vC.body?.weighing?.status === "voided", "Q) a resolved credit can still be voided", vC.body);
    check((await pool.query(`select status from bin_cycles where id = $1`, [cyC.id])).rows[0].status === "closed", "Q) voiding leaves the cycle closed");
    check((await admin_("POST", `/api/bin-cycles/${cyC.id}/resolve`, admin.token, { requestId: randomUUID(), employeeId: maria.employeeId, reason: "again" })).status === 409, "Q) a voided resolution can't be resolved again");

    // ---------------------------------------------------------------
    // T) Stopping tracking (rollback) and starting it again
    // ---------------------------------------------------------------
    await syncOk(tia, [scan(tia, binS.id, at(170))], "T tia");
    check((await cycles(binS))[0]?.status === "filling", "T) Tia is filling Bin S");
    await pool.query(`update bin_cycle_tracking set stopped_at = now() where stopped_at is null`);
    const stoppedAt = new Date((await pool.query(`select max(stopped_at) as s from bin_cycle_tracking`)).rows[0].s);
    await sweepPendingWeighings();
    cy = await cycles(binS);
    check(cy.length === 1 && cy[0].status === "closed_unweighed" && /stopped/.test(cy[0].close_reason), "T) stopping closes the open cycle, nobody credited", cy);
    await sleep(20);
    w = await weigh(binS, new Date());
    check(w.out?.status === "pending" && w.out?.noPickingCycle === false && w.row.employee_id === null, "T) after the stop, Bin S is not credited from Tia's earlier scan", w.out);
    const wS = w.row.id;
    await syncOk(vic, [scan(vic, binS.id, at(172))], "T vic late");
    check((await weighingRow(wS)).status === "pending", "T) a late scan from before the stop never credits a weighing after it");
    check((await pool.query(`select c.status from bin_scans s join bin_cycles c on c.id = s.cycle_id where s.employee_id = $1`, [vic.employeeId])).rows[0]?.status === "closed_unweighed", "T) it is kept with the cycle closed at the stop");
    check((await pool.query(`select count(*)::int as n from bin_cycles where status = any($1::text[]) and carrier_id = any($2::uuid[]) and opened_at <= $3`, [["filling", "awaiting_weighing", "needs_review"], carrierIds, stoppedAt])).rows[0].n === 0, "T) no cycle from before the stop is open");
    await sleep(20);
    await syncOk(uma, [scan(uma, binU.id, new Date())], "T uma");
    await sleep(20);
    w = await weigh(binU, new Date());
    check(w.out?.status === "credited" && w.out?.employeeName === uma.name, "T) while stopped, a scan after the stop is matched by the existing rule", w.out);
    // Start again.
    await pool.query(`insert into bin_cycle_tracking (started_at, note) values (now(), 'binCycles.test restart')`);
    await sweepPendingWeighings();
    check((await cycles(binS)).length === 1 && (await cycles(binS))[0].status === "closed_unweighed", "T) restarting does not reopen the stopped cycle");
    await sleep(20);
    await syncOk(wes, [scan(wes, binW.id, new Date())], "T wes");
    check((await cycles(binW))[0]?.status === "filling", "T) after the restart, a new scan opens a new cycle");
    await sleep(20);
    w = await weigh(binW, new Date());
    check(w.out?.status === "credited" && w.out?.employeeName === wes.name, "T) and its weighing is credited to Wes", w.out);
    check((await weighingRow(wS)).status === "pending", "T) the weighing from the stopped time is still not credited");

    // ---------------------------------------------------------------
    // S) Sweep is idempotent: nothing changes on a second pass
    // ---------------------------------------------------------------
    const snap = async () => JSON.stringify((await pool.query(`select id, status, weighing_id, employee_id from bin_cycles where carrier_id = any($1::uuid[]) order by id`, [carrierIds])).rows) +
      JSON.stringify((await pool.query(`select id, status, employee_id from scale_weighings where carrier_id = any($1::uuid[]) order by id`, [carrierIds])).rows);
    await sweepPendingWeighings();
    const s1 = await snap();
    await sweepPendingWeighings();
    check(s1 === (await snap()), "S) a second sweep changes nothing");
    const scansPerEvent = (await pool.query(`select count(*)::int as n from bin_scans where carrier_id = any($1::uuid[]) group by mobile_time_event_id having count(*) > 1`, [carrierIds])).rows.length;
    check(scansPerEvent === 0, "S) each phone scan is in at most one cycle");
    const twoPerWeighing = (await pool.query(`select weighing_id from bin_cycles where weighing_id is not null and carrier_id = any($1::uuid[]) group by weighing_id having count(*) > 1`, [carrierIds])).rows.length;
    check(twoPerWeighing === 0, "S) each weighing closes at most one cycle");
  } finally {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const w = `(select id from scale_weighings where station_id = any($1::uuid[]))`;
      await client.query(`delete from bin_cycle_events where cycle_id in (select id from bin_cycles where carrier_id = any($1::uuid[]))`, [carrierIds]);
      await client.query(`delete from bin_scans where carrier_id = any($1::uuid[])`, [carrierIds]);
      await client.query(`update bin_cycles set weighing_id = null, status = 'closed_unweighed', resolved_at = null, resolved_employee_id = null, resolved_by_employee_id = null, resolution_reason = null, closed_at = coalesce(closed_at, now()), closed_by_employee_id = coalesce(closed_by_employee_id, employee_id), close_reason = coalesce(close_reason, 'cleanup') where carrier_id = any($1::uuid[])`, [carrierIds]);
      await client.query(`delete from bin_cycles where carrier_id = any($1::uuid[])`, [carrierIds]);
      await client.query(`delete from scale_weighing_corrections where weighing_id in ${w}`, [stationIds]);
      await client.query(`delete from scale_weighing_events where weighing_id in ${w}`, [stationIds]);
      await client.query(`delete from scale_weighing_flags where weighing_id in ${w}`, [stationIds]);
      await client.query(`delete from scale_weighing_claims where weighing_id in ${w}`, [stationIds]);
      await client.query(`delete from scale_weighings where station_id = any($1::uuid[])`, [stationIds]);
      await client.query(`delete from scale_stations where id = any($1::uuid[])`, [stationIds]);
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employee_activity_assignments where employee_id = any($1::uuid[])`, [employeeIds]);
      if (questionId) await client.query(`delete from activity_questions where id = $1`, [questionId]);
      await client.query(`delete from activities where id = any($1::uuid[])`, [activityIds]);
      await client.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      if (trackingInserted) await client.query(`delete from bin_cycle_tracking`);
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
