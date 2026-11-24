// Kilograms/hour Jobs (077, lib/scaleProductivity.ts) against the real
// database: the matched weighed-bin calculation, the TV ranking slide, the
// Dashboard card and the Jobs API. RUN_ID-suffixed fixtures on a day well in
// the future (after the reporting start date), removed at the end.
//
// Run with: npm run test:scale-productivity
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { addDaysToDateStr, calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { getScaleProductivity } from "../lib/scaleProductivity";
import { buildDisplaySlides, _clearSpeedCacheForTests } from "../lib/displaySpeedSlides";
import activitiesRouter from "./activities";
import dashboardRouter from "./dashboard";

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
// A Wednesday well in the future, so the reporting week (Mon..today) holds D-1 and D.
let DAY = addDaysToDateStr(calendarDateInAppTimezone(new Date()), 400 + (RUN_ID % 200));
while (new Date(`${DAY}T12:00:00Z`).getUTCDay() !== 3) DAY = addDaysToDateStr(DAY, 1);
const PREV = addDaysToDateStr(DAY, -1);

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/activities", activitiesRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ids = { employees: [] as string[], carriers: [] as string[], weighings: [] as string[], events: [] as string[], entries: [] as string[], cycles: [] as string[], activities: [] as string[] };
  let stationId: string | undefined;
  let deviceId: string | undefined;
  let periodId: string | undefined;
  let landId: string | undefined;
  let displayId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    async function employee(role: string, first: string) {
      const roleId = (await pool.query(`select id from security_roles where name = $1`, [role])).rows[0].id;
      const id = (
        await pool.query(`insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, $4) returning id`, [first, `KGH ${RUN_ID}`, roleId, teamRoleId])
      ).rows[0].id as string;
      ids.employees.push(id);
      return { id, token: signSession({ id, firstName: first, lastName: `KGH ${RUN_ID}`, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await employee("Administrator", "Adam");
    const ana = await employee("Employee", "Ana");
    const ben = await employee("Employee", "Ben");
    const cal = await employee("Employee", "Cal");
    const dee = await employee("Employee", "Dee");

    async function activity(name: string, extra = "") {
      const id = (
        await pool.query(`insert into activities (name, is_active, density_source, speed_unit, normal_speed ${extra ? ", productivity_metric, scale_normal_kg_per_hour" : ""})
                          values ($1, true, 'stems', 'stems/hour', 300 ${extra}) returning id`, [`QA KGH ${name} ${RUN_ID}`])
      ).rows[0].id as string;
      ids.activities.push(id);
      return id;
    }
    const PICK = await activity("Picking", ", 'scale_kg', 150");
    const OTHER = await activity("Other");
    const EMPTY = await activity("Empty kg job", ", 'scale_kg', 150");

    stationId = (await pool.query(`insert into scale_stations (name, token_hash, credits_enabled) values ($1, $2, true) returning id`, [`QA KGH ${RUN_ID}`, `h-kgh-${RUN_ID}`])).rows[0].id;
    deviceId = (await pool.query(`insert into devices (device_identifier, device_name) values ($1, $2) returning id`, [randomUUID(), `QA KGH phone ${RUN_ID}`])).rows[0].id;
    const { start } = getDayBoundsUtc(DAY);
    const at = (h: number, m = 0) => new Date(start.getTime() + (h * 60 + m) * 60_000);
    periodId = (await pool.query(`insert into bin_cycle_tracking (started_at, stopped_at, note) values ($1, $2, $3) returning id`, [at(-24), at(30), `QA KGH ${RUN_ID}`])).rows[0].id;

    async function bin(name: string) {
      const id = (await pool.query(`insert into carriers (name, tare_weight_kg) values ($1, 150) returning id`, [`QA KGH ${RUN_ID} ${name}`])).rows[0].id as string;
      ids.carriers.push(id);
      return id;
    }
    async function weighing(carrier: string, when: Date, kg: number, status: string, employeeId: string | null, opts: { live?: boolean; duplicate?: boolean } = {}) {
      const id = (
        await pool.query(
          `insert into scale_weighings (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, weighed_at, pending_until, credits_live, status, employee_id, is_duplicate)
           values ($1, $2, $3, 'T', $4 + 150000, 150000, $4, $5, $5::timestamptz + interval '24 hours', $6, $7, $8, $9) returning id`,
          [stationId, randomUUID(), carrier, Math.round(kg * 1000), when, opts.live ?? true, status, employeeId, opts.duplicate ?? false]
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
    async function cycle(carrier: string, employeeId: string, openedAt: Date, weighingId: string | null, scanners: string[] = [employeeId], status = "closed") {
      const closed = status === "closed" || status === "superseded";
      const id = (
        await pool.query(
          `insert into bin_cycles (carrier_id, status, employee_id, opened_at, last_scan_at, weighing_id, closed_at, close_reason)
           values ($1, $2, $3, $4, $4, $5, $6, $7) returning id`,
          [carrier, status === "superseded" ? "closed_unweighed" : status, employeeId, openedAt, weighingId, closed ? new Date(openedAt.getTime() + 60_000) : null, status === "superseded" ? "qa" : null]
        )
      ).rows[0].id as string;
      ids.cycles.push(id);
      for (const [i, emp] of scanners.entries()) {
        const when = new Date(openedAt.getTime() + i * 60_000);
        const ev = await phoneEvent(emp, when);
        await pool.query(`insert into bin_scans (mobile_time_event_id, carrier_id, employee_id, occurred_at, received_at, clock_trusted, cycle_id) values ($1, $2, $3, $4, $4, true, $5)`, [ev, carrier, emp, when, id]);
      }
      return id;
    }
    async function work(employeeId: string, carrier: string | null, from: Date, to: Date | null, activityId = PICK) {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, carrier_id)
           values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5) returning id`,
          [employeeId, activityId, from, to, carrier]
        )
      ).rows[0].id as string;
      ids.entries.push(id);
      return id;
    }
    async function brk(employeeId: string, from: Date, to: Date) {
      const id = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
          [employeeId, from, to]
        )
      ).rows[0].id as string;
      ids.entries.push(id);
    }

    // ---- Ana: two eligible bins = 270 kg / 1.75 h ----
    // A1: scan (cycle) 07:00; the entry started at 06:58, a moment before the
    // scan; picking to 08:10 with a 07:30-07:40 break inside; weighed 08:00
    // -> 62 - 10 = 52 min (nothing after the weighing).
    const A1 = await bin("A1");
    const wA1 = await weighing(A1, at(8), 150, "credited", ana.id);
    await cycle(A1, ana.id, at(7), wA1);
    await work(ana.id, A1, at(6, 58), at(8, 10));
    await brk(ana.id, at(7, 30), at(7, 40));
    // A2: cycle 09:00, two overlapping entries 09:00-09:30 and 09:15-09:45
    // (counted once: 45 min), plus a deleted entry 09:45-09:55; weighed 10:00.
    const A2 = await bin("A2");
    const wA2 = await weighing(A2, at(10), 120, "credited", ana.id);
    await cycle(A2, ana.id, at(9), wA2);
    await work(ana.id, A2, at(9), at(9, 30));
    await work(ana.id, A2, at(9, 15), at(9, 45));
    const del = await work(ana.id, A2, at(9, 45), at(9, 55));
    await pool.query(`update time_entries set deleted_at = now(), deleted_by_employee_id = $2, deletion_reason = 'QA' where id = $1`, [del, admin.id]);
    // Never counted: a trial (credits not live), a voided credit, a pending
    // and a needs-review weighing, a duplicate. Each has matching time.
    const T = await bin("Trial");
    const wT = await weighing(T, at(11), 500, "credited", ana.id, { live: false });
    await cycle(T, ana.id, at(10, 30), wT);
    await work(ana.id, T, at(10, 30), at(11));
    const V = await bin("Voided");
    const wV = await weighing(V, at(12), 500, "voided", ana.id);
    await cycle(V, ana.id, at(11, 30), wV);
    await work(ana.id, V, at(11, 30), at(12));
    const P = await bin("Pending");
    await weighing(P, at(13), 500, "pending", null);
    await work(ana.id, P, at(12, 30), at(13));
    const NR = await bin("Review");
    await weighing(NR, at(14), 500, "needs_review", null);
    await work(ana.id, NR, at(13, 30), at(14));
    await weighing(A2, at(10, 2), 120, "needs_review", null, { duplicate: true });
    // An open bin (filling) with picking time: contributes nothing, counted as not yet weighed.
    const OPEN = await bin("Open");
    await cycle(OPEN, ana.id, at(15), null, [ana.id], "filling");
    await work(ana.id, OPEN, at(15), at(16));

    // ---- Ben: excluded bins, then a superseded review settled ----
    const B1 = await bin("B1"); // Cal also scanned the bin in this cycle
    const wB1 = await weighing(B1, at(8), 100, "credited", ben.id);
    await cycle(B1, ben.id, at(7), wB1, [ben.id, cal.id]);
    await work(ben.id, B1, at(7), at(8));
    const B2 = await bin("B2"); // Cal has time with the bin, no scan
    const wB2 = await weighing(B2, at(9, 30), 100, "credited", ben.id);
    await cycle(B2, ben.id, at(8, 30), wB2);
    await work(ben.id, B2, at(8, 30), at(9, 30));
    await work(cal.id, B2, at(8, 40), at(8, 50));
    const B3 = await bin("B3"); // Cal's earlier use superseded, review open
    const wB3 = await weighing(B3, at(11), 160, "credited", ben.id);
    const cB3 = await cycle(B3, ben.id, at(10), wB3);
    const sup = await cycle(B3, cal.id, at(9, 40), null, [cal.id], "superseded");
    await pool.query(`update bin_cycles set status = 'superseded', superseded_by_cycle_id = $2, review_status = 'open', close_reason = null where id = $1`, [sup, cB3]);
    await work(cal.id, B3, at(9, 40), at(10), OTHER);
    await work(ben.id, B3, at(10), at(11));
    const B4 = await bin("B4"); // half of the time under another Job
    const wB4 = await weighing(B4, at(13), 100, "credited", ben.id);
    await cycle(B4, ben.id, at(12), wB4);
    await work(ben.id, B4, at(12), at(12, 30));
    await work(ben.id, B4, at(12, 30), at(13), OTHER);
    const B5 = await bin("B5"); // late conflict flag
    const wB5 = await weighing(B5, at(15), 100, "credited", ben.id);
    await cycle(B5, ben.id, at(14), wB5);
    await work(ben.id, B5, at(14), at(15));
    const lateEv = await phoneEvent(cal.id, at(14, 50));
    await pool.query(`insert into scale_weighing_flags (weighing_id, mobile_time_event_id, employee_id, kind) values ($1, $2, $3, 'late_conflict')`, [wB5, lateEv, cal.id]);

    // ---- Cal: a credited bin with no time, and a bin under another Job only ----
    const C1 = await bin("C1");
    const wC1 = await weighing(C1, at(16), 100, "credited", cal.id);
    await cycle(C1, cal.id, at(15), wC1);
    await work(cal.id, null, at(15), at(16)); // Cal worked the Job, just not with C1
    const C2 = await bin("C2");
    const wC2 = await weighing(C2, at(18), 100, "credited", cal.id);
    await cycle(C2, cal.id, at(17), wC2);
    await work(cal.id, C2, at(17), at(18), OTHER);
    // Credited, but the cycle's employee is someone else (an old resolution).
    const C3 = await bin("C3");
    const wC3 = await weighing(C3, at(19), 100, "credited", cal.id);
    await cycle(C3, ben.id, at(18, 30), wC3);
    await work(cal.id, C3, at(18, 30), at(19));

    // ---- Dee: overlapping bins, and a bin worked over two days ----
    const D1 = await bin("D1");
    const D2 = await bin("D2");
    const wD1 = await weighing(D1, at(10), 100, "credited", dee.id);
    const wD2 = await weighing(D2, at(10, 30), 100, "credited", dee.id);
    await cycle(D1, dee.id, at(9), wD1);
    await cycle(D2, dee.id, at(9, 30), wD2);
    await work(dee.id, D1, at(9), at(10));
    await work(dee.id, D2, at(9, 30), at(10, 30));
    // D3: opened the previous evening (20:00-21:00), finished 06:00-07:00, weighed 07:10.
    const D3 = await bin("D3");
    const wD3 = await weighing(D3, at(7, 10), 200, "credited", dee.id);
    await cycle(D3, dee.id, at(-4), wD3);
    await work(dee.id, D3, at(-4), at(-3));
    await work(dee.id, D3, at(6), at(7));

    const now = at(30);
    let r = await getScaleProductivity(PICK, DAY, DAY, { now });
    const a = r.byEmployee.get(ana.id);
    check(a?.bins === 2 && a.netGrams === 270_000, "Ana: only the two credited live bins (no trial, void, pending, review, duplicate)", a);
    check(a?.matchedSeconds === (52 + 45) * 60, "Ana: 52 + 45 matched minutes (entry started just before the scan, break removed, overlap once, deleted and post-weighing time left out)", a);
    check(Math.abs((a?.kgPerHour ?? 0) - 270 / (97 / 60)) < 1e-9, "Ana: 270 kg / 1.617 h", a?.kgPerHour);
    check(r.openBinsByEmployee.get(ana.id) === 1, "Ana: one bin not yet weighed", [...r.openBinsByEmployee]);

    const b = r.byEmployee.get(ben.id);
    check(b?.bins === 0 && b.kgPerHour === null, "Ben: no trusted bin yet, no figure (not 0)", b);
    check(
      b?.excludedByReason.several_employees === 2 && b.excludedByReason.superseded_review_open === 1 && b.excludedByReason.other_job === 1 && b.excludedByReason.late_conflict === 1,
      "Ben: exclusions by reason",
      b?.excludedByReason
    );

    const c = r.byEmployee.get(cal.id);
    check(c?.excludedByReason.no_matched_time === 1 && c.excludedByReason.credit_mismatch === 1 && c.excludedBins === 2, "Cal: no matched time and a credit mismatch excluded; the other Job's bin isn't this Job's", c);

    const d = r.byEmployee.get(dee.id);
    check(d?.excludedByReason.overlapping_time === 2, "Dee: two bins with overlapping time both excluded", d);
    check(d?.bins === 1 && d.netGrams === 200_000 && d.matchedSeconds === 2 * 3600, "Dee: the two-day bin counts on its weighing day with both hours", d);

    const prev = await getScaleProductivity(PICK, PREV, PREV, { now });
    check(!prev.byEmployee.get(dee.id)?.bins, "the two-day bin is not reported on the day it was started", prev.byEmployee.get(dee.id));
    const both = await getScaleProductivity(PICK, PREV, DAY, { now });
    check(both.byEmployee.get(dee.id)?.netGrams === 200_000 && both.byEmployee.get(dee.id)?.matchedSeconds === 2 * 3600, "over both days the two-day bin appears once", both.byEmployee.get(dee.id));

    const other = await getScaleProductivity(OTHER, DAY, DAY, { now });
    check(other.byEmployee.get(cal.id)?.bins === 1 && other.byEmployee.get(cal.id)?.netGrams === 100_000, "the other Job sees its own bin C2", other.byEmployee.get(cal.id));

    const before = await getScaleProductivity(PICK, "2026-11-01", "2026-11-23", { now });
    check(before.dateStart === null && before.byEmployee.size === 0, "nothing is reported before 2026-11-24", before);

    const onlyAna = await getScaleProductivity(PICK, DAY, DAY, { now, employeeIds: [ana.id] });
    check(onlyAna.byEmployee.size === 1 && onlyAna.byEmployee.has(ana.id), "employee filter", [...onlyAna.byEmployee.keys()]);

    // An administrator settles the superseded review: Ben's B3 becomes trusted.
    await pool.query(`update bin_cycles set review_status = 'confirmed' where id = $1`, [sup]);
    r = await getScaleProductivity(PICK, DAY, DAY, { now });
    check(r.byEmployee.get(ben.id)?.bins === 1 && r.byEmployee.get(ben.id)?.netGrams === 160_000 && r.byEmployee.get(ben.id)?.matchedSeconds === 3600, "after the review, B3 counts: 160 kg / 1 h", r.byEmployee.get(ben.id));
    // An administrator voids Ana's A2: it leaves the figure (kg and time together).
    await pool.query(`update scale_weighings set status = 'voided' where id = $1`, [wA2]);
    r = await getScaleProductivity(PICK, DAY, DAY, { now });
    check(r.byEmployee.get(ana.id)?.netGrams === 150_000 && r.byEmployee.get(ana.id)?.matchedSeconds === 52 * 60, "after a void, the bin's kg and minutes both leave", r.byEmployee.get(ana.id));
    await pool.query(`update scale_weighings set status = 'credited' where id = $1`, [wA2]);

    // ---- TV ranking slide ----
    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [`QA KGH ${RUN_ID}`])).rows[0].id;
    displayId = (
      await pool.query(`insert into greenhouse_displays (name, display_key_hash, land_id, date_start, date_end) values ($1, $2, $3, $4, $4) returning id`, [`QA KGH ${RUN_ID}`, `k-${RUN_ID}`, landId, DAY])
    ).rows[0].id;
    for (const act of [PICK, EMPTY]) {
      await pool.query(`insert into greenhouse_display_activity_slides (display_id, activity_id, send_to_tv, target_override) values ($1, $2, true, 999)`, [displayId, act]);
    }
    await work(cal.id, null, at(1), at(2), EMPTY); // work on the empty kg Job, no bins
    _clearSpeedCacheForTests();
    const payload = await buildDisplaySlides({ id: displayId!, reportWeek: "this_week", reportIncludeToday: true, mapSlideSeconds: 20 }, DAY, now);
    const pick = payload.slides.find((s) => s.activityId === PICK);
    check(pick?.status === "ok" && pick.speedUnit === "kg/hour" && pick.productivityMetric === "scale_kg", "kg/hour slide uses the kg unit", pick);
    check(pick?.target === 150, "kg/hour slide target is the Job's kg/hour normal speed, not the row-count override (999)", pick?.target);
    const names = pick?.employees.map((e) => e.firstName);
    check(JSON.stringify(names) === JSON.stringify(["Ana", "Ben", "Dee"]), "ranked fastest first: Ana 167, Ben 160, Dee 100", pick?.employees);
    const ae = pick?.employees[0];
    check(ae?.speed === 167 && ae.quantityCounted === 270 && ae.activityHours === 1.62 && ae.binsCounted === 2, "slide carries kg/hour, kg, matched hours and bins", ae);
    check(pick?.employeesWithoutSpeed === 1, "Cal (only excluded bins) is counted without a speed", pick?.employeesWithoutSpeed);
    // Minimum hours on a kg/hour slide = picking hours matched to eligible
    // weighed bins only (not shift hours, not open bins: Ana also has 1 h in
    // an unweighed bin and Cal's job time has no eligible bin).
    await pool.query(`update greenhouse_display_activity_slides set minimum_activity_hours = 1.7 where display_id = $1 and activity_id = $2`, [displayId, PICK]);
    _clearSpeedCacheForTests();
    const minPayload = await buildDisplaySlides({ id: displayId!, reportWeek: "this_week", reportIncludeToday: true, mapSlideSeconds: 20 }, DAY, now);
    const minSlide = minPayload.slides.find((s) => s.activityId === PICK);
    check(
      JSON.stringify(minSlide?.employees.map((e) => e.firstName)) === JSON.stringify(["Dee"]) && minSlide?.belowMinimumHours === 2,
      "minimum 1.7 h uses matched hours: Ana 1.62 h and Ben 1.0 h are below it, Dee 2.0 h is shown",
      minSlide
    );
    await pool.query(`update greenhouse_display_activity_slides set minimum_activity_hours = 1 where display_id = $1 and activity_id = $2`, [displayId, PICK]);
    _clearSpeedCacheForTests();
    const oneHour = (await buildDisplaySlides({ id: displayId!, reportWeek: "this_week", reportIncludeToday: true, mapSlideSeconds: 20 }, DAY, now)).slides.find((s) => s.activityId === PICK);
    check(oneHour?.employees.length === 3 && oneHour.belowMinimumHours === 0, "minimum 1.0 matched hour: all three shown (Ben exactly 1.0 h)", oneHour);

    const empty = payload.slides.find((s) => s.activityId === EMPTY);
    check(empty?.status === "no_speed" && empty.reason === "waiting_for_bins" && /Waiting for weighed bins/.test(empty.notice ?? ""), "a kg/hour Job with work but no weighed bins waits", empty);

    // ---- Dashboard card (this real week, which has no weighed bins of these fixtures) ----
    await pool.query(`insert into dashboard_activities (activity_id) values ($1)`, [PICK]);
    await work(ana.id, OPEN, new Date(Date.now() - 30 * 60_000), null);
    {
      const res = await fetch(`${BASE}/api/dashboard/cards`, { headers: { cookie: `labourlink_session=${admin.token}` } });
      const body = (await res.json()) as any;
      const card = body.cards?.find((x: any) => x.employeeId === ana.id);
      check(res.status === 200 && card?.cardType === "row_stem", "kg/hour Job keeps its row/stem card (block progress unchanged)", body);
      check(
        card?.scaleProductivity?.kgPerHour === null && card.scaleProductivity.weighedBins === 0 && card.scaleProductivity.reportingFrom >= "2026-11-24",
        "card carries kg/hour figures; none yet this week means a waiting state, not 0",
        card?.scaleProductivity
      );
      check("weeklySpeed" in (card ?? {}), "row-count weekly speed is still returned", card);
    }
    await pool.query(`update time_entries set ended_at = now() where employee_id = $1 and ended_at is null`, [ana.id]);

    // ---- Jobs API ----
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { cookie: `labourlink_session=${admin.token}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    let res = await api("PATCH", `/api/activities/${OTHER}`, { productivityMetric: "scale_kg", scaleNormalKgPerHour: 140 });
    check(res.status === 200, "switch a Job to kg/hour", res);
    res = await api("GET", `/api/activities/${OTHER}`);
    const o = res.body.activity;
    check(o.productivityMetric === "scale_kg" && o.scaleNormalKgPerHour === 140, "kg/hour metric and target saved", o);
    check(o.densitySource === "stems" && o.speedUnit === "stems/hour" && o.normalSpeed === 300, "row-count settings are kept, not reinterpreted", o);
    res = await api("PATCH", `/api/activities/${OTHER}`, { productivityMetric: "density" });
    check(res.status === 200, "switch back", res);
    res = await api("GET", `/api/activities/${OTHER}`);
    check(res.body.activity.productivityMetric === "density" && res.body.activity.normalSpeed === 300 && res.body.activity.scaleNormalKgPerHour === 140, "switching back restores the row-count metric; the kg target is kept for later", res.body.activity);
    res = await api("PATCH", `/api/activities/${OTHER}`, { productivityMetric: "kg" });
    check(res.status === 400 && res.body.errors?.productivityMetric, "unknown metric rejected", res);
    res = await api("PATCH", `/api/activities/${OTHER}`, { scaleNormalKgPerHour: -1 });
    check(res.status === 400 && res.body.errors?.scaleNormalKgPerHour, "kg target must be > 0", res);
    res = await api("POST", `/api/activities`, { name: `QA KGH New ${RUN_ID}`, minimumDurationMinutes: 0, densitySource: "stems" });
    if (res.body.activity?.id) ids.activities.push(res.body.activity.id);
    check(res.status === 201 && res.body.activity.productivityMetric === "density" && res.body.activity.scaleNormalKgPerHour === null, "new Jobs default to the row-count metric", res.body);
  } finally {
    server.close();
    const del = async (sql: string, params: unknown[]) => {
      try {
        await pool.query(sql, params);
      } catch (e) {
        console.error("cleanup:", sql, e instanceof Error ? e.message : e);
      }
    };
    if (displayId) await del(`delete from greenhouse_displays where id = $1`, [displayId]);
    if (landId) await del(`delete from greenhouse_lands where id = $1`, [landId]);
    await del(`delete from scale_weighing_flags where weighing_id = any($1::uuid[])`, [ids.weighings]);
    await del(`delete from bin_scans where carrier_id = any($1::uuid[])`, [ids.carriers]);
    await del(`delete from bin_cycles where id = any($1::uuid[])`, [ids.cycles]);
    await del(`delete from scale_weighings where id = any($1::uuid[])`, [ids.weighings]);
    await del(`delete from mobile_time_events where id = any($1::uuid[])`, [ids.events]);
    await del(`delete from time_entries where employee_id = any($1::uuid[])`, [ids.employees]);
    await del(`delete from activities where id = any($1::uuid[])`, [ids.activities]);
    await del(`delete from carriers where id = any($1::uuid[])`, [ids.carriers]);
    if (periodId) await del(`delete from bin_cycle_tracking where id = $1`, [periodId]);
    if (deviceId) await del(`delete from devices where id = $1`, [deviceId]);
    if (stationId) await del(`delete from scale_stations where id = $1`, [stationId]);
    await del(`delete from employees where id = any($1::uuid[])`, [ids.employees]);
    await pool.end();
  }
  console.log(`scale productivity (db): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
