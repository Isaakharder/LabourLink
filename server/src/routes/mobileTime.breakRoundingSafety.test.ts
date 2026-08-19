// Reproduces and locks in the fix for the reported "critical error": an
// employee's Inputs page showed dozens of ~1-second "Break" entries
// repeating every few seconds, plus a handful of physically-impossible
// negative-duration entries. Root cause traced to two bugs in
// mobileTime.ts's break/start and break/end handlers:
//
//   1) POST /time-entries/break/end's fixed-break-item schedule match set
//      the break's end time (overrides.startedAt) directly from the
//      item's scheduled end-of-day time, with NO check that it landed
//      after the break's own actual start — unlike the general
//      break-rounding path a few lines below, which already had this
//      guard. A scheduled end earlier than the break's real start produced
//      ended_at <= started_at.
//   2) Neither break route accepted a client-reported original tap time
//      (unlike POST /time-entries/work's clientStartedAt). A batch of
//      actions replayed from the offline queue (web/src/lib/
//      offlineQueue.ts) after connectivity returns all got rounded
//      against REPLAY time instead of each one's own true tap moment —
//      several taps landing within the same rounding instant fed the
//      floor-guard fallback (`if (rounded <= floor) rounded = floor +
//      1000`) into a runaway cascade of ever-advancing, essentially fake
//      timestamps, one second apart, completely decoupled from real time.
//
// Also covers migration 040's new chk_time_entries_ended_after_started
// constraint — the hard backstop against this class of corruption from
// ANY code path, known or future.
//
// Run with: npm run test:break-rounding-safety
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { zonedWallTimeParts } from "../lib/timezone";
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
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function callDevice(path: string, deviceIdentifier: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  let target!: { id: string };
  let profile!: { id: string };
  let activity!: { id: string };
  const deviceIds: string[] = [];
  const deviceIdentifiers: string[] = [];
  const itemIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    profile = (
      await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
        `QA Break Safety Profile ${RUN_ID}`,
      ])
    ).rows[0];

    activity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA Break Safety Activity ${RUN_ID}`,
      ])
    ).rows[0];

    target = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ('QA', $1, $2, $3, $4, $5, true, $6) returning id`,
        [`Break Safety Target ${RUN_ID}`, `qa-break-safety-target-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash, profile!.id]
      )
    ).rows[0];

    async function pairDevice(): Promise<string> {
      const identifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [identifier, `QA Break Safety Device ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      deviceIdentifiers.push(identifier);
      await pool.query(`update device_assignments set unassigned_at = now() where employee_id = $1 and unassigned_at is null`, [target!.id]);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, target!.id]);
      return identifier;
    }

    async function setBreakRounding(enabled: boolean, direction: "clockwise" | "counter_clockwise", minutes: number) {
      await pool.query(
        `update break_profiles set break_rounding_enabled = $1, break_rounding_direction = $2, break_rounding_interval_minutes = $3 where id = $4`,
        [enabled, direction, minutes, profile!.id]
      );
    }

    async function openWorkEntry(startedAt: Date, deviceId: string): Promise<void> {
      await pool.query(
        `update time_entries set ended_at = greatest(now(), started_at + interval '1 second') where employee_id = $1 and ended_at is null`,
        [target!.id]
      );
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
         values ($1, $2, 'work', $3, gen_random_uuid(), $4, 'manual')`,
        [target!.id, deviceId, activity!.id, startedAt]
      );
    }

    async function fetchOpenEntry() {
      const { rows } = await pool.query(
        `select id, entry_type, started_at, ended_at from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
        [target!.id]
      );
      return rows[0];
    }
    async function fetchEntry(id: string) {
      const { rows } = await pool.query(`select id, entry_type, started_at, ended_at from time_entries where id = $1`, [id]);
      return rows[0];
    }

    // -----------------------------------------------------------------
    // 1) The missing floor-guard bug: a fixed-break-item's scheduled END
    //    time can land BEFORE the break's own actual start when the
    //    break's START was itself rounded significantly forward by the
    //    GENERAL rounding path (a large clockwise interval, unmatched by
    //    this item — its own start_time is set hours away so it can't
    //    match) — must never produce a negative duration; the guard now
    //    applies the same fallback the general rounding path already had.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setBreakRounding(true, "clockwise", 30); // large interval so break/start rounds well into the future
      const now0 = new Date();
      await openWorkEntry(new Date(now0.getTime() - 60 * 60000), deviceIds[deviceIds.length - 1]);

      // This item's own start_time is 6 hours away (can never match
      // break/start's 10-minute window — the break's start is decided by
      // general rounding instead, below), but its end_time is "now" —
      // squarely inside break/end's 10-minute end window when that call
      // happens moments later, even though by then the break's own start
      // has already been rounded up to the next half-hour boundary.
      const itemRes = await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, fixed_break, fixed_start_window_minutes, fixed_end_window_minutes, sort_order, is_active)
         values ($1, $2, $3, $4, false, true, 10, 10, 0, true) returning id`,
        [profile!.id, `QA Safety Item ${RUN_ID}`, timeOfDayStr(new Date(now0.getTime() - 6 * 3600000)), timeOfDayStr(now0)]
      );
      itemIds.push(itemRes.rows[0].id);

      const startRes = await callDevice("/api/mobile/time-entries/break/start", deviceIdentifier, { idempotencyKey: randomUUID() });
      check(startRes.status === 200, "1) break/start (unmatched — general rounding applies) succeeds", startRes.body);
      const openBreak = await fetchOpenEntry();
      check(openBreak?.entry_type === "break", "1) a break is now open", openBreak);
      check(
        new Date(openBreak.started_at).getTime() > now0.getTime(),
        "1) the break's start was rounded forward, past the fixed item's end_time (setting up the conflict)",
        openBreak
      );

      const endRes = await callDevice("/api/mobile/time-entries/break/end", deviceIdentifier, { idempotencyKey: randomUUID() });
      check(endRes.status === 200, "1) break/end (fixed-item end match, scheduled end before break start) succeeds", endRes.body);

      const closed = await fetchEntry(openBreak.id);
      check(
        new Date(closed.ended_at).getTime() > new Date(closed.started_at).getTime(),
        "1) the break has a strictly positive duration — never negative, even with an already-past scheduled end",
        closed
      );

      await pool.query(`update break_profile_items set is_active = false where id = $1`, [itemIds[itemIds.length - 1]]);
    }

    // -----------------------------------------------------------------
    // 2) The offline-replay cascade: two break actions fired back-to-back
    //    in REAL time (simulating a queued replay burst) but carrying
    //    their own true, well-separated clientStartedAt/clientEndedAt
    //    must produce a break duration reflecting that REAL gap — not a
    //    degenerate ~1-second artifact from rounding against replay time.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setBreakRounding(true, "clockwise", 15); // Reynaldo's real profile settings
      const now0 = new Date();
      // Comfortably before trueTapStart below — a break can't start before
      // the work session containing it did.
      await openWorkEntry(new Date(now0.getTime() - 90 * 60000), deviceIds[deviceIds.length - 1]);

      // The employee's phone actually tapped Start Break 50 minutes ago,
      // then End Break 35 minutes ago (a real 35-minute break) — but both
      // requests are only being SENT now (a replayed offline-queue
      // burst), back to back with no real delay between them. Both taps
      // are safely in the past (resolveOriginalTimestamp only rejects a
      // client timestamp that's implausibly far in the FUTURE relative to
      // when the server actually processes it — see workStartRounding.ts's
      // MAX_CLIENT_CLOCK_SKEW_FUTURE_MS), and far enough apart (35 min,
      // more than double the 15-minute rounding interval) that they can't
      // coincidentally collapse into the same rounded bucket the way a
      // genuinely-short break legitimately can.
      const trueTapStart = new Date(now0.getTime() - 50 * 60000);
      const trueTapEnd = new Date(now0.getTime() - 15 * 60000);

      const startRes = await callDevice("/api/mobile/time-entries/break/start", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientStartedAt: trueTapStart.toISOString(),
      });
      check(startRes.status === 200, "2) break/start with a client-reported past tap time succeeds", startRes.body);
      const openBreak = await fetchOpenEntry();

      // Fired immediately — no artificial delay — simulating the queue's
      // own tight replay loop.
      const endRes = await callDevice("/api/mobile/time-entries/break/end", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: trueTapEnd.toISOString(),
      });
      check(endRes.status === 200, "2) break/end (fired immediately after, with its own true tap time) succeeds", endRes.body);

      const closed = await fetchEntry(openBreak.id);
      const durationMinutes = (new Date(closed.ended_at).getTime() - new Date(closed.started_at).getTime()) / 60000;
      check(
        durationMinutes >= 20 && durationMinutes <= 50,
        "2) the recorded break duration reflects the TRUE ~35-minute tap gap, not a ~0-second replay-time artifact",
        { closed, durationMinutes }
      );
    }

    // -----------------------------------------------------------------
    // 3) A batch of MULTIPLE rapid-fire break start/end pairs (the actual
    //    reported shape — dozens of taps replayed in a tight loop), each
    //    with its own genuinely-incrementing, well-separated client tap
    //    time (comfortably more than the 15-minute rounding interval
    //    apart, so a real gap can never coincidentally land in the same
    //    rounded bucket the way a genuinely-short break legitimately
    //    can), must never collapse into a chain of ~1-second entries —
    //    each pair's duration should reflect its own real, multi-minute
    //    gap, even though every HTTP call fires back-to-back with no real
    //    delay (simulating the queue's own tight replay loop).
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setBreakRounding(true, "clockwise", 15);
      const now0 = new Date();
      // Far enough in the past that 4 pairs of (20-minute break + 20-minute
      // work gap) still land entirely before "now" — resolveOriginalTimestamp
      // has no backward bound at all (see workStartRounding.ts), so this is
      // just about the test's own arithmetic staying self-consistent, not
      // about clearing any server-side limit.
      await openWorkEntry(new Date(now0.getTime() - 6 * 3600000), deviceIds[deviceIds.length - 1]);

      let cursor = new Date(now0.getTime() - 4 * 3600000);
      const durations: number[] = [];
      for (let i = 0; i < 4; i++) {
        const tapStart = cursor;
        const tapEnd = new Date(tapStart.getTime() + 20 * 60000); // 20 real minutes later
        await callDevice("/api/mobile/time-entries/break/start", deviceIdentifier, {
          idempotencyKey: randomUUID(),
          clientStartedAt: tapStart.toISOString(),
        });
        const open = await fetchOpenEntry();
        await callDevice("/api/mobile/time-entries/break/end", deviceIdentifier, {
          idempotencyKey: randomUUID(),
          clientEndedAt: tapEnd.toISOString(),
        });
        const closed = await fetchEntry(open.id);
        durations.push((new Date(closed.ended_at).getTime() - new Date(closed.started_at).getTime()) / 60000);
        cursor = new Date(tapEnd.getTime() + 20 * 60000); // next tap 20 real minutes after this one ended
      }
      check(
        durations.every((d) => d >= 10),
        "3) none of the 4 rapid-replayed break pairs collapsed to a near-zero duration",
        durations
      );
    }

    // -----------------------------------------------------------------
    // 4) DB-level backstop: migration 040's constraint rejects ANY insert
    //    where ended_at is at or before started_at, regardless of which
    //    code path attempted it.
    // -----------------------------------------------------------------
    {
      const t = new Date();
      let rejected = false;
      try {
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source)
           values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual')`,
          [target!.id, t, new Date(t.getTime() - 1000)]
        );
      } catch (err) {
        rejected = (err as { code?: string }).code === "23514";
      }
      check(rejected, "4) a raw insert with ended_at before started_at is rejected by chk_time_entries_ended_after_started", rejected);

      let rejectedEqual = false;
      try {
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source)
           values ($1, null, 'break', gen_random_uuid(), $2, $2, 'manual')`,
          [target!.id, t]
        );
      } catch (err) {
        rejectedEqual = (err as { code?: string }).code === "23514";
      }
      check(rejectedEqual, "4) a raw insert with ended_at EQUAL to started_at (zero duration) is also rejected", rejectedEqual);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (target) await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = $1`, [target.id]));
    if (deviceIds.length) await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
    if (deviceIds.length) await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    if (itemIds.length) await tryDelete("break_profile_items", () => pool.query(`delete from break_profile_items where id = any($1::uuid[])`, [itemIds]));
    if (target) await tryDelete("employees", () => pool.query(`delete from employees where id = $1`, [target.id]));
    if (activity) await tryDelete("activities", () => pool.query(`delete from activities where id = $1`, [activity.id]));
    if (profile) await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = $1`, [profile.id]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
