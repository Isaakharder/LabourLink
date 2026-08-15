// HTTP-level tests for break rounding: POST /api/mobile/time-entries/
// break/start and POST /api/mobile/time-entries/break/end (mobileTime.ts),
// the manual break-time correction route (inputs.ts) clearing stale
// rounding audit data, the GET /api/inputs/daily response surfacing
// original/rounded break times and totals computed from the rounded
// values, and the Break Profile settings save/reload round trip
// (breakProfiles.ts). Runs the real routers over real HTTP against the
// real database with disposable QA fixtures, same convention as
// workEndRounding.test.ts.
//
// Pure rounding-math coverage (both directions, exact boundaries, seconds,
// midnight/DST) lives in workStartRounding.test.ts alongside
// roundToInterval — roundBreak is the exact same math, just named for its
// own call sites. This file covers what's genuinely new: the break/start
// and break/end routes' own behavior (disabled, enabled, the short-
// duration guard, a fixed-item schedule match staying unaffected), manual
// corrections clearing audit data, the daily-inputs response shape, and
// settings persistence/independence.
//
// Unlike work-start/work-end rounding, neither break route accepts a
// client-supplied tap timestamp (no clientStartedAt/clientEndedAt
// equivalent) — the server's own real-time now() is always what gets
// rounded. So most assertions below read back the audit column
// (actual_started_at/actual_ended_at, the real tap the server itself
// captured) and independently recompute what roundBreak should produce
// from it, rather than trying to predict the server's exact "now" in
// advance.
//
// Run with: npm run test:break-rounding
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { roundBreak } from "../lib/workStartRounding";
import { zonedWallTimeParts } from "../lib/timezone";
import mobileTimeRouter from "./mobileTime";
import inputsRouter from "./inputs";
import breakProfilesRouter from "./breakProfiles";

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

// "HH:MM:SS" wall-clock reading of `d` in the app timezone — used to build
// break_profile_items.start_time/end_time values that will match "now"
// within a generous window, for the fixed-item-schedule test below.
function timeOfDayStr(d: Date): string {
  const p = zonedWallTimeParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/inputs", inputsRouter);
  app.use("/api/break-profiles", breakProfilesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function callDevice(
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
  async function callAdmin(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  let adminActor!: { id: string; first_name: string; last_name: string };
  let target!: { id: string };
  let profile!: { id: string };
  let activity!: { id: string };
  const deviceIds: string[] = [];
  const deviceIdentifiers: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    adminActor = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id, first_name, last_name`,
        [
          "QA",
          `BR Admin ${RUN_ID}`,
          `qa-br-admin-${RUN_ID}@test.local`,
          await roleId("Administrator"),
          teamRoleId,
          fakePinHash,
        ]
      )
    ).rows[0];
    const adminToken = signSession({
      id: adminActor.id,
      firstName: adminActor.first_name,
      lastName: adminActor.last_name,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });

    profile = (
      await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
        `QA Break Rounding Profile ${RUN_ID}`,
      ])
    ).rows[0];
    // Intentionally no scheduled break items on this profile — nothing
    // about break rounding requires one, and it keeps every test below
    // (except F, which adds and then deactivates one of its own) free of
    // any incidental fixed-item match.

    activity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA Break Rounding Activity ${RUN_ID}`,
      ])
    ).rows[0];

    target = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ($1, $2, $3, $4, $5, $6, true, $7) returning id`,
        [
          "QA",
          `BR Target ${RUN_ID}`,
          `qa-br-target-${RUN_ID}@test.local`,
          await roleId("Employee"),
          teamRoleId,
          fakePinHash,
          profile!.id,
        ]
      )
    ).rows[0];

    async function pairDevice(): Promise<string> {
      const identifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [identifier, `QA BR Device ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      deviceIdentifiers.push(identifier);
      await pool.query(`update device_assignments set unassigned_at = now() where employee_id = $1 and unassigned_at is null`, [
        target!.id,
      ]);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [
        rows[0].id,
        target!.id,
      ]);
      return identifier;
    }

    async function setBreakRounding(enabled: boolean, direction: "clockwise" | "counter_clockwise", minutes: number) {
      await pool.query(
        `update break_profiles
         set break_rounding_enabled = $1, break_rounding_direction = $2, break_rounding_interval_minutes = $3
         where id = $4`,
        [enabled, direction, minutes, profile!.id]
      );
    }

    async function openWorkEntry(startedAt: Date, deviceId: string): Promise<string> {
      // Each section starts from a clean idle state — a prior section's
      // break/end resumes work (it never closes the day), so without this
      // the next section's insert here would violate the one-open-entry-
      // per-employee constraint.
      await pool.query(`update time_entries set ended_at = now() where employee_id = $1 and ended_at is null`, [
        target!.id,
      ]);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
         values ($1, $2, 'work', $3, gen_random_uuid(), $4, 'manual')
         returning id`,
        [target!.id, deviceId, activity!.id, startedAt]
      );
      return rows[0].id;
    }

    async function fetchEntry(id: string) {
      const { rows } = await pool.query(
        `select started_at, actual_started_at, ended_at, actual_ended_at from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }

    async function fetchOpenEntry() {
      const { rows } = await pool.query(
        `select id, entry_type, started_at, actual_started_at, ended_at, actual_ended_at
         from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
        [target!.id]
      );
      return rows[0];
    }

    // -----------------------------------------------------------------
    // A) Rounding disabled — break/start records the exact raw tap, no
    //    audit column; break/end closes it with the exact raw tap too,
    //    with actual_ended_at set EQUAL to it (never null — see
    //    mobileTime.ts's break/end route, which always records the real
    //    tap for the fixed-item-match audit trail regardless of whether
    //    break rounding is enabled) rather than differing from it, which
    //    is what keeps the "Rounded" badge from firing for no reason.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setBreakRounding(false, "clockwise", 5);
      const workStart = new Date(Date.now() - 90 * 60000);
      await openWorkEntry(workStart, deviceIds[deviceIds.length - 1]);

      const startRes = await callDevice("POST", "/api/mobile/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      check(startRes.status === 200, "A) break/start succeeds", startRes.body);

      const openBreak = await fetchOpenEntry();
      check(openBreak?.entry_type === "break", "A) a break is now open", openBreak);
      check(
        openBreak.actual_started_at === null,
        "A) rounding disabled: break's actual_started_at stays null",
        openBreak
      );

      const endRes = await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      check(endRes.status === 200, "A) break/end succeeds", endRes.body);

      const closedBreak = await fetchEntry(openBreak.id);
      check(
        closedBreak.actual_ended_at !== null &&
          new Date(closedBreak.actual_ended_at).getTime() === new Date(closedBreak.ended_at).getTime(),
        "A) rounding disabled: ended_at and actual_ended_at are set to the exact same value (badge-safe)",
        closedBreak
      );
      check(
        new Date(closedBreak.ended_at).getTime() > new Date(closedBreak.started_at).getTime(),
        "A) the break has a strictly positive duration",
        closedBreak
      );
    }

    // -----------------------------------------------------------------
    // B) Rounding enabled — break/start (unmatched, no fixed items on this
    //    profile) rounds the real tap time to the nearest configured
    //    interval, recorded alongside the original tap.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setBreakRounding(true, "clockwise", 5);
      const workStart = new Date(Date.now() - 60 * 60000);
      await openWorkEntry(workStart, deviceIds[deviceIds.length - 1]);

      const startRes = await callDevice("POST", "/api/mobile/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      check(startRes.status === 200, "B) break/start succeeds", startRes.body);

      const openBreak = await fetchOpenEntry();
      check(openBreak.actual_started_at !== null, "B) actual_started_at (the raw tap) was recorded", openBreak);
      const expected = roundBreak(new Date(openBreak.actual_started_at), 5, "clockwise");
      check(
        new Date(openBreak.started_at).getTime() === expected.getTime(),
        "B) started_at is the raw tap rounded clockwise to the nearest 5 minutes",
        { openBreak, expected }
      );

      // Clean up so this doesn't leave an open entry for later sections.
      await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
    }

    // -----------------------------------------------------------------
    // C) Rounding enabled — break/end (unmatched) rounds the real tap
    //    counter-clockwise to the nearest configured interval. The break's
    //    own started_at is seeded well in the past (25 minutes, via a
    //    directly-inserted row rather than going through break/start) so
    //    the short-duration guard tested separately in E never interferes
    //    with what's under test here.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setBreakRounding(true, "counter_clockwise", 15);
      const priorWorkStart = new Date(Date.now() - 90 * 60000);
      const breakStart = new Date(Date.now() - 25 * 60000);
      await openWorkEntry(priorWorkStart, deviceIds[deviceIds.length - 1]);
      await pool.query(`update time_entries set ended_at = $1 where employee_id = $2 and ended_at is null`, [
        breakStart,
        target!.id,
      ]);
      const openBreak = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
           values ($1, $2, 'break', null, gen_random_uuid(), $3, 'manual')
           returning id, started_at`,
          [target!.id, deviceIds[deviceIds.length - 1], breakStart]
        )
      ).rows[0];

      const endRes = await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      check(endRes.status === 200, "C) break/end succeeds", endRes.body);

      const closedBreak = await fetchEntry(openBreak.id);
      check(closedBreak.actual_ended_at !== null, "C) actual_ended_at (the raw tap) was recorded", closedBreak);
      const expected = roundBreak(new Date(closedBreak.actual_ended_at), 15, "counter_clockwise");
      check(
        new Date(closedBreak.ended_at).getTime() === expected.getTime(),
        "C) ended_at is the raw tap rounded counter-clockwise to the nearest 15 minutes",
        { closedBreak, expected }
      );
    }

    // -----------------------------------------------------------------
    // D) Short-duration guard on break/start — counter-clockwise rounding
    //    on a large interval must never push the break's start at or
    //    before the work entry it's about to close. Asserted as an
    //    invariant (resulting duration is strictly positive) rather than
    //    against a precomputed boundary, since break/start has no
    //    client-controllable tap time to pin down exactly — the guard
    //    either fires or the real clock just happens not to need it, and
    //    either way the invariant must hold.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setBreakRounding(true, "counter_clockwise", 60);
      const workStart = new Date(Date.now() - 200); // opened an instant ago
      await openWorkEntry(workStart, deviceIds[deviceIds.length - 1]);

      const res = await callDevice("POST", "/api/mobile/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      check(res.status === 200, "D) break/start still succeeds for a very short workday", res.body);

      const openBreak = await fetchOpenEntry();
      check(
        new Date(openBreak.started_at).getTime() > workStart.getTime(),
        "D) the resulting work segment has a strictly positive duration — rounding never pushed the break's start at or before it",
        { openBreak, workStart }
      );

      await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
    }

    // -----------------------------------------------------------------
    // E) Short-duration guard on break/end — same invariant, on the other
    //    boundary: rounding must never push a break's end at or before
    //    its own start.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      // Rounding disabled for the start so the break's own started_at is
      // the exact, known real tap time — isolates what's under test here
      // (the end-side guard) from any start-side rounding.
      await setBreakRounding(false, "clockwise", 5);
      const workStart = new Date(Date.now() - 60 * 60000);
      await openWorkEntry(workStart, deviceIds[deviceIds.length - 1]);
      await callDevice("POST", "/api/mobile/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      const openBreak = await fetchOpenEntry();

      await setBreakRounding(true, "counter_clockwise", 60);
      const res = await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      check(res.status === 200, "E) break/end still succeeds for a very short break", res.body);

      const closedBreak = await fetchEntry(openBreak.id);
      check(
        new Date(closedBreak.ended_at).getTime() > new Date(closedBreak.started_at).getTime(),
        "E) the break has a strictly positive duration — rounding never pushed its end at or before its own start",
        closedBreak
      );
    }

    // -----------------------------------------------------------------
    // F) A break matched to a scheduled fixed-break item keeps its exact
    //    existing snap-to-schedule behavior — break rounding is never
    //    layered on top of it.
    // -----------------------------------------------------------------
    {
      // Interval deliberately large and directionally certain to move the
      // value if (incorrectly) applied on top of the fixed-item match.
      await setBreakRounding(true, "clockwise", 30);
      const now = new Date();
      const scheduledStart = timeOfDayStr(now); // matches "now" essentially exactly
      const scheduledEnd = timeOfDayStr(new Date(now.getTime() + 60 * 60000));
      const fixedItem = (
        await pool.query(
          `insert into break_profile_items
             (break_profile_id, name, start_time, end_time, is_paid, fixed_break, auto_add,
              fixed_start_window_minutes, fixed_end_window_minutes, sort_order, is_active)
           values ($1, $2, $3, $4, false, true, false, 60, 60, 0, true)
           returning id`,
          [profile!.id, `QA BR Fixed Item ${RUN_ID}`, scheduledStart, scheduledEnd]
        )
      ).rows[0];

      try {
        const deviceIdentifier = await pairDevice();
        const workStart = new Date(Date.now() - 60 * 60000);
        await openWorkEntry(workStart, deviceIds[deviceIds.length - 1]);

        const res = await callDevice("POST", "/api/mobile/time-entries/break/start", deviceIdentifier, {
          idempotencyKey: randomUUID(),
        });
        check(res.status === 200, "F) break/start succeeds", res.body);

        const openBreak = await fetchOpenEntry();
        check(
          openBreak.started_at !== null && !isNaN(new Date(openBreak.started_at).getTime()),
          "F) the break was recorded",
          openBreak
        );
        // The fixed-item match snaps started_at to the scheduled time
        // (wall-clock HH:MM:SS combined with today's date) — not to
        // whatever break-rounding-on-the-raw-tap would have produced.
        // Comparing wall-clock-time-of-day (rather than an exact instant)
        // sidesteps any residual clock skew between "now" captured here
        // and the one the server captured when the request was handled.
        const startedParts = zonedWallTimeParts(new Date(openBreak.started_at));
        const pad = (n: number) => String(n).padStart(2, "0");
        const startedTimeOfDay = `${pad(startedParts.hour)}:${pad(startedParts.minute)}:${pad(startedParts.second)}`;
        check(
          startedTimeOfDay === scheduledStart,
          "F) a fixed-item match snaps to the exact scheduled time, unaffected by break rounding",
          { startedTimeOfDay, scheduledStart }
        );

        await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
      } finally {
        await pool.query(`update break_profile_items set is_active = false where id = $1`, [fixedItem.id]);
      }
    }

    // -----------------------------------------------------------------
    // G) Manual correction via PATCH /api/inputs/breaks/:id clears the
    //    respective audit column — an admin's correction supersedes
    //    whatever break rounding previously recorded, so a stale
    //    "Rounded" badge should no longer show against it.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      // A clean slate for this employee — the PATCH route's overlap check
      // looks at every one of the employee's stored entries, not just this
      // section's own fixture, and earlier sections above leave their own
      // (unrelated) entries in place.
      await pool.query(`delete from time_entries where employee_id = $1`, [target!.id]);
      const originalStartTap = new Date(Date.now() - 120 * 60000);
      const startedAt = new Date(originalStartTap.getTime() + 3 * 60000);
      const originalEndTap = new Date(Date.now() - 60 * 60000);
      const endedAt = new Date(originalEndTap.getTime() + 4 * 60000);
      const breakId = (
        await pool.query(
          `insert into time_entries
             (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, actual_started_at, ended_at, actual_ended_at, source)
           values ($1, $2, 'break', null, gen_random_uuid(), $3, $4, $5, $6, 'manual')
           returning id`,
          [target!.id, deviceIds[deviceIds.length - 1], startedAt, originalStartTap, endedAt, originalEndTap]
        )
      ).rows[0].id;

      const before = await fetchEntry(breakId);
      check(
        before.actual_started_at !== null && before.actual_ended_at !== null,
        "G) the break has rounding audit data on both ends before correction",
        before
      );

      const correctedStart = new Date(startedAt.getTime() - 5 * 60000);
      const correctedEnd = new Date(endedAt.getTime() + 5 * 60000);
      const correctionRes = await callAdmin("PATCH", `/api/inputs/breaks/${breakId}`, adminToken, {
        startTime: correctedStart.toISOString(),
        endTime: correctedEnd.toISOString(),
      });
      check(correctionRes.status === 200, "G) the manual correction succeeds", correctionRes.body);

      const after = await fetchEntry(breakId);
      check(
        new Date(after.started_at).getTime() === correctedStart.getTime() &&
          new Date(after.ended_at).getTime() === correctedEnd.getTime(),
        "G) both corrected values are stored exactly, not rounded",
        after
      );
      check(
        after.actual_started_at === null && after.actual_ended_at === null,
        "G) both corrections clear their respective audit column — the stale 'Rounded' badge no longer applies",
        after
      );

      // Left in place rather than deleted here — it now has a
      // time_entry_corrections row referencing it (FK), and the final
      // cleanup block already deletes corrections before entries for every
      // QA fixture this file creates.
    }

    // -----------------------------------------------------------------
    // G2) Correcting a break's END reconciles the FOLLOWING work entry's
    //     START to match — the exact historical scenario reported: a break
    //     recorded before break rounding existed (12:00:00 PM-12:55:42 PM
    //     equivalent below), whose following work entry does NOT start at
    //     the exact same instant the break ends (a 3-second gap, standing
    //     in for whatever pre-existing imprecision this "historical" data
    //     has) — must still reconcile via the shared-boundary behavior,
    //     not reject with "Corrected break overlaps a work entry."
    // -----------------------------------------------------------------
    {
      // Corrections first: G (and, on the second occurrence of this
      // block, G2) leaves a corrected entry in place with a
      // time_entry_corrections row referencing it (FK).
      await pool.query(`delete from time_entry_corrections where employee_id = $1`, [target!.id]);
      await pool.query(`delete from time_entries where employee_id = $1`, [target!.id]);
      const deviceId = deviceIds[deviceIds.length - 1];

      const breakStart = new Date(Date.now() - 65 * 60000); // ~12:00:00 PM equivalent
      const breakOldEnd = new Date(breakStart.getTime() + 55 * 60000 + 42 * 1000); // ~12:55:42 PM equivalent
      // Deliberately NOT exactly contiguous — a 3-second gap, simulating
      // historical data that predates break rounding's guaranteed shared
      // boundary.
      const followingOldStart = new Date(breakOldEnd.getTime() + 3000);
      const followingEnd = new Date(breakOldEnd.getTime() + 60 * 60000); // plenty of room
      const followingQuantity = 240;

      const breakId = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'break', null, gen_random_uuid(), $3, $4, 'manual')
           returning id`,
          [target!.id, deviceId, breakStart, breakOldEnd]
        )
      ).rows[0].id;
      const followingId = (
        await pool.query(
          `insert into time_entries
             (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
              density_type, density_count_per_row)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', 'plants', $6)
           returning id`,
          [target!.id, deviceId, activity!.id, followingOldStart, followingEnd, followingQuantity]
        )
      ).rows[0].id;

      const correctedEnd = new Date(breakOldEnd.getTime() + 4 * 60000 + 18 * 1000); // ~1:00:00 PM equivalent
      const res = await callAdmin("PATCH", `/api/inputs/breaks/${breakId}`, adminToken, {
        endTime: correctedEnd.toISOString(),
      });
      check(
        res.status === 200,
        "G2) correcting a non-contiguous historical break's end succeeds instead of rejecting with an overlap error",
        res.body
      );

      const breakAfter = await fetchEntry(breakId);
      check(
        new Date(breakAfter.ended_at).getTime() === correctedEnd.getTime(),
        "G2) the break's end is saved exactly as corrected",
        breakAfter
      );

      const { rows: followingRows } = await pool.query(
        `select started_at, ended_at, activity_id, density_count_per_row from time_entries where id = $1`,
        [followingId]
      );
      const followingAfter = followingRows[0];
      check(
        new Date(followingAfter.started_at).getTime() === correctedEnd.getTime(),
        "G2) the following work entry's start is dragged to share the break's new end boundary — closing the old 3-second gap",
        { followingAfter, correctedEnd }
      );
      check(
        new Date(followingAfter.ended_at).getTime() === followingEnd.getTime(),
        "G2) the following work entry's own end time is preserved",
        followingAfter
      );
      check(
        followingAfter.activity_id === activity!.id &&
          Number(followingAfter.density_count_per_row) === followingQuantity,
        "G2) the following work entry's activity and completed production quantity are preserved",
        followingAfter
      );

      const { rows: followingCorrections } = await pool.query(
        `select field_name, old_value, new_value from time_entry_corrections where time_entry_id = $1`,
        [followingId]
      );
      check(
        followingCorrections.some(
          (c) =>
            c.field_name === "started_at" &&
            new Date(c.old_value).getTime() === followingOldStart.getTime() &&
            new Date(c.new_value).getTime() === correctedEnd.getTime()
        ),
        "G2) the reconciled following entry gets its own audit row (old gap-having start -> new shared boundary)",
        followingCorrections
      );
    }

    // -----------------------------------------------------------------
    // G3) Symmetric case: correcting a break's START reconciles the
    //     PRECEDING work entry's END to match, again for a non-exactly-
    //     contiguous historical pair.
    // -----------------------------------------------------------------
    {
      // Corrections first: G (and, on the second occurrence of this
      // block, G2) leaves a corrected entry in place with a
      // time_entry_corrections row referencing it (FK).
      await pool.query(`delete from time_entry_corrections where employee_id = $1`, [target!.id]);
      await pool.query(`delete from time_entries where employee_id = $1`, [target!.id]);
      const deviceId = deviceIds[deviceIds.length - 1];

      const precedingStart = new Date(Date.now() - 180 * 60000);
      const precedingOldEnd = new Date(Date.now() - 120 * 60000);
      // A 2-second gap before the break's old start, same "not exactly
      // contiguous historical data" simulation as G2.
      const breakOldStart = new Date(precedingOldEnd.getTime() + 2000);
      const breakEnd = new Date(breakOldStart.getTime() + 15 * 60000);

      const precedingId = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual')
           returning id`,
          [target!.id, deviceId, activity!.id, precedingStart, precedingOldEnd]
        )
      ).rows[0].id;
      const breakId = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'break', null, gen_random_uuid(), $3, $4, 'manual')
           returning id`,
          [target!.id, deviceId, breakOldStart, breakEnd]
        )
      ).rows[0].id;

      const correctedStart = new Date(breakOldStart.getTime() - 6 * 60000); // moved earlier
      const res = await callAdmin("PATCH", `/api/inputs/breaks/${breakId}`, adminToken, {
        startTime: correctedStart.toISOString(),
      });
      check(
        res.status === 200,
        "G3) correcting a non-contiguous historical break's start succeeds instead of rejecting with an overlap error",
        res.body
      );

      const { rows: precedingRows } = await pool.query(`select started_at, ended_at from time_entries where id = $1`, [
        precedingId,
      ]);
      const precedingAfter = precedingRows[0];
      check(
        new Date(precedingAfter.ended_at).getTime() === correctedStart.getTime(),
        "G3) the preceding work entry's end is dragged earlier to share the break's new start boundary",
        { precedingAfter, correctedStart }
      );
      check(
        new Date(precedingAfter.started_at).getTime() === precedingStart.getTime(),
        "G3) the preceding work entry's own start time is preserved",
        precedingAfter
      );
    }

    // -----------------------------------------------------------------
    // H) GET /api/inputs/daily surfaces startedAtOriginalTime/
    //    endedAtOriginalTime for a rounded break, and totals are computed
    //    from the rounded (not raw) values — the exact bug reported
    //    against the Inputs page's "Workday details" table.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      // A clean slate — totals below must reflect exactly the one break
      // this section creates, not any leftover entries from earlier
      // sections that happen to fall on the same calendar date. Corrections
      // first: G above leaves a corrected break in place with a
      // time_entry_corrections row referencing it (FK).
      await pool.query(`delete from time_entry_corrections where employee_id = $1`, [target!.id]);
      await pool.query(`delete from time_entries where employee_id = $1`, [target!.id]);
      await setBreakRounding(true, "clockwise", 15);
      const workStart = new Date(Date.now() - 60 * 60000);
      await openWorkEntry(workStart, deviceIds[deviceIds.length - 1]);
      await callDevice("POST", "/api/mobile/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      let openBreak = await fetchOpenEntry();
      await pool.query(`update time_entries set is_paid = false where id = $1`, [openBreak.id]);

      await setBreakRounding(true, "counter_clockwise", 10);
      await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
      const closedBreak = await fetchEntry(openBreak.id);

      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(workStart);
      const dailyRes = await callAdmin(
        "GET",
        `/api/inputs/daily?employeeId=${target!.id}&date=${date}`,
        adminToken
      );
      check(dailyRes.status === 200, "H) GET /api/inputs/daily succeeds", dailyRes.body);

      const breakDto = dailyRes.body?.breaks?.find((b: any) => b.id === openBreak.id);
      check(!!breakDto, "H) the rounded break appears in the response", dailyRes.body?.breaks);
      check(
        breakDto?.startedAtOriginalTime != null &&
          new Date(breakDto.startedAtOriginalTime).getTime() === new Date(openBreak.actual_started_at).getTime(),
        "H) startedAtOriginalTime carries the raw tap time",
        breakDto
      );
      check(
        breakDto?.endedAtOriginalTime != null &&
          new Date(breakDto.endedAtOriginalTime).getTime() === new Date(closedBreak.actual_ended_at).getTime(),
        "H) endedAtOriginalTime carries the raw tap time",
        breakDto
      );
      check(
        new Date(breakDto.startedAt).getTime() === new Date(openBreak.started_at).getTime() &&
          new Date(breakDto.endedAt).getTime() === new Date(closedBreak.ended_at).getTime(),
        "H) startedAt/endedAt in the response are the rounded (effective) values",
        breakDto
      );
      const expectedDurationSeconds = Math.round(
        (new Date(closedBreak.ended_at).getTime() - new Date(openBreak.started_at).getTime()) / 1000
      );
      check(
        breakDto.durationSeconds === expectedDurationSeconds,
        "H) durationSeconds is computed from the rounded values, not the raw taps",
        { breakDto, expectedDurationSeconds }
      );
      check(
        dailyRes.body?.totals?.unpaidBreakSeconds === expectedDurationSeconds,
        "H) totals.unpaidBreakSeconds is computed from the same rounded values shown in the table",
        { totals: dailyRes.body?.totals, expectedDurationSeconds }
      );
    }

    // -----------------------------------------------------------------
    // I) A profile whose break-rounding columns were never touched (pure
    //    migration defaults) behaves identically to one explicitly
    //    disabled — "historical profiles remain unchanged."
    // -----------------------------------------------------------------
    {
      const historicalProfile = (
        await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
          `QA BR Historical Profile ${RUN_ID}`,
        ])
      ).rows[0];
      const { rows: defaults } = await pool.query(
        `select break_rounding_enabled, break_rounding_direction, break_rounding_interval_minutes
         from break_profiles where id = $1`,
        [historicalProfile.id]
      );
      check(
        defaults[0].break_rounding_enabled === false &&
          defaults[0].break_rounding_direction === "clockwise" &&
          defaults[0].break_rounding_interval_minutes === 5,
        "I) a brand-new profile defaults to break rounding disabled",
        defaults[0]
      );

      await pool.query(`update employees set break_profile_id = $1 where id = $2`, [
        historicalProfile.id,
        target!.id,
      ]);
      const deviceIdentifier = await pairDevice();
      const workStart = new Date(Date.now() - 60 * 60000);
      await openWorkEntry(workStart, deviceIds[deviceIds.length - 1]);
      await callDevice("POST", "/api/mobile/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
      });
      const openBreak = await fetchOpenEntry();
      check(
        openBreak.actual_started_at === null,
        "I) an untouched (default) profile never rounds a break start",
        openBreak
      );
      await callDevice("POST", "/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });

      await pool.query(`update employees set break_profile_id = $1 where id = $2`, [profile!.id, target!.id]);
      await pool.query(`delete from break_profiles where id = $1`, [historicalProfile.id]);
    }

    // -----------------------------------------------------------------
    // J) Settings persistence: saving via PATCH /api/break-profiles/:id
    //    and reloading via GET returns the same values, independent of
    //    work-start/work-end rounding's own fields.
    // -----------------------------------------------------------------
    {
      const saveRes = await callAdmin("PATCH", `/api/break-profiles/${profile!.id}`, adminToken, {
        workStartRoundingEnabled: true,
        workStartRoundingDirection: "clockwise",
        workStartRoundingIntervalMinutes: 5,
        workEndRoundingEnabled: false,
        breakRoundingEnabled: true,
        breakRoundingDirection: "counter_clockwise",
        breakRoundingIntervalMinutes: 20,
      });
      check(saveRes.status === 200, "J) saving break rounding alongside the other sections succeeds", saveRes.body);
      check(
        saveRes.body?.breakProfile?.breakRoundingEnabled === true &&
          saveRes.body?.breakProfile?.breakRoundingDirection === "counter_clockwise" &&
          saveRes.body?.breakProfile?.breakRoundingIntervalMinutes === 20,
        "J) the save response reflects the saved break-rounding settings",
        saveRes.body?.breakProfile
      );
      check(
        saveRes.body?.breakProfile?.workStartRoundingEnabled === true &&
          saveRes.body?.breakProfile?.workEndRoundingEnabled === false,
        "J) work-start/work-end settings saved in the same request are unaffected by break rounding",
        saveRes.body?.breakProfile
      );

      const reloadRes = await callAdmin("GET", `/api/break-profiles/${profile!.id}`, adminToken);
      check(
        reloadRes.body?.breakProfile?.breakRoundingEnabled === true &&
          reloadRes.body?.breakProfile?.breakRoundingDirection === "counter_clockwise" &&
          reloadRes.body?.breakProfile?.breakRoundingIntervalMinutes === 20,
        "J) reopening the profile returns the saved break-rounding values",
        reloadRes.body?.breakProfile
      );

      // Now change ONLY work-end rounding and confirm break rounding's
      // saved values are untouched — proves the two are genuinely
      // independent, not just independently settable in the same request.
      const secondSave = await callAdmin("PATCH", `/api/break-profiles/${profile!.id}`, adminToken, {
        workEndRoundingEnabled: true,
        workEndRoundingDirection: "clockwise",
        workEndRoundingIntervalMinutes: 10,
      });
      check(
        secondSave.body?.breakProfile?.breakRoundingEnabled === true &&
          secondSave.body?.breakProfile?.breakRoundingDirection === "counter_clockwise" &&
          secondSave.body?.breakProfile?.breakRoundingIntervalMinutes === 20,
        "J) toggling only work-end rounding leaves break rounding's saved settings untouched",
        secondSave.body?.breakProfile
      );
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    await tryDelete("time_entry_corrections", () =>
      pool.query(
        `delete from time_entry_corrections where employee_id in (select id from employees where email like $1)`,
        [`qa-br-%-${RUN_ID}@test.local`]
      )
    );
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-br-%-${RUN_ID}@test.local`,
      ])
    );
    await tryDelete("device_assignments", () =>
      pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds])
    );
    await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    for (const employee of [target, adminActor]) {
      if (employee) await tryDelete("employees", () => pool.query("delete from employees where id = $1", [employee.id]));
    }
    if (activity) await tryDelete("activities", () => pool.query("delete from activities where id = $1", [activity!.id]));
    if (profile) {
      await tryDelete("break_profile_items", () =>
        pool.query("delete from break_profile_items where break_profile_id = $1", [profile!.id])
      );
      await tryDelete("break_profiles", () => pool.query("delete from break_profiles where id = $1", [profile!.id]));
    }
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
