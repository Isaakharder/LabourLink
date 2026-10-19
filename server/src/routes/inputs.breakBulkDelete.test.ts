// Integration test for break deletion on Inputs:
//   - POST /api/inputs/breaks/:id/delete (single — regression coverage for
//     the shared applyBreakDeletion it now uses), and
//   - POST /api/inputs/breaks/bulk-delete (several selected breaks at once).
//
// Covers: reconnecting the surrounding work exactly like one-at-a-time
// deletes; all-or-nothing refusal (changed times, in-progress, wrong
// employee, a break between two different activities, an injected failure
// midway); a concurrent change made while the request waits for the
// per-employee lock; retry safety; permissions per role.
//
// Run with: npm run test:inputs-break-bulk-delete
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
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const emailLike = `qa-brkbulk-%-${RUN_ID}@test.local`;
  const activityIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
    async function insertEmployee(label: string, role: string) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`BrkBulk ${label} ${RUN_ID}`, `qa-brkbulk-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
      );
      const id = rows[0].id as string;
      return { id, token: signSession({ id, firstName: "QA", lastName: label, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await insertEmployee("Admin", "Administrator");
    const manager = await insertEmployee("Manager", "Manager");
    const supervisor = await insertEmployee("Supervisor", "Supervisor");
    const worker = await insertEmployee("Worker", "Employee");
    const target = await insertEmployee("Target", "Employee");
    const other = await insertEmployee("Other", "Employee");

    async function insertActivity(label: string) {
      const { rows } = await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA BrkBulk ${label} ${RUN_ID}`]);
      activityIds.push(rows[0].id);
      return rows[0].id as string;
    }
    const picking = await insertActivity("Picking");
    const pruning = await insertActivity("Pruning");

    const at = (date: string, h: number, m: number) => {
      const [y, mo, d] = date.split("-").map(Number);
      return zonedWallTimeToUtc(y, mo, d, h, m, 0);
    };
    async function work(emp: string, activity: string, date: string, s: [number, number], e: [number, number] | null) {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual') returning id`,
        [emp, activity, at(date, ...s), e ? at(date, ...e) : null]
      );
      return rows[0].id as string;
    }
    async function brk(emp: string, date: string, s: [number, number], e: [number, number] | null) {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual') returning id`,
        [emp, at(date, ...s), e ? at(date, ...e) : null]
      );
      return rows[0].id as string;
    }
    async function entry(id: string) {
      return (await pool.query(`select started_at, ended_at, deleted_at, deletion_reason from time_entries where id = $1`, [id])).rows[0];
    }
    // What the Inputs page sends: the break exactly as it was shown.
    async function shown(id: string) {
      const e = await entry(id);
      return { id, startedAt: new Date(e.started_at).toISOString(), endedAt: new Date(e.ended_at).toISOString() };
    }
    const bulk = async (ids: string[], token = admin.token, employeeId = target.id) =>
      call("POST", "/api/inputs/breaks/bulk-delete", token, { employeeId, breaks: await Promise.all(ids.map(shown)) });
    const single = (id: string, token = admin.token) => call("POST", `/api/inputs/breaks/${id}/delete`, token);

    // A day with three breaks, each between two Picking entries.
    async function threeBreakDay(date: string) {
      const w1 = await work(target.id, picking, date, [8, 0], [10, 0]);
      const b1 = await brk(target.id, date, [10, 0], [10, 15]);
      const w2 = await work(target.id, picking, date, [10, 15], [12, 0]);
      const b2 = await brk(target.id, date, [12, 0], [12, 30]);
      const w3 = await work(target.id, picking, date, [12, 30], [14, 0]);
      const b3 = await brk(target.id, date, [14, 0], [14, 15]);
      const w4 = await work(target.id, picking, date, [14, 15], [16, 0]);
      return { w1, b1, w2, b2, w3, b3, w4 };
    }
    async function shape(day: Awaited<ReturnType<typeof threeBreakDay>>) {
      return Promise.all(
        Object.values(day).map(async (id) => {
          const e = await entry(id);
          const t = (d: Date | null) => (d ? new Date(d).toISOString().slice(11, 19) : null);
          return [t(e.started_at), t(e.ended_at), e.deleted_at !== null];
        })
      );
    }

    // ---- 1) Single break delete — unchanged behaviour -----------------------
    {
      const D = "2019-12-02";
      const day = await threeBreakDay(D);
      const res = await single(day.b1);
      check(res.status === 200, "1) single break delete succeeds", res);
      check((await entry(day.b1)).deleted_at !== null, "1) the break is soft-deleted");
      check(new Date((await entry(day.w1)).ended_at).getTime() === at(D, 10, 15).getTime(), "1) the work before it is reconnected to the work after");
      const audit = await pool.query(`select reason from time_entry_deletions where $1 = any(affected_time_entry_ids)`, [day.b1]);
      check(audit.rows[0]?.reason === "Break deleted from Inputs page", "1) an audit deletion row is recorded", audit.rows);
      const corr = await pool.query(`select field_name from time_entry_corrections where time_entry_id = $1`, [day.w1]);
      check(corr.rows.some((r) => r.field_name === "ended_at"), "1) the reconnect is recorded as a correction");

      const w = await work(target.id, picking, "2019-12-03", [8, 0], [10, 0]);
      const between = await brk(target.id, "2019-12-03", [10, 0], [10, 15]);
      await work(target.id, pruning, "2019-12-03", [10, 15], [12, 0]);
      const refused = await single(between);
      check(refused.status === 409 && /two different activities/.test(refused.body?.error ?? ""), "1) a break between different activities is refused", refused);
      check((await entry(between)).deleted_at === null && (await entry(w)).ended_at !== null, "1) ...and nothing changed");
      const open = await brk(target.id, "2019-12-04", [10, 0], null);
      check((await single(open)).status === 409, "1) an in-progress break is refused");
      await pool.query(`update time_entries set ended_at = $1 where id = $2`, [at("2019-12-04", 10, 5), open]);
      check((await single(day.b2, worker.token)).status === 403, "1) an Employee can't delete a break");
    }

    // ---- 2) Bulk == one at a time, any order sent ---------------------------
    {
      const bulkDay = await threeBreakDay("2019-12-09");
      const singleDay = await threeBreakDay("2019-12-10");
      const res = await bulk([bulkDay.b3, bulkDay.b1]);
      check(res.status === 200 && res.body?.deleted === 2, "2) deleting two breaks together succeeds", res);
      check((await single(singleDay.b1)).status === 200 && (await single(singleDay.b3)).status === 200, "2) reference single deletes succeed");
      const a = await shape(bulkDay);
      const b = await shape(singleDay);
      check(JSON.stringify(a) === JSON.stringify(b), "2) the day ends up exactly as after two single deletes", { a, b });
      check((await entry(bulkDay.b2)).deleted_at === null, "2) the unselected break is untouched");

      const one = await threeBreakDay("2019-12-11");
      const res1 = await bulk([one.b2]);
      check(res1.status === 200 && res1.body?.deleted === 1, "2) a single selected break deletes through bulk too", res1);
      const all = await threeBreakDay("2019-12-12");
      const res3 = await bulk([all.b1, all.b2, all.b3]);
      check(res3.status === 200 && res3.body?.deleted === 3, "2) every break of the day deletes together", res3);
      const ends = await Promise.all([all.w1, all.w2, all.w3].map(async (id) => new Date((await entry(id)).ended_at).getTime()));
      check(
        JSON.stringify(ends) === JSON.stringify([at("2019-12-12", 10, 15), at("2019-12-12", 12, 30), at("2019-12-12", 14, 15)].map((d) => d.getTime())),
        "2) ...each gap reconnected to the following work, with no break time left"
      );
    }

    // ---- 3) Validation refuses the whole request, deleting nothing ----------
    {
      const D = "2019-12-16";
      const day = await threeBreakDay(D);
      const stale = await shown(day.b2);
      await pool.query(`update time_entries set ended_at = $1 where id = $2`, [at(D, 12, 35), day.b2]);
      await pool.query(`update time_entries set started_at = $1 where id = $2`, [at(D, 12, 35), day.w3]);
      const changed = await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, {
        employeeId: target.id,
        breaks: [await shown(day.b1), stale],
      });
      check(changed.status === 409 && /changed since it was loaded/.test(changed.body?.error ?? ""), "3) a break whose times changed refuses the request", changed);
      check(/12:00/.test(changed.body?.error ?? ""), "3) ...naming the break that changed", changed.body);
      check((await entry(day.b1)).deleted_at === null, "3) ...and the other selected break is NOT deleted");

      const open = await brk(target.id, D, [17, 0], null);
      const withOpen = await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, {
        employeeId: target.id,
        breaks: [await shown(day.b1), { id: open, startedAt: at(D, 17, 0).toISOString(), endedAt: at(D, 17, 5).toISOString() }],
      });
      check(withOpen.status === 409 && /in progress/.test(withOpen.body?.error ?? ""), "3) an in-progress break refuses the request", withOpen);

      const theirs = await brk(other.id, D, [10, 0], [10, 15]);
      const wrongOwner = await bulk([day.b1, theirs]);
      check(wrongOwner.status === 409, "3) another employee's break refuses the request", wrongOwner);
      check((await entry(theirs)).deleted_at === null && (await entry(day.b1)).deleted_at === null, "3) ...touching neither employee");

      const notBreak = await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, {
        employeeId: target.id,
        breaks: [{ id: day.w1, startedAt: at(D, 8, 0).toISOString(), endedAt: at(D, 10, 0).toISOString() }],
      });
      check(notBreak.status === 409, "3) a work entry is never deleted as a break", notBreak);

      const otherDay = await brk(target.id, "2019-12-17", [10, 0], [10, 15]);
      check((await bulk([day.b1, otherDay])).status === 400, "3) breaks from two days are refused");
      check((await bulk([day.b1, day.b1])).status === 400, "3) the same break twice is refused");
      check((await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, { employeeId: target.id, breaks: [] })).status === 400, "3) an empty request is refused");
      check(
        (await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, { employeeId: target.id, breaks: [{ id: "x", startedAt: "a", endedAt: "b" }] })).status === 400,
        "3) malformed breaks are refused"
      );
      check((await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, { breaks: [await shown(day.b1)] })).status === 400, "3) employeeId is required");
      const gone = await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, {
        employeeId: target.id,
        breaks: [{ id: "00000000-0000-4000-8000-000000000000", startedAt: at(D, 1, 0).toISOString(), endedAt: at(D, 1, 5).toISOString() }],
      });
      check(gone.status === 404, "3) an unknown break is refused", gone);
    }

    // ---- 4) A refusal midway rolls back the earlier deletions ---------------
    {
      const D = "2019-12-18";
      const w1 = await work(target.id, picking, D, [8, 0], [10, 0]);
      const ok1 = await brk(target.id, D, [10, 0], [10, 15]);
      await work(target.id, picking, D, [10, 15], [12, 0]);
      const blocked = await brk(target.id, D, [12, 0], [12, 30]);
      await work(target.id, pruning, D, [12, 30], [14, 0]);
      const res = await bulk([ok1, blocked]);
      check(res.status === 409 && /12:00/.test(res.body?.error ?? "") && /Nothing was deleted/.test(res.body?.error ?? ""), "4) the blocked break is named and nothing is deleted", res);
      check((await entry(ok1)).deleted_at === null, "4) the break deleted before the refusal was rolled back");
      check(new Date((await entry(w1)).ended_at).getTime() === at(D, 10, 0).getTime(), "4) ...including its reconnect");
    }

    // ---- 5) An injected failure midway leaves every break intact ------------
    {
      const day = await threeBreakDay("2019-12-19");
      const fn = `qa_brkbulk_fail_${RUN_ID}`;
      await pool.query(`create function ${fn}() returns trigger language plpgsql as $$
        begin
          if new.id = '${day.b2}'::uuid and new.deleted_at is not null then raise exception 'injected failure'; end if;
          return new;
        end $$`);
      await pool.query(`create trigger ${fn} before update on time_entries for each row execute function ${fn}()`);
      try {
        const res = await bulk([day.b1, day.b2, day.b3]);
        check(res.status === 500, "5) the injected failure surfaces as an error", res);
        for (const id of [day.b1, day.b2, day.b3]) {
          check((await entry(id)).deleted_at === null, "5) every selected break is intact");
        }
        check(new Date((await entry(day.w1)).ended_at).getTime() === at("2019-12-19", 10, 0).getTime(), "5) no reconnect survived");
        const audit = await pool.query(`select 1 from time_entry_deletions where $1 = any(affected_time_entry_ids)`, [day.b1]);
        check(audit.rowCount === 0, "5) no audit row survived");
      } finally {
        await pool.query(`drop trigger if exists ${fn} on time_entries`);
        await pool.query(`drop function if exists ${fn}()`);
      }
    }

    // ---- 6) Retrying a completed request is safe -----------------------------
    {
      const day = await threeBreakDay("2019-12-23");
      const req = { employeeId: target.id, breaks: [await shown(day.b1), await shown(day.b2)] };
      const first = await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, req);
      check(first.status === 200 && first.body?.deleted === 2, "6) the first request deletes both", first);
      const before = await shape(day);
      const retry = await call("POST", "/api/inputs/breaks/bulk-delete", admin.token, req);
      check(retry.status === 200 && retry.body?.deleted === 0 && retry.body?.alreadyDeleted === true, "6) the identical retry is a 200 no-op", retry);
      check(JSON.stringify(await shape(day)) === JSON.stringify(before), "6) ...and changes nothing");
      const mixed = await bulk([day.b3]).then(async () => call("POST", "/api/inputs/breaks/bulk-delete", admin.token, req));
      check(mixed.status === 200, "6) still safe after further unrelated deletes", mixed);
    }

    // ---- 7) A concurrent change while waiting for the employee lock ---------
    {
      const D = "2019-12-24";
      const day = await threeBreakDay(D);
      const req = { employeeId: target.id, breaks: [await shown(day.b1), await shown(day.b2)] };
      const holder = await pool.connect();
      try {
        await holder.query("begin");
        // An Inputs edit or phone sync for this employee is mid-transaction.
        await holder.query("select pg_advisory_xact_lock(hashtext($1::text))", [target.id]);
        const pending = call("POST", "/api/inputs/breaks/bulk-delete", admin.token, req);
        await new Promise((r) => setTimeout(r, 300));
        await holder.query(`update time_entries set ended_at = $1 where id = $2`, [at(D, 12, 20), day.b2]);
        await holder.query(`update time_entries set started_at = $1 where id = $2`, [at(D, 12, 20), day.w3]);
        await holder.query("commit");
        const res = await pending;
        check(res.status === 409, "7) a break changed while the request waited is refused", res);
        check((await entry(day.b1)).deleted_at === null && (await entry(day.b2)).deleted_at === null, "7) ...and neither break was deleted");
      } finally {
        holder.release();
      }
    }

    // ---- 8) Permissions -------------------------------------------------------
    {
      const day = await threeBreakDay("2019-12-30");
      check((await bulk([day.b1], worker.token)).status === 403, "8) an Employee can't bulk-delete breaks");
      check((await entry(day.b1)).deleted_at === null, "8) ...and nothing was deleted");
      check((await bulk([day.b1], supervisor.token)).status === 200, "8) a Supervisor can");
      check((await bulk([day.b2], manager.token)).status === 200, "8) a Manager can");
      check((await bulk([day.b3], admin.token)).status === 200, "8) an Administrator can");
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
      pool.query(`delete from time_entry_deletions where employee_id in (select id from employees where email like $1)`, [emailLike])
    );
    await tryDelete("time_entry_corrections", () =>
      pool.query(`delete from time_entry_corrections where employee_id in (select id from employees where email like $1)`, [emailLike])
    );
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [emailLike])
    );
    await tryDelete("employees", () => pool.query(`delete from employees where email like $1`, [emailLike]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
