// Integration test for midnight cutoff (midnightCutoff.ts) — real router/lib
// functions over the real database, RUN_ID-suffixed disposable QA fixtures,
// cleanup in a `finally` block regardless of pass/fail. Same convention as
// inputs.badgeReviewConsistency.test.ts / dailyCutoff.test.ts.
//
// Covers every scenario the midnight-cutoff requirements call out: working
// through midnight, on-break through midnight, cron delay (a multi-day-old
// entry closes at ITS OWN first midnight, never "now"), concurrent
// sweep+request-time reconciliation, idempotency/retry, a rounding-enabled
// employee's exact (never-rounded) boundary, the request-time wiring
// (GET /api/mobile/me) including a real tap landing exactly at the
// boundary, explicitly clocking in again after midnight, a late offline
// sync event before the cutoff boundary going to Sync Conflicts (and never
// reopening the closed shift), full payroll/Inputs inclusion of the time up
// to midnight (no exclusion, no needs-review — a routine close is a
// confirmed boundary, never a guess), dailyCutoff's outer-fallback
// threshold, and the Long Open Shift Alert's continued correctness against
// both a plain entry and historical rollover-chain data.
//
// Run with: npm run test:midnight-cutoff
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { computeMidnightCutoffBoundary, reconcileMidnightCutoff, runMidnightCutoffSweep, MIDNIGHT_CUTOFF_REASON } from "./midnightCutoff";
import { runDailyCutoff, DAILY_CUTOFF_STALE_DAYS } from "./dailyCutoff";
import { getLongOpenShiftAlerts, getOrgSettings, setLongOpenShiftAlertThresholdHours } from "./longOpenShiftAlerts";
import { addDaysToDateStr, calendarDateInAppTimezone, getDayBoundsUtc, zonedWallTimeToUtc } from "./timezone";
import { computeWorkdayTotals } from "./workdayTotals";
import mobileTimeRouter from "../routes/mobileTime";

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

// ---------------------------------------------------------------------------
// Pure boundary math (no DB) — same DST cases dailyCutoff.test.ts already
// proves against getDayBoundsUtc directly; computeMidnightCutoffBoundary is
// that exact same primitive, reused verbatim, so this is a direct
// cross-check rather than a re-derivation.
// ---------------------------------------------------------------------------
check(
  computeMidnightCutoffBoundary("2026-08-05").toISOString() === "2026-08-06T04:00:00.000Z",
  "ordinary summer date closes at exactly the next local midnight",
  computeMidnightCutoffBoundary("2026-08-05").toISOString()
);
check(
  computeMidnightCutoffBoundary("2026-03-07").toISOString() === "2026-03-08T05:00:00.000Z",
  "day before spring-forward uses the pre-DST (EST/UTC-5) offset",
  computeMidnightCutoffBoundary("2026-03-07").toISOString()
);
check(
  computeMidnightCutoffBoundary("2026-03-08").toISOString() === "2026-03-09T04:00:00.000Z",
  "spring-forward day itself uses the post-DST (EDT/UTC-4) offset",
  computeMidnightCutoffBoundary("2026-03-08").toISOString()
);
check(
  computeMidnightCutoffBoundary("2026-10-31").toISOString() === "2026-11-01T04:00:00.000Z",
  "day before fall-back uses the pre-transition (EDT/UTC-4) offset",
  computeMidnightCutoffBoundary("2026-10-31").toISOString()
);
check(
  computeMidnightCutoffBoundary("2026-11-01").toISOString() === "2026-11-02T05:00:00.000Z",
  "fall-back day itself uses the post-transition (EST/UTC-5) offset",
  computeMidnightCutoffBoundary("2026-11-01").toISOString()
);
for (const d of ["2026-01-01", "2026-06-15", "2026-12-31", "2026-03-08", "2026-11-01"]) {
  check(
    computeMidnightCutoffBoundary(d).getTime() === getDayBoundsUtc(d).end.getTime(),
    `computeMidnightCutoffBoundary("${d}") equals getDayBoundsUtc(d).end exactly`
  );
}

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

  async function callMobile(
    method: string,
    path: string,
    deviceIdentifier: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
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
  let breakProfileId!: string;
  let activityGroupId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Cutoff-${label}-${RUN_ID}`, `qa-cutoff-${label.toLowerCase()}-${RUN_ID}@test.local`, roleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertDevice(employeeId: string, label: string): Promise<{ deviceRowId: string; deviceIdentifier: string }> {
      const deviceIdentifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [deviceIdentifier, `QA Cutoff Device ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return { deviceRowId: rows[0].id, deviceIdentifier };
    }

    const activityId = (
      await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA Cutoff Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(activityId);

    // Needed for the real sync-event routes (scenarios 9/10) to pass
    // activity validation — validateActivityAndAnswers requires the
    // activity to reach the employee through an active activity group
    // assignment.
    activityGroupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA Cutoff Group ${RUN_ID}`])
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [activityGroupId, activityId]);

    // Break profile with ALL THREE rounding settings enabled, for the
    // "rounding-enabled employee" scenario.
    breakProfileId = (
      await pool.query(
        `insert into break_profiles
           (name, is_active, work_start_rounding_enabled, work_start_rounding_direction, work_start_rounding_interval_minutes,
            work_end_rounding_enabled, work_end_rounding_direction, work_end_rounding_interval_minutes,
            break_rounding_enabled, break_rounding_direction, break_rounding_interval_minutes)
         values ($1, true, true, 'clockwise', 15, true, 'clockwise', 15, true, 'clockwise', 15)
         returning id`,
        [`QA Cutoff Rounding Profile ${RUN_ID}`]
      )
    ).rows[0].id;

    // Every scenario below gets its OWN fresh employee (+ device) rather
    // than sharing one — full isolation avoids one scenario's already-
    // closed rows leaking into another's assertions.
    let fixtureCounter = 0;
    async function freshFixture(label: string): Promise<{ employeeId: string; deviceRowId: string; deviceIdentifier: string }> {
      fixtureCounter++;
      const employeeId = await insertEmployee(`${label}${fixtureCounter}`);
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        employeeId,
        activityGroupId,
      ]);
      const { deviceRowId, deviceIdentifier } = await insertDevice(employeeId, `${label}${fixtureCounter}`);
      return { employeeId, deviceRowId, deviceIdentifier };
    }

    // Helper: insert a raw OPEN time_entries row directly (bypassing
    // openEntry()) with a real-relative-past started_at — the exact shape a
    // genuinely-stale, never-reconciled entry has.
    async function insertOpenEntry(opts: {
      employeeId: string;
      deviceId: string;
      entryType: "work" | "break";
      activityId?: string | null;
      startedAt: Date;
    }): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
         values ($1, $2, $3, $4, $5, $6, 'manual')
         returning id`,
        [opts.employeeId, opts.deviceId, opts.entryType, opts.activityId ?? null, randomUUID(), opts.startedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    // Local-calendar-aware, not naive UTC-date arithmetic: "n days ago" must
    // mean n LOCAL calendar days before today, at hour:00 LOCAL time — a
    // plain `setUTCDate` offset drifts a day whenever the test happens to
    // run while UTC and APP_TIMEZONE disagree on what day it is (any run
    // between UTC midnight and ~4am, still "yesterday evening" in
    // America/Toronto's UTC-4/-5 offset).
    function daysAgo(n: number, hour: number): Date {
      const todayLocal = calendarDateInAppTimezone(new Date());
      const targetLocal = addDaysToDateStr(todayLocal, -n);
      const [y, mo, d] = targetLocal.split("-").map(Number);
      return zonedWallTimeToUtc(y, mo, d, hour, 0, 0);
    }

    async function fetchEntry(id: string) {
      const { rows } = await pool.query(
        `select id, entry_type, activity_id, started_at, ended_at, source, rollover_of_entry_id, device_id,
                actual_started_at, actual_ended_at, auto_closed_at, idempotency_key
         from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }
    async function fetchOpenEntry(employeeId: string) {
      const { rows } = await pool.query(
        `select id, entry_type, activity_id, started_at, ended_at, source, rollover_of_entry_id
         from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
        [employeeId]
      );
      return rows[0];
    }
    async function fetchAllEntries(employeeId: string) {
      const { rows } = await pool.query(
        `select id, entry_type, started_at, ended_at, source
         from time_entries where employee_id = $1 and deleted_at is null order by started_at asc`,
        [employeeId]
      );
      return rows;
    }

    // -----------------------------------------------------------------
    // 1) Working straight through ONE midnight: closed EXACTLY at the
    //    boundary, no continuation row, audit correction recorded.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Working");
      const started = daysAgo(1, 14);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const outcome = await reconcileMidnightCutoff(employeeId);
      check(outcome === "cut_off", "1) reconcile reports cut_off", outcome);

      const after = await fetchEntry(original);
      const localDate = calendarDateInAppTimezone(started);
      const expectedBoundary = computeMidnightCutoffBoundary(localDate);
      check(after.ended_at !== null, "1) the entry is closed");
      check(
        new Date(after.ended_at).getTime() === expectedBoundary.getTime(),
        "1) closed EXACTLY at the next local midnight after its own start",
        { got: after.ended_at, expected: expectedBoundary.toISOString() }
      );
      check(after.entry_type === "work", "1) still a work entry, untouched otherwise");
      const stillOpen = await fetchOpenEntry(employeeId);
      check(stillOpen === undefined, "1) no successor entry was created — nothing is open for this employee anymore", stillOpen);

      const { rows: corrections } = await pool.query(
        `select * from time_entry_corrections where time_entry_id = $1`,
        [original]
      );
      check(corrections.length === 1, "1) exactly one audit correction recorded", corrections);
      check(corrections[0]?.reason === MIDNIGHT_CUTOFF_REASON, "1) correction reason is midnight_cutoff");
      check(corrections[0]?.changed_by_employee_id === null, "1) attributed to the system (null), not a real employee id");
      check(corrections[0]?.old_value === "null", "1) old_value is the literal string 'null' — genuinely had no prior end");
      check(corrections[0]?.new_value === expectedBoundary.toISOString(), "1) new_value is exactly the boundary");
    }

    // -----------------------------------------------------------------
    // 2) On break through midnight: closed the same way, entry_type stays
    //    'break', never silently converted to work.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("OnBreak");
      const started = daysAgo(1, 15);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "break", startedAt: started });
      await reconcileMidnightCutoff(employeeId);
      const after = await fetchEntry(original);
      check(after.ended_at !== null, "2) the break entry is closed");
      check(after.entry_type === "break", "2) still a break entry, not converted to work", after);
      check(after.activity_id === null, "2) break entry has no activity_id");
      const stillOpen = await fetchOpenEntry(employeeId);
      check(stillOpen === undefined, "2) no successor — nothing open afterward");
    }

    // -----------------------------------------------------------------
    // 3) Cron delay: an entry several days old closes at ITS OWN first
    //    midnight, never "now" and never a chain of hops — there is nothing
    //    to continue, so there is only ever one thing to do.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("CronDelay");
      const started = daysAgo(4, 10);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await reconcileMidnightCutoff(employeeId);
      const after = await fetchEntry(original);
      const expectedBoundary = computeMidnightCutoffBoundary(calendarDateInAppTimezone(started));
      check(
        after.ended_at !== null && new Date(after.ended_at).getTime() === expectedBoundary.getTime(),
        "3) a multi-day-delayed reconcile still closes at the entry's OWN first midnight, not 'now'",
        { got: after.ended_at, expected: expectedBoundary.toISOString() }
      );
      const allEntries = await fetchAllEntries(employeeId);
      check(allEntries.length === 1, "3) exactly one row exists — no chain of intermediate hops was created", allEntries.length);
    }

    // -----------------------------------------------------------------
    // 4) Concurrent sweep + request-time reconciliation race for the same
    //    employee — advisory lock serializes, exactly one close, no
    //    duplicate correction.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Race");
      const started = daysAgo(2, 9);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await Promise.all([reconcileMidnightCutoff(employeeId), runMidnightCutoffSweep()]);
      const allEntries = await fetchAllEntries(employeeId);
      check(allEntries.length === 1, "4) exactly one row survives a concurrent sweep+request-time race", allEntries);
      check(allEntries[0]?.ended_at !== null, "4) the race still results in a closed entry");
      const { rows: corrections } = await pool.query(`select count(*) from time_entry_corrections where time_entry_id = $1`, [original]);
      check(Number(corrections[0].count) === 1, "4) exactly one correction row, not a duplicate from the race");
    }

    // -----------------------------------------------------------------
    // 5) Retry/idempotency: calling reconcile twice for the same
    //    already-resolved state writes nothing new the second time.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Retry");
      const started = daysAgo(2, 11);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      const first = await reconcileMidnightCutoff(employeeId);
      const afterFirst = await fetchEntry(original);
      const second = await reconcileMidnightCutoff(employeeId);
      const afterSecond = await fetchEntry(original);
      check(first === "cut_off" && second === "no_action", "5) first call cuts off, second is a true no-op", { first, second });
      check(
        new Date(afterFirst.ended_at).getTime() === new Date(afterSecond.ended_at).getTime(),
        "5) ended_at is unchanged by the retry"
      );
      const { rows: corrections } = await pool.query(`select count(*) from time_entry_corrections where time_entry_id = $1`, [original]);
      check(Number(corrections[0].count) === 1, "5) still exactly one correction after the retry — no duplicate");
    }

    // -----------------------------------------------------------------
    // 6) Rounding-enabled employee: the cutoff boundary is exact, never
    //    snapped to the profile's 15-minute rounding interval.
    // -----------------------------------------------------------------
    {
      const { employeeId: empRounding, deviceRowId: devRounding } = await freshFixture("Rounding");
      await pool.query(`update employees set break_profile_id = $1 where id = $2`, [breakProfileId, empRounding]);
      const started = daysAgo(1, 13);
      const original = await insertOpenEntry({ employeeId: empRounding, deviceId: devRounding, entryType: "work", activityId, startedAt: started });
      await reconcileMidnightCutoff(empRounding);
      const after = await fetchEntry(original);
      const expectedBoundary = computeMidnightCutoffBoundary(calendarDateInAppTimezone(started));
      check(
        new Date(after.ended_at).getTime() === expectedBoundary.getTime(),
        "6) rounding-enabled employee's cutoff boundary is exact, never snapped to the 15-minute rounding interval",
        { got: after.ended_at, expected: expectedBoundary.toISOString() }
      );
    }

    // -----------------------------------------------------------------
    // 7) Request-time wiring (GET /api/mobile/me): an entry started just
    //    before ITS OWN local midnight yesterday still closes correctly on
    //    the next request, and status flips to idle immediately.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId, deviceIdentifier } = await freshFixture("Boundary");
      const yesterdayLocal = addDaysToDateStr(calendarDateInAppTimezone(new Date()), -1);
      const [y, mo, da] = yesterdayLocal.split("-").map(Number);
      const justBeforeMidnightLocal = zonedWallTimeToUtc(y, mo, da, 23, 45, 0);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: justBeforeMidnightLocal });

      const res = await callMobile("GET", "/api/mobile/me", deviceIdentifier);
      check(res.status === 200, "7) GET /api/mobile/me succeeds and triggers request-time reconciliation", res.body);
      check(res.body?.status === "idle", "7) status is idle immediately after the midnight-cutoff close — no auto-resume", res.body);

      const after = await fetchEntry(original);
      check(after.ended_at !== null, "7) an entry minutes before its own local midnight still closes correctly");
      check(
        new Date(after.ended_at).getTime() === computeMidnightCutoffBoundary(yesterdayLocal).getTime(),
        "7) closed exactly at the local midnight boundary, not the original near-midnight tap"
      );
      const stillOpen = await fetchOpenEntry(employeeId);
      check(stillOpen === undefined, "7) nothing is open — no continuation");
    }

    // -----------------------------------------------------------------
    // 8) Explicitly clocking in again after midnight: once cut off, the
    //    employee must press Start Work again — that creates a genuinely
    //    new, unrelated entry, never linked to the closed one.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId, deviceIdentifier } = await freshFixture("ClockInAgain");
      const started = daysAgo(1, 14);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await reconcileMidnightCutoff(employeeId);
      const idleCheck = await callMobile("GET", "/api/mobile/me", deviceIdentifier);
      check(idleCheck.body?.status === "idle", "8) employee shows idle before clocking in again", idleCheck.body);

      const startRes = await callMobile("POST", "/api/mobile/time-entries/work", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        activityId,
      });
      check(startRes.status === 200, "8) Start Work succeeds after a midnight cutoff", startRes.body);

      const newOpen = await fetchOpenEntry(employeeId);
      check(newOpen !== undefined, "8) a new open entry now exists", newOpen);
      check(newOpen?.id !== original, "8) the new entry is NOT the same row as the closed one");
      check(newOpen?.rollover_of_entry_id === null, "8) the new entry has no link back to the closed one — a genuinely fresh shift");
    }

    // -----------------------------------------------------------------
    // 9/10) Late offline sync event before/at the midnight-cutoff boundary
    //     → Sync Conflicts, never reopens the closed shift. A genuinely
    //     LATER event (a real new shift starting after the cutoff) is
    //     accepted normally (negative control).
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId, deviceIdentifier } = await freshFixture("LateSync");
      const started = daysAgo(1, 14);
      await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await reconcileMidnightCutoff(employeeId);
      const cutoffBoundary = computeMidnightCutoffBoundary(calendarDateInAppTimezone(started));

      // A queued offline activity_switch whose real occurrence time is
      // BEFORE the cutoff boundary — simulates a phone that had this tap
      // sitting in its local queue before the boundary passed, only syncing
      // afterward.
      const staleOccurred = new Date(cutoffBoundary.getTime() - 5 * 60 * 1000);
      const staleRes = await callMobile("POST", "/api/mobile/sync/events", deviceIdentifier, {
        events: [{ clientEventId: randomUUID(), deviceSeq: 1, eventType: "activity_switch", occurredAtUtc: staleOccurred.toISOString(), activityId }],
      });
      check(staleRes.status === 200, "9) stale event: sync request itself succeeds (200)", staleRes.body);
      const { rows: staleMte } = await pool.query(
        `select processing_status, conflict_reason from mobile_time_events where employee_id = $1 order by received_at desc limit 1`,
        [employeeId]
      );
      check(
        staleMte[0]?.processing_status === "permanent_conflict" && /midnight cutoff/.test(staleMte[0]?.conflict_reason ?? ""),
        "9) event before the cutoff boundary: permanent_conflict, clearly attributed to the midnight cutoff",
        staleMte[0]
      );
      const stillClosed = await fetchOpenEntry(employeeId);
      check(stillClosed === undefined, "9) the midnight-closed shift is never reopened by the stale event");

      // Negative control: a genuinely LATER event is a real new shift.
      const laterOccurred = new Date(cutoffBoundary.getTime() + 60 * 60 * 1000);
      const laterRes = await callMobile("POST", "/api/mobile/sync/events", deviceIdentifier, {
        events: [{ clientEventId: randomUUID(), deviceSeq: 2, eventType: "work_start", occurredAtUtc: laterOccurred.toISOString(), activityId }],
      });
      check(laterRes.status === 200, "10) later event: sync request succeeds", laterRes.body);
      const { rows: laterMte } = await pool.query(
        `select processing_status, time_entry_id from mobile_time_events where employee_id = $1 order by received_at desc limit 1`,
        [employeeId]
      );
      check(laterMte[0]?.processing_status === "accepted", "10) a genuinely later event after the cutoff is accepted normally (negative control)", laterMte[0]);
      if (laterMte[0]?.time_entry_id) timeEntryIds.push(laterMte[0].time_entry_id);
    }

    // -----------------------------------------------------------------
    // 11) Payroll/Inputs totals: the work up to midnight is ordinary,
    //     fully-counted payable time — a routine midnight close is a
    //     confirmed boundary, never a guess, so nothing is excluded.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Payroll");
      const started = daysAgo(1, 9); // 9am local yesterday
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await reconcileMidnightCutoff(employeeId);
      const after = await fetchEntry(original);
      const expectedSeconds = (new Date(after.ended_at).getTime() - started.getTime()) / 1000;

      const totals = computeWorkdayTotals([{ entryType: "work", startedAt: started, endedAt: new Date(after.ended_at), isPaid: null }]);
      check(
        Math.abs(totals.workedSeconds - expectedSeconds) < 1,
        "11) the full span up to the midnight-cutoff boundary counts as ordinary worked time, uncut — a routine close is never flagged for review",
        { got: totals.workedSeconds, expected: expectedSeconds }
      );
    }

    // -----------------------------------------------------------------
    // 12) dailyCutoff's outer-fallback threshold: does NOT fire on an entry
    //     only 1 real day stale (midnight cutoff should have already
    //     handled it), but DOES fire well past DAILY_CUTOFF_STALE_DAYS —
    //     and never interferes with an entry midnight cutoff already
    //     closed.
    // -----------------------------------------------------------------
    {
      const { employeeId: emp12a, deviceRowId: dev12a } = await freshFixture("CutoffRecent");
      const { employeeId: emp12b, deviceRowId: dev12b } = await freshFixture("CutoffStale");
      const recentlyStale = await insertOpenEntry({ employeeId: emp12a, deviceId: dev12a, entryType: "work", activityId, startedAt: daysAgo(1, 10) });
      const veryStale = await insertOpenEntry({
        employeeId: emp12b,
        deviceId: dev12b,
        entryType: "work",
        activityId,
        startedAt: daysAgo(DAILY_CUTOFF_STALE_DAYS + 2, 10),
      });

      const result = await runDailyCutoff();
      const recentlyStaleAfter = await fetchEntry(recentlyStale);
      const veryStaleAfter = await fetchEntry(veryStale);
      check(recentlyStaleAfter.ended_at === null, "12) a 1-day-stale entry is left alone — midnight cutoff's job, not dailyCutoff's");
      check(veryStaleAfter.ended_at !== null, "12) an entry well past the outer-fallback threshold IS closed", result);
      check(veryStaleAfter.source !== "midnight_rollover", "12) dailyCutoff's own close never creates a rollover-tagged row");
    }

    // -----------------------------------------------------------------
    // 13) Long Open Shift Alert: unaffected by this redesign — correctly
    //     fires/doesn't fire for a plain (chain-length-1) entry, and
    //     org_settings threshold read/write round-trips. (walkShiftStart's
    //     historical rollover-chain-walk is unchanged code, not re-tested
    //     here — see longOpenShiftAlerts.ts's own header.)
    // -----------------------------------------------------------------
    {
      const settingsBefore = await getOrgSettings();
      check(settingsBefore.longOpenShiftAlertThresholdHours === 16, "13) org_settings defaults to a 16-hour threshold", settingsBefore);

      const { employeeId: empUnder, deviceRowId: devUnder } = await freshFixture("AlertUnder");
      const shortShiftEntry = await insertOpenEntry({
        employeeId: empUnder,
        deviceId: devUnder,
        entryType: "work",
        activityId,
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });
      const underAlerts = await getLongOpenShiftAlerts(pool, 16, new Date());
      check(!underAlerts.some((a) => a.employeeId === empUnder), "13) a shift well under the threshold does not alert");

      const { employeeId: empOver, deviceRowId: devOver } = await freshFixture("AlertOver");
      const longShiftEntry = await insertOpenEntry({
        employeeId: empOver,
        deviceId: devOver,
        entryType: "work",
        activityId,
        startedAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
      });
      const overAlerts = await getLongOpenShiftAlerts(pool, 16, new Date());
      check(overAlerts.some((a) => a.employeeId === empOver), "13) a shift over the threshold does alert", overAlerts);
      const stillOpenAfterAlert = await fetchOpenEntry(empOver);
      check(stillOpenAfterAlert?.id === longShiftEntry, "13) the alert never closes or otherwise touches the entry — review only");

      await setLongOpenShiftAlertThresholdHours(20, empOver);
      const settingsAfterSet = await getOrgSettings();
      check(settingsAfterSet.longOpenShiftAlertThresholdHours === 20, "13) threshold write round-trips through getOrgSettings");
      await setLongOpenShiftAlertThresholdHours(16, empOver);

      await pool.query(`update time_entries set ended_at = now() where id = any($1::uuid[])`, [[shortShiftEntry, longShiftEntry]]);
    }
  } finally {
    // Retries transient failures (a dropped pooled connection, a momentary
    // lock) up to 3 times, but a step that's still failing after that is
    // NOT swallowed — it counts as a real test failure (fail++, non-zero
    // exit) instead of being silently logged and moved past. A silent
    // catch here is exactly how the 2026-08-31 QA-fixture leak happened:
    // the employees/break_profiles deletes failed, were logged to stderr
    // (never persisted anywhere), and the run still reported success.
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
      await tryDelete("time_entry_corrections", () =>
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
      await tryDelete("mobile_time_events (by employee)", () =>
        pool.query(`delete from mobile_time_events where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entries (by employee)", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (deviceIds.length) {
      await tryDelete("device_sync_state", () => pool.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]));
    }
    if (activityGroupId) {
      await tryDelete("activity_group_activities", () =>
        pool.query(`delete from activity_group_activities where activity_group_id = $1`, [activityGroupId])
      );
      await tryDelete("activity_groups", () => pool.query(`delete from activity_groups where id = $1`, [activityGroupId]));
    }
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (employeeIds.length) {
      // org_settings.updated_by_employee_id (set by scenario 13's threshold
      // round-trip) otherwise blocks the employees delete below with a FK
      // violation.
      await tryDelete("org_settings (clear updated_by)", () =>
        pool.query(`update org_settings set updated_by_employee_id = null where updated_by_employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    }
    if (breakProfileId) await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = $1`, [breakProfileId]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
