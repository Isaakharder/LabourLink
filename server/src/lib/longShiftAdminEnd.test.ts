// Integration test for the Dashboard "End Work" admin action
// (longShiftAdminEnd.ts) — real router/lib functions over the real
// database, RUN_ID-suffixed disposable QA fixtures, retry-then-fail
// cleanup in a `finally` block regardless of pass/fail (same convention as
// midnightCutoff.test.ts — see that file's own header for why a silent
// catch here is exactly how the 2026-08-31 QA-fixture leak happened).
//
// Covers: working, on break, a custom historical end time, an exact-now
// end, a shift already closed by the automatic midnight cutoff (reconciled
// first, then correcting the assumed boundary rather than an open row),
// duplicate clicks, a genuinely concurrent device action, an already-ended
// employee, an invalid end time (before shift start, and overlapping
// another entry), the audit correction's exact shape, and a stale offline
// event arriving after the admin action or after a midnight cutoff (must go
// to Sync Conflicts, must not reopen).
//
// Run with: npm run test:long-shift-admin-end
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { endLongOpenShift, LongShiftAdminEndError, LONG_SHIFT_ADMIN_END_REASON } from "./longShiftAdminEnd";
import { MIDNIGHT_CUTOFF_REASON } from "./midnightCutoff";
import mobileTimeRouter from "../routes/mobileTime";
import { addDaysToDateStr, calendarDateInAppTimezone, zonedWallTimeToUtc } from "./timezone";

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

  async function callMobile(method: string, path: string, deviceIdentifier: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const timeEntryIds: string[] = [];
  const activityIds: string[] = [];
  let activityGroupId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const adminRoleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string, roleId: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`AdminEnd-${label}-${RUN_ID}`, `qa-adminend-${label.toLowerCase()}-${RUN_ID}@test.local`, roleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertDevice(employeeId: string, label: string): Promise<{ deviceRowId: string; deviceIdentifier: string }> {
      const deviceIdentifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [deviceIdentifier, `QA AdminEnd Device ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return { deviceRowId: rows[0].id, deviceIdentifier };
    }

    const adminId = await insertEmployee("Admin", adminRoleId);

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA AdminEnd Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    // validateActivityAndAnswers (activitySelection.ts) requires the
    // activity to reach the employee through an active activity group
    // assignment — needed for test 11's real sync-event HTTP calls to pass
    // activity validation at all.
    activityGroupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA AdminEnd Group ${RUN_ID}`])
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [activityGroupId, activityId]);

    let fixtureCounter = 0;
    async function freshFixture(label: string): Promise<{ employeeId: string; deviceRowId: string; deviceIdentifier: string }> {
      fixtureCounter++;
      const employeeId = await insertEmployee(`${label}${fixtureCounter}`, employeeRoleId);
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        employeeId,
        activityGroupId,
      ]);
      const { deviceRowId, deviceIdentifier } = await insertDevice(employeeId, `${label}${fixtureCounter}`);
      return { employeeId, deviceRowId, deviceIdentifier };
    }

    async function insertOpenEntry(opts: {
      employeeId: string;
      deviceId: string;
      entryType: "work" | "break";
      activityId?: string | null;
      startedAt: Date;
    }): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
         values ($1, $2, $3, $4, $5, $6, 'manual') returning id`,
        [opts.employeeId, opts.deviceId, opts.entryType, opts.activityId ?? null, randomUUID(), opts.startedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    function hoursAgo(h: number): Date {
      return new Date(Date.now() - h * 60 * 60 * 1000);
    }
    // Local-calendar-aware, not naive UTC-date arithmetic — see
    // midnightCutoff.test.ts's own copy of this fix for why a plain
    // setUTCDate offset drifts a day whenever the test happens to run while
    // UTC and APP_TIMEZONE disagree on what day it is.
    function daysAgo(n: number, hour: number): Date {
      const todayLocal = calendarDateInAppTimezone(new Date());
      const targetLocal = addDaysToDateStr(todayLocal, -n);
      const [y, mo, d] = targetLocal.split("-").map(Number);
      return zonedWallTimeToUtc(y, mo, d, hour, 0, 0);
    }

    async function fetchEntry(id: string) {
      const { rows } = await pool.query(
        `select id, entry_type, started_at, ended_at, actual_ended_at, rollover_of_entry_id, source from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }
    async function corrections(employeeId: string, reason = LONG_SHIFT_ADMIN_END_REASON) {
      const { rows } = await pool.query(
        `select * from time_entry_corrections where employee_id = $1 and reason = $2 order by changed_at asc`,
        [employeeId, reason]
      );
      return rows;
    }

    // -----------------------------------------------------------------
    // 1) Working — ordinary case.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Working");
      const started = hoursAgo(3);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const endAt = new Date();
      const result = await endLongOpenShift(employeeId, endAt, adminId);
      check(result.status === "ended", "1) working: status is 'ended'", result);
      check(result.timeEntryId === openId, "1) working: closes the actual open entry");
      const after = await fetchEntry(openId);
      check(new Date(after.ended_at).getTime() === endAt.getTime(), "1) working: ended_at matches the confirmed time exactly");
      check(after.actual_ended_at === null, "1) working: actual_ended_at cleared/null");
    }

    // -----------------------------------------------------------------
    // 2) On break — closes the break, never resumes work, no continuation.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("OnBreak");
      const started = hoursAgo(1);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "break", startedAt: started });
      const endAt = new Date();
      const result = await endLongOpenShift(employeeId, endAt, adminId);
      check(result.status === "ended" && result.entryType === "break", "2) on break: closes the break entry, reports entryType break", result);
      const { rows: allEntries } = await pool.query(`select id, entry_type from time_entries where employee_id = $1`, [employeeId]);
      check(allEntries.length === 1, "2) on break: no replacement/continuation entry was created", allEntries);
    }

    // -----------------------------------------------------------------
    // 3) Custom historical end time — no rounding applied.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Historical");
      const started = hoursAgo(5);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      // A deliberately odd, non-rounded instant inside the shift window.
      const historicalEnd = new Date(started.getTime() + 90 * 60 * 1000 + 37 * 1000);
      const result = await endLongOpenShift(employeeId, historicalEnd, adminId);
      check(result.status === "ended", "3) historical: accepted");
      const after = await fetchEntry(openId);
      check(
        new Date(after.ended_at).getTime() === historicalEnd.getTime(),
        "3) historical: ended_at is the EXACT admin-entered instant, never rounded",
        { got: after.ended_at, expected: historicalEnd.toISOString() }
      );
    }

    // -----------------------------------------------------------------
    // 4) Exact-now end.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("ExactNow");
      const started = hoursAgo(2);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const now = new Date();
      const result = await endLongOpenShift(employeeId, now, adminId);
      check(result.status === "ended", "4) exact-now: accepted");
      const after = await fetchEntry(openId);
      check(new Date(after.ended_at).getTime() === now.getTime(), "4) exact-now: ended_at matches exactly");
    }

    // -----------------------------------------------------------------
    // 5) A stale open shift — reconciled first, meaning it's already
    //    midnight-cutoff-closed by the time End Work's own logic runs. End
    //    Work then corrects THAT entry's assumed boundary to the admin's
    //    real time (never a separate rolled-forward segment — there is no
    //    such thing anymore), leaving exactly one row, two audit
    //    corrections (the midnight cutoff, then the admin correction).
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Midnight");
      const started = daysAgo(2, 9); // stale by 2 real local midnights
      const originalId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const endAt = new Date();
      const result = await endLongOpenShift(employeeId, endAt, adminId);
      check(result.status === "ended", "5) stale shift: accepted", result);
      check(result.timeEntryId === originalId, "5) corrects the SAME entry midnight cutoff already closed — no separate segment exists");
      check(new Date(result.endedAtIso).getTime() === endAt.getTime(), "5) the entry's end time is now the admin-confirmed instant");

      const { rows: allRows } = await pool.query(`select id, ended_at from time_entries where employee_id = $1`, [employeeId]);
      check(allRows.length === 1, "5) exactly one row exists — midnight cutoff never created a continuation to reconcile", allRows.length);
      check(new Date(allRows[0].ended_at).getTime() === endAt.getTime(), "5) that one row's ended_at matches the admin's confirmed time");

      const { rows: corrections } = await pool.query(
        `select reason, changed_by_employee_id from time_entry_corrections where time_entry_id = $1 order by changed_at asc`,
        [originalId]
      );
      check(corrections.length === 2, "5) two audit corrections exist: the midnight cutoff, then the admin fix", corrections);
      check(corrections[0]?.reason === MIDNIGHT_CUTOFF_REASON && corrections[0]?.changed_by_employee_id === null, "5) first correction is the system midnight cutoff");
      check(
        corrections[1]?.reason === LONG_SHIFT_ADMIN_END_REASON && corrections[1]?.changed_by_employee_id === adminId,
        "5) second correction is the admin's End Work fix, attributed to them"
      );
      timeEntryIds.push(originalId);
    }

    // -----------------------------------------------------------------
    // 6) Duplicate clicks — sequential retries are idempotent.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Dup");
      const started = hoursAgo(4);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const endAt = new Date();
      const first = await endLongOpenShift(employeeId, endAt, adminId);
      const second = await endLongOpenShift(employeeId, new Date(endAt.getTime() + 5000), adminId); // even a slightly different re-entered time
      check(first.status === "ended", "6) duplicate clicks: first call ends the shift");
      check(second.status === "already_finished", "6) duplicate clicks: second call reports already_finished, not another end", second);
      check(second.timeEntryId === first.timeEntryId, "6) duplicate clicks: same entry reported both times");
      check(second.endedAtIso === first.endedAtIso, "6) duplicate clicks: the ALREADY-recorded end time is returned, not the second call's input", {
        first: first.endedAtIso,
        second: second.endedAtIso,
      });
      const corr = await corrections(employeeId);
      check(corr.length === 1, "6) duplicate clicks: exactly one audit correction exists, not two", corr.length);
    }

    // -----------------------------------------------------------------
    // 7) Concurrent device action — a genuine race, not just sequential
    //    retries — exactly one 'ended', one 'already_finished', same entry,
    //    exactly one correction.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Race");
      const started = hoursAgo(3);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const [r1, r2] = await Promise.all([
        endLongOpenShift(employeeId, new Date(), adminId),
        endLongOpenShift(employeeId, new Date(), adminId),
      ]);
      const statuses = [r1.status, r2.status].sort();
      check(
        statuses[0] === "already_finished" && statuses[1] === "ended",
        "7) concurrent: exactly one 'ended' and one 'already_finished' out of a real race",
        statuses
      );
      check(r1.timeEntryId === r2.timeEntryId && r1.timeEntryId === openId, "7) concurrent: both report the same entry");
      const corr = await corrections(employeeId);
      check(corr.length === 1, "7) concurrent: exactly one audit correction survives the race", corr.length);
    }

    // -----------------------------------------------------------------
    // 8) Already-ended employee — the entry was closed by some OTHER path
    //    (the employee's own device) before End Work was ever called.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("AlreadyEnded");
      const started = hoursAgo(6);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const employeeEndedAt = new Date(started.getTime() + 5 * 60 * 60 * 1000);
      await pool.query(`update time_entries set ended_at = $2 where id = $1`, [openId, employeeEndedAt]);

      const result = await endLongOpenShift(employeeId, new Date(), adminId);
      check(result.status === "already_finished", "8) already-ended: reports already_finished, no error", result);
      check(result.timeEntryId === openId, "8) already-ended: reports the entry the employee's own device closed");
      check(
        new Date(result.endedAtIso).getTime() === employeeEndedAt.getTime(),
        "8) already-ended: reports the employee's own real end time, not admin's attempted one"
      );
      const corr = await corrections(employeeId);
      check(corr.length === 0, "8) already-ended: no admin correction written for a shift admin never actually closed", corr.length);
    }

    // -----------------------------------------------------------------
    // 9) Invalid end time — before shift start, and overlapping another entry.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("InvalidBefore");
      const started = hoursAgo(2);
      await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      let threw = false;
      try {
        await endLongOpenShift(employeeId, new Date(started.getTime() - 60 * 1000), adminId);
      } catch (err) {
        threw = err instanceof LongShiftAdminEndError;
        check(
          threw && /after this shift's true start/.test((err as Error).message),
          "9a) invalid end time: rejects a time before the shift's true start with a clear message",
          err instanceof Error ? err.message : err
        );
      }
      check(threw, "9a) invalid end time: throws LongShiftAdminEndError");
      const { rows: stillOpen } = await pool.query(`select id from time_entries where employee_id = $1 and ended_at is null`, [employeeId]);
      check(stillOpen.length === 1, "9a) invalid end time: the entry is left untouched (still open) after rejection");
    }
    {
      const { employeeId, deviceRowId } = await freshFixture("InvalidOverlap");
      const started = hoursAgo(2);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      // A second, already-closed entry that starts 30 minutes from now —
      // any proposed end time reaching that far forward overlaps it.
      // Inserted already-closed in one statement (not insertOpenEntry then
      // update): a second OPEN row for the same employee would collide with
      // idx_time_entries_one_open_per_employee before this test ever gets
      // to exercise the overlap check itself.
      const futureStart = new Date(Date.now() + 30 * 60 * 1000);
      const futureEnd = new Date(Date.now() + 90 * 60 * 1000);
      const overlapRes = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, $2, 'work', $3, $4, $5, $6, 'manual') returning id`,
        [employeeId, deviceRowId, activityId, randomUUID(), futureStart, futureEnd]
      );
      timeEntryIds.push(overlapRes.rows[0].id);

      let threw = false;
      try {
        await endLongOpenShift(employeeId, new Date(Date.now() + 60 * 60 * 1000), adminId);
      } catch (err) {
        threw = err instanceof LongShiftAdminEndError;
        check(
          threw && /overlaps another time entry/.test((err as Error).message),
          "9b) invalid end time: rejects a time that overlaps another entry with a clear message",
          err instanceof Error ? err.message : err
        );
      }
      check(threw, "9b) invalid end time: throws LongShiftAdminEndError");
      // Clean close for teardown symmetry (not part of the assertion).
      await pool.query(`update time_entries set ended_at = now() where id = $1 and ended_at is null`, [openId]);
    }

    // -----------------------------------------------------------------
    // 10) Audit creation — exact shape of the correction row.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Audit");
      const started = hoursAgo(1);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const endAt = new Date();
      await endLongOpenShift(employeeId, endAt, adminId);
      const corr = await corrections(employeeId);
      check(corr.length === 1, "10) audit: exactly one correction row created");
      const c = corr[0];
      check(c.time_entry_id === openId, "10) audit: correction references the correct time entry");
      check(c.changed_by_employee_id === adminId, "10) audit: changed_by_employee_id is the acting administrator, never null");
      check(c.field_name === "ended_at", "10) audit: field_name is ended_at");
      check(c.old_value === "null", "10) audit: old_value recorded as null (the entry was open)");
      check(
        new Date(c.new_value).getTime() === endAt.getTime(),
        "10) audit: new_value is the exact confirmed end time"
      );
      check(c.reason === LONG_SHIFT_ADMIN_END_REASON, "10) audit: reason is long_shift_admin_end");
    }

    // -----------------------------------------------------------------
    // 11) Stale offline events after End Work — go to Sync Conflicts,
    //     never reopen the ended shift; a genuinely LATER event is
    //     unaffected (negative control).
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId, deviceIdentifier } = await freshFixture("StaleSync");
      const started = hoursAgo(4);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const endAt = new Date(started.getTime() + 3 * 60 * 60 * 1000); // ends 3h into the 4h-old shift
      await endLongOpenShift(employeeId, endAt, adminId);

      // A queued offline activity_switch whose real occurrence time is
      // BEFORE the admin's confirmed end — simulates a phone that had this
      // tap sitting in its local queue before the admin acted, only
      // syncing afterward.
      const staleOccurred = new Date(endAt.getTime() - 30 * 60 * 1000);
      const staleRes = await callMobile("POST", "/api/mobile/sync/events", deviceIdentifier, {
        events: [
          {
            clientEventId: randomUUID(),
            deviceSeq: 1,
            eventType: "activity_switch",
            occurredAtUtc: staleOccurred.toISOString(),
            activityId,
          },
        ],
      });
      check(staleRes.status === 200, "11) stale event: sync request itself succeeds (200)", staleRes.body);
      const { rows: staleMte } = await pool.query(
        `select processing_status, conflict_reason from mobile_time_events where employee_id = $1 order by received_at desc limit 1`,
        [employeeId]
      );
      check(
        staleMte[0]?.processing_status === "permanent_conflict" && /administrator ended this shift/.test(staleMte[0]?.conflict_reason ?? ""),
        "11) stale event: recorded as permanent_conflict with a clear reason, surfaced to Sync Conflicts",
        staleMte[0]
      );
      const { rows: stillOpenAfterStale } = await pool.query(`select id from time_entries where employee_id = $1 and ended_at is null`, [
        employeeId,
      ]);
      check(stillOpenAfterStale.length === 0, "11) stale event: never reopened the ended shift — still nothing open", stillOpenAfterStale);

      // Negative control: a genuinely LATER event (after the admin's end)
      // is a real new shift starting and must be accepted normally.
      const laterOccurred = new Date(endAt.getTime() + 60 * 60 * 1000);
      const laterRes = await callMobile("POST", "/api/mobile/sync/events", deviceIdentifier, {
        events: [
          {
            clientEventId: randomUUID(),
            deviceSeq: 2,
            eventType: "work_start",
            occurredAtUtc: laterOccurred.toISOString(),
            activityId,
          },
        ],
      });
      check(laterRes.status === 200, "11) later event: sync request succeeds", laterRes.body);
      const { rows: laterMte } = await pool.query(
        `select processing_status, time_entry_id, conflict_reason from mobile_time_events where employee_id = $1 order by received_at desc limit 1`,
        [employeeId]
      );
      check(
        laterMte[0]?.processing_status === "accepted",
        "11) later event: a genuine new shift AFTER the admin's end is accepted normally (negative control)",
        laterMte[0]
      );
      if (laterMte[0]?.time_entry_id) timeEntryIds.push(laterMte[0].time_entry_id);
    }

    // -----------------------------------------------------------------
    // 12) Recovering a multi-day-stale entry the automatic midnight cutoff
    //     already closed: End Work must correct an entry that's already
    //     CLOSED with a midnight_cutoff correction, not just an open one —
    //     the admin recovery path for a shift the automatic mechanism
    //     closed at its assumed (not necessarily true) boundary. Unlike
    //     scenario 5 (single midnight late), this fixture is multiple days
    //     stale, confirming the same correction path scales to any age.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("CutoffRecover");
      const trueStart = hoursAgo(100); // well past any real single shift
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: trueStart });
      const assumedCutoff = new Date(trueStart.getTime() + 24 * 60 * 60 * 1000); // its own first local midnight
      await pool.query(`update time_entries set ended_at = $2 where id = $1`, [openId, assumedCutoff]);
      await pool.query(
        `insert into time_entry_corrections
           (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, null, 'ended_at', 'null', $3, $4)`,
        [openId, employeeId, assumedCutoff.toISOString(), MIDNIGHT_CUTOFF_REASON]
      );

      const realEndTime = new Date(trueStart.getTime() + 9 * 60 * 60 * 1000); // the actual true end, an ordinary shift length
      const result = await endLongOpenShift(employeeId, realEndTime, adminId);
      check(result.status === "ended", "12) End Work reports 'ended', not 'already_finished', for a midnight-cutoff-closed entry", result);
      check(result.timeEntryId === openId, "12) End Work targets the midnight-cutoff-closed entry itself");

      const after12 = await fetchEntry(openId);
      check(
        new Date(after12.ended_at).getTime() === realEndTime.getTime(),
        "12) the assumed cutoff time is replaced with the administrator's real end time"
      );

      const correctionsAfter12 = await corrections(employeeId, LONG_SHIFT_ADMIN_END_REASON);
      check(correctionsAfter12.length === 1, "12) exactly one long_shift_admin_end correction is recorded for the recovery");
      check(
        correctionsAfter12[0]?.old_value === new Date(assumedCutoff).toISOString(),
        "12) the correction's old_value is the PREVIOUS (assumed) end time, not 'null' — this was a real edit, not a fresh close",
        correctionsAfter12[0]?.old_value
      );

      // Idempotency: calling End Work again now hits the ordinary
      // already-finished path (no midnight_cutoff correction is the most
      // recent anymore), never re-corrects.
      const result2 = await endLongOpenShift(employeeId, realEndTime, adminId);
      check(result2.status === "already_finished", "12) a second End Work call now reports already_finished, the ordinary idempotent path");
      const correctionsAfterSecond = await corrections(employeeId, LONG_SHIFT_ADMIN_END_REASON);
      check(correctionsAfterSecond.length === 1, "12) still exactly one correction — the second call wrote nothing new");
    }

    // -----------------------------------------------------------------
    // 13) A late offline event dated before an automatic midnight cutoff's
    //     boundary must go to Sync Conflicts, never reopen the shift — same
    //     guard as admin End Work (test 11), now also covering the
    //     automatic mechanism.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId, deviceIdentifier } = await freshFixture("CutoffSync");
      const trueStart = hoursAgo(80);
      const openId = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: trueStart });
      const cutoffAt = new Date(trueStart.getTime() + 24 * 60 * 60 * 1000);
      await pool.query(`update time_entries set ended_at = $2 where id = $1`, [openId, cutoffAt]);
      await pool.query(
        `insert into time_entry_corrections
           (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, null, 'ended_at', 'null', $3, $4)`,
        [openId, employeeId, cutoffAt.toISOString(), MIDNIGHT_CUTOFF_REASON]
      );

      const staleOccurred13 = new Date(cutoffAt.getTime() - 30 * 60 * 1000);
      const staleRes13 = await callMobile("POST", "/api/mobile/sync/events", deviceIdentifier, {
        events: [
          { clientEventId: randomUUID(), deviceSeq: 1, eventType: "activity_switch", occurredAtUtc: staleOccurred13.toISOString(), activityId },
        ],
      });
      check(staleRes13.status === 200, "13) stale event: sync request itself succeeds (200)", staleRes13.body);
      const { rows: staleMte13 } = await pool.query(
        `select processing_status, conflict_reason from mobile_time_events where employee_id = $1 order by received_at desc limit 1`,
        [employeeId]
      );
      check(
        staleMte13[0]?.processing_status === "permanent_conflict" && /the midnight cutoff ended this shift/.test(staleMte13[0]?.conflict_reason ?? ""),
        "13) stale event before an automatic midnight cutoff: permanent_conflict, with wording distinguishing it from an admin End Work",
        staleMte13[0]
      );
      const { rows: stillOpenAfterStale13 } = await pool.query(`select id from time_entries where employee_id = $1 and ended_at is null`, [
        employeeId,
      ]);
      check(stillOpenAfterStale13.length === 0, "13) the automatically-closed shift is never reopened by the stale event");

      // Negative control: a genuinely later event is a real new shift.
      const laterOccurred13 = new Date(cutoffAt.getTime() + 60 * 60 * 1000);
      const laterRes13 = await callMobile("POST", "/api/mobile/sync/events", deviceIdentifier, {
        events: [{ clientEventId: randomUUID(), deviceSeq: 2, eventType: "work_start", occurredAtUtc: laterOccurred13.toISOString(), activityId }],
      });
      const { rows: laterMte13 } = await pool.query(
        `select processing_status, time_entry_id from mobile_time_events where employee_id = $1 order by received_at desc limit 1`,
        [employeeId]
      );
      check(
        laterMte13[0]?.processing_status === "accepted",
        "13) a genuinely later event after the automatic cutoff is accepted normally (negative control)",
        laterMte13[0]
      );
      if (laterMte13[0]?.time_entry_id) timeEntryIds.push(laterMte13[0].time_entry_id);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      const maxAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await fn();
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
      fail++;
      console.error(`FAIL: cleanup step "${label}" failed after ${maxAttempts} attempts:`, lastErr);
    }

    if (timeEntryIds.length) {
      await tryDelete("time_entry_corrections (by time_entry)", () =>
        pool.query(`delete from time_entry_corrections where time_entry_id = any($1::uuid[])`, [timeEntryIds])
      );
    }
    if (employeeIds.length) {
      await tryDelete("employee_activity_group_assignments", () =>
        pool.query(`delete from employee_activity_group_assignments where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entry_corrections (by employee)", () =>
        pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("mobile_time_events", () => pool.query(`delete from mobile_time_events where employee_id = any($1::uuid[])`, [employeeIds]));
      await tryDelete("device_sync_state", () =>
        pool.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds])
      );
      await tryDelete("time_entries (by employee)", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (activityGroupId) {
      await tryDelete("activity_group_activities", () =>
        pool.query(`delete from activity_group_activities where activity_group_id = $1`, [activityGroupId])
      );
      await tryDelete("activity_groups", () => pool.query(`delete from activity_groups where id = $1`, [activityGroupId]));
    }
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
