// HTTP-level tests for work-end rounding: POST /api/mobile/time-entries/
// end-day (mobileTime.ts), the manual end-time correction route (inputs.ts)
// clearing stale rounding audit data, and the Break Profile settings
// save/reload round trip (breakProfiles.ts). Runs the real routers over
// real HTTP against the real database with disposable QA fixtures, same
// convention as inputs.manualEntries.test.ts / inputs.performance.test.ts.
//
// Pure rounding-math coverage (both directions, exact boundaries, seconds,
// midnight/DST) lives in workStartRounding.test.ts alongside roundWorkStart
// — roundWorkEnd is the exact same math, just named for its call site. This
// file covers what's genuinely new: the end-day route's own behavior
// (disabled, enabled, short-workday clamp, offline retry/idempotency,
// immediate-idle-on-future-round), manual corrections staying exact, and
// settings persistence/independence.
//
// Run with: npm run test:work-end-rounding
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { roundWorkEnd } from "../lib/workStartRounding";
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
// Every clientEndedAt sent through the HTTP API is bounds-checked by
// resolveOriginalEndedAt against the REAL server clock (trusted only within
// [-5min future, 24h past] — see workStartRounding.ts). A fixed past QA
// calendar date (the pattern used elsewhere for started_at, which is
// inserted directly via SQL and never bounds-checked) would fall far outside
// that window and get silently replaced with "now", defeating every
// assertion below. So every timestamp here is built relative to the real
// "now" captured once at startup, using minute offsets rather than any
// literal date — safe regardless of what real time this script happens to
// run at, and never a genuine clock-skew case as far as the server's own
// bounds-check is concerned.
const testNow = new Date();
function minutesAgo(n: number): Date {
  return new Date(testNow.getTime() - n * 60000);
}
// Snaps a reference instant backward to the nearest exact interval boundary
// (reusing the already-independently-tested roundWorkEnd math purely as a
// fixture-construction convenience, not as the thing under test) — gives a
// stable anchor to build "1 minute past the boundary" / "N-1 minutes past
// the boundary" cases from, without depending on what minute-of-hour the
// real clock happens to be at.
function boundaryNear(n: number, intervalMinutes: number): Date {
  return roundWorkEnd(minutesAgo(n), intervalMinutes, "counter_clockwise");
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
          `WER Admin ${RUN_ID}`,
          `qa-wer-admin-${RUN_ID}@test.local`,
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
      await pool.query(
        `insert into break_profiles (name, is_active) values ($1, true) returning id`,
        [`QA Work End Rounding Profile ${RUN_ID}`]
      )
    ).rows[0];
    // A profile needs at least one scheduled break item per the app's own
    // domain rules elsewhere, but nothing about work-end rounding requires
    // one — this profile intentionally has none, proving rounding doesn't
    // depend on the scheduled-break list at all.

    activity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA Work End Rounding Activity ${RUN_ID}`,
      ])
    ).rows[0];

    target = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ($1, $2, $3, $4, $5, $6, true, $7) returning id`,
        [
          "QA",
          `WER Target ${RUN_ID}`,
          `qa-wer-target-${RUN_ID}@test.local`,
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
        [identifier, `QA WER Device ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      deviceIdentifiers.push(identifier);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [
        rows[0].id,
        target!.id,
      ]);
      return identifier;
    }

    async function setRounding(enabled: boolean, direction: "clockwise" | "counter_clockwise", minutes: number) {
      await pool.query(
        `update break_profiles
         set work_end_rounding_enabled = $1, work_end_rounding_direction = $2, work_end_rounding_interval_minutes = $3
         where id = $4`,
        [enabled, direction, minutes, profile!.id]
      );
    }

    async function openWorkEntry(startedAt: Date): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
         values ($1, $2, 'work', $3, gen_random_uuid(), $4, 'manual')
         returning id`,
        [target!.id, deviceIds[deviceIds.length - 1], activity!.id, startedAt]
      );
      return rows[0].id;
    }

    async function fetchEntry(id: string) {
      const { rows } = await pool.query(
        `select ended_at, actual_ended_at, started_at from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }

    // -----------------------------------------------------------------
    // A) Rounding disabled — exact clientEndedAt stored, no rounding.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(false, "clockwise", 5);
      const startedAt = minutesAgo(200);
      await openWorkEntry(startedAt);
      const clientEndedAt = new Date(minutesAgo(153).getTime() + 12000); // ~47min later, +12s
      const res = await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: clientEndedAt.toISOString(),
      });
      check(res.status === 200 && res.body?.status === "idle", "A) end-day succeeds and status is idle", res.body);

      const { rows } = await pool.query(
        `select id, ended_at, actual_ended_at from time_entries where employee_id = $1 and started_at = $2`,
        [target!.id, startedAt]
      );
      check(
        new Date(rows[0].ended_at).getTime() === clientEndedAt.getTime(),
        "A) rounding disabled: ended_at is the exact unrounded tap time",
        rows[0]
      );
      check(rows[0].actual_ended_at === null, "A) rounding disabled: actual_ended_at stays null", rows[0]);
    }

    // -----------------------------------------------------------------
    // B) Rounding enabled, clockwise.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(true, "clockwise", 5);
      const b = boundaryNear(260, 5);
      const startedAt = new Date(b.getTime() - 90 * 60000);
      const entryId = await openWorkEntry(startedAt);
      const clientEndedAt = new Date(b.getTime() + 1 * 60000); // 1 minute past the boundary
      const expected = new Date(b.getTime() + 5 * 60000); // clockwise rounds forward to the next one
      const res = await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: clientEndedAt.toISOString(),
      });
      check(res.status === 200, "B) end-day succeeds", res.body);
      const row = await fetchEntry(entryId);
      check(
        new Date(row.ended_at).getTime() === expected.getTime(),
        "B) clockwise: 1 minute past a boundary rounds forward to the next one",
        { row, expected }
      );
      check(
        new Date(row.actual_ended_at).getTime() === clientEndedAt.getTime(),
        "B) actual_ended_at holds the original tap time",
        row
      );
    }

    // -----------------------------------------------------------------
    // C) Rounding enabled, counter-clockwise.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(true, "counter_clockwise", 5);
      const b = boundaryNear(320, 5);
      const startedAt = new Date(b.getTime() - 90 * 60000);
      const entryId = await openWorkEntry(startedAt);
      const clientEndedAt = new Date(b.getTime() + 4 * 60000); // 4 minutes past the boundary (not exact)
      await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: clientEndedAt.toISOString(),
      });
      const row = await fetchEntry(entryId);
      check(
        new Date(row.ended_at).getTime() === b.getTime(),
        "C) counter-clockwise: 4 minutes past a boundary rounds backward to it",
        { row, expected: b }
      );
    }

    // -----------------------------------------------------------------
    // D) Exact boundary tap — ended_at unchanged, actual_ended_at still
    //    set (same "always set when enabled" convention as work-start).
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(true, "clockwise", 5);
      const b = boundaryNear(380, 5);
      const startedAt = new Date(b.getTime() - 90 * 60000);
      const entryId = await openWorkEntry(startedAt);
      const clientEndedAt = b; // already an exact 5-minute boundary
      await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: clientEndedAt.toISOString(),
      });
      const row = await fetchEntry(entryId);
      check(
        new Date(row.ended_at).getTime() === clientEndedAt.getTime(),
        "D) an exact boundary tap is left unchanged",
        row
      );
      check(
        row.actual_ended_at !== null && new Date(row.actual_ended_at).getTime() === clientEndedAt.getTime(),
        "D) actual_ended_at is still set (equal to ended_at) even though rounding changed nothing",
        row
      );
    }

    // -----------------------------------------------------------------
    // E) Very short workday — counter-clockwise rounding that would fall
    //    at/before the entry's own start must never be applied; falls
    //    back to the unrounded tap time instead.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(true, "counter_clockwise", 5);
      const startedAt = boundaryNear(440, 5); // start exactly on a boundary
      const entryId = await openWorkEntry(startedAt);
      // 2 minutes into the same 5-minute bucket the entry started in —
      // counter-clockwise would naively round back down to that same
      // boundary, i.e. exactly the entry's own start. Still guarded
      // against (ended == started is invalid, not just ended < started).
      const clientEndedAt = new Date(startedAt.getTime() + 2 * 60000);
      const res = await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: clientEndedAt.toISOString(),
      });
      check(res.status === 200, "E) end-day still succeeds for a very short workday", res.body);
      const row = await fetchEntry(entryId);
      check(
        new Date(row.ended_at).getTime() === clientEndedAt.getTime(),
        "E) rounding that would land at/before the start falls back to the exact unrounded tap time",
        row
      );
      check(
        new Date(row.ended_at).getTime() > new Date(row.started_at).getTime(),
        "E) the resulting duration is strictly positive",
        row
      );
    }

    // -----------------------------------------------------------------
    // F) Offline retry / idempotency — replaying the same idempotencyKey
    //    (and the same preserved clientEndedAt, as a real retry would
    //    resend) must not round twice, change the stored value, or
    //    create another entry.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(true, "clockwise", 10);
      const b = boundaryNear(500, 10);
      const startedAt = new Date(b.getTime() - 90 * 60000);
      const entryId = await openWorkEntry(startedAt);
      const clientEndedAt = new Date(b.getTime() + 1 * 60000); // 1 minute past the boundary
      const expected = new Date(b.getTime() + 10 * 60000);
      const key = randomUUID();

      const first = await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: key,
        clientEndedAt: clientEndedAt.toISOString(),
      });
      check(first.status === 200, "F) first end-day call succeeds", first.body);
      const afterFirst = await fetchEntry(entryId);
      check(
        new Date(afterFirst.ended_at).getTime() === expected.getTime(),
        "F) first call rounds forward to the next 10-minute boundary",
        { afterFirst, expected }
      );

      const second = await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: key,
        clientEndedAt: clientEndedAt.toISOString(),
      });
      check(second.status === 200 && second.body?.status === "idle", "F) replay is a safe no-op", second.body);
      const afterSecond = await fetchEntry(entryId);
      check(
        new Date(afterSecond.ended_at).getTime() === new Date(afterFirst.ended_at).getTime() &&
          new Date(afterSecond.actual_ended_at).getTime() === new Date(afterFirst.actual_ended_at).getTime(),
        "F) replaying does not re-round or change the stored values",
        { afterFirst, afterSecond }
      );

      const { rows: allRows } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and started_at = $2`,
        [target!.id, startedAt]
      );
      check(Number(allRows[0].count) === 1, "F) replaying never creates a duplicate entry", allRows[0]);
    }

    // -----------------------------------------------------------------
    // G) Clockwise rounding into the future — status must be idle in the
    //    very same response, not "still active until the clock catches
    //    up."
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(true, "clockwise", 60);
      // b is the current hour's floor (0-59:59 minutes in the past, always).
      // 1 minute past it, clockwise-rounded on a 60-minute interval, lands
      // on the *next* hour boundary — which is therefore always strictly
      // after the real "now" this test is running at, regardless of what
      // minute within the hour that happens to be.
      const b = roundWorkEnd(testNow, 60, "counter_clockwise");
      const startedAt = new Date(b.getTime() - 30 * 60000);
      await openWorkEntry(startedAt);
      const clientEndedAt = new Date(b.getTime() + 1 * 60000);
      const res = await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: clientEndedAt.toISOString(),
      });
      check(
        res.status === 200 && res.body?.status === "idle",
        "G) a clockwise round-forward into the future still reports idle immediately",
        res.body
      );
    }

    // -----------------------------------------------------------------
    // H) Manual correction clears actual_ended_at and stores the exact
    //    administratively-entered value — never re-rounded.
    // -----------------------------------------------------------------
    {
      const deviceIdentifier = await pairDevice();
      await setRounding(true, "clockwise", 5);
      const b = boundaryNear(90, 5);
      const startedAt = new Date(b.getTime() - 30 * 60000);
      const entryId = await openWorkEntry(startedAt);
      await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: new Date(b.getTime() + 1 * 60000).toISOString(),
      });
      const beforeCorrection = await fetchEntry(entryId);
      check(beforeCorrection.actual_ended_at !== null, "H) the entry has rounding audit data before correction");

      const correctedEnd = new Date(b.getTime() + 3 * 60000 + 30000); // deliberately not a rounding boundary
      const correctionRes = await callAdmin(
        "PATCH",
        `/api/inputs/activity-runs/${entryId}/end-time`,
        adminToken,
        { endTime: correctedEnd.toISOString() }
      );
      check(correctionRes.status === 200, "H) the manual correction succeeds", correctionRes.body);

      const afterCorrection = await fetchEntry(entryId);
      check(
        new Date(afterCorrection.ended_at).getTime() === correctedEnd.getTime(),
        "H) the corrected end time is stored exactly, not rounded",
        afterCorrection
      );
      check(
        afterCorrection.actual_ended_at === null,
        "H) actual_ended_at is cleared — the stale 'Rounded' badge no longer applies",
        afterCorrection
      );
    }

    // -----------------------------------------------------------------
    // I) A profile whose work-end rounding columns were never touched
    //    (pure migration defaults) behaves identically to one explicitly
    //    disabled — "historical profiles remain unchanged."
    // -----------------------------------------------------------------
    {
      const historicalProfile = (
        await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
          `QA WER Historical Profile ${RUN_ID}`,
        ])
      ).rows[0];
      const { rows: defaults } = await pool.query(
        `select work_end_rounding_enabled, work_end_rounding_direction, work_end_rounding_interval_minutes
         from break_profiles where id = $1`,
        [historicalProfile.id]
      );
      check(
        defaults[0].work_end_rounding_enabled === false &&
          defaults[0].work_end_rounding_direction === "clockwise" &&
          defaults[0].work_end_rounding_interval_minutes === 5,
        "I) a brand-new profile defaults to work-end rounding disabled",
        defaults[0]
      );

      await pool.query(`update employees set break_profile_id = $1 where id = $2`, [
        historicalProfile.id,
        target!.id,
      ]);
      const deviceIdentifier = await pairDevice();
      const startedAt = minutesAgo(120);
      const entryId = await openWorkEntry(startedAt);
      const clientEndedAt = new Date(minutesAgo(87).getTime() + 17000); // ~33min later, +17s
      await callDevice("POST", "/api/mobile/time-entries/end-day", deviceIdentifier, {
        idempotencyKey: randomUUID(),
        clientEndedAt: clientEndedAt.toISOString(),
      });
      const row = await fetchEntry(entryId);
      check(
        new Date(row.ended_at).getTime() === clientEndedAt.getTime() && row.actual_ended_at === null,
        "I) an untouched (default) profile never rounds — exact tap time stored, no audit column set",
        row
      );

      // Put the employee back on the main QA profile before the historical
      // one is dropped, otherwise the FK from employees.break_profile_id
      // blocks the delete.
      await pool.query(`update employees set break_profile_id = $1 where id = $2`, [profile!.id, target!.id]);
      await pool.query(`delete from break_profiles where id = $1`, [historicalProfile.id]);
    }

    // -----------------------------------------------------------------
    // J) Settings persistence: saving via PATCH /api/break-profiles/:id
    //    and reloading via GET returns the same values, independent of
    //    work-start rounding's own fields.
    // -----------------------------------------------------------------
    {
      // Reset the employee back onto the main QA profile for a clean save.
      await pool.query(`update employees set break_profile_id = $1 where id = $2`, [profile!.id, target!.id]);

      const saveRes = await callAdmin("PATCH", `/api/break-profiles/${profile!.id}`, adminToken, {
        workStartRoundingEnabled: true,
        workStartRoundingDirection: "counter_clockwise",
        workStartRoundingIntervalMinutes: 15,
        workEndRoundingEnabled: true,
        workEndRoundingDirection: "clockwise",
        workEndRoundingIntervalMinutes: 20,
      });
      check(saveRes.status === 200, "J) saving both rounding sections together succeeds", saveRes.body);
      check(
        saveRes.body?.breakProfile?.workEndRoundingEnabled === true &&
          saveRes.body?.breakProfile?.workEndRoundingDirection === "clockwise" &&
          saveRes.body?.breakProfile?.workEndRoundingIntervalMinutes === 20,
        "J) the save response reflects the saved work-end settings",
        saveRes.body?.breakProfile
      );
      check(
        saveRes.body?.breakProfile?.workStartRoundingDirection === "counter_clockwise" &&
          saveRes.body?.breakProfile?.workStartRoundingIntervalMinutes === 15,
        "J) work-start settings saved in the same request are independent and unaffected by the work-end ones",
        saveRes.body?.breakProfile
      );

      const reloadRes = await callAdmin("GET", `/api/break-profiles/${profile!.id}`, adminToken);
      check(
        reloadRes.body?.breakProfile?.workEndRoundingEnabled === true &&
          reloadRes.body?.breakProfile?.workEndRoundingDirection === "clockwise" &&
          reloadRes.body?.breakProfile?.workEndRoundingIntervalMinutes === 20,
        "J) reopening the profile returns the saved work-end values",
        reloadRes.body?.breakProfile
      );

      // Now change ONLY work-end rounding and confirm work-start's saved
      // values are untouched — proves the two are genuinely independent,
      // not just independently settable in the same request.
      const secondSave = await callAdmin("PATCH", `/api/break-profiles/${profile!.id}`, adminToken, {
        workEndRoundingEnabled: false,
      });
      check(
        secondSave.body?.breakProfile?.workStartRoundingEnabled === true &&
          secondSave.body?.breakProfile?.workStartRoundingDirection === "counter_clockwise" &&
          secondSave.body?.breakProfile?.workStartRoundingIntervalMinutes === 15,
        "J) toggling only work-end rounding off leaves work-start rounding's saved settings untouched",
        secondSave.body?.breakProfile
      );
      check(
        secondSave.body?.breakProfile?.workEndRoundingEnabled === false,
        "J) work-end rounding itself did toggle off as requested",
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
        [`qa-wer-%-${RUN_ID}@test.local`]
      )
    );
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-wer-%-${RUN_ID}@test.local`,
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
    if (profile) await tryDelete("break_profiles", () => pool.query("delete from break_profiles where id = $1", [profile!.id]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
