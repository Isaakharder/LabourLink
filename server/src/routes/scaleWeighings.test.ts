// Integration tests for the Scale Weighings page API (routes/scaleWeighings.ts)
// and the totals views (072_scale_weighing_corrections.sql): one day's
// weighings in the app timezone, filters, totals that leave out voided and
// duplicate weighings, the detail view with its history, and administrator
// voiding (reason required, original kept, applied once). Real router over
// real HTTP against the real database; RUN_ID-suffixed fixtures.
//
// Run with: npm run test:scale-weighings
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { addDaysToDateStr, calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import scaleWeighingsRouter from "./scaleWeighings";

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
// A fixed past day, so nothing else in the test database lands on it.
const DAY = addDaysToDateStr(calendarDateInAppTimezone(new Date()), -400 - (RUN_ID % 300));

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/scale-weighings", scaleWeighingsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const employeeIds: string[] = [];
  const carrierIds: string[] = [];
  let stationId: string | undefined;
  let deviceId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    async function employee(role: string, first: string) {
      const roleId = (await pool.query(`select id from security_roles where name = $1`, [role])).rows[0].id;
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, $4) returning id`,
          [first, `SW ${RUN_ID}`, roleId, teamRoleId]
        )
      ).rows[0].id as string;
      employeeIds.push(id);
      return { id, name: `${first} SW ${RUN_ID}`, token: signSession({ id, firstName: first, lastName: `SW ${RUN_ID}`, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await employee("Administrator", "Adam");
    const manager = await employee("Manager", "Mona");
    const picker = await employee("Employee", "Pia");
    const ruben = await employee("Employee", "Ruben");
    const maria = await employee("Employee", "Maria");

    stationId = (
      await pool.query(`insert into scale_stations (name, token_hash, credits_enabled) values ($1, $2, true) returning id`, [`QA SW ${RUN_ID}`, `h-${RUN_ID}`])
    ).rows[0].id as string;
    async function bin(name: string) {
      const id = (await pool.query(`insert into carriers (name, tare_weight_kg) values ($1, 150) returning id`, [`QA SW ${RUN_ID} ${name}`])).rows[0].id as string;
      carrierIds.push(id);
      return id;
    }
    const bin77 = await bin("Bin 77");
    const bin3 = await bin("Bin 3");

    const { start } = getDayBoundsUtc(DAY);
    const atMin = (m: number) => new Date(start.getTime() + m * 60_000);
    async function weighing(o: { carrier: string; at: Date; netG: number; status: string; employee?: string | null; live?: boolean; duplicate?: boolean }) {
      const tareG = 150_000;
      return (
        await pool.query(
          `insert into scale_weighings (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, weighed_at, pending_until,
             credits_live, status, employee_id, is_duplicate, samples_g)
           values ($1, $2, $3, '0000000182225750', $4, $5, $6, $7, $7::timestamptz + interval '24 hours', $8, $9, $10, $11, $12)
           returning id`,
          [stationId, randomUUID(), o.carrier, tareG + o.netG, tareG, o.netG, o.at, o.live ?? true, o.status, o.employee ?? null, o.duplicate ?? false, JSON.stringify([tareG + o.netG])]
        )
      ).rows[0].id as string;
    }

    // The day: 06:00 Ruben credited 18.1 kg; 06:02 duplicate of it; 08:00
    // Maria credited 20 kg; 09:00 pending 15 kg; 10:00 needs review 12 kg;
    // 11:00 expired 10 kg; 12:00 trial credit to Ruben 5 kg. Plus one
    // weighing just before the day and one just after, which must not show.
    const wRuben = await weighing({ carrier: bin77, at: atMin(360), netG: 18_100, status: "credited", employee: ruben.id });
    await weighing({ carrier: bin77, at: atMin(362), netG: 18_100, status: "needs_review", duplicate: true });
    const wMaria = await weighing({ carrier: bin3, at: atMin(480), netG: 20_000, status: "credited", employee: maria.id });
    const wPending = await weighing({ carrier: bin3, at: atMin(540), netG: 15_000, status: "pending" });
    await weighing({ carrier: bin77, at: atMin(600), netG: 12_000, status: "needs_review" });
    await weighing({ carrier: bin77, at: atMin(660), netG: 10_000, status: "expired" });
    await weighing({ carrier: bin3, at: atMin(720), netG: 5_000, status: "credited", employee: ruben.id, live: false });
    await weighing({ carrier: bin3, at: atMin(-1), netG: 99_000, status: "pending" });
    await weighing({ carrier: bin3, at: atMin(24 * 60), netG: 99_000, status: "pending" });

    // History and the phone claim behind Ruben's credit.
    await pool.query(`insert into scale_weighing_events (weighing_id, kind, to_status) values ($1, 'received', 'pending')`, [wRuben]);
    await pool.query(
      `insert into scale_weighing_events (weighing_id, kind, from_status, to_status, employee_id, reason) values ($1, 'status', 'pending', 'credited', $2, 'One employee chose this bin')`,
      [wRuben, ruben.id]
    );
    deviceId = (await pool.query(`insert into devices (device_identifier, device_name) values ($1, $2) returning id`, [randomUUID(), `QA SW phone ${RUN_ID}`])).rows[0].id as string;
    const eventId = (
      await pool.query(
        `insert into mobile_time_events (client_event_id, device_id, employee_id, device_seq, event_type, occurred_at_utc, local_tz_offset_minutes, payload, processing_status)
         values ($1, $2, $3, 1, 'activity_switch', $4, 0, '{}', 'accepted') returning id`,
        [randomUUID(), deviceId, ruben.id, atMin(330)]
      )
    ).rows[0].id;
    await pool.query(`insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3)`, [eventId, wRuben, ruben.id]);

    async function call(method: string, path: string, token: string | null, body?: unknown) {
      const res = await fetch(`${BASE}/api/scale-weighings${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Cookie: `labourlink_session=${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    }

    // -----------------------------------------------------------------
    // A) Access
    // -----------------------------------------------------------------
    check((await call("GET", `?date=${DAY}`, null)).status === 401, "A) signed out: refused");
    check((await call("GET", `?date=${DAY}`, picker.token)).status === 403, "A) an Employee can't see the page");
    check((await call("GET", `?date=${DAY}`, manager.token)).status === 200, "A) a Manager can");
    const today = await call("GET", "", admin.token);
    check(today.status === 200 && today.body.date === calendarDateInAppTimezone(new Date()), "A) defaults to today", today.body?.date);

    // -----------------------------------------------------------------
    // B) One day, its totals
    // -----------------------------------------------------------------
    const day = await call("GET", `?date=${DAY}`, admin.token);
    const t = day.body.totals;
    check(day.body.weighings.length === 7, "B) only that day's weighings (app timezone)", day.body.weighings.length);
    check(day.body.weighings[0].weighedAt > day.body.weighings[6].weighedAt, "B) newest first");
    check(t.binsWeighed === 6 && t.netKg === 80.1, "B) production: 6 bins, 80.1 kg (duplicate left out)", t);
    check(t.credited === 2 && t.creditedNetKg === 38.1, "B) credited: Ruben 18.1 + Maria 20 (trial credit left out)", t);
    check(t.pending === 1 && t.needsReview === 1 && t.neverCredited === 2 && t.duplicates === 1 && t.trial === 1, "B) pending, review, never credited, duplicates, trial", t);
    const first = day.body.weighings.find((w: any) => w.id === wRuben);
    check(
      first.bin.name.endsWith("Bin 77") && first.grossKg === 168.1 && first.tareKg === 150 && first.netKg === 18.1 && first.employee?.name === ruben.name && first.stationName === `QA SW ${RUN_ID}`,
      "B) a row has time, bin, tag, gross, tare, net, employee, station",
      first
    );
    check(day.body.filters.bins.length === 2 && day.body.filters.employees.length === 2, "B) filter choices: the day's bins and credited employees", day.body.filters);

    // -----------------------------------------------------------------
    // C) Filters
    // -----------------------------------------------------------------
    const byBin = await call("GET", `?date=${DAY}&carrierId=${bin3}`, admin.token);
    check(byBin.body.weighings.length === 3 && byBin.body.totals.netKg === 40, "C) by bin", byBin.body.totals);
    const byEmp = await call("GET", `?date=${DAY}&employeeId=${ruben.id}`, admin.token);
    check(byEmp.body.weighings.length === 2 && byEmp.body.totals.creditedNetKg === 18.1, "C) by employee (trial credit shown, not counted)", byEmp.body.totals);
    const notCredited = await call("GET", `?date=${DAY}&status=not_credited`, admin.token);
    check(notCredited.body.weighings.length === 4, "C) never/not credited: pending, review, duplicate, expired", notCredited.body.weighings.map((w: any) => w.status));
    check((await call("GET", `?date=${DAY}&status=bogus`, admin.token)).status === 400, "C) unknown status filter refused");
    const empty = await call("GET", `?date=${addDaysToDateStr(DAY, -1)}`, admin.token);
    check(empty.body.weighings.length === 1 && empty.body.totals.netKg === 99, "C) the previous day has only its own weighing", empty.body.totals);

    // -----------------------------------------------------------------
    // D) Detail and history
    // -----------------------------------------------------------------
    const det = await call("GET", `/${wRuben}`, manager.token);
    const d = det.body.weighing;
    check(det.status === 200 && d.samplesKg[0] === 168.1 && d.countsAsCredit === true && d.countsForProduction === true, "D) detail with samples and what it counts for", d);
    check(d.history.length === 2 && d.history[1].toStatus === "credited" && d.history[1].employeeName === ruben.name, "D) history shows the credit", d.history);
    check(d.claims.length === 1 && d.claims[0].employeeName === ruben.name && d.claims[0].deviceName === `QA SW phone ${RUN_ID}`, "D) the phone claim behind the credit", d.claims);
    check((await call("GET", `/${randomUUID()}`, admin.token)).status === 404, "D) unknown weighing: 404");

    // -----------------------------------------------------------------
    // E) Voiding a credit
    // -----------------------------------------------------------------
    const correctionId = randomUUID();
    check((await call("POST", `/${wRuben}/void`, manager.token, { correctionId, reason: "Wrong picker" })).status === 403, "E) only an Administrator can void");
    check((await call("POST", `/${wRuben}/void`, admin.token, { correctionId, reason: "  " })).status === 400, "E) a reason is required");
    check((await call("POST", `/${wPending}/void`, admin.token, { correctionId: randomUUID(), reason: "Not right" })).status === 409, "E) only a credit can be voided");
    const [v1, v2] = await Promise.all([
      call("POST", `/${wRuben}/void`, admin.token, { correctionId, reason: "Ruben was on another row; Maria filled this bin" }),
      call("POST", `/${wRuben}/void`, admin.token, { correctionId, reason: "Ruben was on another row; Maria filled this bin" }),
    ]);
    check([v1.status, v2.status].sort().join() === "200,201", "E) the same request sent twice at once is applied once", [v1.status, v2.status]);
    const voided = (v1.status === 201 ? v1 : v2).body.weighing;
    check(voided.status === "voided" && voided.employee?.name === ruben.name && voided.netKg === 18.1, "E) voided, with the original employee and weights kept", voided);
    check(voided.countsAsCredit === false && voided.countsForProduction === false, "E) a voided weighing counts for nothing");
    check(voided.corrections.length === 1 && voided.corrections[0].performedBy === admin.name && voided.corrections[0].previousEmployeeName === ruben.name, "E) the correction records who, why and what it was", voided.corrections);
    check(voided.history[voided.history.length - 1].kind === "void" && voided.history[voided.history.length - 1].actorName === admin.name, "E) history shows the void and who did it");
    check(voided.claims.length === 1, "E) the phone claim stays recorded");
    const again = await call("POST", `/${wRuben}/void`, admin.token, { correctionId: randomUUID(), reason: "Again" });
    check(again.status === 409 && again.body.code === "alreadyVoided", "E) a credit can't be voided twice", again.body);
    const reused = await call("POST", `/${wMaria}/void`, admin.token, { correctionId, reason: "Reuse" });
    check(reused.status === 409, "E) a correction id can't be reused for another weighing", reused.body);
    const after = await call("GET", `?date=${DAY}`, admin.token);
    check(after.body.totals.netKg === 62 && after.body.totals.creditedNetKg === 20 && after.body.totals.voided === 1, "E) totals drop the voided credit", after.body.totals);
    const credits = await pool.query(`select count(*)::int as n from scale_employee_credits where employee_id = $1`, [ruben.id]);
    check(credits.rows[0].n === 0, "E) Ruben has no live credit left in scale_employee_credits (trial excluded too)", credits.rows);
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (stationId) {
        const w = `(select id from scale_weighings where station_id = $1)`;
        await client.query(`delete from scale_weighing_corrections where weighing_id in ${w}`, [stationId]);
        await client.query(`delete from scale_weighing_events where weighing_id in ${w}`, [stationId]);
        await client.query(`delete from scale_weighing_claims where weighing_id in ${w}`, [stationId]);
        await client.query(`delete from scale_weighings where station_id = $1`, [stationId]);
        await client.query(`delete from scale_stations where id = $1`, [stationId]);
      }
      if (deviceId) {
        await client.query(`delete from mobile_time_events where device_id = $1`, [deviceId]);
        await client.query(`delete from devices where id = $1`, [deviceId]);
      }
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
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
