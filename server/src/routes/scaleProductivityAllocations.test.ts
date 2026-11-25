// Scale Weighings -> Review allocation (078, lib/scaleProductivityAllocations.ts)
// against the real database: automatic shared-bin allocation, bins held for
// review, administrator decisions (confirm / override / exclude / reset),
// permissions, validation, concurrent edits, idempotency, corrections after a
// decision, the audit history, and that official scale credits, weighings,
// picking cycles and time entries are never changed. RUN_ID-suffixed
// fixtures on a day well in the future, removed at the end.
//
// Run with: npm run test:scale-productivity-allocations
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { addDaysToDateStr, calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { getScaleProductivity } from "../lib/scaleProductivity";
import allocationsRouter from "./scaleProductivityAllocations";

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
let DAY = addDaysToDateStr(calendarDateInAppTimezone(new Date()), 300 + (RUN_ID % 200));
while (new Date(`${DAY}T12:00:00Z`).getUTCDay() !== 3) DAY = addDaysToDateStr(DAY, 1);

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/scale-productivity-allocations", allocationsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ids = { employees: [] as string[], carriers: [] as string[], weighings: [] as string[], events: [] as string[], cycles: [] as string[], activities: [] as string[] };
  let stationId: string | undefined;
  let deviceId: string | undefined;
  let periodId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    async function employee(role: string, first: string) {
      const roleId = (await pool.query(`select id from security_roles where name = $1`, [role])).rows[0].id;
      const id = (
        await pool.query(`insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, $4) returning id`, [first, `SPA ${RUN_ID}`, roleId, teamRoleId])
      ).rows[0].id as string;
      ids.employees.push(id);
      return { id, token: signSession({ id, firstName: first, lastName: `SPA ${RUN_ID}`, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await employee("Administrator", "Adam");
    const admin2 = await employee("Administrator", "Abby");
    const manager = await employee("Manager", "Max");
    const staff = await employee("Employee", "Ed");
    const jose = await employee("Employee", "Jose");
    const jeff = await employee("Employee", "Jeffrey");
    const hugo = await employee("Employee", "Hugo");
    const ivy = await employee("Employee", "Ivy");

    const PICK = (
      await pool.query(
        `insert into activities (name, is_active, density_source, speed_unit, normal_speed, productivity_metric, scale_normal_kg_per_hour)
         values ($1, true, 'stems', 'stems/hour', 300, 'scale_kg', 150) returning id`,
        [`QA SPA Picking ${RUN_ID}`]
      )
    ).rows[0].id as string;
    ids.activities.push(PICK);

    stationId = (await pool.query(`insert into scale_stations (name, token_hash, credits_enabled) values ($1, $2, true) returning id`, [`QA SPA ${RUN_ID}`, `h-spa-${RUN_ID}`])).rows[0].id;
    deviceId = (await pool.query(`insert into devices (device_identifier, device_name) values ($1, $2) returning id`, [randomUUID(), `QA SPA phone ${RUN_ID}`])).rows[0].id;
    const { start } = getDayBoundsUtc(DAY);
    const at = (h: number, m = 0) => new Date(start.getTime() + (h * 60 + m) * 60_000);
    periodId = (await pool.query(`insert into bin_cycle_tracking (started_at, stopped_at, note) values ($1, $2, $3) returning id`, [at(-48), at(30), `QA SPA ${RUN_ID}`])).rows[0].id;

    async function bin(name: string) {
      const id = (await pool.query(`insert into carriers (name, tare_weight_kg) values ($1, 150) returning id`, [`QA SPA ${RUN_ID} ${name}`])).rows[0].id as string;
      ids.carriers.push(id);
      return id;
    }
    async function weighing(carrier: string, when: Date, kg: number, employeeId: string) {
      const id = (
        await pool.query(
          `insert into scale_weighings (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, weighed_at, pending_until, credits_live, status, employee_id, is_duplicate, match_reason)
           values ($1, $2, $3, 'T', $4 + 150000, 150000, $4, $5, $5::timestamptz + interval '24 hours', true, 'credited', $6, false, 'qa') returning id`,
          [stationId, randomUUID(), carrier, Math.round(kg * 1000), when, employeeId]
        )
      ).rows[0].id as string;
      ids.weighings.push(id);
      return id;
    }
    let seq = 0;
    async function scan(carrier: string, employeeId: string, when: Date, cycleId: string) {
      const ev = (
        await pool.query(
          `insert into mobile_time_events (client_event_id, device_id, employee_id, device_seq, event_type, occurred_at_utc, local_tz_offset_minutes, payload, processing_status)
           values ($1, $2, $3, $4, 'activity_switch', $5, 0, '{}', 'accepted') returning id`,
          [randomUUID(), deviceId, employeeId, ++seq, when]
        )
      ).rows[0].id as string;
      ids.events.push(ev);
      await pool.query(`insert into bin_scans (mobile_time_event_id, carrier_id, employee_id, occurred_at, received_at, clock_trusted, cycle_id) values ($1, $2, $3, $4, $4, true, $5)`, [ev, carrier, employeeId, when, cycleId]);
    }
    // A handover: the earlier employee's cycle superseded by the later one, which the weighing closed.
    async function handover(carrier: string, first: { emp: string; at: Date }, second: { emp: string; at: Date }, weighingId: string, closeAt: Date) {
      const closer = (
        await pool.query(
          `insert into bin_cycles (carrier_id, status, employee_id, opened_at, last_scan_at, weighing_id, closed_at) values ($1, 'closed', $2, $3, $3, $4, $5) returning id`,
          [carrier, second.emp, second.at, weighingId, closeAt]
        )
      ).rows[0].id as string;
      const sup = (
        await pool.query(
          `insert into bin_cycles (carrier_id, status, employee_id, opened_at, last_scan_at, closed_at, close_reason, superseded_by_cycle_id, review_status, finalized_at)
           values ($1, 'superseded', $2, $3, $3, $4, 'qa', $5, 'open', $6) returning id`,
          [carrier, first.emp, first.at, second.at, closer, closeAt]
        )
      ).rows[0].id as string;
      ids.cycles.push(closer, sup);
      await scan(carrier, first.emp, first.at, sup);
      await scan(carrier, second.emp, second.at, closer);
      return { closer, sup };
    }
    async function work(employeeId: string, carrier: string, from: Date, to: Date) {
      return (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, carrier_id)
           values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5) returning id`,
          [employeeId, PICK, from, to, carrier]
        )
      ).rows[0].id as string;
    }

    // H1: Jose 07:00-08:00, Jeffrey 08:00-08:30 (continuous), 200 kg credited to Jeffrey.
    const H1 = await bin("H1");
    const w1 = await weighing(H1, at(8, 40), 200, jeff.id);
    await handover(H1, { emp: jose.id, at: at(7) }, { emp: jeff.id, at: at(8) }, w1, at(8, 40));
    await work(jose.id, H1, at(7), at(8));
    await work(jeff.id, H1, at(8), at(8, 30));
    // H2: Hugo the previous afternoon 16:00-17:00, Ivy 07:30-08:00 (overnight), 150 kg credited to Ivy.
    const H2 = await bin("H2");
    const w2 = await weighing(H2, at(8, 10), 150, ivy.id);
    await handover(H2, { emp: hugo.id, at: at(-8) }, { emp: ivy.id, at: at(7, 30) }, w2, at(8, 10));
    await work(hugo.id, H2, at(-8), at(-7));
    const ivyH2 = await work(ivy.id, H2, at(7, 30), at(8));
    // H3: Jose 09:00-09:20, Ivy 10:00-10:40 (40-minute pause), 120 kg credited to Ivy.
    const H3 = await bin("H3");
    const w3 = await weighing(H3, at(10, 50), 120, ivy.id);
    await handover(H3, { emp: jose.id, at: at(9) }, { emp: ivy.id, at: at(10) }, w3, at(10, 50));
    await work(jose.id, H3, at(9), at(9, 20));
    await work(ivy.id, H3, at(10), at(10, 40));

    // What must never change: the official credits and the records behind them.
    const officialState = async () =>
      JSON.stringify([
        (await pool.query(`select id, status, employee_id, match_reason, resolved_at, net_g, credits_live from scale_weighings where id = any($1::uuid[]) order by id`, [ids.weighings])).rows,
        (await pool.query(`select * from scale_weighing_claims where weighing_id = any($1::uuid[]) order by weighing_id, mobile_time_event_id`, [ids.weighings])).rows,
        (await pool.query(`select id, status, employee_id, weighing_id, review_status, superseded_by_cycle_id, updated_at from bin_cycles where id = any($1::uuid[]) order by id`, [ids.cycles])).rows,
        (await pool.query(`select id, started_at, ended_at, deleted_at, carrier_id from time_entries where employee_id = any($1::uuid[]) and id <> $2 order by id`, [ids.employees, ivyH2])).rows,
      ]);
    const before = await officialState();

    const call = async (who: { token: string } | null, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}/api/scale-productivity-allocations${path}`, {
        method,
        headers: { ...(who ? { cookie: `labourlink_session=${who.token}` } : {}), "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    const prod = async () => (await getScaleProductivity(PICK, DAY, DAY)).byEmployee;

    // ---- Automatic allocation and review states ----
    let p = await prod();
    check(p.get(jose.id)?.netGrams === 133_333 && p.get(jeff.id)?.netGrams === 66_667, "H1 continuous handover: 133.333 / 66.667 kg automatically", [p.get(jose.id), p.get(jeff.id)]);
    check(p.get(jose.id)?.matchedSeconds === 3600 && p.get(jeff.id)?.matchedSeconds === 1800, "each with their own minutes");
    check(!p.get(hugo.id)?.bins && p.get(hugo.id)?.excludedByReason.overnight_handover === 1 && p.get(ivy.id)?.excludedBins === 2, "H2 overnight and H3 gap wait for review", [p.get(hugo.id), p.get(ivy.id)]);

    // ---- Permissions ----
    check((await call(null, "GET", `?date=${DAY}`)).status === 401, "signed out: 401");
    check((await call(manager, "GET", `?date=${DAY}`)).status === 403, "Manager can't open Review allocation");
    check((await call(staff, "GET", `/${w2}`)).status === 403, "Employee can't read an allocation");
    check((await call(manager, "POST", `/${w2}/decision`, { requestId: randomUUID(), action: "confirm", reason: "ok", expectedVersion: 0, expectedFingerprint: "x" })).status === 403, "Manager can't decide");

    // ---- List and detail ----
    let res = await call(admin, "GET", `?date=${DAY}&activityId=${PICK}`);
    const byW = new Map((res.body?.bins ?? []).map((b: any) => [b.weighingId, b]));
    check(res.status === 200 && (byW.get(w1) as any)?.status === "shared_auto" && (byW.get(w2) as any)?.status === "review" && (byW.get(w3) as any)?.status === "review", "list: H1 automatic, H2 and H3 to review", res.body);
    check((byW.get(w1) as any)?.officialCredit.id === jeff.id, "the official credit is shown, unchanged");
    res = await call(admin, "GET", `/${w2}?activityId=${PICK}`);
    let d = res.body;
    const hugoRow = d?.contributors?.find((c: any) => c.employeeId === hugo.id);
    check(res.status === 200 && d.status === "review" && d.reasons[0].code === "overnight_handover" && d.version === 0 && d.allocatable, "detail: in review, version 0", d);
    check(hugoRow?.matchedMinutes === 60 && hugoRow.percent === 66.67 && hugoRow.proposedKg === 100 && hugoRow.countedKg === null, "detail: Hugo 60 min, 66.67 %, proposed 100 kg, nothing counted yet", hugoRow);
    const fp2 = d.fingerprint;

    // ---- Validation ----
    const base = (over: Record<string, unknown> = {}) => ({ requestId: randomUUID(), activityId: PICK, action: "confirm", reason: "Bin stayed in the row overnight", expectedVersion: 0, expectedFingerprint: fp2, ...over });
    check((await call(admin, "POST", `/${w2}/decision`, base({ reason: " " }))).status === 400, "a reason is required");
    check((await call(admin, "POST", `/${w2}/decision`, base({ action: "approve" }))).status === 400, "unknown action");
    check((await call(admin, "POST", `/${w2}/decision`, base({ requestId: "nope" }))).status === 400, "requestId must be a UUID");
    res = await call(admin, "POST", `/${w2}/decision`, base({ action: "override", shares: [{ employeeId: hugo.id, included: true, allocatedKg: 100 }, { employeeId: ivy.id, included: true, allocatedKg: 49.999 }] }));
    check(res.status === 422 && res.body.code === "sumMismatch", "manual kilograms must add up to the net weight to the gram", res.body);
    res = await call(admin, "POST", `/${w2}/decision`, base({ action: "override", shares: [{ employeeId: hugo.id, included: true }] }));
    check(res.status === 422 && res.body.code === "missingEmployee", "every contributor must be included or excluded", res.body);
    res = await call(admin, "POST", `/${w2}/decision`, base({ action: "override", shares: [{ employeeId: hugo.id, included: true }, { employeeId: ivy.id, included: true }, { employeeId: jose.id, included: true }] }));
    check(res.status === 422 && res.body.code === "unknownEmployee", "only this bin's contributors", res.body);
    res = await call(admin, "POST", `/${w2}/decision`, base({ action: "override", shares: [{ employeeId: hugo.id, included: false }, { employeeId: ivy.id, included: false }] }));
    check(res.status === 422 && res.body.code === "nobodyIncluded", "at least one employee included", res.body);
    res = await call(admin, "POST", `/${w2}/decision`, base({ expectedFingerprint: "v1|stale" }));
    check(res.status === 409 && res.body.code === "inputsChanged", "a decision on records that changed since they were shown: 409", res.body);
    check((await call(admin, "POST", `/${w2}/decision`, base({ action: "reset" }))).body?.code === "nothingToReset", "nothing to reset yet");

    // ---- Confirm H2 ----
    const confirmReq = base();
    res = await call(admin, "POST", `/${w2}/decision`, confirmReq);
    check(res.status === 200 && res.body.version === 1 && !res.body.replay, "confirm: version 1", res.body);
    res = await call(admin, "POST", `/${w2}/decision`, confirmReq);
    check(res.status === 200 && res.body.replay === true, "the same request again is a replay, not a second decision", res.body);
    res = await call(admin, "POST", `/${w2}/decision`, { ...confirmReq, action: "exclude" });
    check(res.status === 409 && res.body.code === "requestReused", "a request id can't be reused for another decision", res.body);
    p = await prod();
    check(p.get(hugo.id)?.netGrams === 100_000 && p.get(hugo.id)?.matchedSeconds === 3600 && p.get(ivy.id)?.netGrams === 50_000, "after confirming, H2 counts: Hugo 100 kg / 1 h, Ivy 50 kg / 0.5 h", [p.get(hugo.id), p.get(ivy.id)]);
    check(p.get(hugo.id)?.estimatedGrams === 100_000 && p.get(hugo.id)?.manualGrams === 0, "a confirmed proportional allocation is still an estimate");
    d = (await call(admin, "GET", `/${w2}?activityId=${PICK}`)).body;
    check(d.status === "reviewed" && d.version === 1 && d.decision.action === "confirm" && d.decision.decidedBy.startsWith("Adam") && d.history.length === 1, "detail shows the decision and its history", d);
    check(d.history[0].proposal.contributors.length === 2 && d.history[0].reason === "Bin stayed in the row overnight", "the history keeps what was shown and why");

    // ---- A correction after the decision: back to review, never silently re-applied ----
    await pool.query(`update time_entries set ended_at = $2 where id = $1`, [ivyH2, at(8, 5)]);
    p = await prod();
    check(!p.get(hugo.id)?.bins && p.get(hugo.id)?.excludedByReason.inputs_changed === 1, "a time entry corrected after the review: H2 goes back to review", p.get(hugo.id));
    d = (await call(admin, "GET", `/${w2}?activityId=${PICK}`)).body;
    check(d.status === "review" && d.reasons[0].code === "inputs_changed" && d.decision?.action === "confirm", "detail: the old decision is shown, but no longer applies", d.reasons);
    res = await call(admin, "POST", `/${w2}/decision`, base({ expectedVersion: 1, expectedFingerprint: d.fingerprint, reason: "Re-checked after the time correction" }));
    check(res.status === 200 && res.body.version === 2, "re-confirmed on the corrected records", res.body);
    p = await prod();
    check(p.get(ivy.id)?.matchedSeconds === 35 * 60 && p.get(hugo.id)!.netGrams + p.get(ivy.id)!.netGrams === 150_000, "now with Ivy's corrected 35 minutes, still exactly 150 kg", [p.get(hugo.id), p.get(ivy.id)]);

    // ---- A break closed at midnight, before and after its review in Inputs ----
    // Ivy's unpaid break from 07:45, closed by the midnight cut-off: until it
    // is reviewed it says nothing about when she stopped, so her matched
    // minutes, the bin's fingerprint and the saved decision are untouched.
    const midnight = getDayBoundsUtc(DAY).end;
    const ivyBreak = (
      await pool.query(
        `insert into time_entries (employee_id, entry_type, idempotency_key, started_at, ended_at, source, is_paid)
         values ($1, 'break', gen_random_uuid(), $2, $3, 'manual', false) returning id`,
        [ivy.id, at(7, 45), midnight]
      )
    ).rows[0].id as string;
    await pool.query(
      `insert into time_entry_corrections (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason, changed_at)
       values ($1, $2, null, 'ended_at', 'null', $3, 'midnight_cutoff', $4)`,
      [ivyBreak, ivy.id, midnight.toISOString(), midnight]
    );
    const hugoReviewed = p.get(hugo.id)!.netGrams;
    const fp2Reviewed = (await call(admin, "GET", `/${w2}?activityId=${PICK}`)).body.fingerprint;
    p = await prod();
    check(p.get(ivy.id)?.matchedSeconds === 35 * 60 && p.get(hugo.id)?.netGrams === hugoReviewed, "an unreviewed midnight-closed break: matched minutes and the reviewed H2 unchanged", [p.get(hugo.id), p.get(ivy.id)]);
    // Reviewed in Inputs ("confirm as recorded"; an Inputs user's audited
    // correction, recorded after the break ended): it now counts, Ivy's
    // matched minutes drop to 07:30-07:45, and H2's saved decision no longer
    // applies: back to review. Official credits are untouched (checked below).
    await pool.query(
      `insert into time_entry_corrections (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason, changed_at)
       values ($1, $2, $3, 'ended_at', $4, $4, 'Confirmed as recorded', $5)`,
      [ivyBreak, ivy.id, admin.id, midnight.toISOString(), new Date(midnight.getTime() + 60_000)]
    );
    p = await prod();
    check(!p.get(hugo.id)?.bins && p.get(hugo.id)?.excludedByReason.inputs_changed === 1, "after the break review, H2's previous decision is invalidated: back to review", p.get(hugo.id));
    d = (await call(admin, "GET", `/${w2}?activityId=${PICK}`)).body;
    check(d.status === "review" && d.reasons[0].code === "inputs_changed" && d.fingerprint !== fp2Reviewed, "detail: inputs changed, new fingerprint", d.reasons);
    // Undo the scenario so the rest of this test runs on the original records.
    await pool.query(`delete from time_entry_corrections where time_entry_id = $1`, [ivyBreak]);
    await pool.query(`delete from time_entries where id = $1`, [ivyBreak]);
    p = await prod();
    check(p.get(ivy.id)?.matchedSeconds === 35 * 60 && p.get(hugo.id)?.netGrams === hugoReviewed, "break removed again: the reviewed H2 applies again", [p.get(hugo.id), p.get(ivy.id)]);

    // ---- Concurrent administrators on H3 ----
    d = (await call(admin, "GET", `/${w3}?activityId=${PICK}`)).body;
    const fp3 = d.fingerprint;
    const shares3 = (joseKg: number | null, ivyKg: number | null, joseIn = true) => [
      { employeeId: jose.id, included: joseIn, allocatedKg: joseKg },
      { employeeId: ivy.id, included: true, allocatedKg: ivyKg },
    ];
    const [r1, r2] = await Promise.all([
      call(admin, "POST", `/${w3}/decision`, { requestId: randomUUID(), activityId: PICK, action: "override", reason: "Weighed portions", expectedVersion: 0, expectedFingerprint: fp3, shares: shares3(20, 100) }),
      call(admin2, "POST", `/${w3}/decision`, { requestId: randomUUID(), activityId: PICK, action: "exclude", reason: "Bin was emptied", expectedVersion: 0, expectedFingerprint: fp3 }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check(JSON.stringify(statuses) === JSON.stringify([200, 409]) && [r1, r2].some((x) => x.body?.code === "staleVersion"), "two administrators at once: one wins, the other gets 409 to reload", [r1, r2]);
    const winner = r1.status === 200 ? "override" : "exclude";
    // Continue from whatever won: set manual kilograms.
    res = await call(admin, "POST", `/${w3}/decision`, { requestId: randomUUID(), activityId: PICK, action: "override", reason: "Jose filled about 20 kg", expectedVersion: 1, expectedFingerprint: fp3, shares: shares3(20, 100) });
    check(res.status === 200 && res.body.version === 2, `manual kilograms after the ${winner}`, res.body);
    p = await prod();
    check(p.get(jose.id)?.manualGrams === 20_000 && p.get(ivy.id)?.manualGrams === 100_000, "manual kilograms are counted and labelled as manual", [p.get(jose.id), p.get(ivy.id)]);
    // Exclude Jose's contribution instead (an accidental scan): Ivy gets the whole bin, Jose neither kg nor minutes.
    res = await call(admin, "POST", `/${w3}/decision`, { requestId: randomUUID(), activityId: PICK, action: "override", reason: "Jose's scan was a mistake", expectedVersion: 2, expectedFingerprint: fp3, shares: shares3(null, null, false) });
    check(res.status === 200, "exclude a contribution", res.body);
    const joseNow = (await prod()).get(jose.id);
    check(joseNow?.netGrams === 133_333 && joseNow.matchedSeconds === 3600, "Jose keeps only H1 (H3's 20 minutes and kilograms are gone)", joseNow);
    const shareSum = (await pool.query(`select coalesce(sum(allocated_g), 0)::int as g from scale_productivity_allocation_shares where weighing_id = $1 and included`, [w3])).rows[0].g;
    check(shareSum === 120_000, "stored shares add up to the net weight", shareSum);
    d = (await call(admin, "GET", `/${w3}?activityId=${PICK}`)).body;
    check(d.history.length === 3 && d.history[2].previous?.method === "manual" && d.history[2].next?.method === "proportional", "every correction is in the history with what it replaced", d.history.map((h: any) => [h.action, h.previous?.method, h.next?.method]));

    // ---- Exclude, then reset, an automatic bin ----
    d = (await call(admin, "GET", `/${w1}?activityId=${PICK}`)).body;
    res = await call(admin, "POST", `/${w1}/decision`, { requestId: randomUUID(), activityId: PICK, action: "exclude", reason: "Mixed with another bin", expectedVersion: 0, expectedFingerprint: d.fingerprint });
    p = await prod();
    check(res.status === 200 && !p.get(jeff.id)?.bins && p.get(jeff.id)?.excludedByReason.excluded_by_admin === 1, "an administrator can exclude an automatic bin", p.get(jeff.id));
    res = await call(admin, "POST", `/${w1}/decision`, { requestId: randomUUID(), activityId: PICK, action: "reset", reason: "Was right after all", expectedVersion: 1, expectedFingerprint: d.fingerprint });
    p = await prod();
    check(res.status === 200 && p.get(jeff.id)?.netGrams === 66_667, "reset: the rules decide again", p.get(jeff.id));
    d = (await call(admin, "GET", `/${w1}?activityId=${PICK}`)).body;
    check(d.status === "shared_auto" && d.decision === null && d.history.map((h: any) => h.action).join(",") === "exclude,reset", "history keeps the exclusion and the reset", d.history);

    // ---- Nothing official changed ----
    check((await officialState()) === before, "official credits, claims, picking cycles and time entries are unchanged");
  } finally {
    server.close();
    const del = async (sql: string, params: unknown[]) => {
      try {
        await pool.query(sql, params);
      } catch (e) {
        console.error("cleanup:", sql, e instanceof Error ? e.message : e);
      }
    };
    await del(`delete from scale_productivity_allocation_history where weighing_id = any($1::uuid[])`, [ids.weighings]);
    await del(`delete from scale_productivity_allocations where weighing_id = any($1::uuid[])`, [ids.weighings]);
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
  console.log(`scale productivity allocations (db): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
