// Regression tests: offline phone events syncing after a supervisor recorded
// manual Inputs entries for the same employee (mobileTime.ts's
// resolveManualEntryGuard, applied on POST /sync/events only).
//
//   A. An event inside a FINISHED manual entry is refused (permanent_conflict,
//      kept for Sync Conflicts) and creates no overlapping record; an open
//      phone entry running into the manual entry is ended at its start.
//   B. A phone entry that would be closed across a finished manual entry is
//      ended at the manual entry's start; the closing event is accepted but
//      flagged for review. No overlapping records.
//   C. An event at or before an OPEN manual entry's start (the 60-minute
//      rounding collapse/void window) never changes the manual entry's
//      activity, row, bin, start or existence; it's refused for review. A
//      later phone event still takes over normally.
//   D. Normal syncing with no manual entries is unchanged (no flags).
// Each scenario also replays its events to check retries are idempotent.
//
// Run with: npm run test:mobile-time-sync-events-manual-entry-protection
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
import inputsRouter from "./inputs";
import mobileTimeRouter from "./mobileTime";
import mobileSyncConflictsRouter from "./mobileSyncConflicts";

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
const EMAIL_PATTERN = `qa-manual-protect-%-${RUN_ID}@test.local`;
// Far-past QA dates (2019-07-xx), one per scenario.
const at = (day: number, h: number, m = 0) => zonedWallTimeToUtc(2019, 7, day, h, m, 0).toISOString();
const dateStr = (day: number) => `2019-07-${String(day).padStart(2, "0")}`;

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/inputs", inputsRouter);
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/mobile-sync", mobileSyncConflictsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  async function sync(deviceIdentifier: string, events: unknown[]) {
    const res = await fetch(`${BASE}/api/mobile/sync/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify({ events }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  const statuses = (r: { body: any }) => (r.body?.results ?? []).map((x: any) => x.status);

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const activityIds: string[] = [];
  let groupId: string | undefined;
  let landId: string | undefined;
  let phaseId: string | undefined;
  let rowId: string | undefined;
  let carrierId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function createEmployee(role: string, label: string) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`${label} ${RUN_ID}`, `qa-manual-protect-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0] as { id: string; first_name: string; last_name: string };
    }

    const admin = await createEmployee("Administrator", "Admin");
    const adminToken = signSession({
      id: admin.id,
      firstName: admin.first_name,
      lastName: admin.last_name,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA Manual Protect ${RUN_ID}`])
    ).rows[0].id;
    const plainId: string = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA MP Cleaning ${RUN_ID}`,
      ])
    ).rows[0].id;
    const pickId: string = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA MP Picking ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(plainId, pickId);
    const rowQ: string = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Row', true, 0) returning id`,
        [pickId]
      )
    ).rows[0].id;
    const binQ: string = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'carrier', 'Bin', true, 1) returning id`,
        [pickId]
      )
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`, [
      groupId,
      plainId,
      pickId,
    ]);
    landId = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active) values ($1, 100, 100, true) returning id`,
        [`QA MP Land ${RUN_ID}`]
      )
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, is_active, sort_order)
         values ($1, $2, 50, 50, true, 1) returning id`,
        [landId, `QA MP Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    rowId = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, 313, 0, 0, 5, 20, 'horizontal') returning id`,
        [phaseId]
      )
    ).rows[0].id;
    carrierId = (await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA MP Bin ${RUN_ID}`]))
      .rows[0].id;
    const pickAnswers = { row: { questionId: rowQ, greenhouseRowId: rowId }, bin: { questionId: binQ, carrierId } };

    // One employee + paired phone per scenario, so device sequences and the
    // one-open-entry rule never interact across scenarios.
    async function setupWorker(label: string) {
      const e = await createEmployee("Employee", label);
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [e.id, groupId]);
      const deviceIdentifier = randomUUID();
      const deviceId: string = (
        await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
          deviceIdentifier,
          `QA MP Device ${label} ${RUN_ID}`,
        ])
      ).rows[0].id;
      deviceIds.push(deviceId);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceId, e.id]);
      let seq = 0;
      const ev = (eventType: string, occurredAtUtc: string, extra: Record<string, unknown> = {}) => ({
        clientEventId: randomUUID(),
        deviceSeq: ++seq,
        eventType,
        occurredAtUtc,
        ...extra,
      });
      return { id: e.id, deviceId, deviceIdentifier, ev };
    }
    const work = (activityId: string, answers: unknown = null) => ({ activityId, answers });

    async function addManual(employeeId: string, day: number, start: string, end: string | null, activityId = plainId) {
      const r = await call("POST", "/api/inputs/activities", adminToken, {
        employeeId,
        date: dateStr(day),
        activityId,
        startTime: start,
        endTime: end,
        reason: "Forgot phone",
        overlapPolicy: "reject",
        idempotencyKey: randomUUID(),
      });
      return r;
    }
    const liveEntries = async (employeeId: string) =>
      (
        await pool.query(
          `select id, started_at, ended_at, activity_id, greenhouse_row_id, carrier_id, device_id, created_by_employee_id,
                  idempotency_key, entry_type
           from time_entries where employee_id = $1 and deleted_at is null order by started_at`,
          [employeeId]
        )
      ).rows.map((r) => ({
        ...r,
        s: new Date(r.started_at).toISOString(),
        e: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        manual: r.created_by_employee_id !== null,
      }));
    const overlapCount = async (employeeId: string) =>
      Number(
        (
          await pool.query(
            `select count(*) from time_entries a join time_entries b
               on a.employee_id = b.employee_id and a.id < b.id
             where a.employee_id = $1 and a.deleted_at is null and b.deleted_at is null
               and tstzrange(a.started_at, coalesce(a.ended_at, 'infinity')) && tstzrange(b.started_at, coalesce(b.ended_at, 'infinity'))`,
            [employeeId]
          )
        ).rows[0].count
      );
    const ledger = async (clientEventId: string) =>
      (await pool.query(`select processing_status, conflict_reason, time_entry_id from mobile_time_events where client_event_id = $1`, [clientEventId]))
        .rows[0];
    const conflictsList = async () =>
      ((await call("GET", "/api/mobile-sync/conflicts", adminToken)).body?.conflicts ?? []) as any[];

    // -----------------------------------------------------------------
    // A. Event inside a finished manual entry
    // -----------------------------------------------------------------
    {
      const A = 1;
      const w = await setupWorker("ScenarioA");
      check((await addManual(w.id, A, at(A, 7), at(A, 9))).status === 201, "A setup: manual 7:00-9:00");
      const manualBefore = (await liveEntries(w.id))[0];

      const start = w.ev("work_start", at(A, 6), work(plainId));
      const inside = w.ev("activity_switch", at(A, 8), work(pickId, pickAnswers));
      const end = w.ev("end_day", at(A, 10));
      const batch = [start, inside, end];
      const r = await sync(w.deviceIdentifier, batch);
      check(
        JSON.stringify(statuses(r)) === JSON.stringify(["accepted", "permanent_conflict", "accepted"]),
        "A: 6:00 start accepted, 8:00 switch (inside manual) refused, 10:00 end accepted",
        r.body
      );
      const rows = await liveEntries(w.id);
      check(await overlapCount(w.id) === 0, "A: no overlapping records", rows);
      check(rows.length === 2, "A: only the clipped phone entry and the manual entry exist", rows);
      check(!rows[0]?.manual && rows[0]?.s === at(A, 6) && rows[0]?.e === at(A, 7), "A: phone entry ended where the manual entry starts (6:00-7:00)", rows[0]);
      check(
        rows[1]?.id === manualBefore.id && rows[1]?.s === at(A, 7) && rows[1]?.e === at(A, 9) && rows[1]?.activity_id === plainId,
        "A: manual entry unchanged",
        rows[1]
      );
      check(!rows.some((x) => x.activity_id === pickId), "A: the refused switch created no entry");
      const insideLedger = await ledger(inside.clientEventId);
      check(
        insideLedger?.processing_status === "permanent_conflict" && /manual Inputs entry/.test(insideLedger?.conflict_reason ?? ""),
        "A: the refused event is preserved in the ledger with a manual-entry reason",
        insideLedger
      );
      check((await conflictsList()).some((c) => c.clientEventId === inside.clientEventId), "A: it is listed on Sync Conflicts for review");

      const retryOne = await sync(w.deviceIdentifier, [inside]);
      check(statuses(retryOne)[0] === "permanent_conflict", "A retry: resending the refused event still reports the conflict", retryOne.body);
      const retryAll = await sync(w.deviceIdentifier, batch);
      check(
        JSON.stringify(statuses(retryAll)) === JSON.stringify(["duplicate", "permanent_conflict", "duplicate"]),
        "A retry: resending the whole batch changes nothing",
        retryAll.body
      );
      check(JSON.stringify(await liveEntries(w.id)) === JSON.stringify(rows), "A retry: entries identical after retries");
    }

    // -----------------------------------------------------------------
    // B. Phone entry closed across a finished manual entry
    // -----------------------------------------------------------------
    {
      const B = 2;
      const w = await setupWorker("ScenarioB");
      check((await addManual(w.id, B, at(B, 7), at(B, 9))).status === 201, "B setup: manual 7:00-9:00");
      const start = w.ev("work_start", at(B, 6), work(plainId));
      const switchAfter = w.ev("activity_switch", at(B, 10), work(pickId, pickAnswers));
      const end = w.ev("end_day", at(B, 11));
      const batch = [start, switchAfter, end];
      const r = await sync(w.deviceIdentifier, batch);
      check(JSON.stringify(statuses(r)) === JSON.stringify(["accepted", "accepted", "accepted"]), "B: all three events accepted", r.body);
      check(/manual Inputs entry/.test(r.body?.results?.[1]?.detail?.reason ?? ""), "B: the crossing switch is returned with a review reason", r.body);
      const rows = await liveEntries(w.id);
      check(await overlapCount(w.id) === 0, "B: no overlapping records", rows);
      check(rows.length === 3, "B: phone 6-7, manual 7-9, phone 10-11", rows);
      check(!rows[0]?.manual && rows[0]?.s === at(B, 6) && rows[0]?.e === at(B, 7), "B: first phone entry ended at the manual start", rows[0]);
      check(rows[1]?.manual && rows[1]?.s === at(B, 7) && rows[1]?.e === at(B, 9), "B: manual entry unchanged", rows[1]);
      check(
        !rows[2]?.manual && rows[2]?.s === at(B, 10) && rows[2]?.e === at(B, 11) && rows[2]?.activity_id === pickId && rows[2]?.carrier_id === carrierId,
        "B: the switch's own entry (10:00-11:00) is created normally",
        rows[2]
      );
      const switchLedger = await ledger(switchAfter.clientEventId);
      check(
        switchLedger?.processing_status === "accepted" && /manual Inputs entry/.test(switchLedger?.conflict_reason ?? ""),
        "B: the crossing event is accepted with a review reason in the ledger",
        switchLedger
      );
      check((await conflictsList()).some((c) => c.clientEventId === switchAfter.clientEventId), "B: it is listed on Sync Conflicts for review");
      check(!(await ledger(end.clientEventId))?.conflict_reason, "B: the ordinary end_day carries no flag");

      const retry = await sync(w.deviceIdentifier, batch);
      check(JSON.stringify(statuses(retry)) === JSON.stringify(["duplicate", "duplicate", "duplicate"]), "B retry: whole batch reports duplicate", retry.body);
      check(JSON.stringify(await liveEntries(w.id)) === JSON.stringify(rows), "B retry: entries identical");

      // end_day itself crossing a manual entry is clipped the same way.
      const B2 = 3;
      check((await addManual(w.id, B2, at(B2, 8), at(B2, 9))).status === 201, "B2 setup: manual 8:00-9:00");
      const s2 = w.ev("work_start", at(B2, 6), work(plainId));
      const e2 = w.ev("end_day", at(B2, 12));
      const r2 = await sync(w.deviceIdentifier, [s2, e2]);
      check(JSON.stringify(statuses(r2)) === JSON.stringify(["accepted", "accepted"]), "B2: start and crossing end_day accepted", r2.body);
      const day2 = (await liveEntries(w.id)).filter((x) => x.s >= at(B2, 0));
      check(day2.length === 2 && day2[0].e === at(B2, 8), "B2: phone entry ended at the manual start (8:00), not 12:00", day2);
      check(/manual Inputs entry/.test((await ledger(e2.clientEventId))?.conflict_reason ?? ""), "B2: the end_day is flagged for review");
      check(await overlapCount(w.id) === 0, "B2: no overlapping records");
    }

    // -----------------------------------------------------------------
    // C. 60-minute rounding window vs an open manual entry; then a valid
    //    phone takeover.
    // -----------------------------------------------------------------
    {
      const C = 4;
      const w = await setupWorker("ScenarioC");
      check((await addManual(w.id, C, at(C, 9), null)).status === 201, "C setup: open manual entry from 9:00 (Cleaning, no row/bin)");
      const manual = (await liveEntries(w.id))[0];

      const early = w.ev("work_start", at(C, 8, 30), work(pickId, pickAnswers));
      const earlyBreak = w.ev("break_start", at(C, 8, 45));
      const r = await sync(w.deviceIdentifier, [early, earlyBreak]);
      check(
        JSON.stringify(statuses(r)) === JSON.stringify(["permanent_conflict", "permanent_conflict"]),
        "C: work_start 30 min and break_start 15 min before the manual start are both refused",
        r.body
      );
      let after = await liveEntries(w.id);
      check(after.length === 1, "C: no phone entry was created and the manual entry wasn't voided", after);
      check(
        after[0]?.id === manual.id &&
          after[0]?.activity_id === plainId &&
          after[0]?.greenhouse_row_id === null &&
          after[0]?.carrier_id === null &&
          after[0]?.s === at(C, 9) &&
          after[0]?.e === null &&
          after[0]?.idempotency_key === manual.idempotency_key,
        "C: manual entry's activity, row, bin, start and key are unchanged and it is still open",
        after[0]
      );
      const earlyLedger = await ledger(early.clientEventId);
      check(
        earlyLedger?.processing_status === "permanent_conflict" && /in-progress manual Inputs entry/.test(earlyLedger?.conflict_reason ?? ""),
        "C: the refused event is preserved with a manual-entry reason",
        earlyLedger
      );
      check((await conflictsList()).some((c) => c.clientEventId === early.clientEventId), "C: it is listed on Sync Conflicts for review");

      const retry = await sync(w.deviceIdentifier, [early, earlyBreak]);
      check(
        JSON.stringify(statuses(retry)) === JSON.stringify(["permanent_conflict", "permanent_conflict"]),
        "C retry: resending reports the same conflicts",
        retry.body
      );
      check(JSON.stringify(await liveEntries(w.id)) === JSON.stringify(after), "C retry: manual entry still unchanged");

      // Valid takeover: a later phone event closes the manual entry there.
      const takeover = w.ev("activity_switch", at(C, 10), work(pickId, pickAnswers));
      const end = w.ev("end_day", at(C, 12));
      const t = await sync(w.deviceIdentifier, [takeover, end]);
      check(JSON.stringify(statuses(t)) === JSON.stringify(["accepted", "accepted"]), "C takeover: 10:00 switch and 12:00 end accepted", t.body);
      check(t.body?.results?.[0]?.detail === undefined, "C takeover: an ordinary takeover is not flagged", t.body);
      after = await liveEntries(w.id);
      check(
        after.length === 2 &&
          after[0].id === manual.id &&
          after[0].manual &&
          after[0].activity_id === plainId &&
          after[0].s === at(C, 9) &&
          after[0].e === at(C, 10),
        "C takeover: manual entry closed at 10:00 with its activity/start/audit intact",
        after
      );
      check(
        !after[1]?.manual && after[1]?.s === at(C, 10) && after[1]?.e === at(C, 12) && after[1]?.greenhouse_row_id === rowId,
        "C takeover: phone entry 10:00-12:00",
        after[1]
      );
      check(await overlapCount(w.id) === 0, "C: no overlapping records");
      const retryTakeover = await sync(w.deviceIdentifier, [takeover, end]);
      check(JSON.stringify(statuses(retryTakeover)) === JSON.stringify(["duplicate", "duplicate"]), "C takeover retry: duplicates", retryTakeover.body);
      check(JSON.stringify(await liveEntries(w.id)) === JSON.stringify(after), "C takeover retry: entries identical");

      // An end_day before the open manual entry's start is refused too
      // (it would otherwise close the manual entry at start+1s or fail).
      const C2 = 5;
      check((await addManual(w.id, C2, at(C2, 9), null)).status === 201, "C2 setup: open manual entry from 9:00");
      const earlyEnd = w.ev("end_day", at(C2, 8, 50));
      const e = await sync(w.deviceIdentifier, [earlyEnd]);
      check(statuses(e)[0] === "permanent_conflict", "C2: end_day before the manual start is refused", e.body);
      const day2 = (await liveEntries(w.id)).filter((x) => x.s >= at(C2, 0));
      check(day2.length === 1 && day2[0].e === null && day2[0].manual, "C2: manual entry still open and unchanged", day2);
      await pool.query(`update time_entries set ended_at = $2 where id = $1`, [day2[0].id, at(C2, 15)]);
    }

    // -----------------------------------------------------------------
    // D. Normal syncing (no manual entries) is unchanged.
    // -----------------------------------------------------------------
    {
      const D = 6;
      const w = await setupWorker("ScenarioD");
      const batch = [
        w.ev("work_start", at(D, 7), work(plainId)),
        w.ev("activity_switch", at(D, 9), work(pickId, pickAnswers)),
        w.ev("break_start", at(D, 10)),
        w.ev("break_end", at(D, 10, 15)),
        w.ev("end_day", at(D, 12)),
      ];
      const r = await sync(w.deviceIdentifier, batch);
      check(statuses(r).every((s: string) => s === "accepted"), "D: every event accepted", r.body);
      check((r.body?.results ?? []).every((x: any) => x.detail === undefined), "D: nothing flagged", r.body);
      const rows = await liveEntries(w.id);
      check(rows.length === 4 && (await overlapCount(w.id)) === 0, "D: work, work, break, work — contiguous, no overlaps", rows);
      check(rows[0].e === at(D, 9) && rows[1].e === at(D, 10) && rows[3].e === at(D, 12), "D: boundaries exactly at the event times", rows);
    }
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      for (const table of ["time_entry_corrections", "time_entry_deletions", "time_entries"]) {
        await client.query(`delete from ${table} where employee_id in (select id from employees where email like $1)`, [EMAIL_PATTERN]);
      }
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from activity_questions where activity_id = any($1::uuid[])`, [activityIds]);
      if (groupId) {
        await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId]);
        await client.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId]);
      }
      await client.query(`delete from activities where id = any($1::uuid[])`, [activityIds]);
      if (groupId) await client.query(`delete from activity_groups where id = $1`, [groupId]);
      if (rowId) await client.query(`delete from greenhouse_rows where id = $1`, [rowId]);
      if (phaseId) await client.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      if (carrierId) await client.query(`delete from carriers where id = $1`, [carrierId]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }
    const leftover = await pool.query(`select count(*) from employees where email like $1`, [EMAIL_PATTERN]);
    check(Number(leftover.rows[0].count) === 0, "all QA fixtures cleaned up");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
