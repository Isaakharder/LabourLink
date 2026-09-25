// Feature test for POST /api/inputs/breaks/add-all — "Add All Applicable
// Breaks" on the Inputs Add Break modal. Determines the employee's work
// window from their recorded work start/finish for the date, finds every
// configured break preset whose full start/end falls inside that window,
// excludes anything already recorded (by preset id or by time overlap with
// ANY existing break, preset or custom), and inserts every result in one
// transaction — reusing the exact same planBreakInsertion /
// applyBreakInsertionPlan / insertBreakEntry helpers POST /breaks (the
// single-add flow) uses, so split/trim/merge behavior around each inserted
// break is identical, not a second implementation of it.
//
// Run with: npm run test:add-all-breaks
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
const DATE = "2018-04-10"; // QA-only past date, EDT (UTC-4) — never collides with real data

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

  async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Cookie: `labourlink_session=${token}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const responseBody = await res.json().catch(() => null);
    return { status: res.status, body: responseBody };
  }
  function addAll(employeeId: string, date: string) {
    return call("POST", "/api/inputs/breaks/add-all", adminToken, { employeeId, date });
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];
  let profileId: string | undefined;
  let rollbackProfileId: string | undefined;
  let adminToken = "";

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const adminRoleId = await roleId("Administrator");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`AddAllBreaks Admin ${RUN_ID}`, `qa-add-all-breaks-admin-${RUN_ID}@test.local`, adminRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA AddAllBreaks Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    async function insertProfile(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
        `QA AddAllBreaks ${label} ${RUN_ID}`,
      ]);
      return rows[0].id;
    }
    async function insertItem(pid: string, name: string, startTime: string, endTime: string, isPaid: boolean, sortOrder: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, sort_order)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [pid, name, startTime, endTime, isPaid, sortOrder]
      );
      return rows[0].id;
    }

    profileId = await insertProfile("Full Breaks");
    const morningId = await insertItem(profileId, "Morning", "09:30:00", "09:45:00", false, 1);
    const lunchId = await insertItem(profileId, "Lunch", "12:00:00", "13:00:00", false, 2);
    const afternoonId = await insertItem(profileId, "Afternoon", "15:00:00", "15:15:00", true, 3);

    // A second profile, used only by the rollback scenario below: "Overlap"
    // deliberately overlaps Lunch (12:00-1:00) at 12:30-12:45 — a
    // misconfigured profile is the one realistic way a candidate later in
    // the sorted batch can still fail planBreakInsertion after an earlier
    // candidate in the SAME request has already been inserted, since every
    // candidate is otherwise pre-filtered against the work window and every
    // ALREADY-existing break before the batch even starts.
    rollbackProfileId = await insertProfile("Rollback Breaks");
    const rbMorningId = await insertItem(rollbackProfileId, "Morning", "09:30:00", "09:45:00", false, 1);
    const rbLunchId = await insertItem(rollbackProfileId, "Lunch", "12:00:00", "13:00:00", false, 2);
    const rbOverlapId = await insertItem(rollbackProfileId, "Overlap", "12:30:00", "12:45:00", false, 3);
    const rbAfternoonId = await insertItem(rollbackProfileId, "Afternoon", "15:00:00", "15:15:00", true, 4);
    void rbMorningId;
    void rbAfternoonId;

    async function insertEmployee(label: string, withProfileId: string | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ('QA', $1, $2, $3, $4, $5, true, $6) returning id`,
        [
          `AddAllBreaks-${label}-${RUN_ID}`,
          `qa-add-all-breaks-${label.toLowerCase()}-${RUN_ID}@test.local`,
          employeeRoleId,
          teamRoleId,
          fakePinHash,
          withProfileId,
        ]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertWork(empId: string, startedAt: Date, endedAt: Date | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual') returning id`,
        [empId, activityId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBreakDirect(empId: string, breakProfileItemId: string | null, startedAt: Date, endedAt: Date, isPaid: boolean): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source, break_profile_item_id, scheduled_break_date, is_paid)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual', $4, $5, $6) returning id`,
        [empId, startedAt, endedAt, breakProfileItemId, DATE, isPaid]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function fetchBreaks(empId: string): Promise<any[]> {
      const { rows } = await pool.query(
        `select id, break_profile_item_id, started_at, ended_at, is_paid from time_entries
         where employee_id = $1 and entry_type = 'break' and deleted_at is null order by started_at asc`,
        [empId]
      );
      return rows;
    }
    const fullShiftStart = zonedWallTimeToUtc(2018, 4, 10, 6, 45, 0);
    const fullShiftEnd = zonedWallTimeToUtc(2018, 4, 10, 18, 0, 0);
    const morningStart = zonedWallTimeToUtc(2018, 4, 10, 9, 30, 0);
    const morningEnd = zonedWallTimeToUtc(2018, 4, 10, 9, 45, 0);
    const lunchStart = zonedWallTimeToUtc(2018, 4, 10, 12, 0, 0);
    const lunchEnd = zonedWallTimeToUtc(2018, 4, 10, 13, 0, 0);
    const afternoonStart = zonedWallTimeToUtc(2018, 4, 10, 15, 0, 0);
    const afternoonEnd = zonedWallTimeToUtc(2018, 4, 10, 15, 15, 0);

    // -----------------------------------------------------------------
    // 0) Basic validation — before any of the real scenarios.
    // -----------------------------------------------------------------
    {
      const res = await call("POST", "/api/inputs/breaks/add-all", adminToken, { employeeId: "not-a-uuid", date: DATE });
      check(res.status === 400, "0) an invalid employeeId is rejected (400)", res);
    }

    // -----------------------------------------------------------------
    // 1) FULL SHIFT (6:45 AM-6:00 PM): all three presets are fully inside
    //    the work window, none already recorded — all three are added in
    //    one call, splitting the single work entry into four segments,
    //    exactly as three individual Add Break calls would.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("FullShift", profileId);
      const workId = await insertWork(empId, fullShiftStart, fullShiftEnd);

      const res = await addAll(empId, DATE);
      check(res.status === 201, "1) full shift: all three applicable breaks are added (201)", res.body);
      check(res.body?.added?.length === 3, "1) response reports exactly three added breaks", res.body?.added);

      const breaks = await fetchBreaks(empId);
      check(breaks.length === 3, "1) exactly three break rows exist", breaks.length);
      check(
        breaks[0].break_profile_item_id === morningId &&
          breaks[1].break_profile_item_id === lunchId &&
          breaks[2].break_profile_item_id === afternoonId,
        "1) Morning, Lunch, and Afternoon were each inserted with their own configured preset id",
        breaks
      );
      check(
        new Date(breaks[0].started_at).getTime() === morningStart.getTime() && new Date(breaks[0].ended_at).getTime() === morningEnd.getTime(),
        "1) Morning resolved to its exact configured 9:30-9:45",
        breaks[0]
      );
      check(breaks[2].is_paid === true, "1) Afternoon's paid status came from its own configured item (paid)", breaks[2]);

      // The original work entry was split around each break, just as three
      // separate Add Break calls would have done via planBreakInsertion.
      const { rows: workRows } = await pool.query(
        `select started_at, ended_at, deleted_at from time_entries
         where employee_id = $1 and entry_type = 'work' order by started_at asc`,
        [empId]
      );
      check(workRows.length === 4 && workRows.every((r: any) => r.deleted_at === null), "1) the work entry was split into four surviving segments", workRows);
      check(
        new Date(workRows[0].started_at).getTime() === fullShiftStart.getTime() && new Date(workRows[0].ended_at).getTime() === morningStart.getTime(),
        "1) segment 1: shift start through Morning's start",
        workRows[0]
      );
      check(
        new Date(workRows[1].started_at).getTime() === morningEnd.getTime() && new Date(workRows[1].ended_at).getTime() === lunchStart.getTime(),
        "1) segment 2: Morning's end through Lunch's start",
        workRows[1]
      );
      check(
        new Date(workRows[2].started_at).getTime() === lunchEnd.getTime() && new Date(workRows[2].ended_at).getTime() === afternoonStart.getTime(),
        "1) segment 3: Lunch's end through Afternoon's start",
        workRows[2]
      );
      check(
        new Date(workRows[3].started_at).getTime() === afternoonEnd.getTime() && new Date(workRows[3].ended_at).getTime() === fullShiftEnd.getTime(),
        "1) segment 4: Afternoon's end through shift end",
        workRows[3]
      );
      void workId;
    }

    // -----------------------------------------------------------------
    // 2) PARTIAL SHIFT: work window covers only Lunch (11:30 AM-1:30 PM) —
    //    Morning and Afternoon fall outside it and must NOT be added, even
    //    though they're otherwise unresolved/available presets.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("PartialShift", profileId);
      await insertWork(empId, zonedWallTimeToUtc(2018, 4, 10, 11, 30, 0), zonedWallTimeToUtc(2018, 4, 10, 13, 30, 0));

      const res = await addAll(empId, DATE);
      check(res.status === 201, "2) partial shift succeeds (201)", res.body);
      check(res.body?.added?.length === 1 && res.body?.added?.[0]?.breakProfileItemId === lunchId, "2) only Lunch is reported as added", res.body?.added);

      const breaks = await fetchBreaks(empId);
      check(
        breaks.length === 1 && breaks[0].break_profile_item_id === lunchId,
        "2) only Lunch was inserted — Morning and Afternoon fall outside this shorter work window",
        breaks
      );
    }

    // -----------------------------------------------------------------
    // 3) EXISTING BREAK: Lunch is already recorded (by preset id) — it must
    //    be excluded, left completely untouched, and only Morning/Afternoon
    //    are added.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ExistingBreak", profileId);
      await insertWork(empId, fullShiftStart, fullShiftEnd);
      const existingLunchId = await insertBreakDirect(empId, lunchId, lunchStart, lunchEnd, false);

      const res = await addAll(empId, DATE);
      check(res.status === 201, "3) existing-break scenario still succeeds for the other two (201)", res.body);
      check(
        res.body?.added?.length === 2 && res.body.added.every((a: any) => a.breakProfileItemId !== lunchId),
        "3) Lunch is never re-added — only Morning and Afternoon are reported",
        res.body?.added
      );

      const breaks = await fetchBreaks(empId);
      check(breaks.length === 3, "3) exactly three break rows exist total (one pre-existing plus two new)", breaks.length);
      const lunchRow = breaks.find((b) => b.break_profile_item_id === lunchId);
      check(lunchRow?.id === existingLunchId, "3) the original Lunch row is completely untouched (same id)", { existingLunchId, lunchRow });
    }

    // -----------------------------------------------------------------
    // 4) OVERLAPPING BREAK: a CUSTOM break (no breakProfileItemId) already
    //    occupies part of Afternoon's slot — Afternoon must be excluded
    //    even though no preset with its own id was ever recorded; Morning
    //    and Lunch, which don't overlap anything, are still added.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("OverlappingBreak", profileId);
      await insertWork(empId, fullShiftStart, fullShiftEnd);
      const customStart = zonedWallTimeToUtc(2018, 4, 10, 14, 45, 0);
      const customEnd = zonedWallTimeToUtc(2018, 4, 10, 15, 5, 0); // overlaps Afternoon's 15:00-15:15
      const customId = await insertBreakDirect(empId, null, customStart, customEnd, false);

      const res = await addAll(empId, DATE);
      check(res.status === 201, "4) overlapping-break scenario still succeeds for the other two (201)", res.body);
      check(
        res.body?.added?.length === 2 && res.body.added.every((a: any) => a.breakProfileItemId !== afternoonId),
        "4) Afternoon is excluded — it overlaps the existing custom break, never attempted",
        res.body?.added
      );

      const breaks = await fetchBreaks(empId);
      check(breaks.length === 3, "4) exactly three break rows exist total (the custom break plus Morning and Lunch)", breaks.length);
      check(
        !breaks.some((b) => b.break_profile_item_id === afternoonId),
        "4) no row was ever created for Afternoon",
        breaks
      );
      check(breaks.some((b) => b.id === customId), "4) the original custom break is untouched", breaks);
    }

    // -----------------------------------------------------------------
    // 5) NO APPLICABLE BREAKS: all three presets already recorded — a
    //    genuine success with nothing to do (200, not an error), and
    //    nothing new is created.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("NoneApplicable", profileId);
      await insertWork(empId, fullShiftStart, fullShiftEnd);
      await insertBreakDirect(empId, morningId, morningStart, morningEnd, false);
      await insertBreakDirect(empId, lunchId, lunchStart, lunchEnd, false);
      await insertBreakDirect(empId, afternoonId, afternoonStart, afternoonEnd, true);

      const res = await addAll(empId, DATE);
      check(res.status === 200, "5) nothing to add is a success (200), not an error", res.body);
      check(Array.isArray(res.body?.added) && res.body.added.length === 0, "5) the added list is genuinely empty", res.body?.added);

      const breaks = await fetchBreaks(empId);
      check(breaks.length === 3, "5) still exactly three break rows — nothing new was created", breaks.length);
    }

    // -----------------------------------------------------------------
    // 6) ROLLBACK: a misconfigured profile has Lunch (12:00-1:00) and
    //    Overlap (12:30-12:45) genuinely overlapping each other. Candidates
    //    are applied in start-time order, so Lunch is inserted successfully
    //    FIRST — then Overlap's own planBreakInsertion call finds Lunch's
    //    freshly-inserted row blocking it and fails. The whole batch must
    //    roll back: NOT EVEN Lunch (already successfully applied earlier in
    //    the same request) may survive, and the original work entry must be
    //    completely unchanged.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("Rollback", rollbackProfileId!);
      const workId = await insertWork(empId, fullShiftStart, fullShiftEnd);

      const res = await addAll(empId, DATE);
      check(res.status === 409, "6) a genuine mid-batch conflict rolls back the whole request (409)", res.body);

      const breaks = await fetchBreaks(empId);
      check(breaks.length === 0, "6) NOTHING was left behind — not even Lunch, which was successfully applied earlier in the same transaction", breaks);

      const { rows: workRows } = await pool.query(`select started_at, ended_at, deleted_at from time_entries where id = $1`, [workId]);
      check(
        workRows.length === 1 &&
          new Date(workRows[0].started_at).getTime() === fullShiftStart.getTime() &&
          new Date(workRows[0].ended_at).getTime() === fullShiftEnd.getTime() &&
          workRows[0].deleted_at === null,
        "6) the original work entry is completely intact — the trim that would have accompanied Lunch never persisted",
        workRows
      );

      void rbLunchId;
      void rbOverlapId;
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
      await tryDelete("time_entry_deletions", () => pool.query(`delete from time_entry_deletions where employee_id = any($1::uuid[])`, [employeeIds]));
      await tryDelete("time_entry_corrections", () => pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds]));
      await tryDelete("time_entries", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    // Employees must be deleted before break_profiles — employees.break_profile_id
    // references break_profiles(id), so a profile can't be removed first.
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    for (const pid of [profileId, rollbackProfileId]) {
      if (pid) {
        await tryDelete("break_profile_items", () => pool.query(`delete from break_profile_items where break_profile_id = $1`, [pid]));
        await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = $1`, [pid]));
      }
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
