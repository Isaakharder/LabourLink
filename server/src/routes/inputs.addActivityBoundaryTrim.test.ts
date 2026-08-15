// Integration test for POST /api/inputs/activities' boundary-trim behavior:
// an admin's manually-inserted activity is authoritative for the time
// range they typed, so instead of always rejecting on overlap, a range
// that lands at the START or END of an existing entry trims that one
// boundary to make room (see planActivityInsertion in
// server/src/lib/manualTimeEntries.ts). Covers the reported scenario —
// PATCH /work-start backdates the day's first activity, then Add Activity
// fills in what the employee actually did before that activity's original
// start — plus production-data preservation, break preservation, the
// exact-boundary no-op case, and the cases that must still be blocked
// (would require a split, or would silently delete an entry).
//
// Same real-HTTP-against-real-database convention as
// inputs.manualEntries.test.ts / breakRounding.test.ts — no mocking.
//
// Run with: npm run test:add-activity-boundary-trim
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

// A week of QA-only dates, one scenario per day, chosen far in the past
// (a different year than inputs.manualEntries.test.ts's own QA dates,
// though collision is impossible either way — every fixture here is
// scoped to this file's own freshly-created employee).
const DATE_TRIM_BEGINNING = "2018-05-06";
const DATE_TRIM_END = "2018-05-07";
const DATE_DENSITY = "2018-05-08";
const DATE_BREAK_PRESERVED = "2018-05-09";
const DATE_EXACT_BOUNDARY = "2018-05-10";
const DATE_BLOCKED_SPLIT = "2018-05-11";
const DATE_BLOCKED_COVERS = "2018-05-12";

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
  let group!: { id: string };
  let plainActivity!: { id: string };
  let insertedActivity!: { id: string };
  let densityActivity!: { id: string };
  let land!: { id: string };
  let phase!: { id: string };
  let row!: { id: string };

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
          `AABT Admin ${RUN_ID}`,
          `qa-aabt-admin-${RUN_ID}@test.local`,
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
        ["QA", `AABT Target ${RUN_ID}`, `qa-aabt-target-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];

    // POST /activities runs every activityId through validateActivityAndAnswers
    // (activitySelection.ts) — same rule the mobile picker uses: the
    // activity must belong to one of the employee's assigned activity
    // groups. Unlike PATCH /work-start (which only adjusts an existing
    // entry's timestamp and never touches activityId), this file's other
    // scenarios all go through POST /activities, so this group/assignment
    // setup is required here even though inputs.manualEntries.test.ts
    // already separately covers the authorization rule itself.
    group = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA AABT Group ${RUN_ID}`,
      ])
    ).rows[0];

    plainActivity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA AABT Plain Activity ${RUN_ID}`,
      ])
    ).rows[0];
    insertedActivity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA AABT Inserted Activity ${RUN_ID}`,
      ])
    ).rows[0];
    densityActivity = (
      await pool.query(
        `insert into activities (name, is_active, density_source) values ($1, true, 'plants') returning id`,
        [`QA AABT Density Activity ${RUN_ID}`]
      )
    ).rows[0];

    await pool.query(
      `insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3), ($1, $4)`,
      [group.id, plainActivity.id, insertedActivity.id, densityActivity.id]
    );
    await pool.query(
      `insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`,
      [target.id, group.id]
    );

    land = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active)
         values ($1, 100, 100, true) returning id`,
        [`QA AABT Land ${RUN_ID}`]
      )
    ).rows[0];
    phase = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, is_active, sort_order)
         values ($1, $2, 50, 50, true, 1) returning id`,
        [land.id, `QA AABT Phase ${RUN_ID}`]
      )
    ).rows[0];
    row = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, 201, 0, 0, 5, 20, 'horizontal') returning id`,
        [phase.id]
      )
    ).rows[0];

    async function insertWork(
      activityId: string,
      startedAt: Date,
      endedAt: Date | null,
      extra: { greenhouseRowId?: string; densityType?: string; densityCountPerRow?: number } = {}
    ): Promise<string> {
      const { rows: r } = await pool.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
            greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7)
         returning id`,
        [
          target!.id,
          activityId,
          startedAt,
          endedAt,
          extra.greenhouseRowId ?? null,
          extra.densityType ?? null,
          extra.densityCountPerRow ?? null,
        ]
      );
      return r[0].id;
    }

    async function insertBreak(startedAt: Date, endedAt: Date | null): Promise<string> {
      const { rows: r } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual')
         returning id`,
        [target!.id, startedAt, endedAt]
      );
      return r[0].id;
    }

    async function fetchEntry(id: string) {
      const { rows: r } = await pool.query(
        `select id, activity_id, started_at, ended_at, greenhouse_row_id, density_type, density_count_per_row
         from time_entries where id = $1`,
        [id]
      );
      return r[0];
    }

    // -----------------------------------------------------------------
    // 1) The reported scenario, end to end: the employee's real first
    //    activity was recorded starting at 10:00 AM (they forgot to open
    //    the app until then). PATCH /work-start backdates the day's
    //    start to 6:45 AM (extending that same entry backward — already
    //    correct, existing behavior). POST /activities then fills in what
    //    they actually did from 6:45-10:00 — the entry it collides with
    //    is trimmed at its START (6:45 -> 10:00) instead of rejecting.
    // -----------------------------------------------------------------
    {
      const originalStart = zonedWallTimeToUtc(2018, 5, 6, 10, 0, 0);
      const originalEnd = zonedWallTimeToUtc(2018, 5, 6, 12, 0, 0);
      const entryId = await insertWork(plainActivity!.id, originalStart, originalEnd);

      const patchRes = await call("PATCH", "/api/inputs/work-start", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_TRIM_BEGINNING,
          newStartTime: zonedWallTimeToUtc(2018, 5, 6, 6, 45, 0).toISOString(),
        },
      });
      check(patchRes.status === 200, "1) PATCH /work-start backdates the day's start to 6:45 AM", patchRes.body);

      const extended = await fetchEntry(entryId);
      check(
        new Date(extended.started_at).getTime() === zonedWallTimeToUtc(2018, 5, 6, 6, 45, 0).getTime(),
        "1) the employee's first activity is now extended back to 6:45 AM",
        extended
      );

      const insertRes = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_TRIM_BEGINNING,
          activityId: insertedActivity!.id,
          startTime: zonedWallTimeToUtc(2018, 5, 6, 6, 45, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 5, 6, 10, 0, 0).toISOString(),
          reason: "QA: what the employee actually did before their real first activity",
        },
      });
      check(
        insertRes.status === 201,
        "1) POST /activities for 6:45-10:00 succeeds instead of rejecting with an overlap error",
        insertRes.body
      );

      // ---------------------------------------------------------------
      // 2) The pre-existing first activity is trimmed to start exactly
      //    at 10:00 AM — its own id, end time, and activity are all
      //    preserved (only started_at moved).
      // ---------------------------------------------------------------
      const trimmed = await fetchEntry(entryId);
      check(
        new Date(trimmed.started_at).getTime() === zonedWallTimeToUtc(2018, 5, 6, 10, 0, 0).getTime(),
        "2) the existing first activity's start is trimmed to exactly 10:00 AM",
        trimmed
      );
      check(
        new Date(trimmed.ended_at).getTime() === originalEnd.getTime() && trimmed.activity_id === plainActivity!.id,
        "2) the existing first activity's own end time and activity are unchanged",
        trimmed
      );

      const { rows: newRows } = await pool.query(
        `select id, activity_id, started_at, ended_at from time_entries
         where employee_id = $1 and activity_id = $2`,
        [target!.id, insertedActivity!.id]
      );
      check(
        newRows.length === 1 &&
          new Date(newRows[0].started_at).getTime() === zonedWallTimeToUtc(2018, 5, 6, 6, 45, 0).getTime() &&
          new Date(newRows[0].ended_at).getTime() === zonedWallTimeToUtc(2018, 5, 6, 10, 0, 0).getTime(),
        "1) the newly-inserted activity is recorded exactly as 6:45-10:00",
        newRows
      );

      const { rows: corrections } = await pool.query(
        `select field_name, old_value, new_value, changed_by_employee_id, reason from time_entry_corrections
         where time_entry_id = $1 and field_name = 'started_at' order by changed_at desc limit 1`,
        [entryId]
      );
      check(
        corrections.length === 1 &&
          corrections[0].changed_by_employee_id === adminActor!.id &&
          new Date(corrections[0].old_value).getTime() === zonedWallTimeToUtc(2018, 5, 6, 6, 45, 0).getTime() &&
          new Date(corrections[0].new_value).getTime() === zonedWallTimeToUtc(2018, 5, 6, 10, 0, 0).getTime(),
        "1) the automatic boundary trim is recorded in the audit trail, attributed to the acting admin",
        corrections
      );
    }

    // -----------------------------------------------------------------
    // Symmetric boundary rule: a new activity overlapping the END of an
    // existing one trims that entry's end back to the new activity's
    // start, not its beginning.
    // -----------------------------------------------------------------
    {
      const existingId = await insertWork(
        plainActivity!.id,
        zonedWallTimeToUtc(2018, 5, 7, 8, 0, 0),
        zonedWallTimeToUtc(2018, 5, 7, 10, 30, 0)
      );

      const res = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_TRIM_END,
          activityId: insertedActivity!.id,
          startTime: zonedWallTimeToUtc(2018, 5, 7, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 5, 7, 11, 0, 0).toISOString(),
          reason: "QA: overlaps the end of the existing activity",
        },
      });
      check(res.status === 201, "New activity overlapping the end of an existing one is accepted", res.body);

      const trimmed = await fetchEntry(existingId);
      check(
        new Date(trimmed.ended_at).getTime() === zonedWallTimeToUtc(2018, 5, 7, 10, 0, 0).getTime() &&
          new Date(trimmed.started_at).getTime() === zonedWallTimeToUtc(2018, 5, 7, 8, 0, 0).getTime(),
        "The existing activity's end is trimmed to the new activity's start; its own start is unchanged",
        trimmed
      );
    }

    // -----------------------------------------------------------------
    // 3) Production quantity preserved and speed recalculated: an
    //    existing density-eligible activity gets trimmed the same way,
    //    and its density snapshot (quantity) survives untouched, while
    //    GET /daily's calculated speed reflects the new, shorter
    //    duration on the next read.
    // -----------------------------------------------------------------
    {
      const existingId = await insertWork(
        densityActivity!.id,
        zonedWallTimeToUtc(2018, 5, 8, 6, 45, 0),
        zonedWallTimeToUtc(2018, 5, 8, 14, 45, 0), // 8 hours
        { greenhouseRowId: row!.id, densityType: "plants", densityCountPerRow: 400 }
      );

      const res = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_DENSITY,
          activityId: insertedActivity!.id,
          startTime: zonedWallTimeToUtc(2018, 5, 8, 6, 45, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 5, 8, 10, 45, 0).toISOString(), // trims 4 hours off
          reason: "QA: trims a density-eligible activity",
        },
      });
      check(res.status === 201, "3) POST /activities trims a density-eligible existing activity", res.body);

      const trimmed = await fetchEntry(existingId);
      check(
        trimmed.greenhouse_row_id === row!.id &&
          trimmed.density_type === "plants" &&
          Number(trimmed.density_count_per_row) === 400,
        "3) the trimmed activity's row/density snapshot (production quantity) is preserved exactly",
        trimmed
      );
      check(
        new Date(trimmed.started_at).getTime() === zonedWallTimeToUtc(2018, 5, 8, 10, 45, 0).getTime(),
        "3) the trimmed activity's start is now 10:45 AM",
        trimmed
      );

      const daily = await call("GET", `/api/inputs/daily?employeeId=${target!.id}&date=${DATE_DENSITY}`, {
        token: adminToken,
      });
      const run = daily.body?.runs?.find((r: any) => r.id === existingId || r.segmentIds?.includes(existingId));
      // Remaining duration after trim: 14:45 - 10:45 = 4 hours = 14400s.
      // Speed = quantity / hours = 400 / 4 = 100/hr — recalculated from
      // the NEW duration, not the original 8-hour one (which would have
      // given 50/hr).
      check(
        run?.durationSeconds === 4 * 3600,
        "3) GET /daily recalculates the run's duration from the trimmed start",
        run
      );
      check(
        run?.calculatedSpeedPerHour?.value === 100,
        "3) GET /daily recalculates speed from the new duration (400 plants / 4h = 100/hr), not the pre-trim one",
        run?.calculatedSpeedPerHour
      );
    }

    // -----------------------------------------------------------------
    // 4) A scheduled break sitting inside the manually-inserted range is
    //    preserved untouched and excluded from the activity's own
    //    duration/totals — the 9:00-9:15 AM break inside a 6:45-10:00 AM
    //    manual activity.
    // -----------------------------------------------------------------
    {
      const existingId = await insertWork(
        plainActivity!.id,
        zonedWallTimeToUtc(2018, 5, 9, 10, 0, 0),
        zonedWallTimeToUtc(2018, 5, 9, 12, 0, 0)
      );
      const breakId = await insertBreak(
        zonedWallTimeToUtc(2018, 5, 9, 9, 0, 0),
        zonedWallTimeToUtc(2018, 5, 9, 9, 15, 0)
      );

      const res = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_BREAK_PRESERVED,
          activityId: insertedActivity!.id,
          startTime: zonedWallTimeToUtc(2018, 5, 9, 6, 45, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 5, 9, 10, 0, 0).toISOString(),
          reason: "QA: a break sits inside this range and must survive untouched",
        },
      });
      check(res.status === 201, "4) POST /activities succeeds with a break inside the new range", res.body);

      const breakAfter = await pool.query(`select started_at, ended_at from time_entries where id = $1`, [breakId]);
      check(
        new Date(breakAfter.rows[0].started_at).getTime() === zonedWallTimeToUtc(2018, 5, 9, 9, 0, 0).getTime() &&
          new Date(breakAfter.rows[0].ended_at).getTime() === zonedWallTimeToUtc(2018, 5, 9, 9, 15, 0).getTime(),
        "4) the break's own start/end are completely unchanged",
        breakAfter.rows[0]
      );

      const daily = await call("GET", `/api/inputs/daily?employeeId=${target!.id}&date=${DATE_BREAK_PRESERVED}`, {
        token: adminToken,
      });
      check(
        daily.body?.breaks?.some(
          (b: any) => b.id === breakId && b.durationSeconds === 15 * 60
        ),
        "4) the break still appears in GET /daily with its own 15-minute duration",
        daily.body?.breaks
      );
      const insertedRun = daily.body?.runs?.find((r: any) => r.activityId === insertedActivity!.id);
      check(
        insertedRun?.durationSeconds === (3 * 3600 + 15 * 60), // 6:45-10:00 minus the 15-minute break
        "4) the inserted activity's own duration excludes the break time inside it",
        insertedRun
      );
      const existingAfter = await fetchEntry(existingId);
      check(
        new Date(existingAfter.started_at).getTime() === zonedWallTimeToUtc(2018, 5, 9, 10, 0, 0).getTime(),
        "4) the existing activity is still trimmed correctly alongside the preserved break",
        existingAfter
      );
    }

    // -----------------------------------------------------------------
    // 5) Exact-boundary insertion: the new activity's end lands exactly
    //    on an existing activity's start (and vice versa on the other
    //    side) — allowed with NO adjustment at all, not even a no-op
    //    trim, and no audit rows written.
    // -----------------------------------------------------------------
    {
      const existingId = await insertWork(
        plainActivity!.id,
        zonedWallTimeToUtc(2018, 5, 10, 10, 0, 0),
        zonedWallTimeToUtc(2018, 5, 10, 12, 0, 0)
      );

      const res = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_EXACT_BOUNDARY,
          activityId: insertedActivity!.id,
          startTime: zonedWallTimeToUtc(2018, 5, 10, 8, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 5, 10, 10, 0, 0).toISOString(), // touches exactly
          reason: "QA: exact boundary touch, not an overlap",
        },
      });
      check(res.status === 201, "5) an exact boundary touch is accepted", res.body);

      const existingAfter = await fetchEntry(existingId);
      check(
        new Date(existingAfter.started_at).getTime() === zonedWallTimeToUtc(2018, 5, 10, 10, 0, 0).getTime(),
        "5) the untouched existing activity's start is unchanged",
        existingAfter
      );

      const { rows: corrections } = await pool.query(
        `select id from time_entry_corrections where time_entry_id = $1`,
        [existingId]
      );
      check(
        corrections.length === 0,
        "5) no correction audit row is written for an entry that only touched a boundary, not overlapped it",
        corrections
      );
    }

    // -----------------------------------------------------------------
    // 6) Blocked case: the new range sits entirely INSIDE an existing
    //    activity — would require splitting it, which isn't supported.
    //    The whole request is rejected, and NOTHING changes: no trim, no
    //    insert, no audit row (atomic rollback), and the existing
    //    activity's production data (row/density) is completely intact.
    // -----------------------------------------------------------------
    {
      const existingId = await insertWork(
        densityActivity!.id,
        zonedWallTimeToUtc(2018, 5, 11, 8, 0, 0),
        zonedWallTimeToUtc(2018, 5, 11, 16, 0, 0),
        { greenhouseRowId: row!.id, densityType: "plants", densityCountPerRow: 250 }
      );
      const before = await fetchEntry(existingId);

      const res = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_BLOCKED_SPLIT,
          activityId: insertedActivity!.id,
          startTime: zonedWallTimeToUtc(2018, 5, 11, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 5, 11, 11, 0, 0).toISOString(),
          reason: "QA: entirely inside an existing activity, would need a split",
        },
      });
      check(
        res.status === 409 && /conflict/i.test(res.body?.error ?? ""),
        "6) a range entirely inside an existing activity is rejected (409) with a clear explanation",
        res.body
      );
      check(
        !/\d{4}-\d{2}-\d{2}T.*Z/.test(res.body?.error ?? ""),
        "6) the error message shows a local time, not a raw ISO/UTC timestamp",
        res.body?.error
      );

      const after = await fetchEntry(existingId);
      check(
        JSON.stringify(before) === JSON.stringify(after),
        "6) the existing activity's row is completely unchanged — no partial trim occurred",
        { before, after }
      );
      const { rows: newRows } = await pool.query(
        `select id from time_entries where employee_id = $1 and started_at = $2`,
        [target!.id, zonedWallTimeToUtc(2018, 5, 11, 10, 0, 0)]
      );
      check(newRows.length === 0, "6) no new activity entry was inserted", newRows);
      const { rows: corrections } = await pool.query(
        `select id from time_entry_corrections where time_entry_id = $1`,
        [existingId]
      );
      check(corrections.length === 0, "6) no audit correction row was written — nothing was committed", corrections);
    }

    // -----------------------------------------------------------------
    // 7) Blocked case: the new range completely COVERS one or more
    //    existing activities — never silently deleted. Also exercises
    //    the exact zero-duration edge (existing entry's own end lands
    //    exactly on the new range's end) to confirm that's treated as
    //    "covered" (block), not trimmed down to a zero-duration entry.
    // -----------------------------------------------------------------
    {
      const coveredId = await insertWork(
        densityActivity!.id,
        zonedWallTimeToUtc(2018, 5, 12, 10, 0, 0),
        zonedWallTimeToUtc(2018, 5, 12, 10, 30, 0), // ends exactly at the new range's own end below
        { greenhouseRowId: row!.id, densityType: "plants", densityCountPerRow: 60 }
      );
      const before = await fetchEntry(coveredId);

      const res = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target!.id,
          date: DATE_BLOCKED_COVERS,
          activityId: insertedActivity!.id,
          startTime: zonedWallTimeToUtc(2018, 5, 12, 9, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 5, 12, 10, 30, 0).toISOString(),
          reason: "QA: completely covers an existing activity, including its exact end",
        },
      });
      check(
        res.status === 409 && /conflict/i.test(res.body?.error ?? ""),
        "7) a range completely covering an existing activity (even sharing its exact end) is rejected (409)",
        res.body
      );

      const after = await fetchEntry(coveredId);
      check(
        JSON.stringify(before) === JSON.stringify(after),
        "7) the covered activity's production data (row/density) is not deleted or modified",
        { before, after }
      );
      const { rows: newRows } = await pool.query(
        `select id from time_entries where employee_id = $1 and started_at = $2`,
        [target!.id, zonedWallTimeToUtc(2018, 5, 12, 9, 0, 0)]
      );
      check(newRows.length === 0, "7) no new activity entry was inserted for the blocked range", newRows);
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
        [`qa-aabt-%-${RUN_ID}@test.local`]
      )
    );
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-aabt-%-${RUN_ID}@test.local`,
      ])
    );
    if (row) await tryDelete("greenhouse_rows", () => pool.query("delete from greenhouse_rows where id = $1", [row.id]));
    if (phase) await tryDelete("greenhouse_phases", () => pool.query("delete from greenhouse_phases where id = $1", [phase.id]));
    if (land) await tryDelete("greenhouse_lands", () => pool.query("delete from greenhouse_lands where id = $1", [land.id]));
    if (group) {
      await tryDelete("employee_activity_group_assignments", () =>
        pool.query("delete from employee_activity_group_assignments where activity_group_id = $1", [group.id])
      );
      await tryDelete("activity_group_activities", () =>
        pool.query("delete from activity_group_activities where activity_group_id = $1", [group.id])
      );
    }
    for (const actor of [target, adminActor]) {
      if (actor) await tryDelete("employees", () => pool.query("delete from employees where id = $1", [actor.id]));
    }
    if (plainActivity || insertedActivity || densityActivity) {
      await tryDelete("activities", () =>
        pool.query("delete from activities where id = any($1::uuid[])", [
          [plainActivity?.id, insertedActivity?.id, densityActivity?.id].filter(Boolean),
        ])
      );
    }
    if (group) await tryDelete("activity_groups", () => pool.query("delete from activity_groups where id = $1", [group.id]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
