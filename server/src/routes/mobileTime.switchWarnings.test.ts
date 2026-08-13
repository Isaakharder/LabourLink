// Integration tests for the same-row-recently-completed and minimum-
// duration switch warnings added to POST /api/mobile/time-entries/work (see
// getCurrentWorkSegment + the isRealSwitch block in mobileTime.ts). Same
// convention as the other route integration tests in this directory: real
// router over real HTTP against the real database, RUN_ID-suffixed
// disposable QA fixtures, cleanup as one transaction with a final
// "nothing orphaned" assertion.
//
// Covers: normal switch with no warning (fresh start), minimum-duration
// conflict + confirmSwitch override, same-row-recently-completed conflict +
// confirmSwitch override, priority (both conditions true at once — only
// same-row is reported, and a single confirmSwitch resolves both, never a
// second dialog), and a 0-minute-minimum current activity as the practical
// "at/above the boundary never warns" case (see nfcSwitchWarning.test.ts on
// the client for the precise elapsed === minimum boundary, which isn't
// practical to hit here without sleeping in real wall-clock seconds).
//
// Also covers the same set of guarantees for a carrier ("bin") change on a
// dual row+carrier activity (the NFC active-screen scan feature's server
// side — see nfcActiveScreenScan.ts on the client): minimum-duration and
// same-row-recently-completed both apply to a carrier-only change exactly
// as they do to a row change (the switch guard compares row and carrier
// together, generically), an inactive carrierId is a hard 400 validation
// failure rather than a switch warning, and a literal retry of the same
// idempotencyKey never creates a duplicate segment.
//
// Run with: npm run test:mobile-time-switch-warnings
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

  async function call(path: string, deviceIdentifier: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let groupId!: string;
  let activity15Id!: string; // requires 15 min minimum
  let activity0Id!: string; // 0 min minimum — a practical "never warns" boundary case
  let questionId15!: string;
  let questionId0!: string;
  let landId!: string;
  let phaseId!: string;
  let rowAId!: string;
  let rowBId!: string;
  let rowCId!: string;
  let rowDId!: string;
  let rowEId!: string;
  // Dual-question activity (row + carrier both required, 15-minute
  // minimum) — the same shape as "Picking Peppers" from the NFC scan
  // feature, since a carrier-only switch has to run through the exact same
  // switch-guard block a row switch does (see the isRealSwitch check in
  // mobileTime.ts, which compares row AND carrier together, generically).
  let activityRowCarrierId!: string;
  let questionIdRowCarrierRow!: string;
  let questionIdRowCarrierCarrier!: string;
  let carrierAId!: string;
  let carrierBId!: string;
  let carrierInactiveId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    const employee = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        ["QA", `Switch Warnings ${RUN_ID}`, `qa-switch-warnings-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(employee.id);

    const deviceIdentifier = randomUUID();
    const deviceRow = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        deviceIdentifier,
        `QA Switch Warnings Device ${RUN_ID}`,
      ])
    ).rows[0];
    deviceIds.push(deviceRow.id);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRow.id, employee.id]);

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA Switch Warnings Group ${RUN_ID}`,
      ])
    ).rows[0].id;

    activity15Id = (
      await pool.query(
        `insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 15) returning id`,
        [`QA Switch Warnings Activity15 ${RUN_ID}`]
      )
    ).rows[0].id;
    activity0Id = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Switch Warnings Activity0 ${RUN_ID}`,
      ])
    ).rows[0].id;

    questionId15 = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [activity15Id]
      )
    ).rows[0].id;
    questionId0 = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [activity0Id]
      )
    ).rows[0].id;

    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`, [
      groupId,
      activity15Id,
      activity0Id,
    ]);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
      employee.id,
      groupId,
    ]);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [
        `QA Switch Warnings Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`,
        [landId, `QA Switch Warnings Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    async function makeRow(n: number) {
      return (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
           values ($1, $2, 0, 0, 4, 50, 'vertical') returning id`,
          [phaseId, n]
        )
      ).rows[0].id as string;
    }
    rowAId = await makeRow(1);
    rowBId = await makeRow(2);
    rowCId = await makeRow(3);
    rowDId = await makeRow(4);
    rowEId = await makeRow(5);

    activityRowCarrierId = (
      await pool.query(
        `insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 15) returning id`,
        [`QA Switch Warnings ActivityRowCarrier ${RUN_ID}`]
      )
    ).rows[0].id;
    questionIdRowCarrierRow = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [activityRowCarrierId]
      )
    ).rows[0].id;
    questionIdRowCarrierCarrier = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'carrier', 'Which bin?', true, 1) returning id`,
        [activityRowCarrierId]
      )
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [
      groupId,
      activityRowCarrierId,
    ]);

    carrierAId = (
      await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA Bin A ${RUN_ID}`])
    ).rows[0].id;
    carrierBId = (
      await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA Bin B ${RUN_ID}`])
    ).rows[0].id;
    carrierInactiveId = (
      await pool.query(`insert into carriers (name, is_active) values ($1, false) returning id`, [`QA Bin Inactive ${RUN_ID}`])
    ).rows[0].id;

    function answersFor(questionId: string, rowId: string) {
      return [{ questionId, greenhouseRowId: rowId }];
    }

    // -----------------------------------------------------------------
    // A) fresh start (idle -> work) never warns, regardless of minimum
    //    duration — nothing is being interrupted.
    // -----------------------------------------------------------------
    const start = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activity15Id,
      idempotencyKey: randomUUID(),
      answers: answersFor(questionId15, rowAId),
    });
    check(start.status === 200, "A) fresh work start on the 15-minute-minimum activity succeeds with no warning", start);

    // -----------------------------------------------------------------
    // B) switching to a different row on the SAME activity, seconds after
    //    starting, is well under the 15-minute minimum — rejected with
    //    MINIMUM_DURATION_NOT_REACHED, not silently switched.
    // -----------------------------------------------------------------
    const underMinimum = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activity15Id,
      idempotencyKey: randomUUID(),
      answers: answersFor(questionId15, rowBId),
    });
    check(
      underMinimum.status === 409 && underMinimum.body?.code === "MINIMUM_DURATION_NOT_REACHED",
      "B) switching rows seconds after starting is rejected with MINIMUM_DURATION_NOT_REACHED",
      underMinimum
    );
    check(
      typeof underMinimum.body?.elapsedSeconds === "number" && underMinimum.body.elapsedSeconds < 60,
      "C) the conflict reports a small actual elapsedSeconds",
      underMinimum.body
    );
    check(underMinimum.body?.minimumMinutes === 15, "D) the conflict reports the activity's configured minimum (15)", underMinimum.body);

    // -----------------------------------------------------------------
    // E) confirming the switch (confirmSwitch: true) bypasses the warning
    //    and actually performs the switch to row B.
    // -----------------------------------------------------------------
    const confirmedSwitch = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activity15Id,
      idempotencyKey: randomUUID(),
      answers: answersFor(questionId15, rowBId),
      confirmSwitch: true,
    });
    check(
      confirmedSwitch.status === 200 && confirmedSwitch.body?.currentActivity?.row?.id === rowBId,
      "E) confirmSwitch bypasses the minimum-duration warning and switches to row B",
      confirmedSwitch.body
    );

    // -----------------------------------------------------------------
    // F) row A was just completed (closed by step E's switch to row B).
    //    Switching back to (activity15, rowA) now is BOTH the just-
    //    completed pair AND seconds under activity15's own 15-minute
    //    minimum (current is still activity15, on row B) — both
    //    conditions genuinely true at once. Only SAME_ROW_RECENTLY_
    //    COMPLETED is ever returned (priority order: same-row is checked
    //    before minimum-duration, and the two are never stacked into two
    //    dialogs for one attempt).
    // -----------------------------------------------------------------
    const sameRowAndUnderMinimum = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activity15Id,
      idempotencyKey: randomUUID(),
      answers: answersFor(questionId15, rowAId),
    });
    check(
      sameRowAndUnderMinimum.status === 409 && sameRowAndUnderMinimum.body?.code === "SAME_ROW_RECENTLY_COMPLETED",
      "F) when both conditions are true at once, only SAME_ROW_RECENTLY_COMPLETED is returned (priority order)",
      sameRowAndUnderMinimum.body
    );

    // -----------------------------------------------------------------
    // G) confirming resolves the same-row warning in one request — no
    //    second (minimum-duration) dialog required for this same scan,
    //    even though that condition was also true.
    // -----------------------------------------------------------------
    const confirmedSameRow = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activity15Id,
      idempotencyKey: randomUUID(),
      answers: answersFor(questionId15, rowAId),
      confirmSwitch: true,
    });
    check(
      confirmedSameRow.status === 200 && confirmedSameRow.body?.currentActivity?.row?.id === rowAId,
      "G) confirmSwitch resolves the same-row warning and performs the switch back to row A",
      confirmedSameRow.body
    );

    // -----------------------------------------------------------------
    // H) a 0-minute-minimum CURRENT activity never warns on duration, no
    //    matter how soon the next switch happens — the practical
    //    "at/above the boundary never warns" case (see
    //    nfcSwitchWarning.test.ts for the exact elapsed === minimum
    //    boundary, tested at the pure-function level). Move onto
    //    activity0 first (confirmSwitch bypasses activity15's own
    //    still-unmet minimum on the way out), then switch again
    //    immediately with no confirmSwitch at all.
    // -----------------------------------------------------------------
    const ontoZeroMinuteActivity = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activity0Id,
      idempotencyKey: randomUUID(),
      answers: answersFor(questionId0, rowCId),
      confirmSwitch: true,
    });
    check(ontoZeroMinuteActivity.status === 200, "H1) switching onto the 0-minute-minimum activity succeeds", ontoZeroMinuteActivity.body);

    const zeroMinuteSwitch = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activity0Id,
      idempotencyKey: randomUUID(),
      answers: answersFor(questionId0, rowDId),
    });
    check(
      zeroMinuteSwitch.status === 200,
      "H2) switching again immediately, while the current activity's own minimum is 0, never triggers a warning",
      zeroMinuteSwitch.body
    );

    // -----------------------------------------------------------------
    // Carrier ("bin") switching on a dual row+carrier activity — the NFC
    // active-screen scan feature's server-side contract: a carrier-only
    // change goes through the exact same switch-guard/idempotency
    // machinery a row change does, not a separate, weaker path.
    // -----------------------------------------------------------------
    function answersForRowAndCarrier(rowId: string, carrierId: string) {
      return [
        { questionId: questionIdRowCarrierRow, greenhouseRowId: rowId },
        { questionId: questionIdRowCarrierCarrier, carrierId },
      ];
    }

    // I) fresh start on the dual-question activity (row E, bin A) — no
    //    warning, nothing is being interrupted.
    const freshDualStart = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activityRowCarrierId,
      idempotencyKey: randomUUID(),
      answers: answersForRowAndCarrier(rowEId, carrierAId),
      confirmSwitch: true, // bypasses activity0's own still-unmet 0-minute minimum on the way out
    });
    check(
      freshDualStart.status === 200 &&
        freshDualStart.body?.currentActivity?.row?.id === rowEId &&
        freshDualStart.body?.currentActivity?.carrier?.id === carrierAId,
      "I) starting the dual row+carrier activity on row E / bin A succeeds",
      freshDualStart.body
    );

    // J) switching to a DIFFERENT bin (B) on the SAME row, seconds later,
    //    is a real switch (isRealSwitch compares row and carrier together)
    //    and is well under the 15-minute minimum — rejected exactly like a
    //    row switch would be, not silently applied just because the row
    //    itself didn't change.
    const binSwitchUnderMinimum = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activityRowCarrierId,
      idempotencyKey: randomUUID(),
      answers: answersForRowAndCarrier(rowEId, carrierBId),
    });
    check(
      binSwitchUnderMinimum.status === 409 && binSwitchUnderMinimum.body?.code === "MINIMUM_DURATION_NOT_REACHED",
      "J) switching only the bin seconds after starting is rejected with MINIMUM_DURATION_NOT_REACHED, same as a row switch",
      binSwitchUnderMinimum
    );

    // K) confirming the switch performs it — row stays E, bin becomes B.
    const binSwitchConfirmed = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activityRowCarrierId,
      idempotencyKey: randomUUID(),
      answers: answersForRowAndCarrier(rowEId, carrierBId),
      confirmSwitch: true,
    });
    check(
      binSwitchConfirmed.status === 200 &&
        binSwitchConfirmed.body?.currentActivity?.row?.id === rowEId &&
        binSwitchConfirmed.body?.currentActivity?.carrier?.id === carrierBId,
      "K) confirmSwitch bypasses the minimum-duration warning and switches to bin B, row unchanged",
      binSwitchConfirmed.body
    );

    // L) switching back to (row E, bin A) — the pair just closed by step
    //    K's switch — is SAME_ROW_RECENTLY_COMPLETED, exactly as it would
    //    be for a same-row-just-finished row switch. Confirms the "same
    //    row/bin recently completed" guard is keyed on the full
    //    (activity, row, carrier) tuple, not row alone.
    const binSameJustFinished = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activityRowCarrierId,
      idempotencyKey: randomUUID(),
      answers: answersForRowAndCarrier(rowEId, carrierAId),
    });
    check(
      binSameJustFinished.status === 409 && binSameJustFinished.body?.code === "SAME_ROW_RECENTLY_COMPLETED",
      "L) switching back to the just-finished (row, bin) pair is rejected with SAME_ROW_RECENTLY_COMPLETED",
      binSameJustFinished.body
    );

    // M) an inactive carrier is a hard validation failure (400), never a
    //    switch warning — the server independently re-validates the
    //    carrier is active regardless of what the client's own tag cache
    //    believed (see validateActivityAndAnswers), covering the case an
    //    NFC scan resolves against a stale/offline mapping cache for a bin
    //    that's since been deactivated.
    const inactiveCarrierAttempt = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activityRowCarrierId,
      idempotencyKey: randomUUID(),
      answers: answersForRowAndCarrier(rowEId, carrierInactiveId),
      confirmSwitch: true,
    });
    check(
      inactiveCarrierAttempt.status === 400 && /carrier/i.test(String(inactiveCarrierAttempt.body?.error ?? "")),
      "M) an inactive carrierId is rejected with a 400 validation error, not silently accepted or treated as a warning",
      inactiveCarrierAttempt.body
    );

    // N) idempotent retry — replaying the exact same request (same
    //    idempotencyKey) for a bin switch must not create a second
    //    segment. Confirms the "stable idempotency key per physical scan"
    //    contract holds for carrier switches, not just row switches (every
    //    earlier test in this file used a fresh idempotencyKey per call, so
    //    a literal replay was never exercised before this).
    const retryKey = randomUUID();
    const beforeRetryCount = await pool.query(
      `select count(*) from time_entries where employee_id = $1 and deleted_at is null`,
      [employeeIds[0]]
    );
    const idempotentFirst = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activityRowCarrierId,
      idempotencyKey: retryKey,
      answers: answersForRowAndCarrier(rowEId, carrierAId),
      confirmSwitch: true,
    });
    check(
      idempotentFirst.status === 200 && idempotentFirst.body?.currentActivity?.carrier?.id === carrierAId,
      "N1) the first request of an idempotent-retry pair switches to bin A",
      idempotentFirst.body
    );
    const idempotentRetry = await call("/api/mobile/time-entries/work", deviceIdentifier, {
      activityId: activityRowCarrierId,
      idempotencyKey: retryKey,
      answers: answersForRowAndCarrier(rowEId, carrierAId),
      confirmSwitch: true,
    });
    check(
      idempotentRetry.status === 200 &&
        idempotentRetry.body?.currentActivity?.carrier?.id === carrierAId &&
        idempotentRetry.body?.currentActivity?.startedAt === idempotentFirst.body?.currentActivity?.startedAt,
      "N2) replaying the identical request (same idempotencyKey) returns the same segment, not a new one",
      idempotentRetry.body
    );
    const afterRetryCount = await pool.query(
      `select count(*) from time_entries where employee_id = $1 and deleted_at is null`,
      [employeeIds[0]]
    );
    check(
      Number(afterRetryCount.rows[0].count) === Number(beforeRetryCount.rows[0].count) + 1,
      "N3) the retry created exactly one new time_entries row total, not two — no duplicate segment from the replay",
      { before: beforeRetryCount.rows[0].count, after: afterRetryCount.rows[0].count }
    );
    const dupeKeyRows = await pool.query(`select count(*) from time_entries where idempotency_key = $1`, [retryKey]);
    check(
      Number(dupeKeyRows.rows[0].count) === 1,
      "N4) exactly one time_entries row carries this idempotencyKey, confirming the replay was a true no-op insert",
      dupeKeyRows.rows[0]
    );
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activity_questions where id = any($1::uuid[])`, [
        [questionId15, questionId0, questionIdRowCarrierRow, questionIdRowCarrierCarrier].filter(Boolean),
      ]);
      await client.query(`delete from activities where id = any($1::uuid[])`, [
        [activity15Id, activity0Id, activityRowCarrierId].filter(Boolean),
      ]);
      if (groupId) await client.query(`delete from activity_groups where id = $1`, [groupId]);
      await client.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [
        [rowAId, rowBId, rowCId, rowDId, rowEId].filter(Boolean),
      ]);
      if (phaseId) await client.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      await client.query(`delete from carriers where id = any($1::uuid[])`, [
        [carrierAId, carrierBId, carrierInactiveId].filter(Boolean),
      ]);
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
      [activity15Id, activity0Id, activityRowCarrierId].filter(Boolean),
    ]);
    const leftoverCarriers = await pool.query(`select count(*) from carriers where id = any($1::uuid[])`, [
      [carrierAId, carrierBId, carrierInactiveId].filter(Boolean),
    ]);
    check(
      Number(leftoverEmployees.rows[0].count) === 0 &&
        Number(leftoverActivities.rows[0].count) === 0 &&
        Number(leftoverCarriers.rows[0].count) === 0,
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
