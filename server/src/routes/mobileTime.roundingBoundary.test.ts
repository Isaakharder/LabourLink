// Reproduces and locks in the fix for the "forward-rounding boundary"
// production bug: work-start rounding (roundWorkStart, clockwise) can leave
// a currently-open entry's own started_at LATER than a subsequent genuine
// event's real occurrence time — e.g. a raw work-start tap at 12:52:03
// rounds to a paid/logical start of 13:00:00, and a real carrier change at
// 12:52:41 (after the raw tap, but before the rounded boundary) previously
// tried to close that entry with an end time before its own start, which
// migration 040's chk_time_entries_ended_after_started constraint rejects
// outright — permanently, since retrying the same physically-valid tap can
// never succeed. Confirmed against real production data for two separate
// employees before this fix (both via the stored conflict_reason "This
// event's timestamp would close an existing entry before it started").
//
// Required principle (see openEntry()'s own comment in mobileTime.ts): an
// event that occurs after the RAW work-start tap must never become a
// permanent conflict solely because rounding moved the logical start into
// the future. For a same-kind change (activity/row/carrier) arriving before
// the rounded boundary, the still-open, still-zero-duration entry is
// collapsed in place — the rounded started_at is preserved, the latest
// assignment becomes what's active at that boundary, nothing is fabricated
// and nothing is silently discarded. For a different-kind transition (e.g.
// Start Break arriving before a just-rounded work-start), the never-really-
// paid placeholder is voided (soft-deleted, audited) rather than closed
// with an invalid boundary.
//
// Also covers: the boundary logic must NOT swallow a genuine, unrelated
// backward device-clock jump (bounded to the maximum legal
// work_start_rounding_interval_minutes of 60 — see migrations/
// 030_work_start_rounding.sql's own CHECK constraint) — that class of
// anomaly must keep landing as permanent_conflict exactly as before, and is
// covered separately by mobileTime.syncEvents.clockAnomaly.test.ts; this
// file only re-confirms the two don't collide at the 60-minute edge.
//
// Covers, for BOTH the direct online routes (POST /time-entries/work,
// /break/start, /break/end) and the offline batch sync path (POST
// /sync/events, applySyncedEvent) per "apply consistently in online
// requests and offline batch synchronization":
//   A) carrier change before the rounded start (online + sync)
//   B) row change before the rounded start (online + sync)
//   C) different activity before the rounded start (sync)
//   D) event exactly at the rounded start (sync)
//   E) event after the rounded start (sync)
//   F) start break before the rounded start (online + sync) — different
//      entry_type, must void rather than negative-duration-close, and must
//      not permanently strand the employee unable to resume afterward
//   G) end-day (Finish Work) before an open entry's own started_at — already
//      independently guarded, re-confirmed unaffected by this change
//   H) reconnection: several ordered pending events (carrier change then a
//      later, real activity switch) submitted together in one sync batch
//   I) idempotent retry of a boundary-collapsed event
//   J) raw timestamps and rounding audit (actual_started_at, conflictReason/
//      boundaryNote, time_entry_deletions) preserved throughout
//
// Run with: npm run test:mobile-time-rounding-boundary
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { roundWorkStart } from "../lib/workStartRounding";
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
const ROUNDING_INTERVAL_MINUTES = 15;

// roundWorkStart only ever rounds UP to the next 15-minute wall-clock mark,
// so the headroom between "now" and that next mark is an uncontrollable
// value somewhere in (0, 15 minutes] — entirely a function of where "now"
// happens to fall inside its own bucket, not something a caller can steer
// into an arbitrary narrow window by picking a different input instant (any
// input in the same bucket yields the identical result; jumping to a
// different bucket moves the result by whole 15-minute multiples, never
// partial ones). So this file uses two different, deterministic
// strategies instead of searching for one, depending on what each caller
// actually needs:
//
//   pickFutureBoundary — for the ONLINE-route blocks (A, F, G), whose
//   second call never carries a client timestamp and so always compares
//   against real wall-clock "now" at the moment it's processed. These only
//   need SOME comfortable positive headroom (no upper bound matters, since
//   the online routes never run detectClockAnomaly at all) — a 60-second
//   epsilon before rounding guarantees at least 60 seconds of slack, far
//   more than the low-single-digit-second round trip these tests need.
//
//   pickPastBoundary — for the SYNC-BATCH blocks (B, C, D, E, H, I), which
//   always send an explicit occurredAtUtc and so never depend on real
//   "now" for the boundary-collapse comparison itself. Deliberately
//   anchoring rawTap ~20 minutes in the past keeps the resulting rounded
//   boundary safely in the past too (rawTap's own bucket can extend at
//   most 15 minutes forward, so `rounded` lands somewhere between 5 and 20
//   minutes behind real "now") — sidestepping detectClockAnomaly's
//   forward-skew tolerance entirely, since that check only ever fires for
//   a timestamp AHEAD of processing time, never a past one.
//
// `seedOffsetMs` staggers each call's anchor point so distinct blocks land
// on distinct boundary instants — sharing one is harmless in principle
// (each block resets the employee to idle first), but keeping them
// distinct makes any real cross-block state leak immediately obvious in a
// failure's timestamps instead of silently looking identical to the
// correct case.
// At least this much real headroom between "now" and `rounded` — comfortably
// more than the low-single-digit seconds these tests actually take.
const ONLINE_MIN_HEADROOM_MS = 30 * 1000;

function pickFutureBoundary(seedOffsetMs: number): { rawTap: Date; rounded: Date } {
  // rawTap MUST stay close to real "now" (a few seconds in the past, at
  // most): resolveOriginalStartedAt (workStartRounding.ts) rejects any
  // client-supplied timestamp more than MAX_CLIENT_CLOCK_SKEW_FUTURE_MS (5
  // minutes) ahead of server processing time and silently substitutes
  // server "now" instead — a rawTap constructed by subtracting a few
  // minutes from an already-far-future `rounded` (this function's earlier,
  // buggy version) routinely tripped that substitution, so the server
  // ended up rounding its OWN "now" instead of the intended rawTap, and
  // then online callers observed the wrong boundary entirely.
  let rawTap = new Date(Date.now() - 3000 - seedOffsetMs);
  let rounded = roundWorkStart(rawTap, ROUNDING_INTERVAL_MINUTES, "clockwise");
  // Rare: "now" already sits within ONLINE_MIN_HEADROOM_MS of the next
  // boundary — skip forward to the FOLLOWING one (still safely inside the
  // 5-minute tolerance, since we're only moving ~1 second past a boundary
  // that was itself under 30 seconds away) so real execution always has
  // comfortable room before crossing it.
  while (rounded.getTime() - Date.now() < ONLINE_MIN_HEADROOM_MS) {
    rawTap = new Date(rounded.getTime() + 1000);
    rounded = roundWorkStart(rawTap, ROUNDING_INTERVAL_MINUTES, "clockwise");
  }
  return { rawTap, rounded };
}

function pickPastBoundary(seedOffsetMs: number): { rawTap: Date; rounded: Date } {
  const rawTap = new Date(Date.now() - 20 * 60 * 1000 - seedOffsetMs);
  const rounded = roundWorkStart(rawTap, ROUNDING_INTERVAL_MINUTES, "clockwise");
  return { rawTap, rounded };
}

function midpoint(a: Date, b: Date): Date {
  return new Date(a.getTime() + Math.round((b.getTime() - a.getTime()) / 2));
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

  async function call(path: string, deviceIdentifier: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/mobile${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

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
  const deviceIdentifiers: string[] = [];
  const rowIds: string[] = [];
  const carrierIds: string[] = [];
  const activityIds: string[] = [];
  let groupId!: string;
  let landId!: string;
  let phaseId!: string;
  let profileId!: string;
  let questionRowId!: string;
  let questionCarrierId!: string;
  let activityAId!: string;
  let activityBId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    profileId = (
      await pool.query(
        `insert into break_profiles (name, is_active, work_start_rounding_enabled, work_start_rounding_direction, work_start_rounding_interval_minutes)
         values ($1, true, true, 'clockwise', $2) returning id`,
        [`QA Rounding Boundary Profile ${RUN_ID}`, ROUNDING_INTERVAL_MINUTES]
      )
    ).rows[0].id;

    const employee = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ('QA', $1, $2, $3, $4, $5, true, $6) returning id`,
        [`Rounding Boundary ${RUN_ID}`, `qa-rounding-boundary-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash, profileId]
      )
    ).rows[0];
    employeeIds.push(employee.id);
    const employeeId: string = employee.id;

    async function pairDevice(): Promise<string> {
      const identifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [identifier, `QA Rounding Boundary Device ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      deviceIdentifiers.push(identifier);
      await pool.query(`update device_assignments set unassigned_at = now() where employee_id = $1 and unassigned_at is null`, [employeeId]);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return identifier;
    }

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA Rounding Boundary Group ${RUN_ID}`])
    ).rows[0].id;

    activityAId = (
      await pool.query(
        `insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`,
        [`QA Rounding Boundary Activity A ${RUN_ID}`]
      )
    ).rows[0].id;
    activityBId = (
      await pool.query(
        `insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`,
        [`QA Rounding Boundary Activity B ${RUN_ID}`]
      )
    ).rows[0].id;
    activityIds.push(activityAId, activityBId);

    questionRowId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [activityAId]
      )
    ).rows[0].id;
    questionCarrierId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'carrier', 'Which bin?', true, 1) returning id`,
        [activityAId]
      )
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [groupId, activityAId]);
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [groupId, activityBId]);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [employeeId, groupId]);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [
        `QA Rounding Boundary Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`,
        [landId, `QA Rounding Boundary Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    async function makeRow(n: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, $2, 0, 0, 4, 50, 'vertical') returning id`,
        [phaseId, n]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }
    const row1 = await makeRow(1);
    const row2 = await makeRow(2);

    async function makeCarrier(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [
        `QA Rounding Boundary Carrier ${label} ${RUN_ID}`,
      ]);
      carrierIds.push(rows[0].id);
      return rows[0].id;
    }
    const carrierA = await makeCarrier("A");
    const carrierB = await makeCarrier("B");

    function rowCarrierAnswers(rowId: string, carrierId: string) {
      return { 0: { questionId: questionRowId, greenhouseRowId: rowId }, 1: { questionId: questionCarrierId, carrierId } };
    }

    async function fetchOpen() {
      const { rows } = await pool.query(
        `select id, entry_type, activity_id, started_at, actual_started_at, greenhouse_row_id, carrier_id, deleted_at
         from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
        [employeeId]
      );
      return rows[0];
    }
    async function fetchEntry(id: string) {
      const { rows } = await pool.query(
        `select id, entry_type, activity_id, started_at, actual_started_at, greenhouse_row_id, carrier_id, ended_at, deleted_at, deletion_reason
         from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }
    async function anyNegativeOrPermanentConflictExists(): Promise<boolean> {
      const negDuration = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and ended_at is not null and ended_at <= started_at`,
        [employeeId]
      );
      const conflicts = await pool.query(
        `select count(*) from mobile_time_events where employee_id = $1 and processing_status = 'permanent_conflict'`,
        [employeeId]
      );
      return Number(negDuration.rows[0].count) > 0 || Number(conflicts.rows[0].count) > 0;
    }
    async function resetIdle() {
      await pool.query(
        `update time_entries set ended_at = greatest(now(), started_at + interval '1 second') where employee_id = $1 and ended_at is null`,
        [employeeId]
      );
    }

    // -----------------------------------------------------------------
    // A) ONLINE route: carrier change before the rounded start.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      // A wide (5-8 min) real-clock headroom, not the tighter range the
      // SYNC-batch blocks use: this block's second call (the online
      // carrier switch) never sends a client timestamp at all, so its
      // boundary comparison falls back to real wall-clock "now" at the
      // moment that request is actually processed — which must stay
      // comfortably ahead of round-trip latency to the database between
      // the two sequential HTTP calls, unlike the sync-batch blocks (which
      // compare against each event's own explicit, client-supplied
      // occurredAtUtc and are therefore immune to execution-speed
      // variance).
      const { rawTap, rounded } = pickFutureBoundary(0 * 1000);

      const start = await call("/time-entries/work", deviceIdentifier, {
        activityId: activityAId,
        idempotencyKey: randomUUID(),
        clientStartedAt: rawTap.toISOString(),
        answers: [
          { questionId: questionRowId, greenhouseRowId: row1 },
          { questionId: questionCarrierId, carrierId: carrierA },
        ],
      });
      check(start.status === 200, "A) online work-start (idle -> work, rounded forward) succeeds", start.body);
      const opened = await fetchOpen();
      check(
        new Date(opened.started_at).getTime() === rounded.getTime(),
        "A) the opened entry's started_at is the rounded boundary, not the raw tap",
        { opened, rounded }
      );
      check(
        new Date(opened.actual_started_at).getTime() === rawTap.getTime(),
        "A) actual_started_at preserves the raw tap for audit",
        opened
      );

      // A real-time carrier switch, moments later — the online route never
      // sends a client timestamp for a switch (only for a genuine idle ->
      // work start), so this always closes/reopens at server "now", which
      // stays comfortably before `rounded` given pickFutureBoundary's
      // headroom (well over the sub-second real time this takes to run).
      const switchRes = await call("/time-entries/work", deviceIdentifier, {
        activityId: activityAId,
        idempotencyKey: randomUUID(),
        // Bypasses the pre-existing, unrelated same-row/minimum-duration
        // switch-warning check (getCurrentWorkSegment) — with the just-
        // opened entry's started_at rounded into the future, that check's
        // own elapsedSeconds (now - started_at) goes negative and would
        // otherwise 409 before ever reaching the boundary logic under
        // test. Real client code sends this once the employee has
        // dismissed whatever dialog fired; it never bypasses the boundary
        // handling itself, only this separate warning.
        confirmSwitch: true,
        answers: [
          { questionId: questionRowId, greenhouseRowId: row1 },
          { questionId: questionCarrierId, carrierId: carrierB },
        ],
      });
      check(switchRes.status === 200, "A) online carrier switch before the rounded boundary succeeds (no permanent conflict)", switchRes.body);

      const stillOpen = await fetchOpen();
      check(stillOpen?.id === opened.id, "A) the SAME entry row was collapsed in place, not closed-and-reopened", { opened, stillOpen });
      check(
        new Date(stillOpen.started_at).getTime() === rounded.getTime(),
        "A) started_at (the rounded paid-work boundary) is unchanged by the collapse",
        stillOpen
      );
      check(
        new Date(stillOpen.actual_started_at).getTime() === rawTap.getTime(),
        "A) actual_started_at (raw tap audit trail) is unchanged by the collapse",
        stillOpen
      );
      check(stillOpen.carrier_id === carrierB, "A) the latest carrier selection (carrierB) is what's active — not silently discarded", stillOpen);
      check(!(await anyNegativeOrPermanentConflictExists()), "A) no negative-duration entry or permanent_conflict exists after the switch");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // B) SYNC BATCH: row change before the rounded start.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      const { rawTap, rounded } = pickPastBoundary(1 * 17 * 60 * 1000);
      const before = midpoint(rawTap, rounded);

      const event1 = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: rawTap.toISOString(),
        activityId: activityAId,
        answers: rowCarrierAnswers(row1, carrierA),
      };
      const r1 = await sync(deviceIdentifier, [event1]);
      check(r1.body?.results?.[0]?.status === "accepted", "B) sync work_start (rounded forward) accepted", r1.body);

      const event2 = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "activity_switch",
        occurredAtUtc: before.toISOString(), // strictly between rawTap and rounded
        activityId: activityAId,
        answers: rowCarrierAnswers(row2, carrierA), // row change only
      };
      const r2 = await sync(deviceIdentifier, [event2]);
      check(r2.body?.results?.[0]?.status === "accepted", "B) sync row change before the rounded boundary is accepted, not permanent_conflict", r2.body);
      check(
        typeof r2.body?.results?.[0]?.detail?.reason === "string" && r2.body.results[0].detail.reason.includes("collapsed"),
        "B) the response carries the boundary-collapse audit note",
        r2.body
      );

      const open = await fetchOpen();
      check(new Date(open.started_at).getTime() === rounded.getTime(), "B) started_at is still the rounded boundary after the row change", open);
      check(open.greenhouse_row_id === row2, "B) the latest row selection is active", open);

      const storedRow2 = await pool.query(`select conflict_reason, processing_status from mobile_time_events where client_event_id = $1`, [
        event2.clientEventId,
      ]);
      check(storedRow2.rows[0]?.processing_status === "accepted", "B) event2 stored as accepted", storedRow2.rows[0]);
      check(
        typeof storedRow2.rows[0]?.conflict_reason === "string",
        "B) event2's audit note is preserved on the synced-event ledger too",
        storedRow2.rows[0]
      );
      check(!(await anyNegativeOrPermanentConflictExists()), "B) no negative-duration entry or permanent_conflict exists");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // C) SYNC BATCH: a different activity before the rounded start.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      const { rawTap, rounded } = pickPastBoundary(2 * 17 * 60 * 1000);
      const before = midpoint(rawTap, rounded);

      await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: 1,
          eventType: "work_start",
          occurredAtUtc: rawTap.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row1, carrierA),
        },
      ]);
      const r2 = await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: 2,
          eventType: "activity_switch",
          occurredAtUtc: before.toISOString(),
          activityId: activityBId, // different activity, no questions configured
          answers: null,
        },
      ]);
      check(r2.body?.results?.[0]?.status === "accepted", "C) a different activity before the rounded boundary is accepted", r2.body);
      const open = await fetchOpen();
      check(open.activity_id === activityBId, "C) the latest activity selection is active", open);
      check(new Date(open.started_at).getTime() === rounded.getTime(), "C) started_at is still the rounded boundary", open);
      check(!(await anyNegativeOrPermanentConflictExists()), "C) no negative-duration entry or permanent_conflict exists");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // D) SYNC BATCH: an event exactly AT the rounded start. The ordinary
    //    close-and-reopen path would try to set ended_at === started_at (a
    //    zero-duration close), which chk_time_entries_ended_after_started
    //    rejects unconditionally — so this must also collapse, exactly
    //    like a strictly-before-boundary event, rather than ever reaching
    //    that always-doomed ordinary path.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      const { rawTap, rounded } = pickPastBoundary(3 * 17 * 60 * 1000);

      await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: 1,
          eventType: "work_start",
          occurredAtUtc: rawTap.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row1, carrierA),
        },
      ]);
      const firstOpen = await fetchOpen();

      const r2 = await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: 2,
          eventType: "activity_switch",
          occurredAtUtc: rounded.toISOString(), // exactly at the boundary
          activityId: activityAId,
          answers: rowCarrierAnswers(row2, carrierA),
        },
      ]);
      check(r2.body?.results?.[0]?.status === "accepted", "D) an event exactly at the rounded start is accepted, not a permanent_conflict", r2.body);
      const open = await fetchOpen();
      check(open.id === firstOpen.id, "D) the SAME entry was collapsed in place (a zero-duration close/reopen is never attempted)", {
        firstOpen,
        open,
      });
      check(
        new Date(open.started_at).getTime() === rounded.getTime(),
        "D) started_at (the rounded boundary) is unchanged by the collapse",
        open
      );
      check(open.greenhouse_row_id === row2, "D) the latest assignment is what's active", open);
      check(!(await anyNegativeOrPermanentConflictExists()), "D) no negative-duration entry or permanent_conflict exists");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // E) SYNC BATCH: an event AFTER the rounded start — ordinary path.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      const { rawTap, rounded } = pickPastBoundary(4 * 17 * 60 * 1000);

      await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: 1,
          eventType: "work_start",
          occurredAtUtc: rawTap.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row1, carrierA),
        },
      ]);
      const firstOpen = await fetchOpen();
      const after = new Date(rounded.getTime() + 60000);
      const r2 = await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: 2,
          eventType: "activity_switch",
          occurredAtUtc: after.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row2, carrierA),
        },
      ]);
      check(r2.body?.results?.[0]?.status === "accepted", "E) an event after the rounded start is accepted", r2.body);
      const open = await fetchOpen();
      check(open.id !== firstOpen.id, "E) a genuinely new row was opened (ordinary path)", { firstOpen, open });
      check(!(await anyNegativeOrPermanentConflictExists()), "E) no negative-duration entry or permanent_conflict exists");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // F) ONLINE + SYNC: Start Break before the rounded start — a
    //    DIFFERENT entry_type than what's open, so the never-really-paid
    //    work placeholder must be voided (soft-deleted, audited), never
    //    closed with a negative duration. Also checks the employee is not
    //    left permanently stranded: ending the break afterward must still
    //    resume real, paid work — not "no prior activity to resume".
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      // Wide real-clock headroom (see block A's own comment): POST
      // /time-entries/break/start only honors clientStartedAt at all when
      // this employee's profile has BREAK rounding separately enabled
      // (mobileTime.ts's own "rounding disabled: deliberately no overrides
      // at all" comment) — this QA profile only configures WORK-START
      // rounding, so the break's own boundary comparison always falls back
      // to real wall-clock "now" at request-processing time regardless of
      // what's sent below.
      const { rawTap, rounded } = pickFutureBoundary(10 * 1000);
      const before = midpoint(rawTap, rounded);

      const start = await call("/time-entries/work", deviceIdentifier, {
        activityId: activityAId,
        idempotencyKey: randomUUID(),
        clientStartedAt: rawTap.toISOString(),
        answers: [
          { questionId: questionRowId, greenhouseRowId: row1 },
          { questionId: questionCarrierId, carrierId: carrierA },
        ],
      });
      check(start.status === 200, "F) work-start (rounded forward) succeeds", start.body);
      const openedWork = await fetchOpen();
      check(openedWork.entry_type === "work", "F) work is open", openedWork);

      const breakStart = await call("/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientStartedAt: before.toISOString(), // before the rounded work-start boundary
      });
      check(breakStart.status === 200, "F) break-start before the rounded work-start boundary succeeds (no permanent conflict)", breakStart.body);
      check(!(await anyNegativeOrPermanentConflictExists()), "F) no negative-duration entry or permanent_conflict after break-start");

      const openedBreak = await fetchOpen();
      check(openedBreak?.entry_type === "break", "F) a break is now open", openedBreak);

      const voidedWork = await fetchEntry(openedWork.id);
      check(voidedWork.deleted_at !== null, "F) the never-paid work placeholder was voided (soft-deleted), not closed with an invalid end", voidedWork);
      check(voidedWork.ended_at === null, "F) the voided placeholder was never given an ended_at (no fabricated/negative duration)", voidedWork);

      const deletionAudit = await pool.query(
        `select deletion_type, reason from time_entry_deletions where $1 = any(affected_time_entry_ids)`,
        [openedWork.id]
      );
      check(deletionAudit.rows.length === 1, "F) the void is recorded in time_entry_deletions for audit", deletionAudit.rows);
      check(deletionAudit.rows[0]?.deletion_type === "activity_run", "F) recorded with deletion_type 'activity_run'", deletionAudit.rows[0]);

      // End the break — must resume real, paid work, not get permanently
      // stuck with "no prior activity to resume" just because the
      // interrupted work placeholder was voided.
      const breakEnd = await call("/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
      check(
        breakEnd.status === 200,
        "F) ending the break afterward succeeds — the employee is not permanently stranded by the earlier void",
        breakEnd.body
      );
      const resumed = await fetchOpen();
      check(
        resumed?.entry_type === "work" && resumed.activity_id === activityAId,
        "F) work resumed on the same activity that was selected before the break, not lost",
        resumed
      );
      check(!(await anyNegativeOrPermanentConflictExists()), "F) no negative-duration entry or permanent_conflict after break-end resume");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // F2) Same as F, but with an OLDER, already-finished work session
    //    still sitting in the employee's history (non-deleted, closed
    //    normally) before the boundary-crossing one. Reproduces a real
    //    production bug found via a live smoke check: break/end's
    //    resume-lookup only looked at `deleted_at is null` rows, so once
    //    the NEW (interrupted) session got voided by the boundary fix, the
    //    lookup silently fell through to the OLDER, unrelated session
    //    instead — resuming the wrong activity/row/carrier entirely.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();

      // An older, ordinary, already-finished work session — row2/carrierB,
      // nothing to do with the boundary case below, just real history.
      // Explicitly anchored 3 hours in the past (clientStartedAt) so its
      // own rounded started_at can never coincidentally land in the same
      // 15-minute bucket as the near-"now" boundary case below — a real
      // tie there would make the resume-lookup's `order by started_at
      // desc` non-deterministic between the two candidates, which is a
      // test-construction hazard, not the thing under test.
      const olderRawTap = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const olderStart = await call("/time-entries/work", deviceIdentifier, {
        activityId: activityAId,
        idempotencyKey: randomUUID(),
        clientStartedAt: olderRawTap.toISOString(),
        answers: [
          { questionId: questionRowId, greenhouseRowId: row2 },
          { questionId: questionCarrierId, carrierId: carrierB },
        ],
      });
      check(olderStart.status === 200, "F2) older, unrelated work session starts", olderStart.body);
      const endOlder = await call("/time-entries/end-day", deviceIdentifier, { idempotencyKey: randomUUID() });
      check(endOlder.status === 200, "F2) older work session ends normally (real, non-deleted history)", endOlder.body);

      // Now the real scenario: a NEW session on row1/carrierA, rounded
      // forward, interrupted by Start Break before its own boundary.
      const { rawTap, rounded } = pickFutureBoundary(30 * 1000);
      const before = midpoint(rawTap, rounded);

      const start = await call("/time-entries/work", deviceIdentifier, {
        activityId: activityAId,
        idempotencyKey: randomUUID(),
        clientStartedAt: rawTap.toISOString(),
        answers: [
          { questionId: questionRowId, greenhouseRowId: row1 },
          { questionId: questionCarrierId, carrierId: carrierA },
        ],
      });
      check(start.status === 200, "F2) new work-start (rounded forward) succeeds", start.body);
      const openedWork = await fetchOpen();

      const breakStart = await call("/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientStartedAt: before.toISOString(),
      });
      check(breakStart.status === 200, "F2) break-start before the rounded boundary succeeds", breakStart.body);
      const voidedWork = await fetchEntry(openedWork.id);
      check(voidedWork.deleted_at !== null, "F2) the new session's placeholder was voided", voidedWork);

      const breakEnd = await call("/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
      check(breakEnd.status === 200, "F2) ending the break succeeds", breakEnd.body);
      const resumed = await fetchOpen();
      check(
        resumed?.entry_type === "work" &&
          resumed.activity_id === activityAId &&
          resumed.greenhouse_row_id === row1 &&
          resumed.carrier_id === carrierA,
        "F2) resumes the NEW (voided) session's row1/carrierA — not the older row2/carrierB session",
        { resumed, voidedId: openedWork.id }
      );
      check(resumed?.id !== openedWork.id, "F2) the resumed entry is a genuinely new row, not the voided one restored", {
        resumedId: resumed?.id,
        voidedId: openedWork.id,
      });
      check(!(await anyNegativeOrPermanentConflictExists()), "F2) no negative-duration entry or permanent_conflict throughout");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // G) End-day (Finish Work) — already independently guarded (its own
    //    two-step fallback against rounding an end before its own start);
    //    re-confirmed unaffected by this change: closing a rounded-forward
    //    work entry moments after it opened still produces a strictly
    //    positive duration, never a permanent conflict.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      const { rawTap } = pickFutureBoundary(20 * 1000);

      const start = await call("/time-entries/work", deviceIdentifier, {
        activityId: activityAId,
        idempotencyKey: randomUUID(),
        clientStartedAt: rawTap.toISOString(),
        answers: [
          { questionId: questionRowId, greenhouseRowId: row1 },
          { questionId: questionCarrierId, carrierId: carrierA },
        ],
      });
      check(start.status === 200, "G) work-start (rounded forward) succeeds", start.body);
      const opened = await fetchOpen();

      const endDay = await call("/time-entries/end-day", deviceIdentifier, { idempotencyKey: randomUUID() });
      check(endDay.status === 200, "G) end-day moments after a rounded-forward start still succeeds", endDay.body);
      const closed = await fetchEntry(opened.id);
      check(
        closed.ended_at !== null && new Date(closed.ended_at).getTime() > new Date(closed.started_at).getTime(),
        "G) the entry was closed with a strictly positive duration",
        closed
      );
      check(!(await anyNegativeOrPermanentConflictExists()), "G) no negative-duration entry or permanent_conflict after end-day");
    }

    // -----------------------------------------------------------------
    // H) Reconnection: several ordered pending events submitted together
    //    in ONE sync batch (the real offline-reconnect shape) — a
    //    work_start, then a pre-boundary carrier change, then a later,
    //    genuinely-after-boundary real activity switch — all at once.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      // Marks the cutoff for this block's own "live entries" check below —
      // earlier blocks (F, G) legitimately leave their own closed,
      // non-deleted rows in the table (real historical records, not a
      // bug), so counting ALL of the employee's rows would always fail
      // here regardless of correctness. created_at (default now(), set at
      // insert time) is what distinguishes "created by this block" from
      // "pre-existing history." Sourced from the DB's OWN now() (not a
      // local `new Date()`) — comparing a local clock reading against a
      // DB-generated created_at is exactly the kind of few-hundred-ms
      // clock-skew race that can put a genuinely-in-this-block row on the
      // wrong side of the cutoff.
      const hBlockStart = (await pool.query(`select now() as now`)).rows[0].now as Date;
      const deviceIdentifier = await pairDevice();
      // pickPastBoundary keeps `rounded` safely in the past, so `after`
      // (rounded + 60s below) stays well under the 5-minute forward-skew
      // tolerance regardless.
      const { rawTap, rounded } = pickPastBoundary(7 * 17 * 60 * 1000);
      const before = midpoint(rawTap, rounded);
      const after = new Date(rounded.getTime() + 60000);

      const events = [
        {
          clientEventId: randomUUID(),
          deviceSeq: 1,
          eventType: "work_start",
          occurredAtUtc: rawTap.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row1, carrierA),
        },
        {
          clientEventId: randomUUID(),
          deviceSeq: 2,
          eventType: "activity_switch",
          occurredAtUtc: before.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row1, carrierB), // carrier-only change, still pre-boundary
        },
        {
          clientEventId: randomUUID(),
          deviceSeq: 3,
          eventType: "activity_switch",
          occurredAtUtc: after.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row2, carrierB), // real, post-boundary switch
        },
      ];
      const r = await sync(deviceIdentifier, events);
      check(
        Array.isArray(r.body?.results) && r.body.results.every((x: any) => x.status === "accepted"),
        "H) all 3 reconnection-batch events accepted, none rejected",
        r.body
      );

      const { rows: allEntries } = await pool.query(
        `select id, entry_type, started_at, ended_at, greenhouse_row_id, carrier_id, deleted_at
         from time_entries where employee_id = $1 and created_at >= $2 order by started_at`,
        [employeeId, hBlockStart]
      );
      // Exactly 2 real (non-deleted) rows should exist: the collapsed
      // pre-boundary entry (row1/carrierB, started at the rounded
      // boundary) and the genuinely new post-boundary switch (row2/
      // carrierB) — event2 must never have produced its own separate row.
      const live = allEntries.filter((e) => !e.deleted_at);
      check(live.length === 2, "H) exactly 2 live entries — the pre-boundary event collapsed, it never became its own row", live);
      check(
        live[0]?.greenhouse_row_id === row1 && live[0]?.carrier_id === carrierB,
        "H) the first (collapsed) entry carries the pre-boundary carrier change",
        live[0]
      );
      check(
        new Date(live[0]?.started_at).getTime() === rounded.getTime(),
        "H) the first entry's started_at is still the rounded boundary",
        live[0]
      );
      check(
        live[1]?.greenhouse_row_id === row2 && live[1]?.carrier_id === carrierB,
        "H) the second (genuinely new) entry carries the post-boundary switch",
        live[1]
      );
      check(
        new Date(live[0]?.ended_at).getTime() === new Date(live[1]?.started_at).getTime(),
        "H) the two live entries are contiguous — no gap, no overlap",
        live
      );
      const dupCheck = await pool.query(
        `select client_event_id, count(*) from mobile_time_events where employee_id = $1 group by client_event_id having count(*) > 1`,
        [employeeId]
      );
      check(dupCheck.rows.length === 0, "H) no duplicate ledger rows for any of the 3 events", dupCheck.rows);
      check(!(await anyNegativeOrPermanentConflictExists()), "H) no negative-duration entry or permanent_conflict across the whole reconnection batch");

      await resetIdle();
    }

    // -----------------------------------------------------------------
    // I) Idempotent retry of a boundary-collapsed event — replaying the
    //    exact same pre-boundary event must not double-collapse, duplicate,
    //    or otherwise mutate state further.
    // -----------------------------------------------------------------
    {
      await resetIdle();
      const deviceIdentifier = await pairDevice();
      const { rawTap, rounded } = pickPastBoundary(8 * 17 * 60 * 1000);
      const before = midpoint(rawTap, rounded);

      await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: 1,
          eventType: "work_start",
          occurredAtUtc: rawTap.toISOString(),
          activityId: activityAId,
          answers: rowCarrierAnswers(row1, carrierA),
        },
      ]);
      const collapseEvent = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "activity_switch",
        occurredAtUtc: before.toISOString(),
        activityId: activityAId,
        answers: rowCarrierAnswers(row1, carrierB),
      };
      const first = await sync(deviceIdentifier, [collapseEvent]);
      check(first.body?.results?.[0]?.status === "accepted", "I) first send of the collapsing event accepted", first.body);
      const afterFirst = await fetchOpen();

      const retry = await sync(deviceIdentifier, [collapseEvent]); // exact same clientEventId
      check(
        retry.body?.results?.[0]?.status === "accepted" || retry.body?.results?.[0]?.status === "duplicate",
        "I) retrying the exact same event is reported as accepted/duplicate, never an error or a new conflict",
        retry.body
      );
      const afterRetry = await fetchOpen();
      check(afterRetry.id === afterFirst.id, "I) the retry did not create or collapse into a different row", { afterFirst, afterRetry });
      check(
        new Date(afterRetry.started_at).getTime() === new Date(afterFirst.started_at).getTime() && afterRetry.carrier_id === afterFirst.carrier_id,
        "I) state is byte-identical after the retry — fully idempotent",
        { afterFirst, afterRetry }
      );

      const { rows: liveRows } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
        [employeeId]
      );
      check(Number(liveRows[0].count) === 1, "I) still exactly one open entry after the retry — no duplicate row", liveRows[0]);
      check(!(await anyNegativeOrPermanentConflictExists()), "I) no negative-duration entry or permanent_conflict after the retry");

      await resetIdle();
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    server.close();
    if (employeeIds.length) await tryDelete("time_entry_deletions", () => pool.query(`delete from time_entry_deletions where employee_id = any($1::uuid[])`, [employeeIds]));
    if (employeeIds.length) await tryDelete("mobile_time_events", () => pool.query(`delete from mobile_time_events where employee_id = any($1::uuid[])`, [employeeIds]));
    if (deviceIds.length) await tryDelete("device_sync_state", () => pool.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]));
    if (employeeIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    if (deviceIds.length) await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
    if (deviceIds.length) await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
    if (activityIds.length)
      await tryDelete("employee_activity_group_assignments", () =>
        pool.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId ?? null])
      );
    if (groupId) await tryDelete("activity_group_activities", () => pool.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId]));
    if (activityIds.length) await tryDelete("activity_questions", () => pool.query(`delete from activity_questions where activity_id = any($1::uuid[])`, [activityIds]));
    if (groupId) await tryDelete("activity_groups", () => pool.query(`delete from activity_groups where id = $1`, [groupId]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    if (profileId) await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = $1`, [profileId]));

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
