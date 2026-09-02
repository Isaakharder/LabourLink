// Integration test for the Inputs page's administrator-controlled manual
// entry feature (Add work start / Add break / Add activity —
// server/src/routes/inputs.ts's POST /work-start, /breaks, /activities).
// Unlike this repo's other *.test.ts files (pure-function checks), these
// routes are inseparable from the database (overlap checks, advisory
// locks, foreign-key-audited creation) — no test-DB harness exists in this
// repo, so this runs the real router against the real database the same
// way `npm run dev` would, over real HTTP, using temporary fixtures that
// are always torn down in a `finally` block regardless of pass/fail.
//
// Run with: npm run test:manual-entries
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

// A week of QA-only dates, one scenario per day, chosen far in the past so
// they can never collide with real payroll data currently under review —
// every row created against these dates is deleted in the `finally` block
// below regardless of how the test run ends.
const DATE_WORK_START = "2019-05-06";
const DATE_ACTIVITY_OVERLAP = "2019-05-07";
const DATE_ROW_ACTIVITY = "2019-05-08";
const DATE_BREAKS = "2019-05-09";
const DATE_CUSTOM_BREAK = "2019-05-10";
const DATE_TIMEZONE_BOUNDARY = "2019-05-11";
const DATE_OPEN_ENTRY_CONFLICT = "2019-05-12";

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

  // ---------------------------------------------------------------------
  // Fixtures — every id assigned below is deleted in the `finally` block
  // in explicit dependency order (declared here, outside the try, so
  // `finally` can see whatever got created even if setup fails partway
  // through). No cascade exists between most of these tables (only
  // employee_activity_group_assignments and activity_group_activities'
  // own activity_group_id column cascade), so the reverse-dependency
  // order in `finally` is load-bearing, not stylistic.
  // ---------------------------------------------------------------------
  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  // Definite-assignment (`!`) rather than `| undefined`: every one of these
  // is set early in the try block below and read many times afterward —
  // `finally` only needs to guard with `typeof x !== "undefined"` (true at
  // runtime if setup threw partway through) rather than every other read
  // site needing its own null check for a case that, once past setup,
  // never actually happens.
  let adminActor!: { id: string; first_name: string; last_name: string };
  let supervisorActor!: { id: string; first_name: string; last_name: string };
  let blockedActor!: { id: string; first_name: string; last_name: string };
  let breakProfile!: { id: string };
  let target!: { id: string; first_name: string; last_name: string };
  let unassigned!: { id: string };
  let group!: { id: string };
  let plainActivity!: { id: string; name: string };
  let rowActivity!: { id: string; name: string };
  let land!: { id: string };
  let phase!: { id: string; name: string };
  let row!: { id: string; row_number: number };

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    async function createEmployee(role: string, label: string) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true)
         returning id, first_name, last_name`,
        [
          "QA",
          `${label} ${RUN_ID}`,
          `qa-manual-entries-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`,
          await roleId(role),
          teamRoleId,
          fakePinHash,
        ]
      );
      return rows[0] as { id: string; first_name: string; last_name: string };
    }

    adminActor = await createEmployee("Administrator", "Admin Actor");
    supervisorActor = await createEmployee("Supervisor", "Supervisor Actor");
    blockedActor = await createEmployee("Employee", "Blocked Actor");

    const adminToken = signSession({
      id: adminActor.id,
      firstName: adminActor.first_name,
      lastName: adminActor.last_name,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });
    const supervisorToken = signSession({
      id: supervisorActor.id,
      firstName: supervisorActor.first_name,
      lastName: supervisorActor.last_name,
      securityRole: "Supervisor",
      teamRole: "Team Member",
    });
    const blockedToken = signSession({
      id: blockedActor.id,
      firstName: blockedActor.first_name,
      lastName: blockedActor.last_name,
      securityRole: "Employee",
      teamRole: "Team Member",
    });

    // Break profile: one unpaid, one paid scheduled item.
    breakProfile = (
      await pool.query(
        `insert into break_profiles (name, is_active) values ($1, true) returning id`,
        [`QA Manual Entries Profile ${RUN_ID}`]
      )
    ).rows[0];

    const lunchItem = (
      await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, sort_order)
         values ($1, 'QA Lunch', '12:00:00', '12:30:00', false, 1) returning id, is_paid`,
        [breakProfile.id]
      )
    ).rows[0];
    const coffeeItem = (
      await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, sort_order)
         values ($1, 'QA Coffee', '15:00:00', '15:15:00', true, 2) returning id, is_paid`,
        [breakProfile.id]
      )
    ).rows[0];

    // Target employee: the one whose day the admin/supervisor edits.
    const targetRows = await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
       values ($1, $2, $3, $4, $5, $6, true, $7)
       returning id, first_name, last_name`,
      [
        "QA",
        `Target Employee ${RUN_ID}`,
        `qa-manual-entries-target-${RUN_ID}@test.local`,
        await roleId("Employee"),
        teamRoleId,
        fakePinHash,
        breakProfile.id,
      ]
    );
    target = targetRows.rows[0] as { id: string; first_name: string; last_name: string };

    // A second target with NO activity group / break profile assignment —
    // proves an admin can't manually log something this employee was never
    // actually authorized to do (activitySelection.ts's own stated intent).
    const unassignedRows = await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
       values ($1, $2, $3, $4, $5, $6, true)
       returning id`,
      [
        "QA",
        `Unassigned Employee ${RUN_ID}`,
        `qa-manual-entries-unassigned-${RUN_ID}@test.local`,
        await roleId("Employee"),
        teamRoleId,
        fakePinHash,
      ]
    );
    unassigned = unassignedRows.rows[0] as { id: string };

    // Activity group with two activities: a plain one (no questions) and
    // one requiring a greenhouse_row answer — covers both "just an
    // activity" and "activity-specific fields" cases.
    group = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA Manual Entries Group ${RUN_ID}`,
      ])
    ).rows[0];

    plainActivity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id, name`, [
        `QA Plain Activity ${RUN_ID}`,
      ])
    ).rows[0];
    rowActivity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id, name`, [
        `QA Row Activity ${RUN_ID}`,
      ])
    ).rows[0];

    await pool.query(
      `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
       values ($1, 'greenhouse_row', 'Which row?', true, 0)`,
      [rowActivity.id]
    );

    await pool.query(
      `insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`,
      [group.id, plainActivity.id, rowActivity.id]
    );

    await pool.query(
      `insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`,
      [target.id, group.id]
    );

    // Greenhouse row for the row-question activity.
    land = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active)
         values ($1, 100, 100, true) returning id`,
        [`QA Land ${RUN_ID}`]
      )
    ).rows[0];

    phase = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, is_active, sort_order)
         values ($1, $2, 50, 50, true, 1) returning id, name`,
        [land.id, `QA Phase ${RUN_ID}`]
      )
    ).rows[0];

    row = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, 101, 0, 0, 5, 20, 'horizontal') returning id, row_number`,
        [phase.id]
      )
    ).rows[0];

    // -----------------------------------------------------------------
    // Permissions
    // -----------------------------------------------------------------
    {
      const noAuth = await call("GET", `/api/inputs/daily?employeeId=${target.id}&date=${DATE_WORK_START}`);
      check(noAuth.status === 401, "GET /daily with no session cookie is rejected (401)", noAuth);

      const blocked = await call("POST", "/api/inputs/work-start", {
        token: blockedToken,
        body: { employeeId: target.id, date: DATE_WORK_START, activityId: plainActivity.id, startTime: "x", reason: "test" },
      });
      check(
        blocked.status === 403,
        "POST /work-start with an Employee-role session (not in EDIT_ROLES) is rejected (403)",
        blocked
      );

      const supervisorAllowed = await call(
        "GET",
        `/api/inputs/employee-activities?employeeId=${target.id}`,
        { token: supervisorToken }
      );
      check(
        supervisorAllowed.status === 200,
        "GET /employee-activities with a Supervisor session is allowed (Supervisor is in EDIT_ROLES)",
        supervisorAllowed
      );
    }

    // -----------------------------------------------------------------
    // Employee-scoped activity list — only the employee's own assigned
    // group's activities, never every activity that exists.
    // -----------------------------------------------------------------
    {
      const targetList = await call("GET", `/api/inputs/employee-activities?employeeId=${target.id}`, {
        token: adminToken,
      });
      const names = (targetList.body?.activities ?? []).map((a: any) => a.name);
      check(
        names.includes(plainActivity.name) && names.includes(rowActivity.name),
        "GET /employee-activities returns exactly the target's assigned group's activities",
        targetList.body
      );

      const unassignedList = await call("GET", `/api/inputs/employee-activities?employeeId=${unassigned.id}`, {
        token: adminToken,
      });
      check(
        Array.isArray(unassignedList.body?.activities) && unassignedList.body.activities.length === 0,
        "GET /employee-activities returns an empty list for an employee with no active group assignment",
        unassignedList.body
      );
    }

    // -----------------------------------------------------------------
    // Add work start — creation, audit trail, and duplicate rejection.
    // -----------------------------------------------------------------
    {
      const startIso = zonedWallTimeToUtc(2019, 5, 6, 7, 0, 0).toISOString();
      const created = await call("POST", "/api/inputs/work-start", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_WORK_START,
          activityId: plainActivity.id,
          startTime: startIso,
          reason: "QA: employee forgot to tap in",
        },
      });
      check(created.status === 201, "POST /work-start creates a new work start (201)", created);

      const daily = await call(
        "GET",
        `/api/inputs/daily?employeeId=${target.id}&date=${DATE_WORK_START}`,
        { token: adminToken }
      );
      check(daily.body?.workStartTime === startIso, "GET /daily reflects the exact entered start time (no rounding)");
      check(
        daily.body?.workStartManualEntry?.createdByEmployeeId === adminActor.id,
        "GET /daily's workStartManualEntry attributes the entry to the admin who created it",
        daily.body?.workStartManualEntry
      );
      check(
        daily.body?.workStartManualEntry?.creationReason === "QA: employee forgot to tap in",
        "GET /daily's workStartManualEntry carries the entered reason"
      );

      const dbRow = await pool.query(
        `select created_by_employee_id, creation_reason, device_id from time_entries
         where employee_id = $1 and entry_type = 'work' and started_at = $2`,
        [target.id, startIso]
      );
      check(
        dbRow.rows[0]?.created_by_employee_id === adminActor.id && dbRow.rows[0]?.device_id === null,
        "The underlying row records created_by_employee_id and a null device_id (no originating phone)",
        dbRow.rows[0]
      );

      const duplicate = await call("POST", "/api/inputs/work-start", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_WORK_START,
          activityId: plainActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 6, 9, 0, 0).toISOString(),
          reason: "QA: second attempt",
        },
      });
      check(
        duplicate.status === 409 && /already exists/i.test(duplicate.body?.error ?? ""),
        "A second POST /work-start for the same employee/day is rejected as a duplicate (409)",
        duplicate.body
      );

      // Close this scenario's open work-start entry out — an open entry's
      // range is unbounded forward (see findOverlappingEntry), so left
      // open it would conflict with every later scenario below that
      // reuses the same target employee on a later date, the same way a
      // real forgotten End Work would block the employee's next real day
      // until a supervisor closed it.
      await pool.query("update time_entries set ended_at = $1 where employee_id = $2 and started_at = $3", [
        zonedWallTimeToUtc(2019, 5, 6, 16, 0, 0).toISOString(),
        target.id,
        startIso,
      ]);
    }

    // -----------------------------------------------------------------
    // Add activity — overlap conflict vs. valid boundary-adjacent entry.
    // -----------------------------------------------------------------
    {
      // Pre-existing entry: 10:00-11:00.
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')`,
        [
          target.id,
          plainActivity.id,
          zonedWallTimeToUtc(2019, 5, 7, 10, 0, 0).toISOString(),
          zonedWallTimeToUtc(2019, 5, 7, 11, 0, 0).toISOString(),
        ]
      );

      const overlapping = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_ACTIVITY_OVERLAP,
          activityId: plainActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 7, 10, 30, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 7, 10, 45, 0).toISOString(),
          reason: "QA: overlap attempt",
        },
      });
      check(
        overlapping.status === 409 && /conflict/i.test(overlapping.body?.error ?? ""),
        "POST /activities rejects a time range overlapping an existing entry (409), and explains the conflict",
        overlapping.body
      );

      const adjacent = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_ACTIVITY_OVERLAP,
          activityId: plainActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 7, 11, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 7, 11, 30, 0).toISOString(),
          reason: "QA: adjacent, not overlapping",
        },
      });
      check(
        adjacent.status === 201,
        "POST /activities allows a new entry starting exactly when the previous one ended (boundary touch is not a conflict)",
        adjacent.body
      );
    }

    // -----------------------------------------------------------------
    // Add activity — activity-specific (row) field required/validated.
    // -----------------------------------------------------------------
    {
      const missingRow = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_ROW_ACTIVITY,
          activityId: rowActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 8, 8, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 8, 9, 0, 0).toISOString(),
          reason: "QA: missing required row",
        },
      });
      check(
        missingRow.status === 400 && /greenhouseRowId/.test(missingRow.body?.error ?? ""),
        "POST /activities rejects a row-requiring activity submitted with no row answered",
        missingRow.body
      );

      const questionRow = await pool.query(`select id from activity_questions where activity_id = $1`, [
        rowActivity.id,
      ]);
      const unmatchedQuestionId = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_ROW_ACTIVITY,
          activityId: rowActivity.id,
          answers: [{ questionId: "00000000-0000-0000-0000-000000000000", greenhouseRowId: row.id }],
          startTime: zonedWallTimeToUtc(2019, 5, 8, 8, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 8, 9, 0, 0).toISOString(),
          reason: "QA: answer references a question that doesn't belong to this activity",
        },
      });
      check(
        unmatchedQuestionId.status === 400,
        "POST /activities rejects an answer whose questionId doesn't match a configured question (400)",
        unmatchedQuestionId.body
      );

      const withRowReal = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_ROW_ACTIVITY,
          activityId: rowActivity.id,
          answers: [{ questionId: questionRow.rows[0].id, greenhouseRowId: row.id }],
          startTime: zonedWallTimeToUtc(2019, 5, 8, 8, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 8, 9, 0, 0).toISOString(),
          reason: "QA: with required row (real questionId)",
        },
      });
      check(
        withRowReal.status === 201,
        "POST /activities succeeds once the required row question is correctly answered",
        withRowReal.body
      );

      const daily = await call(
        "GET",
        `/api/inputs/daily?employeeId=${target.id}&date=${DATE_ROW_ACTIVITY}`,
        { token: adminToken }
      );
      const run = (daily.body?.runs ?? []).find((r: any) => r.activityId === rowActivity.id);
      check(
        run?.row?.label === `${phase.name} · Row ${row.row_number}`,
        "GET /daily shows the saved row on the manually-created run",
        run
      );
      check(
        run?.manualEntry?.createdByEmployeeId === adminActor.id,
        "The manually-created activity run itself is marked manualEntry"
      );
    }

    // -----------------------------------------------------------------
    // Add break — creation, inherited paid/unpaid, totals, overlap.
    // -----------------------------------------------------------------
    {
      const lunch = await call("POST", "/api/inputs/breaks", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_BREAKS,
          breakProfileItemId: lunchItem.id,
          startTime: zonedWallTimeToUtc(2019, 5, 9, 12, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 9, 12, 30, 0).toISOString(),
        },
      });
      check(lunch.status === 201, "POST /breaks creates the unpaid Lunch break (201)", lunch.body);

      const coffee = await call("POST", "/api/inputs/breaks", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_BREAKS,
          breakProfileItemId: coffeeItem.id,
          startTime: zonedWallTimeToUtc(2019, 5, 9, 15, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 9, 15, 15, 0).toISOString(),
        },
      });
      check(coffee.status === 201, "POST /breaks creates the paid Coffee break (201)", coffee.body);

      // A Custom break (no breakProfileItemId), not another Lunch — a
      // preset can no longer submit an arbitrary time at all (the server
      // always resolves it from break_profile_items), so re-submitting the
      // SAME preset item here would now correctly be treated as the
      // idempotent "already exists" no-op (200), not this general
      // "overlaps a different existing break" rejection (409) the test
      // means to exercise. Custom is what actually reaches that
      // planBreakInsertion path with an arbitrary, genuinely overlapping
      // time.
      const overlapBreak = await call("POST", "/api/inputs/breaks", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_BREAKS,
          isPaid: false,
          startTime: zonedWallTimeToUtc(2019, 5, 9, 12, 10, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 9, 12, 20, 0).toISOString(),
        },
      });
      check(
        overlapBreak.status === 409,
        "POST /breaks rejects a break overlapping an existing one (409)",
        overlapBreak.body
      );

      const daily = await call("GET", `/api/inputs/daily?employeeId=${target.id}&date=${DATE_BREAKS}`, {
        token: adminToken,
      });
      check(
        daily.body?.totals?.unpaidBreakSeconds === 30 * 60,
        "GET /daily totals.unpaidBreakSeconds reflects the 30-minute unpaid Lunch break",
        daily.body?.totals
      );
      check(
        daily.body?.totals?.paidBreakSeconds === 15 * 60,
        "GET /daily totals.paidBreakSeconds reflects the 15-minute paid Coffee break",
        daily.body?.totals
      );
      const lunchDto = (daily.body?.breaks ?? []).find((b: any) => b.breakProfileItemId === lunchItem.id);
      check(
        lunchDto?.isPaid === false && lunchDto?.manualEntry?.createdByEmployeeId === adminActor.id,
        "The Lunch break DTO carries isPaid=false (inherited) and manualEntry attribution",
        lunchDto
      );

      // No reason was submitted for either break above — the server must
      // still record the acting admin and a fixed, system-generated reason
      // (not a null/empty one) on every break it creates.
      const { rows: breakAuditRows } = await pool.query(
        `select created_by_employee_id, creation_reason from time_entries
         where employee_id = $1 and entry_type = 'break' and scheduled_break_date = $2
         order by started_at`,
        [target.id, DATE_BREAKS]
      );
      check(
        breakAuditRows.length === 2 &&
          breakAuditRows.every(
            (r) => r.created_by_employee_id === adminActor.id && r.creation_reason === "Break manually added from Inputs page."
          ),
        "POST /breaks records the admin and a fixed system-generated reason without a client-supplied reason",
        breakAuditRows
      );
    }

    // -----------------------------------------------------------------
    // Add break — Custom (no breakProfileItemId), explicit isPaid.
    // -----------------------------------------------------------------
    {
      const missingIsPaid = await call("POST", "/api/inputs/breaks", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_CUSTOM_BREAK,
          startTime: zonedWallTimeToUtc(2019, 5, 10, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 10, 10, 10, 0).toISOString(),
        },
      });
      check(
        missingIsPaid.status === 400 && /isPaid/.test(missingIsPaid.body?.error ?? ""),
        "POST /breaks rejects a Custom break with no isPaid supplied (400)",
        missingIsPaid.body
      );

      const customPaid = await call("POST", "/api/inputs/breaks", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_CUSTOM_BREAK,
          isPaid: true,
          startTime: zonedWallTimeToUtc(2019, 5, 10, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 10, 10, 10, 0).toISOString(),
        },
      });
      check(customPaid.status === 201, "POST /breaks creates a Custom break with explicit isPaid=true (201)");

      const daily = await call("GET", `/api/inputs/daily?employeeId=${target.id}&date=${DATE_CUSTOM_BREAK}`, {
        token: adminToken,
      });
      const customDto = (daily.body?.breaks ?? [])[0];
      check(
        customDto?.breakProfileItemId === null && customDto?.isPaid === true,
        "The Custom break DTO has breakProfileItemId=null and the explicitly-set isPaid",
        customDto
      );
    }

    // -----------------------------------------------------------------
    // Timezone boundary — a late-evening APP_TIMEZONE time is attributed
    // to the correct calendar date even though it falls on the next UTC
    // date, and a time genuinely on the wrong calendar date is rejected.
    // -----------------------------------------------------------------
    {
      // 11:30 PM America/Toronto is already the next UTC calendar date
      // (Toronto is UTC-4/-5) — this only round-trips correctly if the
      // server resolves "the selected date" in APP_TIMEZONE, not UTC.
      const lateEvening = zonedWallTimeToUtc(2019, 5, 11, 23, 30, 0);
      check(
        lateEvening.toISOString().slice(0, 10) !== DATE_TIMEZONE_BOUNDARY,
        "sanity: 11:30 PM America/Toronto is already the next UTC calendar date",
        lateEvening.toISOString()
      );

      const created = await call("POST", "/api/inputs/work-start", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_TIMEZONE_BOUNDARY,
          activityId: plainActivity.id,
          startTime: lateEvening.toISOString(),
          reason: "QA: late-evening timezone boundary",
        },
      });
      check(
        created.status === 201,
        "POST /work-start accepts an 11:30 PM APP_TIMEZONE time for its own (not the UTC-shifted) calendar date",
        created.body
      );

      const daily = await call(
        "GET",
        `/api/inputs/daily?employeeId=${target.id}&date=${DATE_TIMEZONE_BOUNDARY}`,
        { token: adminToken }
      );
      check(
        daily.body?.workStartTime === lateEvening.toISOString(),
        "GET /daily for the selected (APP_TIMEZONE) date shows the late-evening entry"
      );

      // A time that's genuinely on the *next* APP_TIMEZONE calendar date is
      // rejected, not silently attributed to the requested date.
      const wrongDate = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_TIMEZONE_BOUNDARY,
          activityId: plainActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 12, 7, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 12, 8, 0, 0).toISOString(),
          reason: "QA: wrong calendar date for the selected day",
        },
      });
      check(
        wrongDate.status === 422,
        "POST /activities rejects a start time that falls on a different APP_TIMEZONE calendar date (422)",
        wrongDate.body
      );

      // Same reason as the Add work start scenario above: this scenario's
      // work-start is left open by design (POST /work-start never takes an
      // end time) and its UTC footprint (May 11 23:30 Toronto = May 12
      // 03:30 UTC) would otherwise block the very next scenario, which
      // uses May 12 dates.
      await pool.query("update time_entries set ended_at = $1 where employee_id = $2 and started_at = $3", [
        zonedWallTimeToUtc(2019, 5, 12, 0, 0, 0).toISOString(),
        target.id,
        lateEvening.toISOString(),
      ]);
    }

    // -----------------------------------------------------------------
    // At most one open (in-progress) entry at a time.
    // -----------------------------------------------------------------
    {
      const firstOpen = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_OPEN_ENTRY_CONFLICT,
          activityId: plainActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 12, 9, 0, 0).toISOString(),
          endTime: null,
          reason: "QA: first open entry",
        },
      });
      check(firstOpen.status === 201, "POST /activities creates a currently-in-progress (open) entry (201)");

      const secondOpen = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_OPEN_ENTRY_CONFLICT,
          activityId: plainActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 12, 10, 0, 0).toISOString(),
          endTime: null,
          reason: "QA: second open entry attempt",
        },
      });
      check(
        secondOpen.status === 409,
        "POST /activities refuses a second open entry while one is already in progress (409)",
        secondOpen.body
      );

      const beforeIt = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: target.id,
          date: DATE_OPEN_ENTRY_CONFLICT,
          activityId: plainActivity.id,
          startTime: zonedWallTimeToUtc(2019, 5, 12, 8, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2019, 5, 12, 8, 30, 0).toISOString(),
          reason: "QA: bounded entry entirely before the open one",
        },
      });
      check(
        beforeIt.status === 201,
        "POST /activities allows a bounded entry entirely before an already-open one (no conflict)",
        beforeIt.body
      );
    }
  } finally {
    // Explicit dependency order — nothing here cascades except
    // employee_activity_group_assignments/activity_group_activities' own
    // activity_group_id column (both reference activity_groups(id) on
    // delete cascade), so this order is load-bearing: each delete below
    // must run before anything it still points to is removed. Every step
    // is wrapped individually so one failure (e.g. a fixture that never
    // got created because setup threw early) can't stop the rest from
    // still being attempted — this must always fully clean up regardless
    // of how the test run itself went.
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    // 1. time_entries — references employees/activities/greenhouse_rows,
    //    nothing references it. Matched by email pattern rather than the
    //    (possibly-unset, if setup threw early) `target` variable, so this
    //    step alone is enough to catch every row this run could have
    //    created no matter where setup stopped.
    await tryDelete("time_entries", () =>
      pool.query(
        `delete from time_entries where employee_id in (select id from employees where email like $1)`,
        [`qa-manual-entries-%-${RUN_ID}@test.local`]
      )
    );

    // 2. activity_questions / activity_group_activities — reference
    //    activities(id) with no cascade; must go before activities.
    if (rowActivity) {
      await tryDelete("activity_questions", () =>
        pool.query("delete from activity_questions where activity_id = $1", [rowActivity.id])
      );
    }
    if (group) {
      await tryDelete("activity_group_activities", () =>
        pool.query("delete from activity_group_activities where activity_group_id = $1", [group.id])
      );
    }

    // 3. employee_activity_group_assignments — references employees(id)
    //    and activity_groups(id), both on delete cascade, but deleted
    //    explicitly anyway rather than relying on cascade ordering here.
    if (group) {
      await tryDelete("employee_activity_group_assignments", () =>
        pool.query("delete from employee_activity_group_assignments where activity_group_id = $1", [group.id])
      );
    }

    // 4. activities — now safe (its own dependents above are gone).
    if (plainActivity || rowActivity) {
      await tryDelete("activities", () =>
        pool.query("delete from activities where id = any($1::uuid[])", [
          [plainActivity?.id, rowActivity?.id].filter(Boolean),
        ])
      );
    }

    // 5. activity_groups
    if (group) {
      await tryDelete("activity_groups", () => pool.query("delete from activity_groups where id = $1", [group.id]));
    }

    // 6. greenhouse_rows -> greenhouse_phases -> greenhouse_lands (each
    //    references the next with no cascade).
    if (row) {
      await tryDelete("greenhouse_rows", () => pool.query("delete from greenhouse_rows where id = $1", [row.id]));
    }
    if (phase) {
      await tryDelete("greenhouse_phases", () =>
        pool.query("delete from greenhouse_phases where id = $1", [phase.id])
      );
    }
    if (land) {
      await tryDelete("greenhouse_lands", () => pool.query("delete from greenhouse_lands where id = $1", [land.id]));
    }

    // 7. employees — must go before break_profiles (employees.break_profile_id
    //    references it with no cascade). time_entries referencing any of
    //    these (via employee_id or created_by_employee_id) is already gone
    //    from step 1.
    for (const actor of [target, unassigned, adminActor, supervisorActor, blockedActor]) {
      if (actor) {
        await tryDelete("employees", () => pool.query("delete from employees where id = $1", [actor.id]));
      }
    }

    // 8. break_profile_items -> break_profiles (items reference the
    //    profile with no cascade; must go first).
    if (breakProfile) {
      await tryDelete("break_profile_items", () =>
        pool.query("delete from break_profile_items where break_profile_id = $1", [breakProfile.id])
      );
      await tryDelete("break_profiles", () =>
        pool.query("delete from break_profiles where id = $1", [breakProfile.id])
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
