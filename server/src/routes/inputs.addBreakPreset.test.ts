// Regression + feature test for the simplified Inputs Add Break modal's
// server side: POST /breaks now resolves a preset ("configured") break's
// start/end time-of-day and paid/unpaid status ENTIRELY from
// break_profile_items server-side, combined with the selected calendar date
// in APP_TIMEZONE (zonedWallTimeToUtc) — client-supplied startTime/endTime
// are never trusted for a preset, only breakProfileItemId is. A Custom
// break (no breakProfileItemId) keeps the exact, unrounded
// administrator-entered time/paid-status behavior unchanged. The existing
// planBreakInsertion trim/split/delete planner and the employee advisory
// lock are unchanged and reused for both paths. A configured break can only
// be added once per employee per date — enforced inside the same
// advisory-locked transaction, so a double Save is idempotent (at most one
// row ever exists).
//
// Run with: npm run test:add-break-preset
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

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];
  let profileId: string | undefined;

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
        [`AddBreakPreset Admin ${RUN_ID}`, `qa-add-break-preset-admin-${RUN_ID}@test.local`, adminRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA AddBreakPreset Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    const profile = (
      await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
        `QA Full Breaks ${RUN_ID}`,
      ])
    ).rows[0];
    profileId = profile.id;
    async function insertItem(name: string, startTime: string, endTime: string, isPaid: boolean, sortOrder: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, sort_order)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [profileId, name, startTime, endTime, isPaid, sortOrder]
      );
      return rows[0].id;
    }
    const morningId = await insertItem("Morning", "09:00:00", "09:15:00", false, 1);
    const lunchId = await insertItem("Lunch", "12:00:00", "13:00:00", false, 2);
    const afternoonId = await insertItem("Afternoon", "15:00:00", "15:15:00", true, 3);

    async function insertEmployee(label: string, withProfile: boolean): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ('QA', $1, $2, $3, $4, $5, true, $6) returning id`,
        [
          `AddBreakPreset-${label}-${RUN_ID}`,
          `qa-add-break-preset-${label.toLowerCase()}-${RUN_ID}@test.local`,
          employeeRoleId,
          teamRoleId,
          fakePinHash,
          withProfile ? profileId : null,
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
    async function fetchEntry(id: string): Promise<any> {
      const { rows } = await pool.query(
        `select id, entry_type, started_at, ended_at, is_paid, break_profile_item_id, scheduled_break_date, deleted_at
         from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }
    function addBreak(empId: string, date: string, body: Record<string, unknown>) {
      return call("POST", "/api/inputs/breaks", adminToken, { employeeId: empId, date, ...body });
    }

    // -----------------------------------------------------------------
    // 1) Every preset in the profile — each resolves its OWN configured
    //    time-of-day and paid status server-side, splitting a wide work
    //    entry exactly as planBreakInsertion always has.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("EveryPreset", true);
      const date = "2026-08-10";
      await insertWork(empId, zonedWallTimeToUtc(2026, 8, 10, 7, 0, 0), zonedWallTimeToUtc(2026, 8, 10, 18, 0, 0));

      for (const [itemId, label, sh, sm, eh, em, isPaid] of [
        [morningId, "Morning", 9, 0, 9, 15, false],
        [lunchId, "Lunch", 12, 0, 13, 0, false],
        [afternoonId, "Afternoon", 15, 0, 15, 15, true],
      ] as const) {
        const res = await addBreak(empId, date, { breakProfileItemId: itemId });
        check(res.status === 201, `1) Add Break for preset "${label}" succeeds`, res.body);
      }

      const { rows: breaks } = await pool.query(
        `select break_profile_item_id, started_at, ended_at, is_paid from time_entries
         where employee_id = $1 and entry_type = 'break' order by started_at asc`,
        [empId]
      );
      check(breaks.length === 3, "1) all three presets were inserted", breaks.length);
      check(
        breaks[0].break_profile_item_id === morningId &&
          new Date(breaks[0].started_at).getTime() === zonedWallTimeToUtc(2026, 8, 10, 9, 0, 0).getTime() &&
          new Date(breaks[0].ended_at).getTime() === zonedWallTimeToUtc(2026, 8, 10, 9, 15, 0).getTime() &&
          breaks[0].is_paid === false,
        "1) Morning resolved to its exact configured 9:00-9:15, unpaid",
        breaks[0]
      );
      check(
        breaks[1].break_profile_item_id === lunchId &&
          new Date(breaks[1].started_at).getTime() === zonedWallTimeToUtc(2026, 8, 10, 12, 0, 0).getTime() &&
          new Date(breaks[1].ended_at).getTime() === zonedWallTimeToUtc(2026, 8, 10, 13, 0, 0).getTime() &&
          breaks[1].is_paid === false,
        "1) Lunch resolved to its exact configured 12:00-1:00, unpaid",
        breaks[1]
      );
      check(
        breaks[2].break_profile_item_id === afternoonId &&
          new Date(breaks[2].started_at).getTime() === zonedWallTimeToUtc(2026, 8, 10, 15, 0, 0).getTime() &&
          new Date(breaks[2].ended_at).getTime() === zonedWallTimeToUtc(2026, 8, 10, 15, 15, 0).getTime() &&
          breaks[2].is_paid === true,
        "1) Afternoon resolved to its exact configured 3:00-3:15 PM, PAID",
        breaks[2]
      );

      const daily = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=${date}`, adminToken);
      check(daily.body?.totals?.paidBreakSeconds === 15 * 60, "1) paid-break total reflects only Afternoon", daily.body?.totals);
      check(daily.body?.totals?.unpaidBreakSeconds === 15 * 60 + 3600, "1) unpaid-break total reflects Morning + Lunch", daily.body?.totals);
    }

    // -----------------------------------------------------------------
    // 2) The server never trusts client-supplied startTime/endTime/isPaid
    //    for a preset — even a deliberately WRONG client payload alongside
    //    a valid breakProfileItemId still resolves to the item's real
    //    configured times and paid status.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("UntrustedClientTimes", true);
      const date = "2026-08-11";
      await insertWork(empId, zonedWallTimeToUtc(2026, 8, 11, 7, 0, 0), zonedWallTimeToUtc(2026, 8, 11, 18, 0, 0));

      const res = await addBreak(empId, date, {
        breakProfileItemId: lunchId,
        // Deliberately bogus — a stale/malicious client claiming this is a
        // paid 3:00-3:05 AM break. Must be completely ignored.
        startTime: zonedWallTimeToUtc(2026, 8, 11, 3, 0, 0).toISOString(),
        endTime: zonedWallTimeToUtc(2026, 8, 11, 3, 5, 0).toISOString(),
        isPaid: true,
      });
      check(res.status === 201, "2) Add Break succeeds despite bogus client-supplied fields", res.body);

      const { rows } = await pool.query(
        `select started_at, ended_at, is_paid from time_entries where employee_id = $1 and entry_type = 'break'`,
        [empId]
      );
      check(
        new Date(rows[0].started_at).getTime() === zonedWallTimeToUtc(2026, 8, 11, 12, 0, 0).getTime() &&
          new Date(rows[0].ended_at).getTime() === zonedWallTimeToUtc(2026, 8, 11, 13, 0, 0).getTime() &&
          rows[0].is_paid === false,
        "2) the real configured Lunch time/paid-status was used, not the bogus client values",
        rows[0]
      );
    }

    // -----------------------------------------------------------------
    // 3) Custom break — exact administrator-entered time and chosen
    //    paid/unpaid status, unaffected by any of the preset logic.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("CustomBreak", true);
      const date = "2026-08-12";
      const start = zonedWallTimeToUtc(2026, 8, 12, 10, 3, 27);
      const end = zonedWallTimeToUtc(2026, 8, 12, 10, 18, 42);
      const res = await addBreak(empId, date, {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        isPaid: true,
      });
      check(res.status === 201, "3) Custom break succeeds", res.body);

      const { rows } = await pool.query(
        `select started_at, ended_at, is_paid, break_profile_item_id from time_entries where employee_id = $1 and entry_type = 'break'`,
        [empId]
      );
      check(
        new Date(rows[0].started_at).getTime() === start.getTime() &&
          new Date(rows[0].ended_at).getTime() === end.getTime() &&
          rows[0].is_paid === true &&
          rows[0].break_profile_item_id === null,
        "3) Custom break stores the exact odd-second administrator-entered time, no rounding, paid as chosen",
        rows[0]
      );
    }

    // -----------------------------------------------------------------
    // 4) Duplicate preset — the same configured break can't be added twice
    //    for the same employee/date.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("Duplicate", true);
      const date = "2026-08-13";
      const first = await addBreak(empId, date, { breakProfileItemId: lunchId });
      check(first.status === 201, "4) first Lunch add succeeds", first.body);

      const second = await addBreak(empId, date, { breakProfileItemId: lunchId });
      check(second.status === 409, "4) adding the same preset again for the same date is rejected", second);
      check(/already/i.test(second.body?.error ?? ""), "4) rejection message says it's already added", second.body);

      const { rows } = await pool.query(
        `select id from time_entries where employee_id = $1 and entry_type = 'break' and break_profile_item_id = $2`,
        [empId, lunchId]
      );
      check(rows.length === 1, "4) only one break row exists — the duplicate attempt created nothing", rows.length);

      // A DIFFERENT preset (Morning) on the same date is unaffected — the
      // duplicate check is scoped per break type, not per date overall.
      const morningRes = await addBreak(empId, date, { breakProfileItemId: morningId });
      check(morningRes.status === 201, "4) a different preset on the same date still succeeds", morningRes.body);
    }

    // -----------------------------------------------------------------
    // 5) Duplicate against an entry from a DIFFERENT source (e.g. a real
    //    phone tap / auto-add) is caught too — not just admin-added ones.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("DuplicateOtherSource", true);
      const date = "2026-08-14";
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source, break_profile_item_id, scheduled_break_date, is_paid)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'auto', $4, $5, false)`,
        [empId, zonedWallTimeToUtc(2026, 8, 14, 12, 0, 0), zonedWallTimeToUtc(2026, 8, 14, 13, 0, 0), lunchId, date]
      );
      const res = await addBreak(empId, date, { breakProfileItemId: lunchId });
      check(res.status === 409, "5) duplicate check catches an existing auto-added row too, not just manual ones", res);
    }

    // -----------------------------------------------------------------
    // 6) Double Save idempotency: two concurrent identical Add-preset
    //    requests — exactly one succeeds, only one row ever exists.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("DoubleSave", true);
      const date = "2026-08-15";
      const [r1, r2] = await Promise.all([
        addBreak(empId, date, { breakProfileItemId: lunchId }),
        addBreak(empId, date, { breakProfileItemId: lunchId }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      check(statuses[0] === 201 && statuses[1] === 409, "6) exactly one of two concurrent identical Saves succeeds", { r1: r1.status, r2: r2.status });

      const { rows } = await pool.query(
        `select id from time_entries where employee_id = $1 and entry_type = 'break' and break_profile_item_id = $2`,
        [empId, lunchId]
      );
      check(rows.length === 1, "6) exactly one break row exists after the double Save", rows.length);
    }

    // -----------------------------------------------------------------
    // 7) Date/timezone handling: the same preset resolves to the correct
    //    UTC instant across a DST boundary (EDT vs EST), proving the
    //    server combines date + configured time via the real
    //    application-timezone conversion, not naive UTC arithmetic.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("DstHandling", true);
      const edtDate = "2026-08-16"; // EDT (UTC-4)
      const estDate = "2026-01-16"; // EST (UTC-5)

      const edtRes = await addBreak(empId, edtDate, { breakProfileItemId: lunchId });
      check(edtRes.status === 201, "7) EDT-date preset add succeeds", edtRes.body);
      const estRes = await addBreak(empId, estDate, { breakProfileItemId: lunchId });
      check(estRes.status === 201, "7) EST-date preset add succeeds", estRes.body);

      const { rows } = await pool.query(
        `select scheduled_break_date, started_at from time_entries
         where employee_id = $1 and entry_type = 'break' order by started_at asc`,
        [empId]
      );
      const est = rows.find((r: any) => new Date(r.started_at) < new Date("2026-06-01"));
      const edt = rows.find((r: any) => new Date(r.started_at) >= new Date("2026-06-01"));
      check(
        new Date(est.started_at).toISOString() === "2026-01-16T17:00:00.000Z",
        "7) 12:00 PM EST correctly resolves to 17:00 UTC (UTC-5)",
        est
      );
      check(
        new Date(edt.started_at).toISOString() === "2026-08-16T16:00:00.000Z",
        "7) 12:00 PM EDT correctly resolves to 16:00 UTC (UTC-4) — one hour earlier in UTC than the EST case",
        edt
      );
    }

    // -----------------------------------------------------------------
    // 8) Work splitting via a PRESET (not just Custom) — confirms
    //    planBreakInsertion still trims/splits correctly when the break's
    //    range came from server-resolved configured times.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("PresetSplitsWork", true);
      const date = "2026-08-17";
      const workId = await insertWork(empId, zonedWallTimeToUtc(2026, 8, 17, 7, 0, 0), zonedWallTimeToUtc(2026, 8, 17, 17, 0, 0));

      const res = await addBreak(empId, date, { breakProfileItemId: lunchId });
      check(res.status === 201, "8) preset Add Break splitting an activity succeeds", res.body);

      const work = await fetchEntry(workId);
      check(
        new Date(work.ended_at).getTime() === zonedWallTimeToUtc(2026, 8, 17, 12, 0, 0).getTime() && work.deleted_at === null,
        "8) the work entry is trimmed to end exactly at Lunch's configured 12:00 start",
        work
      );
      const { rows: continuationRows } = await pool.query(
        `select id, started_at, ended_at from time_entries
         where employee_id = $1 and entry_type = 'work' and started_at = $2`,
        [empId, zonedWallTimeToUtc(2026, 8, 17, 13, 0, 0)]
      );
      check(
        continuationRows.length === 1 &&
          new Date(continuationRows[0].ended_at).getTime() === zonedWallTimeToUtc(2026, 8, 17, 17, 0, 0).getTime(),
        "8) a continuation resumes exactly at Lunch's configured 1:00 end, through the original 5:00 PM end",
        continuationRows
      );
    }

    // -----------------------------------------------------------------
    // 9) Employee with NO assigned Full Breaks profile — only Custom
    //    works; a breakProfileItemId is rejected cleanly.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("NoProfile", false);
      const date = "2026-08-18";

      const itemsRes = await call("GET", `/api/inputs/employee-break-items?employeeId=${empId}`, adminToken);
      check(itemsRes.body?.breakProfile === null && itemsRes.body?.items?.length === 0, "9) an employee with no profile has zero preset options", itemsRes.body);

      const presetRes = await addBreak(empId, date, { breakProfileItemId: lunchId });
      check(presetRes.status === 400, "9) a breakProfileItemId is rejected for an employee with no assigned profile", presetRes);

      const customRes = await addBreak(empId, date, {
        startTime: zonedWallTimeToUtc(2026, 8, 18, 12, 0, 0).toISOString(),
        endTime: zonedWallTimeToUtc(2026, 8, 18, 12, 30, 0).toISOString(),
        isPaid: false,
      });
      check(customRes.status === 201, "9) Custom still works for an employee with no assigned break profile", customRes.body);
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
    // references break_profiles(id), so the profile can't be removed first.
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    if (profileId) {
      await tryDelete("break_profile_items", () => pool.query(`delete from break_profile_items where break_profile_id = $1`, [profileId]));
      await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = $1`, [profileId]));
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
