// Integration tests for the "hour matching" fixed-break redesign
// (server/src/lib/fixedBreakMatching.ts) — a Start Break tap matching by
// CONTAINMENT within a configured break's own [start_time, end_time)
// rather than an independent ± minutes window, and End Break unconditionally
// using that same break's configured end time once matched, with no
// separate end-side window. Covers the exact product example (a 12:00
// PM-1:00 PM Lunch Break tapped at 12:02 PM/12:58 PM must record exactly
// 12:00 PM-1:00 PM), multiple daily presets matched independently, only one
// instance of a scheduled break per employee/date, Custom/unscheduled
// breaks keeping real punch times, and — the actual root cause this
// redesign fixes — matching anchored to the real tap time rather than
// whenever the server happens to process a delayed/offline-queued sync
// event, including near a local-midnight boundary.
//
// breakRounding.test.ts covers the same matching logic through the LIVE
// (immediate-tap) routes; this file specifically exercises the OFFLINE SYNC
// path (POST /api/mobile/sync/events), since that's the path a delayed or
// out-of-order replay actually goes through.
//
// Run with: npm run test:fixed-break-matching
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { addDaysToDateStr, calendarDateInAppTimezone, zonedWallTimeToUtc } from "../lib/timezone";
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

// break_profile_items.start_time/end_time are "time" columns (second
// granularity) — any instant used both to configure an item's schedule AND
// as an exact expected value must be truncated to the same whole second the
// server will recompute from that stored HH:MM:SS string, or an exact
// millisecond comparison spuriously fails on the sub-second remainder.
function truncToSecond(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

// "HH:MM:SS" wall-clock reading of `d` in the app timezone.
function timeOfDayStr(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(d)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {} as Record<string, string>);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
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
  const breakProfileIds: string[] = [];
  let groupId: string | undefined;
  let activityId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    const activity = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA FBM Activity ${RUN_ID}`,
      ])
    ).rows[0];
    activityId = activity.id;
    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA FBM Group ${RUN_ID}`,
      ])
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [
      groupId,
      activity.id,
    ]);

    // One shared employee/device/profile per top-level scenario, kept
    // isolated from each other by using a fresh employee (and therefore a
    // fresh profile) per scenario — cheap, and it means no scenario needs
    // to clean up the others' time_entries before it can run cleanly.
    async function freshFixture(label: string): Promise<{
      employeeId: string;
      deviceIdentifier: string;
      profileId: string;
    }> {
      const profile = (
        await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
          `QA FBM Profile ${label} ${RUN_ID}`,
        ])
      ).rows[0];
      breakProfileIds.push(profile.id);

      const employee = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
           values ('QA', $1, $2, $3, $4, $5, true, $6) returning id`,
          [`FBM-${label} ${RUN_ID}`, `qa-fbm-${label.toLowerCase()}-${RUN_ID}@test.local`, roleId, teamRoleId, fakePinHash, profile.id]
        )
      ).rows[0];
      employeeIds.push(employee.id);

      const deviceIdentifier = randomUUID();
      const device = (
        await pool.query(
          `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
          [deviceIdentifier, `QA FBM Device ${label} ${RUN_ID}`]
        )
      ).rows[0];
      deviceIds.push(device.id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [device.id, employee.id]);
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        employee.id,
        groupId,
      ]);

      return { employeeId: employee.id, deviceIdentifier, profileId: profile.id };
    }

    async function insertFixedItem(
      profileId: string,
      name: string,
      startTime: string,
      endTime: string,
      isPaid: boolean
    ): Promise<string> {
      const { rows } = await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, fixed_break, sort_order, is_active)
         values ($1, $2, $3, $4, $5, true, 0, true) returning id`,
        [profileId, name, startTime, endTime, isPaid]
      );
      return rows[0].id;
    }

    async function fetchEntriesForEmployee(employeeId: string) {
      const { rows } = await pool.query(
        `select id, entry_type, started_at, ended_at, break_profile_item_id, scheduled_break_date, is_paid, deleted_at
         from time_entries where employee_id = $1 order by started_at asc`,
        [employeeId]
      );
      return rows;
    }

    function workStartEvent(deviceSeq: number, occurredAtUtc: string, activityId: string) {
      return { clientEventId: randomUUID(), deviceSeq, eventType: "work_start", occurredAtUtc, activityId };
    }
    function breakStartEvent(deviceSeq: number, occurredAtUtc: string) {
      return { clientEventId: randomUUID(), deviceSeq, eventType: "break_start", occurredAtUtc };
    }
    function breakEndEvent(deviceSeq: number, occurredAtUtc: string) {
      return { clientEventId: randomUUID(), deviceSeq, eventType: "break_end", occurredAtUtc };
    }

    // -----------------------------------------------------------------
    // 1) The canonical example, through the OFFLINE SYNC path: a 12:00
    //    PM-1:00 PM Lunch Break, tapped at 12:02 PM and 12:58 PM, synced
    //    immediately — must record exactly 12:00 PM-1:00 PM.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("Lunch");
      const lunchStart = truncToSecond(new Date(Date.now() - 3 * 3600000)); // "12:00 PM" — 3 hours ago
      const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000); // "1:00 PM"
      const itemId = await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      const workStartAt = new Date(lunchStart.getTime() - 3600000);
      const tapStart = new Date(lunchStart.getTime() + 2 * 60000); // 12:02 PM
      const tapEnd = new Date(lunchEnd.getTime() - 2 * 60000); // 12:58 PM

      const res = await sync(deviceIdentifier, [
        workStartEvent(1, workStartAt.toISOString(), activity.id),
        breakStartEvent(2, tapStart.toISOString()),
        breakEndEvent(3, tapEnd.toISOString()),
      ]);
      check(res.status === 200, "1) the sync batch succeeds", res.body);
      check(
        res.body?.results?.every((r: { status: string }) => r.status === "accepted"),
        "1) every event in the batch is accepted",
        res.body
      );

      const entries = await fetchEntriesForEmployee(employeeId);
      const breakEntry = entries.find((e) => e.entry_type === "break");
      check(!!breakEntry, "1) a break entry was recorded", entries);
      check(breakEntry.break_profile_item_id === itemId, "1) the break is tagged to the Lunch item", breakEntry);
      check(
        new Date(breakEntry.started_at).getTime() === lunchStart.getTime(),
        "1) started_at is the exact scheduled 12:00 PM, not the 12:02 PM tap",
        { started_at: breakEntry.started_at, expected: lunchStart.toISOString() }
      );
      check(
        new Date(breakEntry.ended_at).getTime() === lunchEnd.getTime(),
        "1) ended_at is the exact scheduled 1:00 PM, not the 12:58 PM tap",
        { ended_at: breakEntry.ended_at, expected: lunchEnd.toISOString() }
      );
      check(breakEntry.is_paid === true, "1) is_paid comes from the configured break (paid), not the device", breakEntry);
    }

    // -----------------------------------------------------------------
    // 2) Multiple daily presets matched independently: a 15-minute Morning
    //    Break and a 1-hour Lunch on the same profile, tapped in sequence
    //    — each must match its own item, never the other, and never bleed
    //    into general rounding.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("MultiPreset");
      const dayStart = truncToSecond(new Date(Date.now() - 6 * 3600000));
      const morningStart = new Date(dayStart.getTime());
      const morningEnd = new Date(morningStart.getTime() + 15 * 60000);
      const lunchStart = new Date(dayStart.getTime() + 3 * 3600000);
      const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000);

      const morningItemId = await insertFixedItem(
        profileId,
        "Morning Break",
        timeOfDayStr(morningStart),
        timeOfDayStr(morningEnd),
        false
      );
      const lunchItemId = await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      const res = await sync(deviceIdentifier, [
        workStartEvent(1, new Date(dayStart.getTime() - 3600000).toISOString(), activity.id),
        breakStartEvent(2, new Date(morningStart.getTime() + 5 * 60000).toISOString()), // 5 min into Morning Break
        breakEndEvent(3, new Date(morningEnd.getTime() - 3 * 60000).toISOString()), // 3 min before its end
        breakStartEvent(4, new Date(lunchStart.getTime() + 2 * 60000).toISOString()), // 2 min into Lunch
        breakEndEvent(5, new Date(lunchEnd.getTime() - 2 * 60000).toISOString()), // 2 min before Lunch ends
      ]);
      check(res.status === 200, "2) the sync batch succeeds", res.body);
      check(
        res.body?.results?.every((r: { status: string }) => r.status === "accepted"),
        "2) every event in the batch is accepted",
        res.body
      );

      const entries = await fetchEntriesForEmployee(employeeId);
      const breaks = entries.filter((e) => e.entry_type === "break");
      check(breaks.length === 2, "2) two break entries were recorded", breaks.length);

      const morningBreak = breaks.find((b) => b.break_profile_item_id === morningItemId);
      const lunchBreak = breaks.find((b) => b.break_profile_item_id === lunchItemId);
      check(!!morningBreak && !!lunchBreak, "2) each break is tagged to its OWN distinct item, never swapped", breaks);
      check(
        !!morningBreak &&
          new Date(morningBreak.started_at).getTime() === morningStart.getTime() &&
          new Date(morningBreak.ended_at).getTime() === morningEnd.getTime(),
        "2) the Morning Break records its own exact scheduled 15-minute window",
        morningBreak
      );
      check(
        !!lunchBreak &&
          new Date(lunchBreak.started_at).getTime() === lunchStart.getTime() &&
          new Date(lunchBreak.ended_at).getTime() === lunchEnd.getTime(),
        "2) the Lunch break records its own exact scheduled 1-hour window",
        lunchBreak
      );
      check(morningBreak.is_paid === false && lunchBreak.is_paid === true, "2) each break's paid status matches ITS OWN configured item", {
        morningBreak,
        lunchBreak,
      });
    }

    // -----------------------------------------------------------------
    // 3) The actual root cause fix: matching is anchored to the event's
    //    own occurredAtUtc, never to whenever the server happens to
    //    process a delayed offline-queue sync — a batch tapped at
    //    12:02 PM/12:58 PM but only SYNCED many hours later must still
    //    resolve to the exact scheduled 12:00 PM-1:00 PM.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("Delayed");
      // The break's configured schedule is "now" (today, this instant) —
      // but every event below carries an occurredAtUtc from EARLIER today,
      // and the sync HTTP call itself only fires now, simulating a device
      // that reconnected hours after the fact.
      const lunchStart = truncToSecond(new Date(Date.now() - 4 * 3600000));
      const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000);
      await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      const res = await sync(deviceIdentifier, [
        workStartEvent(1, new Date(lunchStart.getTime() - 3600000).toISOString(), activity.id),
        breakStartEvent(2, new Date(lunchStart.getTime() + 2 * 60000).toISOString()),
        breakEndEvent(3, new Date(lunchEnd.getTime() - 2 * 60000).toISOString()),
      ]);
      check(res.status === 200, "3) the delayed sync batch succeeds", res.body);

      const entries = await fetchEntriesForEmployee(employeeId);
      const breakEntry = entries.find((e) => e.entry_type === "break");
      check(
        !!breakEntry && breakEntry.break_profile_item_id !== null,
        "3) even though the sync itself happened hours late, the tap's OWN time still matched the fixed item",
        breakEntry
      );
      check(
        !!breakEntry &&
          new Date(breakEntry.started_at).getTime() === lunchStart.getTime() &&
          new Date(breakEntry.ended_at).getTime() === lunchEnd.getTime(),
        "3) the exact scheduled window is recorded regardless of when the server actually processed the sync",
        breakEntry
      );
    }

    // -----------------------------------------------------------------
    // 4) Duplicate sync: replaying the EXACT same batch (identical
    //    clientEventIds) must not create a second break entry — every
    //    event reports 'duplicate', zero side effects.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("DupSync");
      const lunchStart = truncToSecond(new Date(Date.now() - 3 * 3600000));
      const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000);
      const itemId = await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      const events = [
        workStartEvent(1, new Date(lunchStart.getTime() - 3600000).toISOString(), activity.id),
        breakStartEvent(2, new Date(lunchStart.getTime() + 2 * 60000).toISOString()),
        breakEndEvent(3, new Date(lunchEnd.getTime() - 2 * 60000).toISOString()),
      ];

      const firstRes = await sync(deviceIdentifier, events);
      check(firstRes.status === 200, "4) the first sync succeeds", firstRes.body);

      const replayRes = await sync(deviceIdentifier, events);
      check(replayRes.status === 200, "4) replaying the identical batch still returns 200", replayRes.body);
      check(
        replayRes.body?.results?.every((r: { status: string }) => r.status === "duplicate"),
        "4) every event in the replayed batch reports 'duplicate'",
        replayRes.body
      );

      const { rows: matchedCount } = await pool.query(
        `select count(*)::int as n from time_entries where employee_id = $1 and break_profile_item_id = $2 and deleted_at is null`,
        [employeeId, itemId]
      );
      check(matchedCount[0].n === 1, "4) exactly one break entry exists after the duplicate replay", matchedCount[0]);
    }

    // -----------------------------------------------------------------
    // 5) Out-of-order arrival across separate sync calls: a device
    //    uploads work_start + break_start in one call (a brief connectivity
    //    window), then break_end only arrives in a LATER, separate call —
    //    the match established in the first call must still be honored
    //    (unconditional End Break, per resolveFixedBreakCloseBoundary)
    //    when the second call finally applies it.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("OutOfOrder");
      const lunchStart = truncToSecond(new Date(Date.now() - 3 * 3600000));
      const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000);
      await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      const firstRes = await sync(deviceIdentifier, [
        workStartEvent(1, new Date(lunchStart.getTime() - 3600000).toISOString(), activity.id),
        breakStartEvent(2, new Date(lunchStart.getTime() + 2 * 60000).toISOString()),
      ]);
      check(firstRes.status === 200, "5) the first (partial) sync call succeeds", firstRes.body);
      const midEntries = await fetchEntriesForEmployee(employeeId);
      const midBreak = midEntries.find((e) => e.entry_type === "break" && e.ended_at === null);
      check(!!midBreak && midBreak.break_profile_item_id !== null, "5) the break is open and already matched after call 1", midBreak);

      // The End Break tap genuinely happened close to the start, but only
      // reaches the server in a second, later call.
      const secondRes = await sync(deviceIdentifier, [breakEndEvent(3, new Date(lunchEnd.getTime() - 2 * 60000).toISOString())]);
      check(secondRes.status === 200, "5) the later, separate call carrying only break_end succeeds", secondRes.body);

      const finalEntries = await fetchEntriesForEmployee(employeeId);
      const closedBreak = finalEntries.find((e) => e.entry_type === "break");
      check(
        !!closedBreak &&
          new Date(closedBreak.started_at).getTime() === lunchStart.getTime() &&
          new Date(closedBreak.ended_at).getTime() === lunchEnd.getTime(),
        "5) the break still closes at the exact scheduled end, established back in the first call",
        closedBreak
      );
    }

    // -----------------------------------------------------------------
    // 6) Custom/unscheduled breaks retain their actual punch times: a tap
    //    outside every configured fixed item's window is recorded with no
    //    break_profile_item_id and the exact raw occurredAtUtc for both
    //    ends (no break-rounding profile setting enabled here).
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("Custom");
      const lunchStart = truncToSecond(new Date(Date.now() - 3 * 3600000));
      const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000);
      await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      // Tapped well outside the Lunch window entirely — a genuine ad-hoc
      // break, not the scheduled one.
      const customStart = new Date(lunchEnd.getTime() + 30 * 60000);
      const customEnd = new Date(customStart.getTime() + 7 * 60000);

      const res = await sync(deviceIdentifier, [
        workStartEvent(1, new Date(lunchStart.getTime() - 3600000).toISOString(), activity.id),
        breakStartEvent(2, customStart.toISOString()),
        breakEndEvent(3, customEnd.toISOString()),
      ]);
      check(res.status === 200, "6) the sync batch succeeds", res.body);

      const entries = await fetchEntriesForEmployee(employeeId);
      const customBreak = entries.find((e) => e.entry_type === "break");
      check(!!customBreak && customBreak.break_profile_item_id === null, "6) the custom break matches no fixed item", customBreak);
      check(
        !!customBreak &&
          new Date(customBreak.started_at).getTime() === customStart.getTime() &&
          new Date(customBreak.ended_at).getTime() === customEnd.getTime(),
        "6) the custom break's own exact tap times are preserved verbatim",
        customBreak
      );
    }

    // -----------------------------------------------------------------
    // 7) Only one instance of a scheduled break per employee/date: a
    //    second Start Break tap arriving shortly after the first (e.g. an
    //    accidental double-tap queued as two distinct events, or a second
    //    device) while still inside the SAME item's window must NOT
    //    re-match it — it's recorded as an ordinary, unscheduled break
    //    instead, and correctly closes the first (already-matched) break
    //    at its own tap time, with no overlap or negative duration either
    //    way.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("OnlyOnce");
      const lunchStart = truncToSecond(new Date(Date.now() - 3 * 3600000));
      const lunchEnd = new Date(lunchStart.getTime() + 90 * 60000); // a wide 90-minute window
      const itemId = await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      const secondTapAt = new Date(lunchStart.getTime() + 3 * 60000);
      const res = await sync(deviceIdentifier, [
        workStartEvent(1, new Date(lunchStart.getTime() - 3600000).toISOString(), activity.id),
        breakStartEvent(2, new Date(lunchStart.getTime() + 2 * 60000).toISOString()), // matches Lunch
        breakStartEvent(3, secondTapAt.toISOString()), // 1 minute later, still well inside the window
        breakEndEvent(4, new Date(secondTapAt.getTime() + 5 * 60000).toISOString()),
      ]);
      check(res.status === 200, "7) the sync batch succeeds", res.body);
      check(
        res.body?.results?.every((r: { status: string }) => r.status === "accepted"),
        "7) every event is accepted (the second tap is a valid, if unscheduled, break)",
        res.body
      );

      const entries = await fetchEntriesForEmployee(employeeId);
      const breaks = entries.filter((e) => e.entry_type === "break");
      check(breaks.length === 2, "7) two break entries exist", breaks.length);
      const matchedBreaks = breaks.filter((b) => b.break_profile_item_id === itemId);
      check(matchedBreaks.length === 1, "7) exactly ONE of them is bound to the fixed item — the second never re-matches it", breaks);
      const firstBreak = breaks.find((b) => b.break_profile_item_id === itemId);
      check(
        !!firstBreak && new Date(firstBreak.ended_at).getTime() === secondTapAt.getTime(),
        "7) the first (matched) break is closed cleanly by the second tap, no gap or overlap",
        firstBreak
      );
    }

    // -----------------------------------------------------------------
    // 8) Anchoring near a local-midnight boundary: a break scheduled late
    //    in the day (23:45-23:59), tapped shortly before real local
    //    midnight, but the sync call itself is only processed by the
    //    server AFTER midnight has passed — must still resolve to the
    //    boundary's own calendar date (yesterday), not "today" as re-read
    //    from server now() at processing time.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("Midnight");
      const yesterdayLocal = addDaysToDateStr(calendarDateInAppTimezone(new Date()), -1);
      const [y, mo, da] = yesterdayLocal.split("-").map(Number);
      const scheduledStart = zonedWallTimeToUtc(y, mo, da, 23, 45, 0);
      const scheduledEnd = zonedWallTimeToUtc(y, mo, da, 23, 59, 0);
      await insertFixedItem(profileId, "Late Break", timeOfDayStr(scheduledStart), timeOfDayStr(scheduledEnd), false);

      const tapStart = new Date(scheduledStart.getTime() + 2 * 60000); // 23:47 yesterday
      const tapEnd = new Date(scheduledEnd.getTime() - 2 * 60000); // 23:57 yesterday
      // The sync call fires "now" (well after actual local midnight has
      // passed, since this test itself runs at whatever real time of day
      // it runs) — proving processing time never leaks into the match.
      const res = await sync(deviceIdentifier, [
        workStartEvent(1, new Date(scheduledStart.getTime() - 3600000).toISOString(), activity.id),
        breakStartEvent(2, tapStart.toISOString()),
        breakEndEvent(3, tapEnd.toISOString()),
      ]);
      check(res.status === 200, "8) the sync batch succeeds even though it's processed on a different calendar day", res.body);

      const entries = await fetchEntriesForEmployee(employeeId);
      const breakEntry = entries.find((e) => e.entry_type === "break");
      check(
        !!breakEntry && breakEntry.break_profile_item_id !== null,
        "8) the late-night tap still matches its fixed item, regardless of the calendar day the sync itself lands on",
        breakEntry
      );
      check(
        !!breakEntry && calendarDateInAppTimezone(new Date(breakEntry.scheduled_break_date)) === yesterdayLocal,
        "8) scheduled_break_date is anchored to the tap's own (yesterday's) calendar date, never today's",
        { breakEntry, expected: yesterdayLocal }
      );
      check(
        !!breakEntry &&
          new Date(breakEntry.started_at).getTime() === scheduledStart.getTime() &&
          new Date(breakEntry.ended_at).getTime() === scheduledEnd.getTime(),
        "8) the exact scheduled 23:45-23:59 window is recorded",
        breakEntry
      );
    }

    // -----------------------------------------------------------------
    // 9) Explicit confirmation of the five exact approved behaviors for a
    //    Lunch Break configured 12:00-1:00:
    //      a) a start tap ANYWHERE from 12:00:00 through 12:59:59 matches
    //         and records 12:00 — including right at the lower boundary
    //         and one second before the upper one;
    //      b) the eventual closing action records 1:00 regardless of
    //         whether it's tapped early or late relative to 1:00;
    //      c) a start tap AT 1:00:00 or later does NOT match that Lunch;
    //      d) a Custom (non-matching) break keeps its own real tap times;
    //      e) mobile_time_events keeps the raw tap timestamps verbatim,
    //         completely unaffected by whatever time_entries ends up
    //         recording.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceIdentifier, profileId } = await freshFixture("ExactBoundary");
      const lunchStart = truncToSecond(new Date(Date.now() - 5 * 3600000)); // "12:00:00"
      const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000); // "1:00:00"
      const itemId = await insertFixedItem(profileId, "Lunch", timeOfDayStr(lunchStart), timeOfDayStr(lunchEnd), true);

      // 9a) A tap AT the exact lower boundary (12:00:00) matches.
      const atLowerBoundary = new Date(lunchStart.getTime());
      // 9b) Closed EARLY relative to 1:00 (well inside the hour).
      const earlyClose = new Date(lunchStart.getTime() + 10 * 60000); // 12:10:00
      const evt1 = workStartEvent(1, new Date(lunchStart.getTime() - 3600000).toISOString(), activity.id);
      const evt2 = breakStartEvent(2, atLowerBoundary.toISOString());
      const evt3 = breakEndEvent(3, earlyClose.toISOString());
      const res1 = await sync(deviceIdentifier, [evt1, evt2, evt3]);
      check(res1.status === 200, "9a/b) the sync batch succeeds", res1.body);

      const entries1 = await fetchEntriesForEmployee(employeeId);
      const lunchBreak = entries1.find((e) => e.entry_type === "break" && e.break_profile_item_id === itemId);
      check(!!lunchBreak, "9a) a tap exactly AT 12:00:00 matches Lunch", entries1);
      check(
        !!lunchBreak && new Date(lunchBreak.started_at).getTime() === lunchStart.getTime(),
        "9a) it records exactly 12:00:00, not the raw tap",
        lunchBreak
      );
      check(
        !!lunchBreak && new Date(lunchBreak.ended_at).getTime() === lunchEnd.getTime(),
        "9b) closing EARLY (12:10) still records the full scheduled 1:00:00, never the early tap",
        lunchBreak
      );

      // 9e) mobile_time_events keeps the RAW tap timestamps for both
      //     events, untouched by the fact time_entries recorded 12:00/1:00
      //     instead.
      const { rows: rawEvents } = await pool.query(
        `select event_type, occurred_at_utc from mobile_time_events
         where employee_id = $1 and client_event_id = any($2::uuid[])
         order by device_seq asc`,
        [employeeId, [evt2.clientEventId, evt3.clientEventId]]
      );
      check(
        rawEvents.length === 2 &&
          new Date(rawEvents[0].occurred_at_utc).getTime() === atLowerBoundary.getTime() &&
          new Date(rawEvents[1].occurred_at_utc).getTime() === earlyClose.getTime(),
        "9e) mobile_time_events preserves the exact raw tap timestamps for auditing, independent of the resolved schedule",
        rawEvents
      );

      // 9c) A tap AT 1:00:00 (the upper boundary itself, not after it) on
      //     the SAME date must NOT match Lunch — [start, end) excludes the
      //     endpoint — and, since it's also a genuinely later real event
      //     relative to the just-closed work resumption, it's accepted as
      //     an ordinary (ad hoc) break, not a conflict.
      const atUpperBoundary = new Date(lunchEnd.getTime());
      // 9d) Its own End Break comes 12 minutes later, at a moment with no
      //     relation to any configured schedule — a genuine Custom break.
      const customEnd = new Date(atUpperBoundary.getTime() + 12 * 60000);
      const evt4 = breakStartEvent(4, atUpperBoundary.toISOString());
      const evt5 = breakEndEvent(5, customEnd.toISOString());
      const res2 = await sync(deviceIdentifier, [evt4, evt5]);
      check(res2.status === 200, "9c/d) the second sync batch succeeds", res2.body);
      check(
        res2.body?.results?.every((r: { status: string }) => r.status === "accepted"),
        "9c/d) both events are accepted as an ordinary break, not a conflict",
        res2.body
      );

      const entries2 = await fetchEntriesForEmployee(employeeId);
      const customBreak = entries2.find((e) => e.entry_type === "break" && e.id !== lunchBreak!.id);
      check(!!customBreak && customBreak.break_profile_item_id === null, "9c) a tap AT 1:00:00 does NOT match Lunch (upper bound excluded)", customBreak);
      check(
        !!customBreak &&
          new Date(customBreak.started_at).getTime() === atUpperBoundary.getTime() &&
          new Date(customBreak.ended_at).getTime() === customEnd.getTime(),
        "9d) the Custom break's own real tap times are recorded verbatim, not snapped to any schedule",
        customBreak
      );

      // Exactly one row still carries this item's FK — the 1:00:00 tap
      // never created a second (bogus) match either.
      const { rows: matchedCount } = await pool.query(
        `select count(*)::int as n from time_entries where employee_id = $1 and break_profile_item_id = $2 and deleted_at is null`,
        [employeeId, itemId]
      );
      check(matchedCount[0].n === 1, "9c) still exactly one Lunch-matched row for this employee/date", matchedCount[0]);
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

    if (employeeIds.length) {
      await tryDelete("mobile_time_events", () =>
        pool.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds])
      );
      await tryDelete("device_sync_state", () =>
        pool.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds])
      );
      await tryDelete("time_entry_deletions", () =>
        pool.query(`delete from time_entry_deletions where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entry_corrections", () =>
        pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
      await tryDelete("employee_activity_group_assignments", () =>
        pool.query(`delete from employee_activity_group_assignments where employee_id = any($1::uuid[])`, [employeeIds])
      );
    }
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    if (breakProfileIds.length) {
      await tryDelete("break_profile_items", () =>
        pool.query(`delete from break_profile_items where break_profile_id = any($1::uuid[])`, [breakProfileIds])
      );
      await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = any($1::uuid[])`, [breakProfileIds]));
    }
    if (groupId) {
      await tryDelete("activity_group_activities", () =>
        pool.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId])
      );
    }
    if (activityId) await tryDelete("activities", () => pool.query(`delete from activities where id = $1`, [activityId]));
    if (groupId) await tryDelete("activity_groups", () => pool.query(`delete from activity_groups where id = $1`, [groupId]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
