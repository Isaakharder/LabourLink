// Integration test for POST /api/inputs/activity-runs/:id/delete's
// boundary-repair behavior: deleting an activity run must never silently
// move the employee's recorded work-start time. "Work start" is nothing
// but "the earliest surviving work entry for the day" (see GET /daily's
// own workStart derivation in inputs.ts) — so deleting the day's first
// activity used to promote whatever came after it into being the new work
// start, with zero audit trail. The fix: the activity immediately
// following the deleted one is extended backward to the deleted run's
// original start (same "existing audit system" convention as the boundary
// trims POST /activities already performs — see
// inputs.addActivityBoundaryTrim.test.ts), unless that next entry is a
// break, which is a protected boundary and is never crossed.
//
// Same real-HTTP-against-real-database convention as
// inputs.addActivityBoundaryTrim.test.ts / inputs.manualEntries.test.ts —
// no mocking, entries inserted directly via SQL (bypassing activity-group
// validation, which is irrelevant to deletion), deletion driven through the
// real route.
//
// Run with: npm run test:activity-run-deletion
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
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

// One QA-only date per scenario, far in the past and in a different
// month/year than other test files' own QA dates — collision is impossible
// either way since every fixture here is scoped to this file's own
// freshly-created employees, but this keeps failures easy to eyeball.
const DATE_FIRST_COMPLETED = "2019-06-03";
const DATE_FIRST_IN_PROGRESS = "2019-06-04";
const DATE_MIDDLE = "2019-06-05";
const DATE_BREAK_BOUNDARY = "2019-06-06";
const DATE_FINAL = "2019-06-07";

function dayBoundsUtc(y: number, m: number, d: number): { start: Date; end: Date } {
  const start = zonedWallTimeToUtc(y, m, d, 0, 0, 0);
  const end = zonedWallTimeToUtc(y, m, d + 1, 0, 0, 0);
  return { start, end };
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/inputs", inputsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  let adminActor!: { id: string; first_name: string; last_name: string };
  let target!: { id: string };
  let other!: { id: string };
  let activityOne!: { id: string };
  let activityTwo!: { id: string };

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
          `ARD Admin ${RUN_ID}`,
          `qa-ard-admin-${RUN_ID}@test.local`,
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

    target = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        ["QA", `ARD Target ${RUN_ID}`, `qa-ard-target-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    other = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        ["QA", `ARD Other ${RUN_ID}`, `qa-ard-other-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];

    activityOne = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA ARD Activity One ${RUN_ID}`,
      ])
    ).rows[0];
    activityTwo = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA ARD Activity Two ${RUN_ID}`,
      ])
    ).rows[0];

    // Alternating activityOne/activityTwo between adjacent entries in every
    // scenario below is deliberate, not decorative: groupIntoActivityRuns
    // merges two contiguous same-activity work rows into a single run, which
    // would make it impossible to delete "just the first one" — each
    // scenario needs genuinely separate, individually-deletable runs.
    async function insertWork(employeeId: string, activityId: string, startedAt: Date, endedAt: Date | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')
         returning id`,
        [employeeId, activityId, startedAt, endedAt]
      );
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, startedAt: Date, endedAt: Date | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual')
         returning id`,
        [employeeId, startedAt, endedAt]
      );
      return rows[0].id;
    }

    async function fetchEntry(id: string) {
      const { rows } = await pool.query(
        `select id, employee_id, entry_type, started_at, ended_at, actual_started_at, deleted_at,
                deleted_by_employee_id, deletion_reason
         from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }

    async function deleteRun(id: string) {
      return call("POST", `/api/inputs/activity-runs/${id}/delete`, { token: adminToken });
    }

    async function getDaily(employeeId: string, date: string) {
      return call("GET", `/api/inputs/daily?employeeId=${employeeId}&date=${date}`, { token: adminToken });
    }

    async function startedCorrectionFor(entryId: string) {
      const { rows } = await pool.query(
        `select time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason, changed_at
         from time_entry_corrections where time_entry_id = $1 and field_name = 'started_at'
         order by changed_at desc limit 1`,
        [entryId]
      );
      return rows[0];
    }

    async function deletionRowFor(affectedId: string) {
      const { rows } = await pool.query(
        `select employee_id, deleted_by_employee_id, deletion_type, affected_time_entry_ids, reason
         from time_entry_deletions where $1 = any(affected_time_entry_ids) order by deleted_at desc limit 1`,
        [affectedId]
      );
      return rows[0];
    }

    // -----------------------------------------------------------------
    // 1) The reported bug, end to end: work starts at 6:45, a 10-minute
    //    first activity runs 6:45-6:55, a second activity runs 6:55-7:30.
    //    Deleting the first activity must extend the second one back to
    //    6:45 — not leave the day's recorded work-start time at 6:55 — and
    //    must do so via the existing correction/deletion audit tables, with
    //    no gap or overlap left behind. Also proves employee scoping: a
    //    second employee with the identical timeline on the same date is
    //    completely unaffected by the deletion.
    // -----------------------------------------------------------------
    {
      const aStart = zonedWallTimeToUtc(2019, 6, 3, 6, 45, 0);
      const aEnd = zonedWallTimeToUtc(2019, 6, 3, 6, 55, 0);
      const bEnd = zonedWallTimeToUtc(2019, 6, 3, 7, 30, 0);
      const aId = await insertWork(target!.id, activityOne!.id, aStart, aEnd);
      const bId = await insertWork(target!.id, activityTwo!.id, aEnd, bEnd);

      // Employee-isolation control: an unrelated employee with the exact
      // same timeline on the same date — must be untouched by anything
      // below (requirement 7).
      const otherAId = await insertWork(other!.id, activityOne!.id, aStart, aEnd);
      const otherBId = await insertWork(other!.id, activityTwo!.id, aEnd, bEnd);

      const beforeDaily = await getDaily(target!.id, DATE_FIRST_COMPLETED);
      check(
        new Date(beforeDaily.body?.workStartTime).getTime() === aStart.getTime(),
        "1) before deletion, work start is 6:45 (the first activity's own start)",
        beforeDaily.body?.workStartTime
      );

      const delRes = await deleteRun(aId);
      check(delRes.status === 200, "1) deleting the first activity succeeds", delRes.body);

      const aAfter = await fetchEntry(aId);
      check(
        aAfter.deleted_at !== null &&
          aAfter.deleted_by_employee_id === adminActor!.id &&
          aAfter.deletion_reason === "Activity log deleted from Inputs page",
        "1) the deleted activity is soft-deleted with the admin and a fixed system-generated reason, no reason submitted by the caller",
        aAfter
      );

      const bAfter = await fetchEntry(bId);
      check(
        new Date(bAfter.started_at).getTime() === aStart.getTime(),
        "1) the following activity is extended backward to the deleted activity's original start (6:45)",
        bAfter
      );
      check(
        new Date(bAfter.ended_at).getTime() === bEnd.getTime(),
        "1) the following activity's own end time is untouched",
        bAfter
      );
      check(bAfter.actual_started_at === null, "1) a stale rounding badge on the extended entry is cleared", bAfter);

      const afterDaily = await getDaily(target!.id, DATE_FIRST_COMPLETED);
      check(
        new Date(afterDaily.body?.workStartTime).getTime() === aStart.getTime(),
        "1) [root cause] the employee's recorded work-start time (6:45) is unchanged after deletion",
        afterDaily.body?.workStartTime
      );

      const correction = await startedCorrectionFor(bId);
      check(
        !!correction &&
          correction.employee_id === target!.id &&
          correction.changed_by_employee_id === adminActor!.id &&
          new Date(correction.old_value).getTime() === aEnd.getTime() &&
          new Date(correction.new_value).getTime() === aStart.getTime() &&
          !!correction.reason &&
          correction.changed_at != null,
        "1) the extension is recorded in time_entry_corrections via the existing audit system",
        correction
      );

      const deletion = await deletionRowFor(aId);
      check(
        !!deletion &&
          deletion.employee_id === target!.id &&
          deletion.deleted_by_employee_id === adminActor!.id &&
          deletion.deletion_type === "activity_run" &&
          deletion.affected_time_entry_ids.length === 1 &&
          deletion.affected_time_entry_ids[0] === aId,
        "1) the deletion audit trail (time_entry_deletions) is preserved exactly as before",
        deletion
      );

      // 8) No overlap or unintended gap: exactly one surviving row now
      // covers precisely [6:45, 7:30) — the union of what were two entries,
      // with the deleted one's interval fully absorbed and no seam left.
      const { start: dayStart, end: dayEnd } = dayBoundsUtc(2019, 6, 3);
      const { rows: survivingTarget } = await pool.query(
        `select id, started_at, ended_at from time_entries
         where employee_id = $1 and started_at >= $2 and started_at < $3 and deleted_at is null
         order by started_at asc`,
        [target!.id, dayStart, dayEnd]
      );
      check(
        survivingTarget.length === 1 &&
          survivingTarget[0].id === bId &&
          new Date(survivingTarget[0].started_at).getTime() === aStart.getTime() &&
          new Date(survivingTarget[0].ended_at).getTime() === bEnd.getTime(),
        "8) exactly one entry survives, covering the full 6:45-7:30 span with no gap and no overlap",
        survivingTarget
      );

      // 7) The other employee's identical-looking timeline is completely
      // untouched — the "next entry" lookup is scoped by employee_id.
      const otherA = await fetchEntry(otherAId);
      const otherB = await fetchEntry(otherBId);
      check(
        otherA.deleted_at === null && new Date(otherA.started_at).getTime() === aStart.getTime(),
        "7) another employee's first activity is untouched",
        otherA
      );
      check(
        otherB.deleted_at === null && new Date(otherB.started_at).getTime() === aEnd.getTime(),
        "7) another employee's second activity is NOT extended — still starts at 6:55",
        otherB
      );
      const otherCorrection = await startedCorrectionFor(otherBId);
      check(!otherCorrection, "7) no correction row was ever written for another employee's entries", otherCorrection);
    }

    // -----------------------------------------------------------------
    // 2) Same first-activity-deleted scenario, but the following activity
    //    is still in progress (open, ended_at null) — must extend just the
    //    same way, and must stay open.
    // -----------------------------------------------------------------
    {
      const aStart = zonedWallTimeToUtc(2019, 6, 4, 8, 0, 0);
      const aEnd = zonedWallTimeToUtc(2019, 6, 4, 8, 10, 0);
      const aId = await insertWork(target!.id, activityOne!.id, aStart, aEnd);
      const bId = await insertWork(target!.id, activityTwo!.id, aEnd, null);

      const delRes = await deleteRun(aId);
      check(delRes.status === 200, "2) deleting the first activity succeeds", delRes.body);

      const bAfter = await fetchEntry(bId);
      check(
        new Date(bAfter.started_at).getTime() === aStart.getTime() && bAfter.ended_at === null,
        "2) the still-in-progress following activity is extended backward to 8:00 and stays open",
        bAfter
      );

      const daily = await getDaily(target!.id, DATE_FIRST_IN_PROGRESS);
      check(
        new Date(daily.body?.workStartTime).getTime() === aStart.getTime(),
        "2) recorded work-start time (8:00) is unchanged when the following activity is in progress",
        daily.body?.workStartTime
      );
    }

    // -----------------------------------------------------------------
    // 3) Deleting a MIDDLE activity extends only the immediately following
    //    activity, leaves everything earlier (including the true work
    //    start) completely untouched.
    // -----------------------------------------------------------------
    {
      const zStart = zonedWallTimeToUtc(2019, 6, 5, 6, 0, 0);
      const zEnd = zonedWallTimeToUtc(2019, 6, 5, 6, 15, 0);
      const aStart = zonedWallTimeToUtc(2019, 6, 5, 9, 0, 0);
      const aEnd = zonedWallTimeToUtc(2019, 6, 5, 9, 15, 0);
      const bEnd = zonedWallTimeToUtc(2019, 6, 5, 9, 30, 0); // the entry being deleted
      const cEnd = zonedWallTimeToUtc(2019, 6, 5, 10, 0, 0);

      const zId = await insertWork(target!.id, activityOne!.id, zStart, zEnd);
      const aId = await insertWork(target!.id, activityTwo!.id, aStart, aEnd);
      const bId = await insertWork(target!.id, activityOne!.id, aEnd, bEnd);
      const cId = await insertWork(target!.id, activityTwo!.id, bEnd, cEnd);

      const delRes = await deleteRun(bId);
      check(delRes.status === 200, "3) deleting the middle activity succeeds", delRes.body);

      const cAfter = await fetchEntry(cId);
      check(
        new Date(cAfter.started_at).getTime() === aEnd.getTime(),
        "3) the activity immediately following the deleted middle one extends backward to absorb it",
        cAfter
      );

      const aAfter = await fetchEntry(aId);
      check(
        new Date(aAfter.started_at).getTime() === aStart.getTime() && new Date(aAfter.ended_at).getTime() === aEnd.getTime(),
        "3) the activity BEFORE the deleted one is completely untouched",
        aAfter
      );
      const zAfter = await fetchEntry(zId);
      check(
        new Date(zAfter.started_at).getTime() === zStart.getTime() && zAfter.deleted_at === null,
        "6) an earlier, unrelated activity (the real work start) is unaffected by a later deletion",
        zAfter
      );

      const daily = await getDaily(target!.id, DATE_MIDDLE);
      check(
        new Date(daily.body?.workStartTime).getTime() === zStart.getTime(),
        "4) recorded work-start time is unchanged by a middle-of-day deletion",
        daily.body?.workStartTime
      );
    }

    // -----------------------------------------------------------------
    // 5) A break sitting immediately after the deleted activity is a
    //    protected boundary: the following activity on the far side of the
    //    break must NOT be extended across it, and the break itself must
    //    not be modified.
    // -----------------------------------------------------------------
    {
      const zStart = zonedWallTimeToUtc(2019, 6, 6, 6, 0, 0);
      const zEnd = zonedWallTimeToUtc(2019, 6, 6, 6, 15, 0);
      const aStart = zonedWallTimeToUtc(2019, 6, 6, 11, 0, 0);
      const aEnd = zonedWallTimeToUtc(2019, 6, 6, 11, 15, 0);
      const breakEnd = zonedWallTimeToUtc(2019, 6, 6, 11, 30, 0);
      const bEnd = zonedWallTimeToUtc(2019, 6, 6, 12, 0, 0);

      const zId = await insertWork(target!.id, activityOne!.id, zStart, zEnd);
      const aId = await insertWork(target!.id, activityTwo!.id, aStart, aEnd);
      const breakId = await insertBreak(target!.id, aEnd, breakEnd);
      const bId = await insertWork(target!.id, activityOne!.id, breakEnd, bEnd);

      const delRes = await deleteRun(aId);
      check(delRes.status === 200, "5) deleting the activity before a break succeeds", delRes.body);

      const breakAfter = await pool.query(`select started_at, ended_at, deleted_at from time_entries where id = $1`, [
        breakId,
      ]);
      check(
        new Date(breakAfter.rows[0].started_at).getTime() === aEnd.getTime() &&
          new Date(breakAfter.rows[0].ended_at).getTime() === breakEnd.getTime() &&
          breakAfter.rows[0].deleted_at === null,
        "5) the break itself is completely unmodified",
        breakAfter.rows[0]
      );

      const bAfter = await fetchEntry(bId);
      check(
        new Date(bAfter.started_at).getTime() === breakEnd.getTime(),
        "5) the activity on the far side of the break is NOT extended backward across it",
        bAfter
      );
      const correction = await startedCorrectionFor(bId);
      check(!correction, "5) no correction row is written for the entry across the break", correction);

      const zAfter = await fetchEntry(zId);
      const daily = await getDaily(target!.id, DATE_BREAK_BOUNDARY);
      check(
        zAfter.deleted_at === null &&
          new Date(zAfter.started_at).getTime() === zStart.getTime() &&
          new Date(daily.body?.workStartTime).getTime() === zStart.getTime(),
        "5) the day's real recorded work-start time is unaffected by the break-adjacent deletion",
        { zAfter, workStartTime: daily.body?.workStartTime }
      );
    }

    // -----------------------------------------------------------------
    // 6) Deleting the FINAL activity of the day (no following entry at
    //    all) deletes normally and touches nothing else.
    // -----------------------------------------------------------------
    {
      const aStart = zonedWallTimeToUtc(2019, 6, 7, 14, 0, 0);
      const aEnd = zonedWallTimeToUtc(2019, 6, 7, 14, 15, 0);
      const bEnd = zonedWallTimeToUtc(2019, 6, 7, 14, 45, 0);
      const aId = await insertWork(target!.id, activityOne!.id, aStart, aEnd);
      const bId = await insertWork(target!.id, activityTwo!.id, aEnd, bEnd);

      const delRes = await deleteRun(bId);
      check(delRes.status === 200, "6) deleting the final activity of the day succeeds", delRes.body);

      const aAfter = await fetchEntry(aId);
      check(
        new Date(aAfter.started_at).getTime() === aStart.getTime() &&
          new Date(aAfter.ended_at).getTime() === aEnd.getTime() &&
          aAfter.deleted_at === null,
        "6) the earlier, unrelated activity is completely unchanged",
        aAfter
      );
      const correction = await startedCorrectionFor(aId);
      check(!correction, "6) no correction row is written when there is no following activity to extend", correction);

      const daily = await getDaily(target!.id, DATE_FINAL);
      check(
        new Date(daily.body?.workStartTime).getTime() === aStart.getTime(),
        "4) recorded work-start time is unchanged when the deleted activity was the last of the day",
        daily.body?.workStartTime
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

    await tryDelete("time_entry_deletions", () =>
      pool.query(
        `delete from time_entry_deletions where employee_id in (select id from employees where email like $1)`,
        [`qa-ard-%-${RUN_ID}@test.local`]
      )
    );
    await tryDelete("time_entry_corrections", () =>
      pool.query(
        `delete from time_entry_corrections where employee_id in (select id from employees where email like $1)`,
        [`qa-ard-%-${RUN_ID}@test.local`]
      )
    );
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-ard-%-${RUN_ID}@test.local`,
      ])
    );
    for (const actor of [target, other, adminActor]) {
      if (actor) await tryDelete("employees", () => pool.query("delete from employees where id = $1", [actor.id]));
    }
    if (activityOne || activityTwo) {
      await tryDelete("activities", () =>
        pool.query("delete from activities where id = any($1::uuid[])", [
          [activityOne?.id, activityTwo?.id].filter(Boolean),
        ])
      );
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
