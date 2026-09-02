// Regression test for the Inputs blank-screen crash (Marcelino Besa,
// 2026-08-31): a system-generated correction (midnightRollover.ts's own
// `old_value: 'null'` sentinel — the literal 4-character string, not JSON
// null, used so the audit trail reads "there was no previous value") was
// passed straight through into the API's *CorrectedFrom fields. The client
// formats those as a date (formatTimeInAppTimezone); `new Date("null")` is
// an Invalid Date, and Intl.DateTimeFormat throws RangeError: Invalid time
// value on one — uncaught during render, with no error boundary, blanking
// the whole page. Fixed at its source in inputs.ts (correctedFromMap now
// excludes old_value === 'null'); this locks that in with a fixture shaped
// exactly like the real multi-day rollover chain, plus the other data
// shapes explicitly called out in the investigation: a duplicate
// midnight-boundary started_at, and getRolloverPriorDurationSeconds's
// cycle guard.
//
// Run with: npm run test:inputs-rollover-corrected-from-display
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession, SESSION_COOKIE } from "../middleware/auth";
import { reconcileMidnightRollover, MIDNIGHT_ROLLOVER_REASON } from "../lib/midnightRollover";
import { getRolloverPriorDurationSeconds } from "../lib/rowCompletionCandidates";
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

  async function call(method: string, path: string, token: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];
  const deviceIds: string[] = [];

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
        [`RolloverDisplay Admin ${RUN_ID}`, `qa-rollover-display-admin-${RUN_ID}@test.local`, adminRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA RolloverDisplay Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`RolloverDisplay-${label}-${RUN_ID}`, `qa-rollover-display-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertDevice(employeeId: string, label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [randomUUID(), `QA RolloverDisplay Device ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return rows[0].id;
    }

    function daysAgo(n: number, hour: number): Date {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - n);
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    }

    // -----------------------------------------------------------------
    // 1) Marcelino-shaped fixture: a real tap, then TWO midnight-rollover
    //    hops (matching the real 3-day chain), all still visible from
    //    Inputs. The MIDDLE day (the one whose entry was closed BY
    //    rollover, exactly like Marcelino's Aug 30/31) is the one whose
    //    endedAtCorrectedFrom must come back null, never the string "null".
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("Chain");
      const deviceId = await insertDevice(empId, "Chain");
      const started = daysAgo(2, 20); // 2 real days ago, evening — will need 2 rollover hops to reach today
      const originalId = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
           values ($1, $2, 'work', $3, $4, $5, 'manual') returning id`,
          [empId, deviceId, activityId, randomUUID(), started]
        )
      ).rows[0].id;
      timeEntryIds.push(originalId);

      await reconcileMidnightRollover(empId);

      const chain = (
        await pool.query(`select id, started_at, ended_at from time_entries where employee_id = $1 order by started_at asc`, [empId])
      ).rows;
      check(chain.length >= 3, "1) reconciliation produced a multi-hop chain (real tap + 2 rollover continuations)", chain.length);
      for (const r of chain) timeEntryIds.push(r.id);

      // The middle entry: started via rollover, ALSO closed via rollover
      // (both its own started_at boundary AND ended_at boundary are
      // system-generated) — exactly Marcelino's Aug 30 entry shape.
      const middleEntry = chain[1];
      const middleDateLocal = new Date(middleEntry.started_at).toISOString().slice(0, 10);

      const dailyRes = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=${middleDateLocal}`, adminToken);
      check(dailyRes.status === 200, "1) GET /api/inputs/daily succeeds for the rollover-closed middle day", dailyRes.body);
      const run = dailyRes.body?.runs?.[0];
      check(run !== undefined, "1) the middle day's run is present in the response", dailyRes.body);
      check(
        run?.endedAtCorrectedFrom === null,
        "1) endedAtCorrectedFrom is real JSON null for a midnight-rollover close, never the string \"null\"",
        run?.endedAtCorrectedFrom
      );
      check(
        typeof run?.durationSeconds === "number" && Number.isFinite(run.durationSeconds),
        "1) durationSeconds is a finite number",
        run?.durationSeconds
      );
    }

    // -----------------------------------------------------------------
    // 2) Negative control: a REAL admin correction (not a system rollover
    //    close) must still show up as a genuine ISO timestamp string in
    //    endedAtCorrectedFrom — the fix must not suppress real corrections,
    //    only the literal-string-"null" system sentinel.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("RealCorrection");
      const deviceId = await insertDevice(empId, "RealCorrection");
      const started = daysAgo(0, 9);
      const originalEnd = new Date(started.getTime() + 3600_000);
      const entryId = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'work', $3, $4, $5, $6, 'manual') returning id`,
          [empId, deviceId, activityId, randomUUID(), started, originalEnd]
        )
      ).rows[0].id;
      timeEntryIds.push(entryId);
      const correctedEnd = new Date(originalEnd.getTime() + 900_000);
      await pool.query(
        `insert into time_entry_corrections (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, $3, 'ended_at', $4, $5, 'Time corrected from Inputs page')`,
        [entryId, empId, adminId, originalEnd.toISOString(), correctedEnd.toISOString()]
      );
      await pool.query(`update time_entries set ended_at = $2 where id = $1`, [entryId, correctedEnd]);

      const dateLocal = started.toISOString().slice(0, 10);
      const dailyRes = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=${dateLocal}`, adminToken);
      const run = dailyRes.body?.runs?.[0];
      check(
        run?.endedAtCorrectedFrom === originalEnd.toISOString(),
        "2) a genuine admin correction still surfaces its real prior timestamp, unaffected by the fix",
        { got: run?.endedAtCorrectedFrom, expected: originalEnd.toISOString() }
      );
    }

    // -----------------------------------------------------------------
    // 3) Duplicate midnight-boundary entries (data anomaly, constructed
    //    directly): two entries sharing the identical started_at for the
    //    same employee/day. GET /api/inputs/daily must not crash and must
    //    report finite totals either way.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("DupBoundary");
      const deviceId = await insertDevice(empId, "DupBoundary");
      const boundary = daysAgo(0, 4);
      const idA = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'work', $3, $4, $5, $6, 'midnight_rollover') returning id`,
          [empId, deviceId, activityId, randomUUID(), boundary, new Date(boundary.getTime() + 3600_000)]
        )
      ).rows[0].id;
      const idB = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'work', $3, $4, $5, $6, 'midnight_rollover') returning id`,
          [empId, deviceId, activityId, randomUUID(), boundary, new Date(boundary.getTime() + 1800_000)]
        )
      ).rows[0].id;
      timeEntryIds.push(idA, idB);

      const dateLocal = boundary.toISOString().slice(0, 10);
      const dailyRes = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=${dateLocal}`, adminToken);
      check(dailyRes.status === 200, "3) duplicate-started_at entries do not crash the daily route", dailyRes.body);
      check(
        Number.isFinite(dailyRes.body?.totals?.workedSeconds),
        "3) totals.workedSeconds stays finite even with a duplicate-boundary anomaly",
        dailyRes.body?.totals
      );
    }

    // -----------------------------------------------------------------
    // 4) Invalid date query param — already-existing validation, confirmed
    //    still rejecting cleanly (400, not a crash) rather than reaching
    //    any of the date-arithmetic code at all.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("InvalidDate");
      const res = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=not-a-date`, adminToken);
      check(res.status === 400, "4) an invalid date query param is rejected with 400, not a crash", res);
    }

    // -----------------------------------------------------------------
    // 5) Cyclic rollover_of_entry_id — getRolloverPriorDurationSeconds must
    //    terminate via its explicit cycle guard, not merely its 60-hop cap,
    //    and must return a finite number.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("Cycle");
      const deviceId = await insertDevice(empId, "Cycle");
      const t0 = daysAgo(1, 10);
      const t1 = new Date(t0.getTime() + 3600_000);
      const t2 = new Date(t1.getTime() + 3600_000);
      // Both rows individually valid (ended_at after started_at) — the
      // cycle is purely in rollover_of_entry_id's pointers, wired below,
      // independent of each row's own chronological validity.
      const idA = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'work', $3, $4, $5, $6, 'midnight_rollover') returning id`,
          [empId, deviceId, activityId, randomUUID(), t0, t1]
        )
      ).rows[0].id;
      const idB = (
        await pool.query(
          `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, $2, 'work', $3, $4, $5, $6, 'midnight_rollover') returning id`,
          [empId, deviceId, activityId, randomUUID(), t1, t2]
        )
      ).rows[0].id;
      timeEntryIds.push(idA, idB);
      // Wire the cycle: A points back to B, B points back to A.
      await pool.query(`update time_entries set rollover_of_entry_id = $2 where id = $1`, [idA, idB]);
      await pool.query(`update time_entries set rollover_of_entry_id = $2 where id = $1`, [idB, idA]);

      const start = Date.now();
      const result = await getRolloverPriorDurationSeconds(idA);
      const elapsedMs = Date.now() - start;
      check(Number.isFinite(result), "5) getRolloverPriorDurationSeconds returns a finite number even on a cycle", result);
      // Each hop is one DB round trip; a genuine 60-hop walk through a
      // pooled connection takes meaningfully longer than a 2-hop cycle
      // detection — not an exact bound, just confirming it didn't walk
      // the full cap.
      check(elapsedMs < 5000, "5) terminates promptly via the cycle guard, not by exhausting the 60-hop cap", elapsedMs);
    }

    console.log(`MIDNIGHT_ROLLOVER_REASON sanity: ${MIDNIGHT_ROLLOVER_REASON}`);
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

    if (timeEntryIds.length) {
      await tryDelete("time_entry_corrections", () =>
        pool.query(`delete from time_entry_corrections where time_entry_id = any($1::uuid[])`, [timeEntryIds])
      );
    }
    if (employeeIds.length) {
      await tryDelete("time_entry_corrections (by employee)", () =>
        pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entries (by employee)", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
