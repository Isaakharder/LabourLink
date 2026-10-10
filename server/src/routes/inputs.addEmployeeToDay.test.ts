// Integration test for the Inputs sidebar's "Add employee to this day" flow
// (web AddEmployeeToDayModal.tsx): GET /api/inputs/employee-options, and the
// two opt-in fields it sends to the shared manual-entry route POST
// /api/inputs/activities — overlapPolicy "reject" and idempotencyKey — plus
// how such a manual entry behaves when the employee's phone later syncs
// (POST /api/mobile/sync/events). Same real-database harness as
// inputs.manualEntries.test.ts: temporary fixtures on far-past QA dates,
// always torn down in `finally`.
//
// Run with: npm run test:inputs-add-employee-to-day
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
import inputsRouter from "./inputs";
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
const EMAIL_PATTERN = `qa-add-to-day-%-${RUN_ID}@test.local`;

// One scenario per QA date (2019-06-xx), far from any real data.
const D_NEW = { str: "2019-06-03", d: 3 };
const D_LISTED = { str: "2019-06-04", d: 4 };
const D_PHONE_HANDOFF = { str: "2019-06-05", d: 5 };
const D_PHONE_EARLIER = { str: "2019-06-06", d: 6 };
const D_FILTER = { str: "2019-06-07", d: 7 };
const D_RACE = { str: "2019-06-08", d: 8 };
const at = (day: number, h: number, m = 0) => zonedWallTimeToUtc(2019, 6, day, h, m, 0).toISOString();

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/inputs", inputsRouter);
  app.use("/api/mobile", mobileTimeRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  async function sync(deviceIdentifier: string, events: unknown[]) {
    const res = await fetch(`${BASE}/api/mobile/sync/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify({ events }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let groupId: string | undefined;
  const activityIds: string[] = [];
  let landId: string | undefined;
  let phaseId: string | undefined;
  let rowId: string | undefined;
  let carrierId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function createEmployee(role: string, label: string, isActive = true) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, $6) returning id, first_name, last_name`,
        [
          `${label} ${RUN_ID}`,
          `qa-add-to-day-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`,
          await roleId(role),
          teamRoleId,
          fakePinHash,
          isActive,
        ]
      );
      employeeIds.push(rows[0].id);
      return rows[0] as { id: string; first_name: string; last_name: string };
    }
    const tokenFor = (e: { id: string; first_name: string; last_name: string }, securityRole: string) =>
      signSession({ id: e.id, firstName: e.first_name, lastName: e.last_name, securityRole, teamRole: "Team Member" });

    const admin = await createEmployee("Administrator", "Admin");
    const supervisor = await createEmployee("Supervisor", "Supervisor");
    const plainEmployee = await createEmployee("Employee", "Plain Employee");
    const forgotPhone = await createEmployee("Employee", "Forgot Phone");
    const listed = await createEmployee("Employee", "Listed");
    const phoneUser = await createEmployee("Employee", "Phone User");
    const inactive = await createEmployee("Employee", "Inactive", false);
    const adminToken = tokenFor(admin, "Administrator");
    const supervisorToken = tokenFor(supervisor, "Supervisor");
    const employeeToken = tokenFor(plainEmployee, "Employee");

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA Add To Day Group ${RUN_ID}`,
      ])
    ).rows[0].id;
    const plainActivityId: string = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Add To Day Cleaning ${RUN_ID}`,
      ])
    ).rows[0].id;
    const pickActivityId: string = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Add To Day Picking ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(plainActivityId, pickActivityId);
    const rowQuestionId: string = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Row', true, 0) returning id`,
        [pickActivityId]
      )
    ).rows[0].id;
    const binQuestionId: string = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'carrier', 'Bin', true, 1) returning id`,
        [pickActivityId]
      )
    ).rows[0].id;
    await pool.query(
      `insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`,
      [groupId, plainActivityId, pickActivityId]
    );
    for (const e of [forgotPhone, listed, phoneUser]) {
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        e.id,
        groupId,
      ]);
    }
    landId = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active) values ($1, 100, 100, true) returning id`,
        [`QA Add To Day Land ${RUN_ID}`]
      )
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, is_active, sort_order)
         values ($1, $2, 50, 50, true, 1) returning id`,
        [landId, `QA Add To Day Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    rowId = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, 212, 0, 0, 5, 20, 'horizontal') returning id`,
        [phaseId]
      )
    ).rows[0].id;
    carrierId = (
      await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA Bin ${RUN_ID}`])
    ).rows[0].id;

    const pickAnswers = [
      { questionId: rowQuestionId, greenhouseRowId: rowId },
      { questionId: binQuestionId, carrierId },
    ];
    const entriesFor = (employeeId: string) =>
      pool.query(
        `select id, started_at, ended_at, source, created_by_employee_id, creation_reason, greenhouse_row_id, carrier_id,
                activity_id, device_id, idempotency_key, deleted_at
         from time_entries where employee_id = $1 order by started_at`,
        [employeeId]
      );

    // -----------------------------------------------------------------
    // Permissions
    // -----------------------------------------------------------------
    {
      const noAuth = await call("GET", `/api/inputs/employee-options?date=${D_NEW.str}`);
      check(noAuth.status === 401, "GET /employee-options without a session is 401", noAuth);
      const asEmployee = await call("GET", `/api/inputs/employee-options?date=${D_NEW.str}`, { token: employeeToken });
      check(asEmployee.status === 403, "GET /employee-options as Employee role is 403", asEmployee);
      const postAsEmployee = await call("POST", "/api/inputs/activities", {
        token: employeeToken,
        body: {
          employeeId: forgotPhone.id,
          date: D_NEW.str,
          activityId: plainActivityId,
          startTime: at(D_NEW.d, 7),
          endTime: at(D_NEW.d, 8),
          reason: "Forgot phone",
          overlapPolicy: "reject",
          idempotencyKey: randomUUID(),
        },
      });
      check(postAsEmployee.status === 403, "POST /activities as Employee role is 403", postAsEmployee);
      check((await entriesFor(forgotPhone.id)).rows.length === 0, "a rejected (403) request created nothing");
      const badDate = await call("GET", "/api/inputs/employee-options?date=nope", { token: adminToken });
      check(badDate.status === 400, "GET /employee-options rejects a malformed date", badDate);
    }

    // -----------------------------------------------------------------
    // Picker lists active employees with no work on the date.
    // -----------------------------------------------------------------
    {
      const options = await call("GET", `/api/inputs/employee-options?date=${D_NEW.str}`, { token: supervisorToken });
      check(options.status === 200, "Supervisor can load employee options", options);
      const byId = new Map<string, any>((options.body?.employees ?? []).map((e: any) => [e.id, e]));
      check(byId.has(forgotPhone.id), "an employee with no entries that day is offered", options.body);
      check(byId.get(forgotPhone.id)?.hasEntriesOnDate === undefined, "options no longer carry hasEntriesOnDate", byId.get(forgotPhone.id));
      check(!byId.has(inactive.id), "an inactive employee is not offered");
      const sidebar = await call("GET", `/api/inputs/employees?date=${D_NEW.str}`, { token: adminToken });
      check(
        !(sidebar.body?.employees ?? []).some((e: any) => e.id === forgotPhone.id),
        "...and isn't in the sidebar yet",
        sidebar.body
      );
    }

    // -----------------------------------------------------------------
    // Validation: required row/bin, overlapPolicy/idempotencyKey shape.
    // -----------------------------------------------------------------
    const base = {
      employeeId: forgotPhone.id,
      date: D_NEW.str,
      activityId: pickActivityId,
      startTime: at(D_NEW.d, 7),
      endTime: at(D_NEW.d, 11, 30),
      reason: "Forgot phone",
      overlapPolicy: "reject",
    };
    {
      const noAnswers = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...base, idempotencyKey: randomUUID() },
      });
      check(noAnswers.status === 400, "missing required row and bin is rejected (400)", noAnswers);
      const rowOnly = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...base, answers: [pickAnswers[0]], idempotencyKey: randomUUID() },
      });
      check(rowOnly.status === 400, "missing required bin is rejected (400)", rowOnly);
      const badPolicy = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...base, answers: pickAnswers, overlapPolicy: "merge" },
      });
      check(badPolicy.status === 400, "an unknown overlapPolicy is rejected (400)", badPolicy);
      const badKey = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...base, answers: pickAnswers, idempotencyKey: "not-a-uuid" },
      });
      check(badKey.status === 400, "a non-UUID idempotencyKey is rejected (400)", badKey);
      const inactiveTarget = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...base, employeeId: inactive.id, answers: pickAnswers, idempotencyKey: randomUUID() },
      });
      check(inactiveTarget.status === 404, "an inactive employee can't be added (404)", inactiveTarget);
      check((await entriesFor(forgotPhone.id)).rows.length === 0, "no entry created by any rejected request");
    }

    // -----------------------------------------------------------------
    // Employee with no work that day: created with the manual audit trail,
    // appears in the sidebar; a retry with the same key is a no-op.
    // -----------------------------------------------------------------
    const key = randomUUID();
    {
      const created = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...base, answers: pickAnswers, idempotencyKey: key },
      });
      check(created.status === 201 && created.body?.duplicate === undefined, "Supervisor adds the forgotten-phone stint (201)", created);
      const rows = (await entriesFor(forgotPhone.id)).rows;
      check(rows.length === 1, "exactly one entry created", rows);
      const r = rows[0];
      check(
        r?.source === "manual" && r?.device_id === null && r?.created_by_employee_id === supervisor.id && r?.creation_reason === "Forgot phone",
        "entry carries the manual-entry audit trail (source manual, no device, created_by, reason)",
        r
      );
      check(r?.greenhouse_row_id === rowId && r?.carrier_id === carrierId, "row and bin are stored on the entry", r);
      check(r?.idempotency_key === key, "the client's idempotency key is stored on the entry", r);

      const sidebar = await call("GET", `/api/inputs/employees?date=${D_NEW.str}`, { token: adminToken });
      check(
        (sidebar.body?.employees ?? []).some((e: any) => e.id === forgotPhone.id),
        "the employee now appears in the sidebar for that date",
        sidebar.body
      );
      const daily = await call("GET", `/api/inputs/daily?employeeId=${forgotPhone.id}&date=${D_NEW.str}`, { token: adminToken });
      const run = daily.body?.runs?.[0];
      check(
        run?.manualEntry?.createdByEmployeeId === supervisor.id && run?.manualEntry?.creationReason === "Forgot phone",
        "GET /daily shows it with the same Manual label data as Add activity",
        run
      );

      const retry = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...base, answers: pickAnswers, idempotencyKey: key },
      });
      check(retry.status === 200 && retry.body?.duplicate === true, "re-sending the same submission returns duplicate: true (200)", retry);
      check((await entriesFor(forgotPhone.id)).rows.length === 1, "...and creates no second entry");

      const freshKeySameTimes = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { ...base, answers: pickAnswers, idempotencyKey: randomUUID() },
      });
      check(freshKeySameTimes.status === 409, "a second submission of the same times under a new key is rejected as an overlap (409)", freshKeySameTimes);

      const keyReusedForOther = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { ...base, employeeId: listed.id, answers: pickAnswers, idempotencyKey: key },
      });
      check(keyReusedForOther.status === 409, "a key already used for another employee is rejected (409)", keyReusedForOther);
      check((await entriesFor(listed.id)).rows.length === 0, "...and creates nothing for that employee");
    }

    // -----------------------------------------------------------------
    // Employee already on the day: adding beside existing work is fine;
    // any overlap is rejected and the existing entry stays untouched —
    // whereas the default policy (Add activity) still trims, unchanged.
    // -----------------------------------------------------------------
    {
      const listedBase = { employeeId: listed.id, date: D_LISTED.str, activityId: plainActivityId, reason: "Phone broken" };
      const first = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { ...listedBase, startTime: at(D_LISTED.d, 8), endTime: at(D_LISTED.d, 10) },
      });
      check(first.status === 201, "setup: existing 8:00-10:00 entry for the listed employee", first);
      const options = await call("GET", `/api/inputs/employee-options?date=${D_LISTED.str}`, { token: adminToken });
      check(
        options.status === 200 && !(options.body?.employees ?? []).some((e: any) => e.id === listed.id),
        "the picker leaves out an employee who already has work that day",
        options.body
      );

      const after = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { ...listedBase, startTime: at(D_LISTED.d, 10), endTime: at(D_LISTED.d, 12), overlapPolicy: "reject", idempotencyKey: randomUUID() },
      });
      check(after.status === 201, "adding non-overlapping work (10:00-12:00, touching the end) is allowed", after);

      const overlap = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { ...listedBase, startTime: at(D_LISTED.d, 7), endTime: at(D_LISTED.d, 9), overlapPolicy: "reject", idempotencyKey: randomUUID() },
      });
      check(overlap.status === 409 && /overlaps/.test(overlap.body?.error ?? ""), "a boundary overlap (7:00-9:00) is rejected under reject (409)", overlap);
      const covering = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { ...listedBase, startTime: at(D_LISTED.d, 9), endTime: null, overlapPolicy: "reject", idempotencyKey: randomUUID() },
      });
      check(covering.status === 409, "an in-progress entry starting inside existing work is rejected (409)", covering);
      const rows = (await entriesFor(listed.id)).rows;
      check(rows.length === 2, "only the two non-overlapping entries exist", rows);
      check(
        new Date(rows[0]?.started_at).toISOString() === at(D_LISTED.d, 8) && new Date(rows[0]?.ended_at).toISOString() === at(D_LISTED.d, 10),
        "the existing 8:00-10:00 entry was not trimmed",
        rows[0]
      );

      const trimDefault = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { ...listedBase, startTime: at(D_LISTED.d, 7), endTime: at(D_LISTED.d, 9) },
      });
      check(trimDefault.status === 201, "without overlapPolicy (Add activity), the same boundary overlap still trims (201)", trimDefault);
      const trimmed = (await entriesFor(listed.id)).rows.find((r) => new Date(r.ended_at).toISOString() === at(D_LISTED.d, 10));
      check(new Date(trimmed?.started_at).toISOString() === at(D_LISTED.d, 9), "...the existing entry's start moved to 9:00 as before", trimmed);
    }

    // -----------------------------------------------------------------
    // Picker filtering: only active employees with NO non-deleted work entry
    // starting within the date's organization-timezone day.
    // -----------------------------------------------------------------
    const ADD_REASON = "Added manually through Inputs";
    async function worker(label: string) {
      const e = await createEmployee("Employee", label);
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        e.id,
        groupId,
      ]);
      return e;
    }
    async function rawEntry(employeeId: string, opts: { start: string; end?: string | null; type?: "work" | "break"; deleted?: boolean }) {
      const type = opts.type ?? "work";
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, is_paid,
                                   deleted_at, deleted_by_employee_id, deletion_reason)
         values ($1, null, $2, $3, gen_random_uuid(), $4, $5, 'manual', $6, $7, $8, $9)`,
        [
          employeeId,
          type,
          type === "work" ? plainActivityId : null,
          opts.start,
          opts.end ?? null,
          type === "break" ? false : null,
          opts.deleted ? new Date() : null,
          opts.deleted ? admin.id : null,
          opts.deleted ? "QA deleted entry" : null,
        ]
      );
    }
    const localIso = (day: number, h: number, m = 0) => zonedWallTimeToUtc(2019, 6, day, h, m, 0).toISOString();
    const F = D_FILTER.d;
    const fNone = await worker("Filter None");
    const fManual = await worker("Filter Manual");
    const fOpen = await worker("Filter Open");
    const fDeleted = await worker("Filter Deleted");
    const fBreakOnly = await worker("Filter Break Only");
    const fPrevDay = await worker("Filter Prev Day");
    const fMidnight = await worker("Filter Midnight");
    const fNextDay = await worker("Filter Next Day");
    {
      const manual = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { employeeId: fManual.id, date: D_FILTER.str, activityId: plainActivityId, startTime: at(F, 8), endTime: at(F, 9), reason: "Another supervisor" },
      });
      check(manual.status === 201, "filter setup: manual work for fManual", manual);
      await rawEntry(fOpen.id, { start: at(F, 8), end: null });
      await rawEntry(fDeleted.id, { start: at(F, 8), end: at(F, 9), deleted: true });
      await rawEntry(fBreakOnly.id, { start: at(F, 12), end: at(F, 12, 30), type: "break" });
      await rawEntry(fPrevDay.id, { start: localIso(F - 1, 23, 30), end: localIso(F - 1, 23, 59) });
      await rawEntry(fMidnight.id, { start: localIso(F, 0, 0), end: localIso(F, 0, 30) });
      await rawEntry(fNextDay.id, { start: localIso(F + 1, 0, 0), end: localIso(F + 1, 1, 0) });

      const options = await call("GET", `/api/inputs/employee-options?date=${D_FILTER.str}`, { token: supervisorToken });
      const ids = new Set<string>((options.body?.employees ?? []).map((e: any) => e.id));
      check(ids.has(fNone.id), "filter: no entries at all -> offered");
      check(!ids.has(fManual.id), "filter: manual work that day -> not offered");
      check(!ids.has(fOpen.id), "filter: in-progress work that day -> not offered");
      check(ids.has(fDeleted.id), "filter: only a deleted work entry -> offered");
      check(ids.has(fBreakOnly.id), "filter: only a break (no work entry) -> offered");
      check(ids.has(fPrevDay.id), "filter: work at 23:30 the previous local day -> offered");
      check(!ids.has(fMidnight.id), "filter: work starting at local 00:00 of the date -> not offered");
      check(ids.has(fNextDay.id), "filter: work starting at local 00:00 the next day -> offered");
      check(!ids.has(inactive.id), "filter: inactive employee -> not offered");
    }

    // -----------------------------------------------------------------
    // Saving without a reason: automatic creation reason, audit preserved.
    // -----------------------------------------------------------------
    {
      const key = randomUUID();
      const body = {
        employeeId: fNone.id,
        date: D_FILTER.str,
        activityId: plainActivityId,
        startTime: at(F, 7),
        endTime: at(F, 10),
        addEmployeeToDay: true,
        idempotencyKey: key,
      };
      const created = await call("POST", "/api/inputs/activities", { token: supervisorToken, body });
      check(created.status === 201, "save with addEmployeeToDay and no reason succeeds (201)", created);
      const { rows } = await pool.query(
        `select source, created_by_employee_id, creation_reason, created_at, device_id from time_entries
         where employee_id = $1 and deleted_at is null`,
        [fNone.id]
      );
      check(rows.length === 1, "exactly one entry created", rows);
      check(
        rows[0]?.source === "manual" &&
          rows[0]?.device_id === null &&
          rows[0]?.created_by_employee_id === supervisor.id &&
          rows[0]?.creation_reason === ADD_REASON,
        "entry records who created it, the automatic reason, and is manual",
        rows[0]
      );
      check(
        Boolean(rows[0]?.created_at) && Math.abs(Date.now() - new Date(rows[0].created_at).getTime()) < 5 * 60 * 1000,
        "entry records when it was created",
        rows[0]
      );
      const daily = await call("GET", `/api/inputs/daily?employeeId=${fNone.id}&date=${D_FILTER.str}`, { token: adminToken });
      const run = daily.body?.runs?.[0];
      check(
        run?.manualEntry?.createdByEmployeeId === supervisor.id &&
          run?.manualEntry?.createdByName === `${supervisor.first_name} ${supervisor.last_name}` &&
          run?.manualEntry?.creationReason === ADD_REASON,
        "GET /daily shows the Manual label data (created by, reason)",
        run
      );
      const options = await call("GET", `/api/inputs/employee-options?date=${D_FILTER.str}`, { token: supervisorToken });
      check(!(options.body?.employees ?? []).some((e: any) => e.id === fNone.id), "the employee drops out of the picker once added");

      const retry = await call("POST", "/api/inputs/activities", { token: supervisorToken, body });
      check(retry.status === 200 && retry.body?.duplicate === true, "a retry of the same submission is a duplicate, not a has-work rejection", retry);
      check(
        Number((await pool.query(`select count(*) from time_entries where employee_id = $1 and deleted_at is null`, [fNone.id])).rows[0].count) === 1,
        "...and creates nothing"
      );

      const ignoredReason = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...body, employeeId: fPrevDay.id, reason: "Typed reason", idempotencyKey: randomUUID() },
      });
      check(ignoredReason.status === 201, "a reason sent with addEmployeeToDay is accepted", ignoredReason);
      const prev = await pool.query(
        `select creation_reason from time_entries where employee_id = $1 and deleted_at is null and started_at = $2`,
        [fPrevDay.id, at(F, 7)]
      );
      check(prev.rows[0]?.creation_reason === ADD_REASON, "...but the standard reason is stored for this modal", prev.rows[0]);

      const addActivityNoReason = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { employeeId: fDeleted.id, date: D_FILTER.str, activityId: plainActivityId, startTime: at(F, 7), endTime: at(F, 8) },
      });
      check(addActivityNoReason.status === 400, "Add activity (no addEmployeeToDay) still requires a reason (400)", addActivityNoReason);

      const overBreak = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...body, employeeId: fBreakOnly.id, startTime: at(F, 11), endTime: at(F, 13), idempotencyKey: randomUUID() },
      });
      check(overBreak.status === 409 && /overlaps/.test(overBreak.body?.error ?? ""), "addEmployeeToDay still rejects overlaps (with a break) (409)", overBreak);

      const asEmployee = await call("POST", "/api/inputs/activities", {
        token: employeeToken,
        body: { ...body, employeeId: fDeleted.id, idempotencyKey: randomUUID() },
      });
      check(asEmployee.status === 403, "addEmployeeToDay keeps the Inputs edit permissions (403 for Employee role)", asEmployee);
      const badFlag = await call("POST", "/api/inputs/activities", {
        token: supervisorToken,
        body: { ...body, employeeId: fDeleted.id, addEmployeeToDay: "yes", idempotencyKey: randomUUID() },
      });
      check(badFlag.status === 400, "a non-boolean addEmployeeToDay is rejected (400)", badFlag);
    }

    // -----------------------------------------------------------------
    // Save-time race: work added after the picker loaded.
    // -----------------------------------------------------------------
    {
      const R = D_RACE.d;
      const raceSupervisor = await worker("Race Supervisor Target");
      const racePhone = await worker("Race Phone Target");
      const raceDeviceIdentifier = randomUUID();
      const raceDeviceId: string = (
        await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
          raceDeviceIdentifier,
          `QA Add To Day Race Device ${RUN_ID}`,
        ])
      ).rows[0].id;
      deviceIds.push(raceDeviceId);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [raceDeviceId, racePhone.id]);

      const before = await call("GET", `/api/inputs/employee-options?date=${D_RACE.str}`, { token: supervisorToken });
      const beforeIds = new Set<string>((before.body?.employees ?? []).map((e: any) => e.id));
      check(beforeIds.has(raceSupervisor.id) && beforeIds.has(racePhone.id), "race: both employees offered when the modal opens");

      // Another supervisor records work for one; the other's phone syncs.
      const other = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: { employeeId: raceSupervisor.id, date: D_RACE.str, activityId: plainActivityId, startTime: at(R, 13), endTime: at(R, 14), reason: "Other supervisor" },
      });
      check(other.status === 201, "race setup: another supervisor added work", other);
      const phone = await sync(raceDeviceIdentifier, [
        { clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: at(R, 13), activityId: plainActivityId, answers: null },
        { clientEventId: randomUUID(), deviceSeq: 2, eventType: "end_day", occurredAtUtc: at(R, 14) },
      ]);
      check(phone.body?.results?.every((r: any) => r.status === "accepted"), "race setup: the phone synced work", phone.body);

      const targets: [typeof raceSupervisor, string][] = [
        [raceSupervisor, "another supervisor's entry"],
        [racePhone, "a phone sync"],
      ];
      for (const [target, label] of targets) {
        const countBefore = Number((await pool.query(`select count(*) from time_entries where employee_id = $1`, [target.id])).rows[0].count);
        const late = await call("POST", "/api/inputs/activities", {
          token: supervisorToken,
          body: {
            employeeId: target.id,
            date: D_RACE.str,
            activityId: plainActivityId,
            startTime: at(R, 7),
            endTime: at(R, 9),
            addEmployeeToDay: true,
            idempotencyKey: randomUUID(),
          },
        });
        check(
          late.status === 409 && late.body?.code === "EMPLOYEE_HAS_WORK" && /now has work recorded for this day/.test(late.body?.error ?? ""),
          `race: saving after ${label} is rejected with EMPLOYEE_HAS_WORK (409)`,
          late
        );
        const countAfter = Number((await pool.query(`select count(*) from time_entries where employee_id = $1`, [target.id])).rows[0].count);
        check(countAfter === countBefore, `race: nothing created after ${label}`);
      }
      const after = await call("GET", `/api/inputs/employee-options?date=${D_RACE.str}`, { token: supervisorToken });
      const afterIds = new Set<string>((after.body?.employees ?? []).map((e: any) => e.id));
      check(!afterIds.has(raceSupervisor.id) && !afterIds.has(racePhone.id), "race: the refreshed picker no longer offers either employee");
    }

    // -----------------------------------------------------------------
    // Later phone sync. A device paired to phoneUser replays offline events.
    // -----------------------------------------------------------------
    const deviceIdentifier = randomUUID();
    const deviceId: string = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        deviceIdentifier,
        `QA Add To Day Device ${RUN_ID}`,
      ])
    ).rows[0].id;
    deviceIds.push(deviceId);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceId, phoneUser.id]);
    let seq = 0;

    // Handoff: an open manual entry from 8:00; the phone's 10:00 work_start
    // closes it at 10:00 and takes over — no overlap, manual part kept.
    {
      const manual = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: phoneUser.id,
          date: D_PHONE_HANDOFF.str,
          activityId: plainActivityId,
          startTime: at(D_PHONE_HANDOFF.d, 8),
          endTime: null,
          reason: "Phone was dead",
          overlapPolicy: "reject",
          idempotencyKey: randomUUID(),
        },
      });
      check(manual.status === 201, "open (no end time) manual entry from 8:00 is created", manual);

      const again = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: phoneUser.id,
          date: D_PHONE_HANDOFF.str,
          activityId: plainActivityId,
          startTime: at(D_PHONE_HANDOFF.d, 9),
          endTime: null,
          reason: "Phone was dead",
          overlapPolicy: "reject",
          idempotencyKey: randomUUID(),
        },
      });
      check(again.status === 409, "a second in-progress entry while one is open is rejected (409)", again);

      const phone = await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: ++seq,
          eventType: "work_start",
          occurredAtUtc: at(D_PHONE_HANDOFF.d, 10),
          activityId: plainActivityId,
          answers: null,
        },
      ]);
      check(phone.body?.results?.[0]?.status === "accepted", "the phone's later work_start is accepted", phone.body);
      const rows = (await entriesFor(phoneUser.id)).rows.filter((r) => !r.deleted_at);
      check(rows.length === 2, "manual entry + phone entry", rows);
      check(
        rows[0]?.source === "manual" &&
          rows[0]?.created_by_employee_id === admin.id &&
          new Date(rows[0]?.ended_at).toISOString() === at(D_PHONE_HANDOFF.d, 10),
        "the manual entry is closed exactly where the phone took over, keeping its Manual audit",
        rows[0]
      );
      check(
        rows[1]?.device_id === deviceId && new Date(rows[1]?.started_at).toISOString() === at(D_PHONE_HANDOFF.d, 10) && rows[1]?.ended_at === null,
        "the phone entry starts at 10:00 and is the one now open",
        rows[1]
      );

      const end = await sync(deviceIdentifier, [
        { clientEventId: randomUUID(), deviceSeq: ++seq, eventType: "end_day", occurredAtUtc: at(D_PHONE_HANDOFF.d, 16) },
      ]);
      check(end.body?.results?.[0]?.status === "accepted", "setup: phone ends the day", end.body);
    }

    // An offline phone event from well before an open manual entry's start
    // can't close it backwards: it's a sync conflict for review, and the
    // manual entry is left intact.
    {
      const manual = await call("POST", "/api/inputs/activities", {
        token: adminToken,
        body: {
          employeeId: phoneUser.id,
          date: D_PHONE_EARLIER.str,
          activityId: plainActivityId,
          startTime: at(D_PHONE_EARLIER.d, 9),
          endTime: null,
          reason: "Phone was dead",
          overlapPolicy: "reject",
          idempotencyKey: randomUUID(),
        },
      });
      check(manual.status === 201, "open manual entry from 9:00 on the next QA day", manual);
      const phone = await sync(deviceIdentifier, [
        {
          clientEventId: randomUUID(),
          deviceSeq: ++seq,
          eventType: "activity_switch",
          occurredAtUtc: at(D_PHONE_EARLIER.d, 6, 30),
          activityId: plainActivityId,
          answers: null,
        },
      ]);
      check(phone.body?.results?.[0]?.status === "permanent_conflict", "a phone event 2.5h before the manual start is a sync conflict", phone.body);
      const rows = (await entriesFor(phoneUser.id)).rows.filter(
        (r) => !r.deleted_at && new Date(r.started_at).toISOString() >= at(D_PHONE_EARLIER.d, 0)
      );
      check(
        rows.length === 1 && rows[0].source === "manual" && rows[0].ended_at === null && rows[0].activity_id === plainActivityId,
        "the manual entry is untouched",
        rows
      );
    }
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(
        `delete from time_entry_corrections where employee_id in (select id from employees where email like $1)`,
        [EMAIL_PATTERN]
      );
      await client.query(
        `delete from time_entry_deletions where employee_id in (select id from employees where email like $1)`,
        [EMAIL_PATTERN]
      );
      await client.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        EMAIL_PATTERN,
      ]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from activity_questions where activity_id = any($1::uuid[])`, [activityIds]);
      if (groupId) {
        await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId]);
        await client.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId]);
      }
      await client.query(`delete from activities where id = any($1::uuid[])`, [activityIds]);
      if (groupId) await client.query(`delete from activity_groups where id = $1`, [groupId]);
      if (rowId) await client.query(`delete from greenhouse_rows where id = $1`, [rowId]);
      if (phaseId) await client.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      if (carrierId) await client.query(`delete from carriers where id = $1`, [carrierId]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }
    const leftover = await pool.query(`select count(*) from employees where email like $1`, [EMAIL_PATTERN]);
    check(Number(leftover.rows[0].count) === 0, "all QA fixtures cleaned up");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
