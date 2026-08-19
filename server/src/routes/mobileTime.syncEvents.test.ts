// Integration tests for POST /api/mobile/sync/events — the server side of
// the local-first mobile event log (web/src/lib/localEventStore.ts /
// syncEngine.ts, Stage 4 of the offline-first redesign). Real router over
// real HTTP against the real database, RUN_ID-suffixed disposable QA
// fixtures, cleanup as one transaction with a final "nothing orphaned"
// assertion — same convention as mobileTime.switchWarnings.test.ts.
//
// Covers: a genuine idle -> work -> break -> break-resume -> activity-switch
// -> end-day chain applied entirely through the batch endpoint, with
// device_seq strictly ordered; idempotent replay of an already-accepted
// event (returns 'duplicate', zero side effects, no second time_entries
// row); sequence-gap detection (an event arriving out of order is held as
// 'sequence_gap' and never applied, without discarding the batch); the gap
// clearing once the missing device_seq arrives, applied in a LATER call —
// proving a sequence_gap is never permanently recorded (unlike a genuine
// terminal outcome), so the exact same event gets a fresh, correct attempt
// once the queue catches up; an invalid activityId producing a
// permanent_conflict that stays a conflict on replay (never silently
// becomes 'duplicate'); and exact occurred_at_utc preservation for a
// multi-day-old timestamp — proving the removed 24-hour rounding fallback
// (confirmed decision) is really gone, not just relocated.
//
// Run with: npm run test:mobile-time-sync-events
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import mobileTimeRouter from "./mobileTime";

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

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function sync(deviceIdentifier: string, events: unknown[]): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/mobile/sync/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify({ events }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let groupId!: string;
  let generalActivityId!: string; // no questions
  let pickingActivityId!: string; // requires greenhouseRowId
  let questionId!: string;
  let landId!: string;
  let phaseId!: string;
  let rowAId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    const employee = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        ["QA", `Sync Events ${RUN_ID}`, `qa-sync-events-${RUN_ID}@test.local`, roleId, teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(employee.id);
    const employeeId: string = employee.id;

    const deviceIdentifier = randomUUID();
    const deviceRow = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        deviceIdentifier,
        `QA Sync Events Device ${RUN_ID}`,
      ])
    ).rows[0];
    deviceIds.push(deviceRow.id);
    const deviceRowId: string = deviceRow.id;
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRowId, employeeId]);

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA Sync Events Group ${RUN_ID}`,
      ])
    ).rows[0].id;

    generalActivityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Sync Events General ${RUN_ID}`,
      ])
    ).rows[0].id;
    pickingActivityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Sync Events Picking ${RUN_ID}`,
      ])
    ).rows[0].id;
    questionId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [pickingActivityId]
      )
    ).rows[0].id;

    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`, [
      groupId,
      generalActivityId,
      pickingActivityId,
    ]);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
      employeeId,
      groupId,
    ]);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [
        `QA Sync Events Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`,
        [landId, `QA Sync Events Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    rowAId = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, 1, 0, 0, 4, 50, 'vertical') returning id`,
        [phaseId]
      )
    ).rows[0].id;

    // A whole offline day, replayed all at once — multi-day-old occurrence
    // times, well past the removed 24h fallback ceiling, so this also
    // proves that removal (confirmed decision) actually took effect.
    const dayStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const t = (minutesOffset: number) => new Date(dayStart.getTime() + minutesOffset * 60000).toISOString();

    const event1 = { clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: t(0), activityId: generalActivityId, answers: null };
    const event2 = { clientEventId: randomUUID(), deviceSeq: 2, eventType: "break_start", occurredAtUtc: t(60) };
    const event3 = { clientEventId: randomUUID(), deviceSeq: 3, eventType: "break_end", occurredAtUtc: t(75) };
    const event4 = {
      clientEventId: randomUUID(),
      deviceSeq: 4,
      eventType: "activity_switch",
      occurredAtUtc: t(120),
      activityId: pickingActivityId,
      greenhouseRowId: rowAId,
      answers: { [questionId]: { questionId, questionType: "greenhouse_row", greenhouseRowId: rowAId } },
    };
    const event5 = { clientEventId: randomUUID(), deviceSeq: 5, eventType: "end_day", occurredAtUtc: t(180) };

    // -----------------------------------------------------------------
    // A) event1 alone: a genuine idle -> work transition, accepted.
    // -----------------------------------------------------------------
    const r1 = await sync(deviceIdentifier, [event1]);
    check(r1.status === 200, "A) event1 (work_start) call succeeds", r1.body);
    check(r1.body?.results?.[0]?.status === "accepted", "A) event1 is accepted", r1.body);

    const entryAfter1 = await pool.query(`select id, started_at, activity_id, idempotency_key from time_entries where employee_id = $1`, [
      employeeId,
    ]);
    check(entryAfter1.rows.length === 1, "A) exactly one time_entries row exists after event1", entryAfter1.rows);
    check(
      entryAfter1.rows[0]?.idempotency_key === event1.clientEventId,
      "A) the row's idempotency_key is event1's clientEventId (reused as the same identifier throughout)"
    );
    check(
      new Date(entryAfter1.rows[0]?.started_at).getTime() === new Date(event1.occurredAtUtc).getTime(),
      "A) started_at exactly matches the 3-day-old occurredAtUtc — no rounding, no clamping to sync/arrival time",
      { started_at: entryAfter1.rows[0]?.started_at, occurredAtUtc: event1.occurredAtUtc }
    );

    // -----------------------------------------------------------------
    // B) replaying event1 alone: idempotent, no new row, reported as
    //    'duplicate' (not a second 'accepted').
    // -----------------------------------------------------------------
    const rReplay = await sync(deviceIdentifier, [event1]);
    check(rReplay.body?.results?.[0]?.status === "duplicate", "B) replaying event1 reports 'duplicate'", rReplay.body);
    const entryAfterReplay = await pool.query(`select count(*) from time_entries where employee_id = $1`, [employeeId]);
    check(Number(entryAfterReplay.rows[0].count) === 1, "B) still exactly one time_entries row after the replay");

    // -----------------------------------------------------------------
    // C) event3 arriving before event2 is a sequence gap — held, not
    //    applied, and NOT permanently recorded (see part D).
    // -----------------------------------------------------------------
    const rGap = await sync(deviceIdentifier, [event3]);
    check(rGap.body?.results?.[0]?.status === "sequence_gap", "C) event3 before event2 is a sequence_gap", rGap.body);
    const noBreakEndYet = await pool.query(`select count(*) from time_entries where employee_id = $1`, [employeeId]);
    check(Number(noBreakEndYet.rows[0].count) === 1, "C) the gapped event3 created no time_entries row");
    const gapLedgerRow = await pool.query(
      `select count(*) from mobile_time_events where device_id = $1 and client_event_id = $2`,
      [deviceRowId, event3.clientEventId]
    );
    check(
      Number(gapLedgerRow.rows[0].count) === 0,
      "C) the sequence_gap attempt was NOT persisted to mobile_time_events (transient, not terminal)"
    );

    // -----------------------------------------------------------------
    // D) sending [event2, event3] together now applies both in order:
    //    event2 (break_start) closes the work entry; event3 (break_end)
    //    resumes the SAME activity — proving the earlier gap didn't
    //    poison this event's ability to apply correctly once in order.
    // -----------------------------------------------------------------
    const rCatchUp = await sync(deviceIdentifier, [event2, event3]);
    check(rCatchUp.body?.results?.[0]?.status === "accepted", "D) event2 (break_start) accepted", rCatchUp.body);
    check(rCatchUp.body?.results?.[1]?.status === "accepted", "D) event3 (break_end) accepted", rCatchUp.body);

    const chainAfterD = await pool.query(
      `select entry_type, activity_id, started_at, ended_at from time_entries where employee_id = $1 order by started_at asc`,
      [employeeId]
    );
    check(chainAfterD.rows.length === 3, "D) three time_entries rows exist: work, break, resumed work", chainAfterD.rows);
    check(chainAfterD.rows[0]?.entry_type === "work" && chainAfterD.rows[0]?.ended_at !== null, "D) first work segment is closed");
    check(chainAfterD.rows[1]?.entry_type === "break", "D) middle segment is the break");
    check(
      chainAfterD.rows[2]?.entry_type === "work" && chainAfterD.rows[2]?.activity_id === generalActivityId && chainAfterD.rows[2]?.ended_at === null,
      "D) break_end resumed the SAME General activity, still open",
      chainAfterD.rows[2]
    );
    check(
      new Date(chainAfterD.rows[0]?.ended_at).getTime() === new Date(event2.occurredAtUtc).getTime(),
      "D) the first segment's ended_at exactly matches event2's occurredAtUtc"
    );

    // -----------------------------------------------------------------
    // E) event4 (activity_switch, with a real answers object keyed by
    //    questionId — the Record<string, QuestionAnswer> shape the
    //    client's local event log actually stores) applies normally.
    // -----------------------------------------------------------------
    const rSwitch = await sync(deviceIdentifier, [event4]);
    check(rSwitch.body?.results?.[0]?.status === "accepted", "E) event4 (activity_switch to Picking+rowA) accepted", rSwitch.body);
    const openAfterSwitch = await pool.query(
      `select activity_id, greenhouse_row_id from time_entries where employee_id = $1 and ended_at is null`,
      [employeeId]
    );
    check(
      openAfterSwitch.rows[0]?.activity_id === pickingActivityId && openAfterSwitch.rows[0]?.greenhouse_row_id === rowAId,
      "E) the now-open entry is Picking on rowA — answers correctly resolved server-side",
      openAfterSwitch.rows[0]
    );

    // -----------------------------------------------------------------
    // F) event5 (end_day) closes the day; nothing left open.
    // -----------------------------------------------------------------
    const rEndDay = await sync(deviceIdentifier, [event5]);
    check(rEndDay.body?.results?.[0]?.status === "accepted", "F) event5 (end_day) accepted", rEndDay.body);
    const openAfterEndDay = await pool.query(`select count(*) from time_entries where employee_id = $1 and ended_at is null`, [
      employeeId,
    ]);
    check(Number(openAfterEndDay.rows[0].count) === 0, "F) nothing is open after end_day");

    // -----------------------------------------------------------------
    // G) an invalid activityId is a permanent_conflict, and replaying it
    //    stays a conflict — never silently becomes 'duplicate'/'accepted'.
    // -----------------------------------------------------------------
    const badEvent = {
      clientEventId: randomUUID(),
      deviceSeq: 6,
      eventType: "work_start",
      occurredAtUtc: t(200),
      activityId: randomUUID(), // not a real activity
      answers: null,
    };
    const rBad = await sync(deviceIdentifier, [badEvent]);
    check(rBad.body?.results?.[0]?.status === "permanent_conflict", "G) an invalid activityId is a permanent_conflict", rBad.body);
    const rBadReplay = await sync(deviceIdentifier, [badEvent]);
    check(
      rBadReplay.body?.results?.[0]?.status === "permanent_conflict",
      "G) replaying the same bad event still reports permanent_conflict, not duplicate",
      rBadReplay.body
    );

    // -----------------------------------------------------------------
    // H) device_sync_state advanced through every terminal outcome,
    //    including the permanent_conflict (so later events aren't blocked
    //    behind an unresolved conflict forever).
    // -----------------------------------------------------------------
    const syncState = await pool.query(`select last_processed_seq from device_sync_state where device_id = $1`, [deviceRowId]);
    check(Number(syncState.rows[0]?.last_processed_seq) === 6, "H) last_processed_seq advanced through all 6 events, including the conflict", syncState.rows[0]);

    const ledgerCount = await pool.query(`select count(*) from mobile_time_events where device_id = $1`, [deviceRowId]);
    check(Number(ledgerCount.rows[0].count) === 6, "H) exactly 6 terminal ledger rows recorded (event3's transient gap attempt never counted)");
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activity_questions where id = any($1::uuid[])`, [[questionId].filter(Boolean)]);
      await client.query(`delete from activities where id = any($1::uuid[])`, [
        [generalActivityId, pickingActivityId].filter(Boolean),
      ]);
      if (groupId) await client.query(`delete from activity_groups where id = $1`, [groupId]);
      await client.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [[rowAId].filter(Boolean)]);
      if (phaseId) await client.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }

    const leftoverEmployees = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    const leftoverActivities = await pool.query(`select count(*) from activities where id = any($1::uuid[])`, [
      [generalActivityId, pickingActivityId].filter(Boolean),
    ]);
    check(
      Number(leftoverEmployees.rows[0].count) === 0 && Number(leftoverActivities.rows[0].count) === 0,
      "Z) all QA fixtures cleaned up, none left orphaned"
    );

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
