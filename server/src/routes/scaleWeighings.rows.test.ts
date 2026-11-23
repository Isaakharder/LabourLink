// Rows column on the Scale Weighings page (lib/scaleWeighingRows.ts): which
// greenhouse rows each weighed bin was picked in, through the real router.
// Covers weighings decided before picking-cycle tracking (one credited
// employee's claims) and inside a tracking period (the cycle the weighing
// closed), and every case that must show "unknown" (—) instead of guessing:
// needs review, pending, a duplicate, no cycle, several employees in one
// cycle, a bin use that started on an earlier day, and no row recorded.
// Never mixes in other employees, other bins, deleted entries, or entries
// outside the bin use. RUN_ID-suffixed fixtures on a fixed past day.
//
// Run with: npm run test:scale-weighings-rows
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { addDaysToDateStr, calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { ROWS_REASONS } from "../lib/scaleWeighingRows";
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
const DAY = addDaysToDateStr(calendarDateInAppTimezone(new Date()), -800 - (RUN_ID % 300));

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

  const ids = {
    employees: [] as string[],
    carriers: [] as string[],
    weighings: [] as string[],
    events: [] as string[],
    entries: [] as string[],
    cycles: [] as string[],
    rows: [] as string[],
    phases: [] as string[],
  };
  let stationId: string | undefined;
  let deviceId: string | undefined;
  let landId: string | undefined;
  let activityId: string | undefined;
  let periodId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    async function employee(role: string, first: string) {
      const roleId = (await pool.query(`select id from security_roles where name = $1`, [role])).rows[0].id;
      const id = (
        await pool.query(`insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, $4) returning id`, [
          first,
          `SWR ${RUN_ID}`,
          roleId,
          teamRoleId,
        ])
      ).rows[0].id as string;
      ids.employees.push(id);
      return { id, token: signSession({ id, firstName: first, lastName: `SWR ${RUN_ID}`, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await employee("Administrator", "Adam");
    const ana = await employee("Employee", "Ana");
    const ben = await employee("Employee", "Ben");

    stationId = (
      await pool.query(`insert into scale_stations (name, token_hash, credits_enabled) values ($1, $2, true) returning id`, [`QA SWR ${RUN_ID}`, `h-swr-${RUN_ID}`])
    ).rows[0].id as string;
    deviceId = (await pool.query(`insert into devices (device_identifier, device_name) values ($1, $2) returning id`, [randomUUID(), `QA SWR phone ${RUN_ID}`])).rows[0]
      .id as string;
    activityId = (await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA SWR Picking ${RUN_ID}`])).rows[0].id as string;
    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [`QA SWR ${RUN_ID}`])).rows[0]
      .id as string;
    async function phase(name: string) {
      const id = (
        await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [landId, name])
      ).rows[0].id as string;
      ids.phases.push(id);
      return id;
    }
    const p1 = await phase(`QA SWR ${RUN_ID} Phase 1`);
    const p2 = await phase(`QA SWR ${RUN_ID} Phase 2`);
    async function row(phaseId: string, n: number) {
      const id = (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
          [phaseId, n, n * 3]
        )
      ).rows[0].id as string;
      ids.rows.push(id);
      return id;
    }
    const r1 = await row(p1, 1);
    const r2 = await row(p1, 2);
    const r3 = await row(p1, 3);
    const r10 = await row(p1, 10);
    const r7 = await row(p2, 7);
    const label = (phaseNo: number, n: number) => `QA SWR ${RUN_ID} Phase ${phaseNo} · Row ${n}`;

    async function bin(name: string) {
      const id = (await pool.query(`insert into carriers (name, tare_weight_kg) values ($1, 150) returning id`, [`QA SWR ${RUN_ID} ${name}`])).rows[0].id as string;
      ids.carriers.push(id);
      return id;
    }

    const { start } = getDayBoundsUtc(DAY);
    const at = (h: number, m = 0) => new Date(start.getTime() + (h * 60 + m) * 60_000);

    async function weighing(carrier: string, when: Date, status: string, employeeId: string | null = null, duplicate = false) {
      const id = (
        await pool.query(
          `insert into scale_weighings (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, weighed_at, pending_until,
             credits_live, status, employee_id, is_duplicate)
           values ($1, $2, $3, 'T', 170000, 150000, 20000, $4, $4::timestamptz + interval '24 hours', true, $5, $6, $7) returning id`,
          [stationId, randomUUID(), carrier, when, status, employeeId, duplicate]
        )
      ).rows[0].id as string;
      ids.weighings.push(id);
      return id;
    }
    let seq = 0;
    async function phoneEvent(employeeId: string, when: Date) {
      const id = (
        await pool.query(
          `insert into mobile_time_events (client_event_id, device_id, employee_id, device_seq, event_type, occurred_at_utc, local_tz_offset_minutes, payload, processing_status)
           values ($1, $2, $3, $4, 'activity_switch', $5, 0, '{}', 'accepted') returning id`,
          [randomUUID(), deviceId, employeeId, ++seq, when]
        )
      ).rows[0].id as string;
      ids.events.push(id);
      return id;
    }
    async function claim(weighingId: string, employeeId: string, when: Date) {
      const ev = await phoneEvent(employeeId, when);
      await pool.query(`insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3)`, [ev, weighingId, employeeId]);
    }
    async function work(employeeId: string, carrier: string, rowId: string | null, from: Date, to: Date | null) {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, greenhouse_row_id, carrier_id)
           values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6) returning id`,
          [employeeId, activityId, from, to, rowId, carrier]
        )
      ).rows[0].id as string;
      ids.entries.push(id);
      return id;
    }
    async function cycle(carrier: string, employeeId: string, openedAt: Date, weighingId: string, scanners: string[]) {
      const id = (
        await pool.query(
          `insert into bin_cycles (carrier_id, status, employee_id, opened_at, last_scan_at, weighing_id, closed_at)
           values ($1, 'closed', $2, $3, $3, $4, $3::timestamptz + interval '1 hour') returning id`,
          [carrier, employeeId, openedAt, weighingId]
        )
      ).rows[0].id as string;
      ids.cycles.push(id);
      for (const [i, emp] of scanners.entries()) {
        const when = new Date(openedAt.getTime() + i * 60_000);
        const ev = await phoneEvent(emp, when);
        await pool.query(
          `insert into bin_scans (mobile_time_event_id, carrier_id, employee_id, occurred_at, received_at, clock_trusted, cycle_id) values ($1, $2, $3, $4, $4, true, $5)`,
          [ev, carrier, emp, when, id]
        );
      }
      return id;
    }

    // Picking-cycle tracking ran 12:00-20:00 that day (a closed period, so it
    // never touches the live tracking state of the test database).
    periodId = (
      await pool.query(`insert into bin_cycle_tracking (started_at, stopped_at, note) values ($1, $2, $3) returning id`, [at(12), at(20), `QA SWR ${RUN_ID}`])
    ).rows[0].id as string;

    // ---- Before tracking (original rule) ----
    // L1: Ana credited, bin A. Her rows with bin A from her first claim to the
    // weighing: rows 1 and 2. Not: row 3 (another bin), Ben's row 7 (another
    // employee), row 10 after the weighing, a deleted row 3 entry, or an
    // entry with bin A that ended before her first claim.
    const binA = await bin("Bin A");
    const binOther = await bin("Bin Other");
    const L1 = await weighing(binA, at(9, 10), "credited", ana.id);
    await claim(L1, ana.id, at(7));
    await claim(L1, ana.id, at(8));
    await work(ana.id, binA, r3, at(6), at(7)); // ended as the first claim began
    await work(ana.id, binA, r1, at(7), at(8));
    await work(ana.id, binA, r2, at(8), at(9));
    await work(ana.id, binOther, r3, at(9), at(9, 5));
    await work(ben.id, binA, r7, at(7, 30), at(8));
    await work(ana.id, binA, r10, at(9, 20), at(10));
    const deleted = await work(ana.id, binA, r3, at(8, 30), at(8, 40));
    await pool.query(`update time_entries set deleted_at = now(), deleted_by_employee_id = $2, deletion_reason = 'QA' where id = $1`, [deleted, admin.id]);
    // L2: duplicate of L1 two minutes later.
    const L2 = await weighing(binA, at(9, 12), "needs_review", null, true);
    // L3: needs review (two employees chose the bin).
    const binB = await bin("Bin B");
    const L3 = await weighing(binB, at(9, 30), "needs_review");
    await work(ana.id, binB, r1, at(8), at(9));
    // L4: pending, nobody chose the bin.
    const binC = await bin("Bin C");
    const L4 = await weighing(binC, at(9, 40), "pending");
    // L5: credited, but the claim is from the day before (bin emptied
    // unweighed and reused?): unknown.
    const binD = await bin("Bin D");
    const L5 = await weighing(binD, at(8), "credited", ana.id);
    await claim(L5, ana.id, at(-9));
    await work(ana.id, binD, r1, at(-9), at(-8));
    await work(ana.id, binD, r2, at(7), at(7, 50));
    // L6: credited, but no row was recorded with the bin.
    const binE = await bin("Bin E");
    const L6 = await weighing(binE, at(10), "credited", ben.id);
    await claim(L6, ben.id, at(9));
    await work(ben.id, binE, null, at(9), at(9, 50));
    // L7: voided credit keeps its rows.
    const binV = await bin("Bin V");
    const L7 = await weighing(binV, at(11), "voided", ben.id);
    await claim(L7, ben.id, at(10, 30));
    await work(ben.id, binV, r7, at(10, 30), at(10, 55));

    // ---- Inside the tracking period ----
    // T1: Ana's cycle on bin F opened 14:00, weighed 16:30. Ben's earlier use
    // (superseded, his own entries) and Ana's previous use ending at 14:00
    // are left out; her entry still open at the weighing is included.
    const binF = await bin("Bin F");
    const T1 = await weighing(binF, at(16, 30), "credited", ana.id);
    await cycle(binF, ana.id, at(14), T1, [ana.id, ana.id]);
    await work(ben.id, binF, r3, at(13), at(13, 30));
    await work(ana.id, binF, r1, at(13, 30), at(14));
    await work(ana.id, binF, r2, at(14), at(15));
    await work(ana.id, binF, r2, at(15, 15), at(16));
    await work(ana.id, binF, r7, at(16), null);
    // T2: pending inside tracking, no cycle linked.
    const binG = await bin("Bin G");
    const T2 = await weighing(binG, at(13), "pending");
    await work(ana.id, binG, r1, at(12, 30), at(12, 50));
    // T3: one cycle scanned by two employees (pre-075 style).
    const binH = await bin("Bin H");
    const T3 = await weighing(binH, at(15), "credited", ana.id);
    await cycle(binH, ana.id, at(13), T3, [ana.id, ben.id]);
    await work(ana.id, binH, r1, at(13), at(14));
    // T4: needs review inside tracking (held by the station check), with the
    // cycle it closed: its rows are known.
    const binJ = await bin("Bin J");
    const T4 = await weighing(binJ, at(17, 40), "needs_review");
    await cycle(binJ, ben.id, at(17), T4, [ben.id]);
    await work(ben.id, binJ, r10, at(17), at(17, 30));
    await work(ben.id, binJ, r3, at(17, 30), at(17, 35));

    const get = async (path: string) => {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: `labourlink_session=${admin.token}` } });
      return { status: res.status, body: (await res.json()) as any };
    };
    const day = await get(`/api/scale-weighings?date=${DAY}`);
    check(day.status === 200, "list loads", day.body);
    const byId = new Map<string, any>((day.body.weighings ?? []).map((w: any) => [w.id, w]));
    const labels = (id: string) => {
      const r = byId.get(id)?.rows;
      return r?.status === "known" ? r.rows.map((x: any) => x.label) : null;
    };
    const reason = (id: string) => (byId.get(id)?.rows?.status === "unknown" ? byId.get(id).rows.reason : null);

    check(JSON.stringify(labels(L1)) === JSON.stringify([label(1, 1), label(1, 2)]), "L1: only Ana's rows with this bin during this bin use", byId.get(L1)?.rows);
    check(reason(L2) === ROWS_REASONS.duplicate, "L2: duplicate shows —", byId.get(L2)?.rows);
    check(reason(L3) === ROWS_REASONS.competing, "L3: needs review before tracking shows —", byId.get(L3)?.rows);
    check(reason(L4) === ROWS_REASONS.nobody, "L4: pending with nobody shows —", byId.get(L4)?.rows);
    check(byId.get(L4)?.rows?.code === "nobody" && byId.get(T2)?.rows?.code === "noCycle" && byId.get(L2)?.rows?.code === "duplicate", "unknown rows carry a reason code", [byId.get(L4)?.rows, byId.get(T2)?.rows]);
    check(reason(L5) === ROWS_REASONS.earlierDay, "L5: a bin use from an earlier day shows —", byId.get(L5)?.rows);
    check(reason(L6) === ROWS_REASONS.noRows, "L6: no row recorded shows —", byId.get(L6)?.rows);
    check(JSON.stringify(labels(L7)) === JSON.stringify([label(2, 7)]), "L7: a voided credit keeps its rows", byId.get(L7)?.rows);
    check(JSON.stringify(labels(T1)) === JSON.stringify([label(1, 2), label(2, 7)]), "T1: the cycle's rows, phases in order, no earlier use", byId.get(T1)?.rows);
    check(reason(T2) === ROWS_REASONS.noCycle, "T2: no cycle linked shows —", byId.get(T2)?.rows);
    check(reason(T3) === ROWS_REASONS.severalInCycle, "T3: two employees in one cycle shows —", byId.get(T3)?.rows);
    check(JSON.stringify(labels(T4)) === JSON.stringify([label(1, 3), label(1, 10)]), "T4: needs review with its cycle shows its rows, numeric order", byId.get(T4)?.rows);
    const t1Row = byId.get(T1)?.rows?.rows?.[1];
    check(t1Row?.phaseName === `QA SWR ${RUN_ID} Phase 2` && t1Row?.rowNumber === 7 && t1Row?.id === r7, "row carries phase name, number and id", t1Row);

    // Status counts cover the bin/employee filters only.
    check(
      day.body.statusCounts?.all === 11 && day.body.statusCounts?.credited === 5 && day.body.statusCounts?.needs_review === 2 && day.body.statusCounts?.duplicate === 1,
      "status counts: needs review leaves out the duplicate, which has its own count",
      day.body.statusCounts
    );
    check(day.body.totals.needsReview === day.body.statusCounts.needs_review, "Needs review card = Needs review count", day.body.totals);
    const review = await get(`/api/scale-weighings?date=${DAY}&status=needs_review`);
    check(
      review.body.weighings.length === review.body.statusCounts.needs_review && review.body.weighings.every((w: any) => w.status === "needs_review" && !w.isDuplicate),
      "Needs review filter lists exactly what the card and count say",
      review.body.weighings.map((w: any) => [w.status, w.isDuplicate])
    );
    check(JSON.stringify(review.body.totals) === JSON.stringify(day.body.totals), "status filter leaves the summary cards unchanged", review.body.totals);
    const dups = await get(`/api/scale-weighings?date=${DAY}&status=duplicate`);
    check(dups.body.weighings.length === 1 && dups.body.weighings[0].id === L2, "Duplicate filter lists the duplicate", dups.body.weighings.length);
    const filtered = await get(`/api/scale-weighings?date=${DAY}&status=pending`);
    check(filtered.body.weighings.length === 2 && filtered.body.statusCounts.all === 11, "status filter keeps every count", filtered.body.statusCounts);
    const byBin = await get(`/api/scale-weighings?date=${DAY}&carrierId=${binA}`);
    check(byBin.body.statusCounts.all === 2 && byBin.body.statusCounts.credited === 1, "bin filter narrows the counts", byBin.body.statusCounts);

    // Detail view carries the same rows.
    const detail = await get(`/api/scale-weighings/${T1}`);
    check(JSON.stringify(detail.body.weighing?.rows) === JSON.stringify(byId.get(T1)?.rows), "detail has the same rows as the list", detail.body.weighing?.rows);
    const detailUnknown = await get(`/api/scale-weighings/${L3}`);
    check(detailUnknown.body.weighing?.rows?.reason === ROWS_REASONS.competing, "detail explains an unknown", detailUnknown.body.weighing?.rows);

    // Read-only: nothing about the weighings changed.
    const { rows: after } = await pool.query(`select id, status, employee_id from scale_weighings where id = any($1::uuid[]) order by id`, [ids.weighings]);
    check(after.find((w) => w.id === L1)?.status === "credited" && after.find((w) => w.id === T4)?.status === "needs_review", "weighings unchanged");
  } finally {
    const tryDelete = async (q: string, p: unknown[]) => {
      try {
        await pool.query(q, p);
      } catch (err) {
        console.error("cleanup step failed:", q, err);
      }
    };
    await tryDelete(`delete from bin_scans where cycle_id = any($1::uuid[])`, [ids.cycles]);
    await tryDelete(`delete from bin_cycles where id = any($1::uuid[])`, [ids.cycles]);
    await tryDelete(`delete from scale_weighing_claims where weighing_id = any($1::uuid[])`, [ids.weighings]);
    await tryDelete(`delete from scale_weighing_events where weighing_id = any($1::uuid[])`, [ids.weighings]);
    await tryDelete(`delete from scale_weighings where id = any($1::uuid[])`, [ids.weighings]);
    await tryDelete(`delete from mobile_time_events where id = any($1::uuid[])`, [ids.events]);
    await tryDelete(`delete from time_entries where id = any($1::uuid[])`, [ids.entries]);
    await tryDelete(`delete from greenhouse_rows where id = any($1::uuid[])`, [ids.rows]);
    await tryDelete(`delete from greenhouse_phases where id = any($1::uuid[])`, [ids.phases]);
    if (landId) await tryDelete(`delete from greenhouse_lands where id = $1`, [landId]);
    if (activityId) await tryDelete(`delete from activities where id = $1`, [activityId]);
    await tryDelete(`delete from carriers where id = any($1::uuid[])`, [ids.carriers]);
    if (periodId) await tryDelete(`delete from bin_cycle_tracking where id = $1`, [periodId]);
    if (deviceId) await tryDelete(`delete from devices where id = $1`, [deviceId]);
    if (stationId) await tryDelete(`delete from scale_stations where id = $1`, [stationId]);
    await tryDelete(`delete from employees where id = any($1::uuid[])`, [ids.employees]);
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
