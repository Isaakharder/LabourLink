// Integration test for POST /api/inputs/activity-runs/bulk-delete — deleting
// several Ctrl/Cmd-selected activity logs on Inputs at once.
//
// Each selected log is sent as its own segment ids and deleted exactly like
// the single Delete (POST /activity-runs/:id/delete): soft-deleted, the
// following work entry extended back over the gap, audit rows written.
// Covers: the result equals deleting the same logs one at a time; the
// hazard that motivated exact segment ids (deleting one log makes the next
// entry extend back and MERGE with an earlier unselected log into a run
// with the same id — deleting "by run id" would then take the unselected
// log too); all-or-nothing refusal when anything changed; validation and
// permissions.
//
// Run with: npm run test:inputs-bulk-delete
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

  const emailLike = `qa-bulkdel-%-${RUN_ID}@test.local`;
  const activityIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
    async function insertEmployee(label: string, role: string) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`BulkDel ${label} ${RUN_ID}`, `qa-bulkdel-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
      );
      const id = rows[0].id as string;
      return { id, token: signSession({ id, firstName: "QA", lastName: label, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await insertEmployee("Admin", "Administrator");
    const supervisor = await insertEmployee("Supervisor", "Supervisor");
    const worker = await insertEmployee("Worker", "Employee");
    const target = await insertEmployee("Target", "Employee");
    const other = await insertEmployee("Other", "Employee");

    async function insertActivity(label: string) {
      const { rows } = await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA BulkDel ${label} ${RUN_ID}`]);
      activityIds.push(rows[0].id);
      return rows[0].id as string;
    }
    const picking = await insertActivity("Picking");
    const bags = await insertActivity("Packing Bags");

    const at = (date: string, h: number, m: number, s = 0) => {
      const [y, mo, d] = date.split("-").map(Number);
      return zonedWallTimeToUtc(y, mo, d, h, m, s);
    };
    async function work(emp: string, activity: string, date: string, s: [number, number, number?], e: [number, number, number?] | null) {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual') returning id`,
        [emp, activity, at(date, s[0], s[1], s[2] ?? 0), e ? at(date, e[0], e[1], e[2] ?? 0) : null]
      );
      return rows[0].id as string;
    }
    async function brk(emp: string, date: string, s: [number, number], e: [number, number]) {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual') returning id`,
        [emp, at(date, ...s), at(date, ...e)]
      );
      return rows[0].id as string;
    }
    async function entry(id: string) {
      return (await pool.query(`select started_at, ended_at, deleted_at, deletion_reason, actual_started_at from time_entries where id = $1`, [id])).rows[0];
    }
    const bulkDelete = (runs: string[][], token = admin.token) => call("POST", "/api/inputs/activity-runs/bulk-delete", token, { runs });

    // Nattawat's pattern, built twice on two dates: once deleted in bulk,
    // once with two single deletes — the results must be identical.
    async function nattawatDay(date: string) {
      return {
        pick619: await work(target.id, picking, date, [8, 0, 0], [8, 18, 3]),
        bags1: await work(target.id, bags, date, [8, 18, 3], [8, 18, 20]),
        pick617: await work(target.id, picking, date, [8, 18, 20], [8, 49, 53]),
        bags2: await work(target.id, bags, date, [8, 49, 53], [8, 50, 6]),
        pick615: await work(target.id, picking, date, [8, 50, 6], [9, 17, 19]),
      };
    }

    // ---- 1) Bulk == one at a time ---------------------------------------
    {
      // Different activities between every pair so each is its own run.
      const bulkDay = await nattawatDay("2019-11-04");
      const singleDay = await nattawatDay("2019-11-05");
      // Submitted latest-first on purpose — the server must still go earliest first.
      const res = await bulkDelete([[bulkDay.bags2], [bulkDay.bags1]]);
      check(res.status === 200 && res.body?.deleted === 2, "1) bulk delete of both Packing Bags succeeds", res);
      for (const id of [singleDay.bags1, singleDay.bags2]) {
        const r = await call("POST", `/api/inputs/activity-runs/${id}/delete`, admin.token);
        check(r.status === 200, "1) reference single delete succeeds", r);
      }
      const shape = async (d: Awaited<ReturnType<typeof nattawatDay>>) =>
        Promise.all(Object.values(d).map(async (id) => {
          const e = await entry(id);
          const day = new Date(e.started_at);
          // Time of day only, so the two dates compare.
          return [day.getUTCHours(), day.getUTCMinutes(), day.getUTCSeconds(), e.deleted_at !== null];
        }));
      const bulkShape = await shape(bulkDay);
      check(JSON.stringify(bulkShape) === JSON.stringify(await shape(singleDay)), "1) bulk result is identical to deleting the logs one at a time", bulkShape);
      const p617 = await entry(bulkDay.pick617);
      const p615 = await entry(bulkDay.pick615);
      check(
        new Date(p617.started_at).getTime() === at("2019-11-04", 8, 18, 3).getTime() &&
          new Date(p615.started_at).getTime() === at("2019-11-04", 8, 49, 53).getTime(),
        "1) each following Picking entry extends back over its deleted gap",
        { p617: p617.started_at, p615: p615.started_at }
      );
      check((await entry(bulkDay.pick619)).deleted_at === null, "1) the unselected first Picking row is untouched");
      const audits = await pool.query(
        `select count(*)::int as n from time_entry_deletions where affected_time_entry_ids && $1::uuid[]`,
        [[bulkDay.bags1, bulkDay.bags2]]
      );
      check(audits.rows[0].n === 2, "1) one deletion audit record per deleted log", audits.rows[0]);
      const corrections = await pool.query(
        `select count(*)::int as n from time_entry_corrections where time_entry_id = any($1::uuid[]) and field_name = 'started_at'`,
        [[bulkDay.pick617, bulkDay.pick615]]
      );
      check(corrections.rows[0].n === 2, "1) both start extensions are in the correction history", corrections.rows[0]);
    }

    // ---- 2) The merge hazard -----------------------------------------------
    {
      // P and N: same activity, no row, no carrier — once Q's gap is filled
      // they're contiguous and group into ONE run whose id is N's.
      const D = "2019-11-06";
      const p = await work(target.id, picking, D, [8, 0], [8, 10]);
      const q = await work(target.id, bags, D, [8, 10], [8, 11]);
      const n = await work(target.id, picking, D, [8, 11], [8, 20]);
      const after = await work(target.id, bags, D, [8, 20], [8, 21]);
      const res = await bulkDelete([[q], [n]]);
      check(res.status === 200, "2) deleting Packing Bags + the Picking after it succeeds", res);
      check((await entry(p)).deleted_at === null, "2) the UNselected earlier Picking log survives — never pulled in by a merge");
      check((await entry(q)).deleted_at !== null && (await entry(n)).deleted_at !== null, "2) both selected logs are deleted");
      const pAfter = await entry(p);
      check(new Date(pAfter.ended_at).getTime() === at(D, 8, 10).getTime(), "2) the surviving log keeps its own times", pAfter);
      check(new Date((await entry(after)).started_at).getTime() === at(D, 8, 10).getTime(), "2) the following entry absorbs both gaps");
    }

    // ---- 3) All-or-nothing when anything changed ---------------------------
    {
      const D = "2019-11-07";
      const a = await work(target.id, picking, D, [8, 0], [8, 30]);
      await work(target.id, bags, D, [8, 30], [8, 40]);
      // A two-segment run (break-split): sending only one of its segments
      // is a selection that no longer matches a whole log.
      const c1 = await work(target.id, picking, D, [8, 40], [9, 0]);
      await brk(target.id, D, [9, 0], [9, 15]);
      const c2 = await work(target.id, picking, D, [9, 15], [9, 30]);
      const partial = await bulkDelete([[a], [c1]]);
      check(partial.status === 409 && /changed since they were loaded/.test(partial.body?.error ?? ""), "3) part of a log is refused", partial);
      check((await entry(a)).deleted_at === null, "3) ...and nothing else in the request was deleted");
      const whole = await bulkDelete([[a], [c1, c2]]);
      check(whole.status === 200, "3) the whole break-split log (both segments) can be deleted", whole);
      const again = await bulkDelete([[a]]);
      check(again.status === 409, "3) an already-deleted log is refused (stale page / double submit)", again);
    }

    // ---- 4) Validation and permissions -------------------------------------
    {
      const D = "2019-11-08";
      const t1 = await work(target.id, picking, D, [8, 0], [8, 30]);
      const t2 = await work(target.id, bags, D, [8, 30], [8, 40]);
      const o1 = await work(other.id, picking, D, [8, 0], [8, 30]);
      const open = await work(target.id, bags, "2019-11-09", [8, 0], null);
      const b = await brk(target.id, D, [9, 0], [9, 15]);
      check((await bulkDelete([[t1], [o1]])).status === 400, "4) logs from two employees are refused");
      check((await bulkDelete([[open]])).status === 409, "4) an in-progress log is refused");
      check((await bulkDelete([[b]])).status === 409, "4) a break is refused");
      check((await bulkDelete([[t1], [t1]])).status === 400, "4) the same log twice is refused");
      check((await bulkDelete([])).status === 400, "4) an empty request is refused");
      check((await bulkDelete([["not-a-uuid"]])).status === 400, "4) malformed ids are refused");
      check((await bulkDelete([[t1], [t2]], worker.token)).status === 403, "4) an Employee can't delete logs");
      const sup = await bulkDelete([[t1], [t2]], supervisor.token);
      check(sup.status === 200, "4) a Supervisor (Inputs editor) can", sup);
      check((await entry(o1)).deleted_at === null, "4) the other employee's log was never touched");
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
