// Stage 6 scenario coverage for POST /api/mobile/sync/events beyond the
// basic accept/replay/gap/conflict cases already covered by
// mobileTime.syncEvents.test.ts and mobileTime.syncEvents.clockAnomaly.test.ts.
// Real router over real HTTP against the real database, RUN_ID-suffixed
// disposable QA fixtures, cleanup as one transaction with a final
// "nothing orphaned" assertion — same convention as every other
// integration test in this directory.
//
// Covers (mapped to the offline-first plan's 20 test scenarios):
//   - a large queue (600+ events across many batches) — "thousands of
//     queued events" scaled down to keep this test fast, same code path
//   - retries / many replays of the exact same batch (a lost-ack replay:
//     the client never saw the first response and resubmits everything)
//   - a batch that's a MIX of already-processed and genuinely-new events
//     (the shape of "network loss mid-batch" from the client's point of
//     view — it doesn't know which of its own events the server actually
//     received before the connection dropped, so it just resends its
//     whole still-pending queue)
//   - multiple sequence gaps opening and then all clearing once the
//     missing events finally arrive
//   - a deleted (soft-deleted) row referenced by a late-arriving offline
//     event — a real permanent_conflict, not just an invalid-id one
//   - two devices, same employee: the OLD device's late-arriving offline
//     events must never get misattributed once an admin has reassigned
//     the employee to a different device
//   - a manual Inputs correction and a device sync happening independently
//     — the correction must survive an unrelated later sync untouched
//   - "no duplicates anywhere": one idempotency_key per event id,
//     verified explicitly at the end of the large-queue/replay scenarios
//
// Run with: npm run test:mobile-time-sync-events-scenarios
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import mobileTimeRouter from "./mobileTime";
import inputsRouter from "./inputs";

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
  app.use("/api/inputs", inputsRouter);
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

  async function callAdmin(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let groupId!: string;
  let activityId!: string;
  let landId!: string;
  let phaseId!: string;
  let rowId!: string;
  let rowQuestionId!: string;
  let rowActivityId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    async function makeEmployee(label: string, roleName: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Scenarios ${label} ${RUN_ID}`, `qa-scenarios-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(roleName), teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    // Each scenario below that needs its OWN device gets its OWN fresh
    // employee too — migration 033 enforces at most one ACTIVE device per
    // employee, so two independent scenarios can never safely share one
    // (a real, caught-in-testing bug: the first draft of this file reused
    // `employeeId` across several scenarios and hit that exact constraint).
    // groupId doesn't exist yet at this point in the file, so group
    // assignment happens after it's created, in makeEmployeeInGroup below.
    async function makeEmployeeInGroup(label: string): Promise<string> {
      const id = await makeEmployee(label, "Employee");
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [id, groupId]);
      return id;
    }

    const employeeId = await makeEmployee("Employee", "Employee");
    const employee2Id = await makeEmployee("Employee2", "Employee");
    const adminId = await makeEmployee("Admin", "Administrator");
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Scenarios Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function makeDevice(label: string, employeeIdForAssignment: string | null): Promise<{ id: string; identifier: string }> {
      const identifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [identifier, `QA Scenarios ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      if (employeeIdForAssignment) {
        await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeIdForAssignment]);
      }
      return { id: rows[0].id, identifier };
    }

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA Scenarios Group ${RUN_ID}`])
    ).rows[0].id;
    activityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Scenarios Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    rowActivityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Scenarios Row Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    rowQuestionId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [rowActivityId]
      )
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`, [
      groupId,
      activityId,
      rowActivityId,
    ]);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2), ($3, $2)`, [
      employeeId,
      groupId,
      employee2Id,
    ]);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [
        `QA Scenarios Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`,
        [landId, `QA Scenarios Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    rowId = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, 1, 0, 0, 4, 50, 'vertical') returning id`,
        [phaseId]
      )
    ).rows[0].id;

    // ===================================================================
    // SCENARIO 1: a large queue — 600 events (work_start/activity_switch
    // alternating, all same activity so every one is a legitimate
    // transition) submitted across 12 batches of 50, exactly the batch
    // size syncEngine.ts itself uses. Verifies: all 600 accepted, no
    // duplicates, device_sync_state ends up exactly at 600, and the
    // resulting time_entries chain has no gaps/overlaps.
    // ===================================================================
    {
      const device = await makeDevice("LargeQueue", employeeId);
      const BATCH_SIZE = 50;
      const TOTAL = 600;
      const dayStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago, well offline
      const events = Array.from({ length: TOTAL }, (_, i) => ({
        clientEventId: randomUUID(),
        deviceSeq: i + 1,
        eventType: i === 0 ? "work_start" : "activity_switch",
        occurredAtUtc: new Date(dayStart.getTime() + i * 60000).toISOString(), // one per minute
        activityId,
        answers: null,
      }));

      let allAccepted = true;
      for (let i = 0; i < TOTAL; i += BATCH_SIZE) {
        const batch = events.slice(i, i + BATCH_SIZE);
        const r = await sync(device.identifier, batch);
        if (r.status !== 200 || !(r.body.results as any[]).every((res) => res.status === "accepted")) {
          allAccepted = false;
        }
      }
      check(allAccepted, "1) all 600 events across 12 batches were accepted");

      const state = await pool.query(`select last_processed_seq from device_sync_state where device_id = $1`, [device.id]);
      check(Number(state.rows[0]?.last_processed_seq) === TOTAL, "1) device_sync_state advanced to exactly 600", state.rows[0]);

      const ledgerCount = await pool.query(`select count(*) from mobile_time_events where device_id = $1`, [device.id]);
      check(Number(ledgerCount.rows[0].count) === TOTAL, "1) exactly 600 ledger rows — no duplicates from the batching itself");

      const entries = await pool.query(
        `select started_at, ended_at from time_entries where employee_id = $1 order by started_at asc`,
        [employeeId]
      );
      check(entries.rows.length === TOTAL, "1) exactly 600 time_entries rows — one per event, no merges/splits", { count: entries.rows.length });
      let noGapsOrOverlaps = true;
      for (let i = 0; i < entries.rows.length - 1; i++) {
        if (new Date(entries.rows[i].ended_at).getTime() !== new Date(entries.rows[i + 1].started_at).getTime()) {
          noGapsOrOverlaps = false;
          break;
        }
      }
      check(noGapsOrOverlaps, "1) every entry's ended_at exactly matches the next entry's started_at — no gaps or overlaps in the chain");

      // -----------------------------------------------------------------
      // SCENARIO 2: many replays — resubmit the ENTIRE 600-event queue
      // again (simulating a lost-ack client that never saw ANY of the
      // previous responses and just resends everything it still thinks is
      // pending), still batched at the same 50-per-request size the real
      // client's syncEngine.ts actually uses (a genuine client never sends
      // 600 events in one HTTP request — Express's own JSON body-size
      // limit would reject that outright, which is a real, useful signal
      // this test caught on its first draft: it originally tried to send
      // all 600 as one request and got a body-parser rejection back).
      // Every single one must come back 'duplicate', and NOT ONE new
      // time_entries row may be created.
      // -----------------------------------------------------------------
      let allDuplicate = true;
      for (let i = 0; i < TOTAL; i += BATCH_SIZE) {
        const batch = events.slice(i, i + BATCH_SIZE);
        const r = await sync(device.identifier, batch);
        if (!(r.body?.results as any[])?.every((res) => res.status === "duplicate")) allDuplicate = false;
      }
      check(allDuplicate, "2) resubmitting the entire 600-event queue (batched) reports 'duplicate' for every single one");
      const entriesAfterReplay = await pool.query(`select count(*) from time_entries where employee_id = $1`, [employeeId]);
      check(Number(entriesAfterReplay.rows[0].count) === TOTAL, "2) no duplicates anywhere — still exactly 600 time_entries rows after a full replay");

      // A THIRD replay, just to be sure repeated replays stay idempotent
      // rather than only working once.
      const replayAgain = await sync(device.identifier, events.slice(0, 50));
      check(
        (replayAgain.body.results as any[]).every((r) => r.status === "duplicate"),
        "2) a third replay of a subset is still all 'duplicate'"
      );
    }

    // ===================================================================
    // SCENARIO 3: a "network loss mid-batch" shaped resubmission — the
    // client sends [A, B, C], the connection drops before it sees the
    // response (a genuine lost ack, even though the server actually
    // processed all three), so it resends [A, B, C, D, E] next time
    // (A-C already-processed, D-E genuinely new). Every event must get
    // the CORRECT individual status, and only D/E create new entries.
    // ===================================================================
    {
      const lostAckEmployeeId = await makeEmployeeInGroup("LostAck");
      const device = await makeDevice("LostAck", lostAckEmployeeId);
      const base = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const five = Array.from({ length: 5 }, (_, i) => ({
        clientEventId: randomUUID(),
        deviceSeq: i + 1,
        eventType: i === 0 ? "work_start" : "activity_switch",
        occurredAtUtc: new Date(base.getTime() + i * 60000).toISOString(),
        activityId,
        answers: null,
      }));

      const firstThree = await sync(device.identifier, five.slice(0, 3));
      check(
        (firstThree.body.results as any[]).every((r) => r.status === "accepted"),
        "3) first 3 events accepted normally",
        firstThree.body
      );

      // The client "lost" that response and now resends all 5 (3 old + 2
      // new) in the next batch, exactly as syncEngine.ts's own pending
      // queue (still containing all 5, since markSyncResult for the first
      // 3 hasn't been applied client-side yet in this simulated scenario)
      // would.
      const allFive = await sync(device.identifier, five);
      const statuses = (allFive.body.results as any[]).map((r) => r.status);
      check(
        statuses[0] === "duplicate" && statuses[1] === "duplicate" && statuses[2] === "duplicate",
        "3) the 3 already-processed events come back 'duplicate', not re-applied",
        statuses
      );
      check(statuses[3] === "accepted" && statuses[4] === "accepted", "3) the 2 genuinely new events are accepted", statuses);

      const entryCount = await pool.query(`select count(*) from time_entries where employee_id = $1 and started_at >= $2`, [
        lostAckEmployeeId,
        base.toISOString(),
      ]);
      check(Number(entryCount.rows[0].count) === 5, "3) exactly 5 time_entries rows total — the lost-ack replay created no duplicates");
    }

    // ===================================================================
    // SCENARIO 4: multiple sequence gaps opening and then ALL clearing
    // once the missing events finally arrive, in one later batch.
    // ===================================================================
    {
      const multiGapEmployeeId = await makeEmployeeInGroup("MultiGap");
      const device = await makeDevice("MultiGap", multiGapEmployeeId);
      const base = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const ten = Array.from({ length: 10 }, (_, i) => ({
        clientEventId: randomUUID(),
        deviceSeq: i + 1,
        eventType: i === 0 ? "work_start" : "activity_switch",
        occurredAtUtc: new Date(base.getTime() + i * 60000).toISOString(),
        activityId,
        answers: null,
      }));

      // Send only 1, 4, 7, 10 — three separate gaps.
      const sparse = [ten[0], ten[3], ten[6], ten[9]];
      const rSparse = await sync(device.identifier, sparse);
      const sparseStatuses = (rSparse.body.results as any[]).map((r) => r.status);
      check(sparseStatuses[0] === "accepted", "4) event 1 (no gap yet) accepted", sparseStatuses);
      check(
        sparseStatuses[1] === "sequence_gap" && sparseStatuses[2] === "sequence_gap" && sparseStatuses[3] === "sequence_gap",
        "4) events 4, 7, 10 are all held as sequence_gap (event 2/3 missing)",
        sparseStatuses
      );

      // Now send everything — the gaps fill in and the whole chain applies.
      const rFull = await sync(device.identifier, ten);
      const fullStatuses = (rFull.body.results as any[]).map((r) => r.status);
      check(
        fullStatuses.every((s) => s === "accepted" || s === "duplicate"),
        "4) once the full ordered set is sent, every event resolves to accepted or duplicate — no gaps remain",
        fullStatuses
      );
      const state = await pool.query(`select last_processed_seq from device_sync_state where device_id = $1`, [device.id]);
      check(Number(state.rows[0]?.last_processed_seq) === 10, "4) device_sync_state fully caught up to 10", state.rows[0]);
    }

    // ===================================================================
    // SCENARIO 5: a deleted (soft-deleted) greenhouse row referenced by a
    // late-arriving offline event — a genuine permanent_conflict distinct
    // from "never existed at all."
    // ===================================================================
    {
      const deletedRowEmployeeId = await makeEmployeeInGroup("DeletedRow");
      const device = await makeDevice("DeletedRow", deletedRowEmployeeId);
      const doomedRow = (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
           values ($1, 99, 0, 0, 4, 50, 'vertical') returning id`,
          [phaseId]
        )
      ).rows[0].id;

      // The device answered this question while the row still existed —
      // then an admin deleted the row before the device ever got back
      // online to sync.
      await pool.query(`update greenhouse_rows set deleted_at = now() where id = $1`, [doomedRow]);

      const event = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        activityId: rowActivityId,
        greenhouseRowId: doomedRow,
        answers: { [rowQuestionId]: { questionId: rowQuestionId, questionType: "greenhouse_row", greenhouseRowId: doomedRow } },
      };
      const r = await sync(device.identifier, [event]);
      check(r.body?.results?.[0]?.status === "permanent_conflict", "5) an offline event referencing a since-deleted row is a permanent_conflict", r.body);

      await pool.query(`delete from greenhouse_rows where id = $1`, [doomedRow]);
    }

    // ===================================================================
    // SCENARIO 6: two devices, same employee — an employee reassigned
    // from device A to device B mid-shift. Device A's late-arriving
    // offline events (queued before the reassignment) must be rejected
    // outright (device no longer assigned), never silently attributed to
    // the employee's timeline as if device A were still authorized.
    // Device B, now the active device, works normally.
    // ===================================================================
    {
      const deviceA = await makeDevice("ReassignA", employee2Id);
      const eventBeforeReassign = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        activityId,
        answers: null,
      };
      const rBefore = await sync(deviceA.identifier, [eventBeforeReassign]);
      check(rBefore.body?.results?.[0]?.status === "accepted", "6) device A syncs normally before reassignment", rBefore.body);

      // Admin reassigns employee2 to a new device — closes device A's
      // assignment (mirrors what desktop Setup > Devices does: end the
      // old assignment, start a new one; migration 033 enforces at most
      // one active assignment per employee).
      const deviceB = await makeDevice("ReassignB", null);
      await pool.query(`update device_assignments set unassigned_at = now() where device_id = $1 and unassigned_at is null`, [deviceA.id]);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceB.id, employee2Id]);

      // Device A had a SECOND event queued locally before it ever learned
      // about the reassignment (it was offline). It comes back online and
      // tries to sync — must be rejected at the device-auth layer, never
      // reach the sync endpoint's own logic at all.
      const eventAfterReassign = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "activity_switch",
        occurredAtUtc: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        activityId,
        answers: null,
      };
      const rAfter = await sync(deviceA.identifier, [eventAfterReassign]);
      check(rAfter.status === 401, "6) device A's late sync after reassignment is rejected with 401, not silently applied", rAfter.body);
      check(rAfter.body?.code === "DEVICE_UNASSIGNED", "6) rejection code is DEVICE_UNASSIGNED", rAfter.body);

      const orphanedEventStored = await pool.query(`select count(*) from mobile_time_events where client_event_id = $1`, [
        eventAfterReassign.clientEventId,
      ]);
      check(Number(orphanedEventStored.rows[0].count) === 0, "6) the rejected event was never recorded in the ledger at all — no misattribution");

      // Device B, now the actively assigned device, works normally and is
      // correctly attributed to employee2.
      const eventOnB = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "activity_switch",
        occurredAtUtc: new Date().toISOString(),
        activityId,
        answers: null,
      };
      const rOnB = await sync(deviceB.identifier, [eventOnB]);
      check(rOnB.body?.results?.[0]?.status === "accepted", "6) device B (the newly assigned device) syncs normally", rOnB.body);
      const attributedRow = await pool.query(`select employee_id from mobile_time_events where client_event_id = $1`, [eventOnB.clientEventId]);
      check(attributedRow.rows[0]?.employee_id === employee2Id, "6) device B's event is correctly attributed to employee2, not device A's old context");
    }

    // ===================================================================
    // SCENARIO 7: a manual Inputs correction and an unrelated later
    // device sync — the correction must survive untouched. Uses a THIRD,
    // fresh employee/device pair so this scenario's own timeline can't be
    // polluted by any of the scenarios above.
    // ===================================================================
    {
      const correctionEmployeeId = await makeEmployee("Correction", "Employee");
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        correctionEmployeeId,
        groupId,
      ]);
      const device = await makeDevice("Correction", correctionEmployeeId);

      const shiftStart = new Date(Date.now() - 4 * 60 * 60 * 1000);
      const workStart = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: shiftStart.toISOString(),
        activityId,
        answers: null,
      };
      const endDay = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "end_day",
        occurredAtUtc: new Date(shiftStart.getTime() + 3 * 60 * 60 * 1000).toISOString(), // worked 3 hours
      };
      await sync(device.identifier, [workStart, endDay]);

      const completedEntry = await pool.query(
        `select id, started_at, ended_at from time_entries where employee_id = $1 and entry_type = 'work' order by started_at desc limit 1`,
        [correctionEmployeeId]
      );
      const entryId = completedEntry.rows[0].id;
      const originalEndedAt = completedEntry.rows[0].ended_at;

      // Admin corrects the end time (the employee actually worked 15 more
      // minutes than the device recorded).
      const correctedEnd = new Date(new Date(originalEndedAt).getTime() + 15 * 60 * 1000);
      const correctionRes = await callAdmin("PATCH", `/api/inputs/activity-runs/${entryId}/end-time`, adminToken, {
        endTime: correctedEnd.toISOString(),
      });
      check(correctionRes.status === 200, "7) admin correction succeeds", correctionRes.body);

      // An UNRELATED later sync from the same device for a NEW day —
      // must not touch the corrected entry at all (openEntry only ever
      // acts on the currently-OPEN row, and this employee has nothing
      // open right now).
      const nextDayStart = {
        clientEventId: randomUUID(),
        deviceSeq: 3,
        eventType: "work_start",
        occurredAtUtc: new Date().toISOString(),
        activityId,
        answers: null,
      };
      const rNextDay = await sync(device.identifier, [nextDayStart]);
      check(rNextDay.body?.results?.[0]?.status === "accepted", "7) the next unrelated sync applies normally", rNextDay.body);

      const entryAfter = await pool.query(`select ended_at from time_entries where id = $1`, [entryId]);
      check(
        new Date(entryAfter.rows[0].ended_at).getTime() === correctedEnd.getTime(),
        "7) the manually corrected end time survives an unrelated later sync completely untouched",
        { expected: correctedEnd.toISOString(), actual: entryAfter.rows[0].ended_at }
      );
    }
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activity_questions where id = any($1::uuid[])`, [[rowQuestionId].filter(Boolean)]);
      await client.query(`delete from activities where id = any($1::uuid[])`, [[activityId, rowActivityId].filter(Boolean)]);
      if (groupId) await client.query(`delete from activity_groups where id = $1`, [groupId]);
      await client.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [[rowId].filter(Boolean)]);
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

    const leftover = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    check(Number(leftover.rows[0].count) === 0, "Z) all QA fixtures cleaned up, none left orphaned");

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
