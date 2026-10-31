// Integration tests for the LabourLink Scale station API (routes/scale.ts)
// and weighing assignment (lib/scaleMatching.ts), including the follow-up
// matching the phone sync route (routes/mobileTime.ts POST /sync/events)
// runs after it responds. Real routers over real HTTP against the real
// database, RUN_ID-suffixed disposable QA fixtures, cleanup in one
// transaction — same convention as mobileTime.syncEvents.test.ts.
//
// Phone bin choices go through the real sync route, so a "claim" here is
// exactly what a phone produces in production.
//
// Run with: npm run test:scale-station-api
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { generateIntegrationToken } from "../lib/integrationToken";
import { reconcileAfterPhoneSync, sweepPendingWeighings } from "../lib/scaleMatching";
import mobileTimeRouter from "./mobileTime";
import scaleRouter from "./scale";

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
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/scale", scaleRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function station(token: string | null, method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}/api/scale${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const carrierIds: string[] = [];
  const stationIds: string[] = [];
  let activityId: string | undefined;
  let zeroActivityId: string | undefined;
  let questionId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    activityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Scale Picking ${RUN_ID}`,
      ])
    ).rows[0].id as string;
    zeroActivityId = activityId;
    questionId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'carrier', 'Which bin?', true, 0) returning id`,
        [activityId]
      )
    ).rows[0].id as string;

    // Phones: one employee + device each, with their own device_seq counter.
    interface Phone {
      employeeId: string;
      deviceRowId: string;
      identifier: string;
      seq: number;
      name: string;
    }
    async function phone(first: string): Promise<Phone> {
      const e = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active)
           values ($1, $2, $3, $4, $5, true) returning id`,
          [first, `Scale ${RUN_ID}`, `qa-scale-${first.toLowerCase()}-${RUN_ID}@test.local`, roleId, teamRoleId]
        )
      ).rows[0].id as string;
      employeeIds.push(e);
      const identifier = randomUUID();
      const d = (
        await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
          identifier,
          `QA Scale ${first} ${RUN_ID}`,
        ])
      ).rows[0].id as string;
      deviceIds.push(d);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [d, e]);
      await pool.query(`insert into employee_activity_assignments (employee_id, activity_id) values ($1, $2)`, [e, activityId]);
      return { employeeId: e, deviceRowId: d, identifier, seq: 0, name: `${first} Scale ${RUN_ID}` };
    }
    // One phone event choosing `carrierId` at `at`: work_start for the
    // phone's first event, activity_switch after that.
    function choice(p: Phone, carrierId: string, at: Date) {
      p.seq += 1;
      return {
        clientEventId: randomUUID(),
        deviceSeq: p.seq,
        eventType: p.seq === 1 ? "work_start" : "activity_switch",
        occurredAtUtc: at.toISOString(),
        activityId,
        carrierId,
        answers: [{ questionId, carrierId }],
      };
    }
    async function sync(p: Phone, events: unknown[]) {
      const res = await fetch(`${BASE}/api/mobile/sync/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": p.identifier },
        body: JSON.stringify({ events }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    }

    async function carrier(label: string, tareKg: number) {
      const tag = `${RUN_ID}${carrierIds.length}`.padStart(16, "0");
      const id = (
        await pool.query(`insert into carriers (name, tare_weight_kg, rfid_tag) values ($1, $2, $3) returning id`, [
          `QA Scale ${RUN_ID} ${label}`,
          tareKg,
          tag,
        ])
      ).rows[0].id as string;
      carrierIds.push(id);
      return { id, tag };
    }
    async function makeStation(name: string, creditsEnabled: boolean, isActive = true) {
      const { token, tokenHash } = generateIntegrationToken();
      const id = (
        await pool.query(
          `insert into scale_stations (name, token_hash, credits_enabled, is_active) values ($1, $2, $3, $4) returning id`,
          [`QA Scale ${RUN_ID} ${name}`, tokenHash, creditsEnabled, isActive]
        )
      ).rows[0].id as string;
      stationIds.push(id);
      return { id, token };
    }
    function weighing(c: { id: string; tag: string }, at: Date, grossG = 172_500, tareG = 154_400) {
      return {
        stationWeighingId: randomUUID(),
        carrierId: c.id,
        rfidTag: c.tag,
        grossG,
        tareG,
        netG: grossG - tareG,
        weighedAt: at.toISOString(),
        samplesG: [grossG, grossG, grossG],
      };
    }
    async function dbWeighing(token: string, stationWeighingId: string) {
      const { rows } = await pool.query(
        `select w.* from scale_weighings w join scale_stations s on s.id = w.station_id
         where w.station_weighing_id = $1 and s.token_hash = encode(sha256($2::bytea), 'hex')`,
        [stationWeighingId, token]
      );
      return rows[0];
    }
    // Waits for the phone sync's after-response matching to settle.
    async function waitForStatus(weighingId: string, want: string, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { rows } = await pool.query(`select status from scale_weighings where id = $1`, [weighingId]);
        if (rows[0]?.status === want || Date.now() > deadline) return rows[0]?.status;
        await sleep(50);
      }
    }

    const ruben = await phone("Ruben");
    const maria = await phone("Maria");
    const ana = await phone("Ana");
    const sam = await phone("Sam");
    const binZ = await carrier("Bin Z", 20); // chosen at work start, never weighed
    const binA = await carrier("Bin A", 154.4);
    const binB = await carrier("Bin B", 154.4);
    const binC = await carrier("Bin C", 154.4);
    const binD = await carrier("Bin D", 154.4);
    const binF = await carrier("Bin F", 154.4);
    const binG = await carrier("Bin G", 154.4);
    const concurrentBins = [];
    for (let i = 0; i < 5; i++) concurrentBins.push(await carrier(`Bin E${i}`, 154.4));
    const trial = await makeStation("Trial", false);
    const live = await makeStation("Live", true);
    const retired = await makeStation("Retired", false, false);

    const T = new Date(Date.now() - 2 * 60 * MIN);
    const at = (minutes: number) => new Date(T.getTime() + minutes * MIN);

    // -----------------------------------------------------------------
    // A) Station authentication
    // -----------------------------------------------------------------
    check((await station(null, "GET", "/station")).status === 401, "A) no token is refused");
    check((await station("not-a-real-token", "GET", "/station")).status === 401, "A) an unknown token is refused");
    check((await station(retired.token, "GET", "/station")).status === 401, "A) a deactivated station is refused");
    const me = await station(trial.token, "GET", "/station");
    check(me.status === 200 && me.body?.station?.creditsEnabled === false, "A) a new station starts in trial (credits off)", me.body);
    await sleep(200);
    const seen = await pool.query(`select last_seen_at from scale_stations where id = $1`, [trial.id]);
    check(seen.rows[0].last_seen_at !== null, "A) last_seen_at is recorded", seen.rows[0]);

    // -----------------------------------------------------------------
    // B) Carriers for the station's cache
    // -----------------------------------------------------------------
    const cs = await station(trial.token, "GET", "/carriers");
    const a = cs.body?.carriers?.find((c: any) => c.id === binA.id);
    check(cs.status === 200 && a?.rfidTag === binA.tag && a?.tareWeightKg === 154.4 && a?.isActive === true, "B) bins with a tag are listed with tare", a);
    check(cs.body.carriers.every((c: any) => c.rfidTag), "B) only bins with a tag are listed");

    // -----------------------------------------------------------------
    // C) Validation
    // -----------------------------------------------------------------
    const bad = await station(trial.token, "POST", "/weighings", { ...weighing(binA, at(0)), netG: 1 });
    check(bad.status === 400 && bad.body?.errors?.netG, "C) net must equal gross - tare", bad.body);
    const noTag = await station(trial.token, "POST", "/weighings", { ...weighing(binA, at(0)), rfidTag: "" });
    check(noTag.status === 400 && noTag.body?.errors?.rfidTag, "C) an RFID tag is required", noTag.body);
    const unknownBin = await station(trial.token, "POST", "/weighings", { ...weighing(binA, at(0)), carrierId: randomUUID() });
    check(unknownBin.status === 422, "C) an unknown bin is refused", unknownBin.body);
    const fractional = await station(trial.token, "POST", "/weighings", { ...weighing(binA, at(0)), grossG: 1.5 });
    check(fractional.status === 400, "C) weights are whole grams");

    // -----------------------------------------------------------------
    // D) One employee's bin choice credits the weighing (trial station)
    // -----------------------------------------------------------------
    let r = await sync(ruben, [choice(ruben, binZ.id, at(-180)), choice(ruben, binA.id, at(-30))]);
    check(r.status === 200 && r.body.results.every((x: any) => x.status === "accepted"), "D) Ruben's phone choices are accepted", r.body);
    await sleep(200);
    const wD = weighing(binA, at(0));
    const d1 = await station(trial.token, "POST", "/weighings", wD);
    check(d1.status === 201, "D) the weighing is stored", d1.body);
    check(d1.body?.status === "credited" && d1.body?.employeeName === ruben.name, "D) credited to Ruben", d1.body);
    check(d1.body?.creditsLive === false && d1.body?.pendingUntil === null, "D) a trial station's credit is not live", d1.body);
    const rowD = await dbWeighing(trial.token, wD.stationWeighingId);
    check(rowD.employee_id === ruben.employeeId && rowD.net_g === 18_100 && rowD.credits_live === false, "D) row: employee, net 18.1 kg, trial", rowD);
    const claimsD = await pool.query(`select * from scale_weighing_claims where weighing_id = $1`, [rowD.id]);
    check(claimsD.rows.length === 1 && claimsD.rows[0].employee_id === ruben.employeeId, "D) exactly Ruben's Bin A choice was consumed", claimsD.rows);
    const histD = await pool.query(`select kind, to_status from scale_weighing_events where weighing_id = $1 order by created_at`, [rowD.id]);
    check(
      JSON.stringify(histD.rows.map((h) => [h.kind, h.to_status])) === JSON.stringify([["received", "pending"], ["status", "credited"]]),
      "D) history: received, then credited",
      histD.rows
    );

    // Idempotency
    const replay = await station(trial.token, "POST", "/weighings", wD);
    check(replay.status === 200 && replay.body?.status === "credited", "D) a replay returns the stored outcome", replay.body);
    const changed = await station(trial.token, "POST", "/weighings", { ...wD, grossG: 180_000, netG: 180_000 - wD.tareG });
    check(changed.status === 409, "D) the same id with different contents is refused", changed.body);
    const countD = await pool.query(`select count(*)::int as n from scale_weighings where station_weighing_id = $1`, [wD.stationWeighingId]);
    check(countD.rows[0].n === 1, "D) still exactly one row for that id");

    // -----------------------------------------------------------------
    // E) Same bin again within five minutes: duplicate, never counted
    // -----------------------------------------------------------------
    const wE = weighing(binA, at(2));
    const e1 = await station(trial.token, "POST", "/weighings", wE);
    const rowE = await dbWeighing(trial.token, wE.stationWeighingId);
    check(e1.body?.status === "needs_review" && rowE.is_duplicate === true && rowE.employee_id === null, "E) a duplicate is held for review, nobody credited", rowE);

    // -----------------------------------------------------------------
    // F) No choice yet: pending; a late phone sync credits it
    // -----------------------------------------------------------------
    const wF = weighing(binB, at(0));
    const f1 = await station(trial.token, "POST", "/weighings", wF);
    check(f1.body?.status === "pending" && typeof f1.body?.pendingUntil === "string", "F) no claim yet: pending with a deadline", f1.body);
    check(new Date(f1.body.pendingUntil).getTime() === at(0).getTime() + 24 * 60 * MIN, "F) deadline is weighed_at + 24 h", f1.body);
    const rowF = await dbWeighing(trial.token, wF.stationWeighingId);
    r = await sync(maria, [choice(maria, binZ.id, at(-180)), choice(maria, binB.id, at(-10))]);
    check(r.status === 200, "F) Maria's offline choices sync", r.body);
    check((await waitForStatus(rowF.id, "credited")) === "credited", "F) the phone sync's follow-up matching credits the pending weighing");
    const rowF2 = await dbWeighing(trial.token, wF.stationWeighingId);
    check(rowF2.employee_id === maria.employeeId, "F) credited to Maria", rowF2);

    // -----------------------------------------------------------------
    // G) A different employee's late claim in a credited cycle: flagged only
    // -----------------------------------------------------------------
    r = await sync(ana, [choice(ana, binZ.id, at(-180)), choice(ana, binB.id, at(-5))]);
    check(r.status === 200, "G) Ana's choices sync", r.body);
    let flags: any[] = [];
    for (let i = 0; i < 100 && flags.length === 0; i++) {
      flags = (await pool.query(`select * from scale_weighing_flags where weighing_id = $1`, [rowF.id])).rows;
      if (flags.length === 0) await sleep(50);
    }
    check(flags.length === 1 && flags[0].kind === "late_conflict" && flags[0].employee_id === ana.employeeId, "G) Ana's claim is flagged as a late conflict", flags);
    const rowG = await dbWeighing(trial.token, wF.stationWeighingId);
    check(rowG.status === "credited" && rowG.employee_id === maria.employeeId, "G) Maria's credit is unchanged", rowG);

    // -----------------------------------------------------------------
    // H) Two employees in one cycle: needs review, nobody credited
    // -----------------------------------------------------------------
    await sync(ruben, [choice(ruben, binA.id, at(30))]);
    await sync(maria, [choice(maria, binA.id, at(40))]);
    await sleep(200);
    const wH = weighing(binA, at(60));
    const h1 = await station(trial.token, "POST", "/weighings", wH);
    const rowH = await dbWeighing(trial.token, wH.stationWeighingId);
    const competing = await pool.query(`select employee_id from scale_weighing_flags where weighing_id = $1 and kind = 'competing'`, [rowH.id]);
    check(h1.body?.status === "needs_review" && rowH.employee_id === null, "H) two employees: needs review", h1.body);
    check(
      new Set(competing.rows.map((x) => x.employee_id)).size === 2,
      "H) both employees' claims are recorded as competing",
      competing.rows
    );
    check(
      (await pool.query(`select count(*)::int as n from scale_weighing_claims where weighing_id = $1`, [rowH.id])).rows[0].n === 0,
      "H) no claim was consumed"
    );

    // -----------------------------------------------------------------
    // I) Expiry: no claim received within 24 h; a later one can't credit it
    // -----------------------------------------------------------------
    const old = new Date(Date.now() - 25 * 60 * MIN);
    const wI = weighing(binC, old);
    const i1 = await station(trial.token, "POST", "/weighings", wI);
    check(i1.body?.status === "expired", "I) uploaded 25 h after weighing with no claim: expired", i1.body);
    r = await sync(sam, [choice(sam, binC.id, new Date(old.getTime() - 60 * MIN))]);
    check(r.status === 200, "I) Sam's day-old choice syncs now", r.body);
    await sleep(300);
    const rowI = await dbWeighing(trial.token, wI.stationWeighingId);
    check(rowI.status === "expired" && rowI.employee_id === null, "I) a claim received after the deadline never credits", rowI);

    // -----------------------------------------------------------------
    // J) A phone event whose clock was flagged never credits
    // -----------------------------------------------------------------
    await pool.query(
      `insert into mobile_time_events
         (client_event_id, device_id, employee_id, device_seq, event_type, occurred_at_utc, local_tz_offset_minutes, payload, processing_status,
          conflict_reason, conflict_detail)
       values ($1, $2, $3, 999, 'activity_switch', $4, 0, $5, 'accepted', 'Device clock moved backward', $6)`,
      [
        randomUUID(),
        sam.deviceRowId,
        sam.employeeId,
        at(105),
        JSON.stringify({ activityId, carrierId: binD.id, answers: [{ questionId, carrierId: binD.id }] }),
        JSON.stringify({ regressionMs: 60000 }),
      ]
    );
    const j1 = await station(trial.token, "POST", "/weighings", weighing(binD, at(110)));
    check(j1.body?.status === "pending", "J) a clock-flagged choice does not credit", j1.body);

    // -----------------------------------------------------------------
    // K) Weighing upload and phone sync racing: exactly one credit each time
    // -----------------------------------------------------------------
    for (let i = 0; i < concurrentBins.length; i++) {
      const bin = concurrentBins[i];
      const w = weighing(bin, at(71 + i * 2));
      const [s, u] = await Promise.all([sync(ana, [choice(ana, bin.id, at(70 + i * 2))]), station(trial.token, "POST", "/weighings", w)]);
      check(s.status === 200 && u.status === 201, `K${i}) both requests succeed`, { s: s.body, u: u.body });
      const row = await dbWeighing(trial.token, w.stationWeighingId);
      check((await waitForStatus(row.id, "credited")) === "credited", `K${i}) credited`);
      const n = (await pool.query(`select count(*)::int as n from scale_weighing_claims where weighing_id = $1`, [row.id])).rows[0].n;
      check(n === 1, `K${i}) exactly one claim consumed`, n);
    }
    const dupUploads = weighing(binG, at(118));
    const both = await Promise.all([1, 2, 3].map(() => station(trial.token, "POST", "/weighings", dupUploads)));
    check(both.every((x) => x.status === 201 || x.status === 200), "K) the same upload sent three times at once all succeed", both.map((x) => x.status));
    check(
      (await pool.query(`select count(*)::int as n from scale_weighings where station_weighing_id = $1`, [dupUploads.stationWeighingId])).rows[0].n === 1,
      "K) ...and store one row"
    );

    // -----------------------------------------------------------------
    // L) Live station: credits are live
    // -----------------------------------------------------------------
    await sync(ruben, [choice(ruben, binF.id, at(100))]);
    await sleep(200);
    const l1 = await station(live.token, "POST", "/weighings", weighing(binF, at(101)));
    check(l1.body?.status === "credited" && l1.body?.creditsLive === true, "L) a live station's credit is live", l1.body);

    // -----------------------------------------------------------------
    // M) Matching switched off: nothing is decided; status read catches up
    // -----------------------------------------------------------------
    process.env.SCALE_MATCHING_ENABLED = "false";
    const binH = await carrier("Bin H", 154.4);
    const wM = weighing(binH, at(116));
    const m1 = await station(trial.token, "POST", "/weighings", wM);
    check(m1.body?.status === "pending", "M) with matching off a weighing stays pending", m1.body);
    await sync(ruben, [choice(ruben, binH.id, at(114))]);
    await sleep(300);
    const rowM = await dbWeighing(trial.token, wM.stationWeighingId);
    check(rowM.status === "pending", "M) ...and a phone sync doesn't change it", rowM);
    check((await sweepPendingWeighings()) === 0, "M) the sweep does nothing while switched off");
    delete process.env.SCALE_MATCHING_ENABLED;
    const m2 = await station(trial.token, "POST", "/weighings/status", { ids: [wM.stationWeighingId] });
    check(m2.body?.statuses?.[wM.stationWeighingId]?.status === "credited", "M) switched back on, the next status read credits it", m2.body);

    // -----------------------------------------------------------------
    // N) Anomalies held for review
    // -----------------------------------------------------------------
    const n1 = await station(trial.token, "POST", "/weighings", weighing(binA, at(-200)));
    check(n1.body?.status === "needs_review", "N) a weighing older than one already received for the bin is held for review", n1.body);
    const binI = await carrier("Bin I", 154.4);
    const n2 = await station(trial.token, "POST", "/weighings", weighing(binI, new Date(Date.now() + 60 * MIN)));
    check(n2.body?.status === "needs_review", "N) a station clock ahead of the server is held for review", n2.body);

    // -----------------------------------------------------------------
    // O) Status endpoint
    // -----------------------------------------------------------------
    const unknownId = randomUUID();
    const o1 = await station(trial.token, "POST", "/weighings/status", { ids: [wD.stationWeighingId, wF.stationWeighingId, unknownId, "junk"] });
    check(o1.status === 200 && o1.body.statuses[wD.stationWeighingId]?.status === "credited", "O) statuses are returned", o1.body);
    check(!(unknownId in o1.body.statuses), "O) an id the server has never seen is omitted (the station re-sends it)");
    const o2 = await station(live.token, "POST", "/weighings/status", { ids: [wD.stationWeighingId] });
    check(Object.keys(o2.body.statuses).length === 0, "O) a station only sees its own weighings", o2.body);
    const o3 = await station(trial.token, "POST", "/weighings/status", { ids: Array.from({ length: 101 }, () => randomUUID()) });
    check(o3.status === 400, "O) at most 100 ids per call");

    // -----------------------------------------------------------------
    // P) The post-sync matcher never throws
    // -----------------------------------------------------------------
    let threw = false;
    try {
      await reconcileAfterPhoneSync("not-a-uuid", ["also-not-a-uuid"]);
    } catch {
      threw = true;
    }
    check(!threw, "P) a matching failure after phone sync is caught and logged, never thrown");

    // Every credited weighing has exactly one employee and only its own claims.
    const integrity = await pool.query(
      `select w.id from scale_weighings w
       where w.station_id = any($1::uuid[]) and w.status = 'credited'
         and exists (select 1 from scale_weighing_claims c where c.weighing_id = w.id and c.employee_id <> w.employee_id)`,
      [stationIds]
    );
    check(integrity.rows.length === 0, "Z) no credited weighing consumed another employee's claim", integrity.rows);
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const w = `(select id from scale_weighings where station_id = any($1::uuid[]))`;
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
      if (zeroActivityId) await client.query(`delete from activities where id = $1`, [zeroActivityId]);
      await client.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }
    const left = await pool.query(`select count(*)::int as n from carriers where id = any($1::uuid[])`, [carrierIds]);
    check(left.rows[0].n === 0, "Z) all QA fixtures cleaned up");
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
