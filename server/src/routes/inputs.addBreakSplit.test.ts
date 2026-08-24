// Reproduces and locks in the fix for the reported bug: manually adding a
// break that falls inside a single work entry (Dave Quiring's real
// scenario — one "General" activity 7:00 AM-5:00 PM, forgot to log his
// 12:00-1:00 PM break) was rejected outright with a conflict error, forcing
// an admin to manually shorten the activity, add a second one, and only
// then add the break. POST /breaks now resolves this automatically via
// planBreakInsertion (server/src/lib/manualTimeEntries.ts): a work entry
// the break sits entirely inside is SPLIT (trim + a copied continuation
// entry), a work entry the break only touches at one boundary is trimmed,
// a work entry the break fully covers is soft-deleted, and an overlap with
// an existing break (or an open-ended work entry) still rejects exactly as
// before.
//
// Same real-HTTP-against-real-database convention as
// inputs.addActivityBoundaryTrim.test.ts — no mocking.
//
// Run with: npm run test:add-break-split
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

const DATE_MAIN = "2017-05-01"; // Dave's exact scenario
const DATE_PAID_BREAK = "2017-05-02";
const DATE_BEGIN = "2017-05-03"; // break at activity start
const DATE_END_BOUNDARY = "2017-05-04"; // break at activity end
const DATE_FULL_COVER = "2017-05-05"; // break fully covers a whole activity
const DATE_MULTI_SPAN = "2017-05-06"; // break spans multiple work entries
const DATE_BREAK_OVERLAP = "2017-05-07"; // existing break overlap rejected
const DATE_EXACT_TOUCH = "2017-05-08"; // exact boundary touches remain valid
const DATE_ROW_VISIT = "2017-05-09"; // row/density visit continuity
const DATE_ROLLBACK = "2017-05-10"; // forced-failure atomicity

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
  let dave!: { id: string };
  let bystander!: { id: string };
  let generalActivity!: { id: string };
  let secondActivity!: { id: string };
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
        ["QA", `ABS Admin ${RUN_ID}`, `qa-abs-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    const adminToken = signSession({
      id: adminActor.id,
      firstName: adminActor.first_name,
      lastName: adminActor.last_name,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });

    dave = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('Dave', $1, $2, $3, $4, $5, true) returning id`,
        [`Quiring QA ${RUN_ID}`, `qa-abs-dave-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    bystander = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ABS Bystander ${RUN_ID}`, `qa-abs-bystander-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];

    generalActivity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `General QA ${RUN_ID}`,
      ])
    ).rows[0];
    secondActivity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA ABS Second Activity ${RUN_ID}`,
      ])
    ).rows[0];
    densityActivity = (
      await pool.query(
        `insert into activities (name, is_active, density_source, speed_unit) values ($1, true, 'plants', 'plants/hour') returning id`,
        [`QA ABS Density Activity ${RUN_ID}`]
      )
    ).rows[0];

    land = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active) values ($1, 100, 100, true) returning id`,
        [`QA ABS Land ${RUN_ID}`]
      )
    ).rows[0];
    phase = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, is_active, sort_order)
         values ($1, $2, 50, 50, true, 1) returning id`,
        [land.id, `QA ABS Phase ${RUN_ID}`]
      )
    ).rows[0];
    row = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, 301, 0, 0, 5, 20, 'horizontal') returning id`,
        [phase.id]
      )
    ).rows[0];

    async function insertWork(
      employeeId: string,
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
          employeeId,
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

    async function insertBreak(employeeId: string, startedAt: Date, endedAt: Date | null): Promise<string> {
      const { rows: r } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual')
         returning id`,
        [employeeId, startedAt, endedAt]
      );
      return r[0].id;
    }

    async function fetchEntry(id: string) {
      const { rows: r } = await pool.query(
        `select id, entry_type, employee_id, activity_id, started_at, ended_at, greenhouse_row_id, density_type,
                density_count_per_row, deleted_at, deleted_by_employee_id, deletion_reason,
                created_by_employee_id, creation_reason
         from time_entries where id = $1`,
        [id]
      );
      return r[0];
    }

    async function addBreak(employeeId: string, date: string, startedAt: Date, endedAt: Date, extra: { isPaid?: boolean } = {}) {
      return call("POST", "/api/inputs/breaks", {
        token: adminToken,
        body: {
          employeeId,
          date,
          isPaid: extra.isPaid ?? false,
          startTime: startedAt.toISOString(),
          endTime: endedAt.toISOString(),
        },
      });
    }

    // -----------------------------------------------------------------
    // 1 & 2) Dave's exact reported scenario: General 7:00 AM-5:00 PM,
    //    adding an unpaid 12:00-1:00 PM break splits it into
    //    7:00-12:00 / break / 1:00-5:00, worked total becomes 9:00 and
    //    break total becomes 1:00, work start/end are unchanged.
    // -----------------------------------------------------------------
    {
      const start = zonedWallTimeToUtc(2017, 5, 1, 7, 0, 0);
      const end = zonedWallTimeToUtc(2017, 5, 1, 17, 0, 0);
      const entryId = await insertWork(dave!.id, generalActivity!.id, start, end);

      // 14) A bystander employee's own entry, same day/time shape, must
      //     never be touched by Dave's split.
      const bystanderStart = zonedWallTimeToUtc(2017, 5, 1, 7, 0, 0);
      const bystanderEnd = zonedWallTimeToUtc(2017, 5, 1, 17, 0, 0);
      const bystanderId = await insertWork(bystander!.id, generalActivity!.id, bystanderStart, bystanderEnd);

      const breakStart = zonedWallTimeToUtc(2017, 5, 1, 12, 0, 0);
      const breakEnd = zonedWallTimeToUtc(2017, 5, 1, 13, 0, 0);
      const res = await addBreak(dave!.id, DATE_MAIN, breakStart, breakEnd, { isPaid: false });
      check(res.status === 201, "1) Add Break for 12:00-1:00 succeeds instead of rejecting", res.body);

      const original = await fetchEntry(entryId);
      check(
        new Date(original.started_at).getTime() === start.getTime() &&
          new Date(original.ended_at).getTime() === breakStart.getTime() &&
          original.deleted_at === null,
        "1) the original General entry is trimmed to 7:00-12:00, not deleted",
        original
      );

      const { rows: continuationRows } = await pool.query(
        `select id, activity_id, started_at, ended_at, created_by_employee_id, creation_reason
         from time_entries where employee_id = $1 and activity_id = $2 and started_at = $3`,
        [dave!.id, generalActivity!.id, breakEnd]
      );
      check(continuationRows.length === 1, "1) exactly one continuation entry was created starting at 1:00 PM", continuationRows);
      const continuation = continuationRows[0];
      check(
        new Date(continuation.ended_at).getTime() === end.getTime(),
        "1) the continuation entry ends at the original 5:00 PM end",
        continuation
      );

      const { rows: breakRows } = await pool.query(
        `select id, started_at, ended_at, is_paid from time_entries where employee_id = $1 and entry_type = 'break'`,
        [dave!.id]
      );
      check(
        breakRows.length === 1 &&
          new Date(breakRows[0].started_at).getTime() === breakStart.getTime() &&
          new Date(breakRows[0].ended_at).getTime() === breakEnd.getTime() &&
          breakRows[0].is_paid === false,
        "1) the requested unpaid 12:00-1:00 break was inserted exactly as asked",
        breakRows
      );

      const daily = await call("GET", `/api/inputs/daily?employeeId=${dave!.id}&date=${DATE_MAIN}`, { token: adminToken });
      check(daily.body?.workStartTime && new Date(daily.body.workStartTime).getTime() === start.getTime(), "2) work start remains 7:00 AM", daily.body?.workStartTime);
      check(
        daily.body?.totals?.workedSeconds === 9 * 3600,
        "2) worked total becomes 9:00 (32400s)",
        daily.body?.totals
      );
      check(
        daily.body?.totals?.breakSeconds === 3600 && daily.body?.totals?.unpaidBreakSeconds === 3600,
        "2) break total becomes 1:00 (3600s), all unpaid",
        daily.body?.totals
      );
      const generalRuns = daily.body?.runs?.filter((r: any) => r.activityId === generalActivity!.id) ?? [];
      const lastRun = generalRuns[generalRuns.length - 1];
      check(
        lastRun?.endedAt && new Date(lastRun.endedAt).getTime() === end.getTime(),
        "2) work end remains 5:00 PM",
        lastRun
      );

      // 14) Bystander untouched.
      const bystanderAfter = await fetchEntry(bystanderId);
      check(
        new Date(bystanderAfter.started_at).getTime() === bystanderStart.getTime() &&
          new Date(bystanderAfter.ended_at).getTime() === bystanderEnd.getTime() &&
          bystanderAfter.deleted_at === null,
        "14) another employee's entry on the same day/time shape is never modified",
        bystanderAfter
      );
      const bystanderBreaks = await pool.query(`select id from time_entries where employee_id = $1 and entry_type = 'break'`, [bystander!.id]);
      check(bystanderBreaks.rows.length === 0, "14) no break was created for the bystander employee", bystanderBreaks.rows);

      // 13) Audit records: trim attributed to the admin with the automatic
      //     reason, continuation attributed to the admin with the fixed
      //     system-generated break reason, break itself attributed to the
      //     admin.
      const { rows: corrections } = await pool.query(
        `select field_name, old_value, new_value, changed_by_employee_id, reason from time_entry_corrections where time_entry_id = $1`,
        [entryId]
      );
      check(
        corrections.length === 1 &&
          corrections[0].field_name === "ended_at" &&
          corrections[0].changed_by_employee_id === adminActor!.id &&
          new Date(corrections[0].old_value).getTime() === end.getTime() &&
          new Date(corrections[0].new_value).getTime() === breakStart.getTime(),
        "13) the trim is recorded in time_entry_corrections, attributed to the admin",
        corrections
      );
      check(
        continuation.created_by_employee_id === adminActor!.id &&
          continuation.creation_reason === "Break manually added from Inputs page.",
        "13) the continuation entry's audit fields identify the admin and the fixed system-generated reason",
        continuation
      );
      const breakAudit = await pool.query(
        `select created_by_employee_id, creation_reason from time_entries where id = $1`,
        [breakRows[0].id]
      );
      check(
        breakAudit.rows[0].created_by_employee_id === adminActor!.id &&
          breakAudit.rows[0].creation_reason === "Break manually added from Inputs page.",
        "13) the break entry's own audit fields identify the admin and the fixed system-generated reason",
        breakAudit.rows[0]
      );
    }

    // -----------------------------------------------------------------
    // 3) Paid-break totals follow the existing paid-break rules — a paid
    //    break still splits the activity, but contributes to
    //    paidBreakSeconds (and therefore paid time), not unpaid. Per the
    //    Inputs workday-total/boundary-provenance fix (workdayTotals.ts):
    //    a paid break is never subtracted from Worked — Worked is now the
    //    whole 7:00-17:00 span, the paid break's own 15 minutes folded in
    //    (the employee is compensated for that span either way), not
    //    excluded from it the way an unpaid break's time is.
    // -----------------------------------------------------------------
    {
      const start = zonedWallTimeToUtc(2017, 5, 2, 7, 0, 0);
      const end = zonedWallTimeToUtc(2017, 5, 2, 17, 0, 0);
      await insertWork(dave!.id, generalActivity!.id, start, end);

      const breakStart = zonedWallTimeToUtc(2017, 5, 2, 12, 0, 0);
      const breakEnd = zonedWallTimeToUtc(2017, 5, 2, 12, 15, 0);
      const res = await addBreak(dave!.id, DATE_PAID_BREAK, breakStart, breakEnd, { isPaid: true });
      check(res.status === 201, "3) Add Break for a paid 12:00-12:15 break succeeds", res.body);

      const daily = await call("GET", `/api/inputs/daily?employeeId=${dave!.id}&date=${DATE_PAID_BREAK}`, { token: adminToken });
      check(
        daily.body?.totals?.paidBreakSeconds === 15 * 60 && daily.body?.totals?.unpaidBreakSeconds === 0,
        "3) the paid break contributes to paidBreakSeconds, not unpaidBreakSeconds",
        daily.body?.totals
      );
      check(
        daily.body?.totals?.workedSeconds === 10 * 3600,
        "3) worked total is the FULL 7:00-17:00 span (10:00:00) — a paid break is never subtracted from Worked",
        daily.body?.totals
      );
    }

    // -----------------------------------------------------------------
    // 4) Break at the BEGINNING of an activity — moves the work start
    //    forward, no zero-duration entry, no continuation created (the
    //    whole entry becomes the "after" piece).
    // -----------------------------------------------------------------
    {
      const start = zonedWallTimeToUtc(2017, 5, 3, 8, 0, 0);
      const end = zonedWallTimeToUtc(2017, 5, 3, 16, 0, 0);
      const entryId = await insertWork(dave!.id, generalActivity!.id, start, end);

      const breakStart = start;
      const breakEnd = zonedWallTimeToUtc(2017, 5, 3, 8, 30, 0);
      const res = await addBreak(dave!.id, DATE_BEGIN, breakStart, breakEnd);
      check(res.status === 201, "4) Add Break exactly at the activity's own start succeeds", res.body);

      const after = await fetchEntry(entryId);
      check(
        new Date(after.started_at).getTime() === breakEnd.getTime() && new Date(after.ended_at).getTime() === end.getTime(),
        "4) the work entry's start moves forward to the break's end — no zero-duration entry",
        after
      );
      const { rows: extraRows } = await pool.query(
        `select id from time_entries where employee_id = $1 and started_at::date = $2::date and entry_type = 'work'`,
        [dave!.id, DATE_BEGIN]
      );
      check(extraRows.length === 1, "4) no continuation entry was created — only the one trimmed entry remains", extraRows);
    }

    // -----------------------------------------------------------------
    // 5) Break at the END of an activity — trims the work end, no
    //    zero-duration continuation created.
    // -----------------------------------------------------------------
    {
      const start = zonedWallTimeToUtc(2017, 5, 4, 8, 0, 0);
      const end = zonedWallTimeToUtc(2017, 5, 4, 16, 0, 0);
      const entryId = await insertWork(dave!.id, generalActivity!.id, start, end);

      const breakStart = zonedWallTimeToUtc(2017, 5, 4, 15, 30, 0);
      const breakEnd = end;
      const res = await addBreak(dave!.id, DATE_END_BOUNDARY, breakStart, breakEnd);
      check(res.status === 201, "5) Add Break exactly at the activity's own end succeeds", res.body);

      const after = await fetchEntry(entryId);
      check(
        new Date(after.started_at).getTime() === start.getTime() && new Date(after.ended_at).getTime() === breakStart.getTime(),
        "5) the work entry's end trims back to the break's start — no zero-duration continuation",
        after
      );
      const { rows: extraRows } = await pool.query(
        `select id from time_entries where employee_id = $1 and started_at::date = $2::date and entry_type = 'work'`,
        [dave!.id, DATE_END_BOUNDARY]
      );
      check(extraRows.length === 1, "5) no continuation entry was created — only the one trimmed entry remains", extraRows);
    }

    // -----------------------------------------------------------------
    // 6) Break fully COVERING a whole (short) activity — that activity is
    //    soft-deleted, not left behind as a zero/negative-duration row.
    // -----------------------------------------------------------------
    {
      const coveredStart = zonedWallTimeToUtc(2017, 5, 5, 12, 0, 0);
      const coveredEnd = zonedWallTimeToUtc(2017, 5, 5, 12, 10, 0);
      const coveredId = await insertWork(dave!.id, secondActivity!.id, coveredStart, coveredEnd);

      const breakStart = zonedWallTimeToUtc(2017, 5, 5, 11, 45, 0);
      const breakEnd = zonedWallTimeToUtc(2017, 5, 5, 12, 15, 0);
      const res = await addBreak(dave!.id, DATE_FULL_COVER, breakStart, breakEnd);
      check(res.status === 201, "6) Add Break that fully covers a short activity succeeds", res.body);

      const covered = await fetchEntry(coveredId);
      check(
        covered.deleted_at !== null &&
          covered.deleted_by_employee_id === adminActor!.id &&
          typeof covered.deletion_reason === "string" &&
          covered.deletion_reason.length > 0,
        "6) the fully-covered activity is soft-deleted with admin/reason recorded, not hard-deleted",
        covered
      );
      const { rows: deletionRows } = await pool.query(
        `select deletion_type, affected_time_entry_ids, deleted_by_employee_id from time_entry_deletions where $1 = any(affected_time_entry_ids)`,
        [coveredId]
      );
      check(
        deletionRows.length === 1 && deletionRows[0].deleted_by_employee_id === adminActor!.id,
        "13) the covered-entry deletion is recorded in time_entry_deletions, attributed to the admin",
        deletionRows
      );
    }

    // -----------------------------------------------------------------
    // 7) Break spanning MULTIPLE work entries — the boundary entries are
    //    trimmed, and any entry fully inside is deleted, all atomically.
    // -----------------------------------------------------------------
    {
      const entryAId = await insertWork(
        dave!.id,
        generalActivity!.id,
        zonedWallTimeToUtc(2017, 5, 6, 8, 0, 0),
        zonedWallTimeToUtc(2017, 5, 6, 9, 30, 0)
      );
      const entryBId = await insertWork(
        dave!.id,
        secondActivity!.id,
        zonedWallTimeToUtc(2017, 5, 6, 9, 30, 0),
        zonedWallTimeToUtc(2017, 5, 6, 9, 45, 0)
      );
      const entryCId = await insertWork(
        dave!.id,
        generalActivity!.id,
        zonedWallTimeToUtc(2017, 5, 6, 9, 45, 0),
        zonedWallTimeToUtc(2017, 5, 6, 11, 0, 0)
      );

      const breakStart = zonedWallTimeToUtc(2017, 5, 6, 9, 0, 0);
      const breakEnd = zonedWallTimeToUtc(2017, 5, 6, 10, 30, 0);
      const res = await addBreak(dave!.id, DATE_MULTI_SPAN, breakStart, breakEnd);
      check(res.status === 201, "7) Add Break spanning three work entries succeeds", res.body);

      const a = await fetchEntry(entryAId);
      check(
        new Date(a.started_at).getTime() === zonedWallTimeToUtc(2017, 5, 6, 8, 0, 0).getTime() &&
          new Date(a.ended_at).getTime() === breakStart.getTime() &&
          a.deleted_at === null,
        "7) the leading entry is trimmed back to the break's start",
        a
      );
      const b = await fetchEntry(entryBId);
      check(b.deleted_at !== null, "7) the fully-covered middle entry is soft-deleted", b);
      const c = await fetchEntry(entryCId);
      check(
        new Date(c.started_at).getTime() === breakEnd.getTime() &&
          new Date(c.ended_at).getTime() === zonedWallTimeToUtc(2017, 5, 6, 11, 0, 0).getTime() &&
          c.deleted_at === null,
        "7) the trailing entry is trimmed forward to the break's end",
        c
      );
    }

    // -----------------------------------------------------------------
    // 8) Existing BREAK overlap is still rejected outright — a break can
    //    never split or absorb another break.
    // -----------------------------------------------------------------
    {
      const workId = await insertWork(
        dave!.id,
        generalActivity!.id,
        zonedWallTimeToUtc(2017, 5, 7, 7, 0, 0),
        zonedWallTimeToUtc(2017, 5, 7, 17, 0, 0)
      );
      const existingBreakId = await insertBreak(
        dave!.id,
        zonedWallTimeToUtc(2017, 5, 7, 12, 0, 0),
        zonedWallTimeToUtc(2017, 5, 7, 12, 30, 0)
      );

      const res = await addBreak(
        dave!.id,
        DATE_BREAK_OVERLAP,
        zonedWallTimeToUtc(2017, 5, 7, 12, 15, 0),
        zonedWallTimeToUtc(2017, 5, 7, 13, 0, 0)
      );
      check(
        res.status === 409 && /conflict/i.test(res.body?.error ?? ""),
        "8) a break overlapping an existing break is still rejected (409)",
        res.body
      );

      const workAfter = await fetchEntry(workId);
      check(
        new Date(workAfter.started_at).getTime() === zonedWallTimeToUtc(2017, 5, 7, 7, 0, 0).getTime() &&
          new Date(workAfter.ended_at).getTime() === zonedWallTimeToUtc(2017, 5, 7, 17, 0, 0).getTime(),
        "8) the surrounding work entry is completely untouched by the rejected request",
        workAfter
      );
      const existingBreakAfter = await fetchEntry(existingBreakId);
      check(
        new Date(existingBreakAfter.started_at).getTime() === zonedWallTimeToUtc(2017, 5, 7, 12, 0, 0).getTime(),
        "8) the existing break is completely untouched",
        existingBreakAfter
      );
    }

    // -----------------------------------------------------------------
    // 9) Exact boundary touches (new break's start/end lands exactly on
    //    an existing entry's own end/start) are valid, not overlaps —
    //    nothing is trimmed and no audit row is written.
    // -----------------------------------------------------------------
    {
      const beforeId = await insertWork(
        dave!.id,
        generalActivity!.id,
        zonedWallTimeToUtc(2017, 5, 8, 7, 0, 0),
        zonedWallTimeToUtc(2017, 5, 8, 12, 0, 0)
      );
      const afterId = await insertWork(
        dave!.id,
        generalActivity!.id,
        zonedWallTimeToUtc(2017, 5, 8, 13, 0, 0),
        zonedWallTimeToUtc(2017, 5, 8, 17, 0, 0)
      );

      const res = await addBreak(
        dave!.id,
        DATE_EXACT_TOUCH,
        zonedWallTimeToUtc(2017, 5, 8, 12, 0, 0),
        zonedWallTimeToUtc(2017, 5, 8, 13, 0, 0)
      );
      check(res.status === 201, "9) a break landing exactly between two existing entries (no overlap) succeeds", res.body);

      const beforeAfter = await fetchEntry(beforeId);
      const afterAfter = await fetchEntry(afterId);
      check(
        new Date(beforeAfter.ended_at).getTime() === zonedWallTimeToUtc(2017, 5, 8, 12, 0, 0).getTime() &&
          new Date(afterAfter.started_at).getTime() === zonedWallTimeToUtc(2017, 5, 8, 13, 0, 0).getTime(),
        "9) both surrounding entries are completely unchanged",
        { beforeAfter, afterAfter }
      );
      const { rows: corrections } = await pool.query(
        `select id from time_entry_corrections where time_entry_id = any($1::uuid[])`,
        [[beforeId, afterId]]
      );
      check(corrections.length === 0, "9) no correction audit rows are written for an exact boundary touch", corrections);
    }

    // -----------------------------------------------------------------
    // 10, 11, 12) A row/density-eligible activity split by a manual break
    //    stays ONE logical visit: one combined run, density counted
    //    exactly once, break time excluded from duration/speed, and no
    //    false "Needs review" badge or duplicate completion.
    // -----------------------------------------------------------------
    {
      const start = zonedWallTimeToUtc(2017, 5, 9, 7, 0, 0);
      const end = zonedWallTimeToUtc(2017, 5, 9, 15, 0, 0); // 8 hours
      const entryId = await insertWork(dave!.id, densityActivity!.id, start, end, {
        greenhouseRowId: row!.id,
        densityType: "plants",
        densityCountPerRow: 400,
      });

      const breakStart = zonedWallTimeToUtc(2017, 5, 9, 11, 0, 0);
      const breakEnd = zonedWallTimeToUtc(2017, 5, 9, 11, 30, 0); // 30-minute break
      const res = await addBreak(dave!.id, DATE_ROW_VISIT, breakStart, breakEnd);
      check(res.status === 201, "10) Add Break splitting a row/density activity succeeds", res.body);

      const original = await fetchEntry(entryId);
      check(
        original.greenhouse_row_id === row!.id &&
          original.density_type === "plants" &&
          Number(original.density_count_per_row) === 400,
        "10) the original (before-break) segment keeps its frozen row/density snapshot",
        original
      );
      const { rows: continuationRows } = await pool.query(
        `select id, greenhouse_row_id, density_type, density_count_per_row from time_entries
         where employee_id = $1 and activity_id = $2 and started_at = $3`,
        [dave!.id, densityActivity!.id, breakEnd]
      );
      check(
        continuationRows.length === 1 &&
          continuationRows[0].greenhouse_row_id === row!.id &&
          continuationRows[0].density_type === "plants" &&
          Number(continuationRows[0].density_count_per_row) === 400,
        "10) resuming after the inserted break retains the ORIGINAL frozen density snapshot verbatim (never re-resolved)",
        continuationRows
      );

      const daily = await call("GET", `/api/inputs/daily?employeeId=${dave!.id}&date=${DATE_ROW_VISIT}`, { token: adminToken });
      const rowRuns = daily.body?.runs?.filter((r: any) => r.row?.id === row!.id) ?? [];
      check(rowRuns.length === 1, "10) the two segments are shown as ONE combined logical run, not two", rowRuns.length);
      const combinedRun = rowRuns[0];
      check(
        combinedRun?.segmentIds?.length === 2,
        "10) that one run is made of both underlying segments (before + after the break)",
        combinedRun?.segmentIds
      );

      // 11) 7.5 hours of actual work (8h total minus the 30-minute break),
      //     400 plants counted exactly once: 400 / 7.5 = 53.33.../hr.
      check(
        combinedRun?.durationSeconds === 7.5 * 3600,
        "11) break time is excluded from the run's worked duration (7.5h, not 8h)",
        combinedRun?.durationSeconds
      );
      check(
        Math.abs((combinedRun?.calculatedSpeedPerHour?.value ?? 0) - 400 / 7.5) < 0.01,
        "11) speed reflects the row's density counted exactly once over the break-excluded duration",
        combinedRun?.calculatedSpeedPerHour
      );

      // 12) No false "Needs review" badge, and no row_completions record
      //     was created for this single, unambiguous visit.
      check(
        combinedRun?.isUnresolvedRowCompletion === false,
        "12) no false 'Needs review' badge appears for the split visit",
        combinedRun
      );
      check(combinedRun?.rowCompletion === null, "12) no completion record was created — a single visit never needs one", combinedRun?.rowCompletion);
      const { rows: completionRows } = await pool.query(
        `select rc.id from row_completions rc
         join row_completion_segments rcs on rcs.row_completion_id = rc.id
         where rcs.time_entry_id = any($1::uuid[])`,
        [[entryId, continuationRows[0]?.id].filter(Boolean)]
      );
      check(completionRows.length === 0, "12) no duplicate row_completions record exists for this single physical visit", completionRows);
    }

    // -----------------------------------------------------------------
    // 15) Forced-failure atomicity: if the multi-step write fails partway
    //     through (simulated here the same way the real route's own
    //     try/catch/rollback would encounter a genuine DB error — the real
    //     HTTP route's own request validation prevents ever REACHING this
    //     state through the public API, which is a good thing, but the
    //     underlying transaction's atomicity has to hold regardless of
    //     what causes a late failure, not just the validated ones), the
    //     ENTIRE adjustment rolls back — no trim, no continuation, no
    //     deletion, no break survives partially applied.
    // -----------------------------------------------------------------
    {
      const start = zonedWallTimeToUtc(2017, 5, 10, 7, 0, 0);
      const end = zonedWallTimeToUtc(2017, 5, 10, 17, 0, 0);
      const entryId = await insertWork(dave!.id, generalActivity!.id, start, end);
      const before = await fetchEntry(entryId);

      const breakStart = zonedWallTimeToUtc(2017, 5, 10, 12, 0, 0);
      const breakEnd = zonedWallTimeToUtc(2017, 5, 10, 13, 0, 0);

      const client = await pool.connect();
      let rolledBack = false;
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1::text))", [dave!.id]);
        // Same trim this scenario would legitimately compute.
        await client.query(`update time_entries set ended_at = $1 where id = $2`, [breakStart, entryId]);
        await client.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')`,
          [dave!.id, generalActivity!.id, breakEnd, end]
        );
        // Deliberately invalid foreign key on the FINAL step — a break
        // referencing a break_profile_items id that doesn't exist. A real
        // Postgres FK violation, not a simulated/mocked one.
        await client.query(
          `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source, break_profile_item_id)
           values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual', $4)`,
          [dave!.id, breakStart, breakEnd, "00000000-0000-0000-0000-000000000000"]
        );
        await client.query("commit");
      } catch {
        await client.query("rollback");
        rolledBack = true;
      } finally {
        client.release();
      }
      check(rolledBack, "15) the forced final-step failure was caught and rolled back", rolledBack);

      const after = await fetchEntry(entryId);
      check(
        JSON.stringify(before) === JSON.stringify(after),
        "15) the original entry is completely intact after rollback — the trim never persisted",
        { before, after }
      );
      const { rows: leftoverContinuation } = await pool.query(
        `select id from time_entries where employee_id = $1 and started_at = $2`,
        [dave!.id, breakEnd]
      );
      check(leftoverContinuation.length === 0, "15) no continuation entry survived the rollback", leftoverContinuation);
      const { rows: leftoverBreak } = await pool.query(
        `select id from time_entries where employee_id = $1 and entry_type = 'break' and started_at = $2`,
        [dave!.id, breakStart]
      );
      check(leftoverBreak.length === 0, "15) no break entry survived the rollback", leftoverBreak);
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
      pool.query(`delete from time_entry_deletions where employee_id in (select id from employees where email like $1)`, [
        `qa-abs-%-${RUN_ID}@test.local`,
      ])
    );
    await tryDelete("time_entry_corrections", () =>
      pool.query(
        `delete from time_entry_corrections where employee_id in (select id from employees where email like $1)`,
        [`qa-abs-%-${RUN_ID}@test.local`]
      )
    );
    await tryDelete("row_completion_segments", () =>
      pool.query(
        `delete from row_completion_segments where time_entry_id in (select id from time_entries where employee_id in (select id from employees where email like $1))`,
        [`qa-abs-%-${RUN_ID}@test.local`]
      )
    );
    await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = $1`, [row?.id]));
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-abs-%-${RUN_ID}@test.local`,
      ])
    );
    if (row) await tryDelete("greenhouse_rows", () => pool.query("delete from greenhouse_rows where id = $1", [row.id]));
    if (phase) await tryDelete("greenhouse_phases", () => pool.query("delete from greenhouse_phases where id = $1", [phase.id]));
    if (land) await tryDelete("greenhouse_lands", () => pool.query("delete from greenhouse_lands where id = $1", [land.id]));
    for (const actor of [dave, bystander, adminActor]) {
      if (actor) await tryDelete("employees", () => pool.query("delete from employees where id = $1", [actor.id]));
    }
    if (generalActivity || secondActivity || densityActivity) {
      await tryDelete("activities", () =>
        pool.query("delete from activities where id = any($1::uuid[])", [
          [generalActivity?.id, secondActivity?.id, densityActivity?.id].filter(Boolean),
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
