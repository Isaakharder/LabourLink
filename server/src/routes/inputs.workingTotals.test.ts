// Integration test for the Inputs header's "Employees working" totals
// (GET /api/inputs/employees' workingTotals): distinct employees with
// non-deleted work recorded on the date — finished, in progress or manual;
// break-only and deleted entries don't count — grouped by current Employee
// Group (every configured group, zeros included; Ungrouped only when
// non-zero), using the sidebar's own organization-timezone day bounds and
// unaffected by the sidebar search. Same real-database harness as
// inputs.manualEntries.test.ts: far-past QA dates, fixtures always removed.
//
// Run with: npm run test:inputs-working-totals
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
const EMAIL_PATTERN = `qa-working-totals-%-${RUN_ID}@test.local`;
// Far-past QA dates: 2018-03-14 is the main day, 2018-03-15 the switch target.
const DAY = { str: "2018-03-14", d: 14 };
const NEXT = { str: "2018-03-15", d: 15 };
const at = (day: number, h: number, m = 0) => zonedWallTimeToUtc(2018, 3, day, h, m, 0).toISOString();

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

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const groupIds: string[] = [];
  let activityGroupId: string | undefined;
  let activityId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");

    async function createGroup(name: string) {
      const id: string = (await pool.query(`insert into employee_groups (name) values ($1) returning id`, [`${name} ${RUN_ID}`])).rows[0].id;
      groupIds.push(id);
      return { id, name: `${name} ${RUN_ID}` };
    }
    async function createEmployee(label: string, groupId: string | null, opts: { role?: string; active?: boolean } = {}) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, employee_group_id)
         values ('QA', $1, $2, $3, $4, $5, $6, $7) returning id, first_name, last_name`,
        [
          `${label} ${RUN_ID}`,
          `qa-working-totals-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`,
          opts.role ? await roleId(opts.role) : employeeRoleId,
          teamRoleId,
          fakePinHash,
          opts.active ?? true,
          groupId,
        ]
      );
      employeeIds.push(rows[0].id);
      return rows[0] as { id: string; first_name: string; last_name: string };
    }
    async function entry(employeeId: string, start: string, end: string | null, opts: { type?: "work" | "break"; deleted?: boolean } = {}) {
      const type = opts.type ?? "work";
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, is_paid,
                                   deleted_at, deleted_by_employee_id, deletion_reason)
         values ($1, null, $2, $3, gen_random_uuid(), $4, $5, 'manual', $6, $7, $8, $9) returning id`,
        [
          employeeId,
          type,
          type === "work" ? activityId : null,
          start,
          end,
          type === "break" ? false : null,
          opts.deleted ? new Date() : null,
          opts.deleted ? employeeId : null,
          opts.deleted ? "QA deleted" : null,
        ]
      );
      return rows[0].id as string;
    }

    const admin = await createEmployee("Admin", null, { role: "Administrator" });
    const adminToken = signSession({ id: admin.id, firstName: admin.first_name, lastName: admin.last_name, securityRole: "Administrator", teamRole: "Team Member" });
    const supervisor = await createEmployee("Supervisor", null, { role: "Supervisor" });
    const supervisorToken = signSession({ id: supervisor.id, firstName: supervisor.first_name, lastName: supervisor.last_name, securityRole: "Supervisor", teamRole: "Team Member" });

    activityGroupId = (await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA WT ${RUN_ID}`])).rows[0].id;
    activityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [`QA WT Activity ${RUN_ID}`])
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [activityGroupId, activityId]);

    const locals = await createGroup("QA Locals");
    const guys = await createGroup("QA Greenhouse Guys");
    const empty = await createGroup("QA Empty Group");

    const twoEntries = await createEmployee("Two Entries", locals.id); // finished + in progress
    const manual = await createEmployee("Manual", locals.id); // manual via the route
    const breakOnly = await createEmployee("Break Only", guys.id);
    const deletedOnly = await createEmployee("Deleted Only", guys.id);
    const ungrouped = await createEmployee("Ungrouped Worker", null);
    const prevDay = await createEmployee("Previous Day", guys.id);
    const deactivated = await createEmployee("Deactivated", guys.id, { active: false });
    const nextDayOnly = await createEmployee("Next Day Only", guys.id);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [manual.id, activityGroupId]);

    await entry(twoEntries.id, at(DAY.d, 7), at(DAY.d, 9));
    await entry(twoEntries.id, at(DAY.d, 9), null);
    const m = await call("POST", "/api/inputs/activities", adminToken, {
      employeeId: manual.id,
      date: DAY.str,
      activityId,
      startTime: at(DAY.d, 8),
      endTime: at(DAY.d, 12),
      reason: "Forgot phone",
    });
    check(m.status === 201, "setup: manual work added through Inputs", m);
    await entry(breakOnly.id, at(DAY.d, 12), at(DAY.d, 12, 30), { type: "break" });
    await entry(deletedOnly.id, at(DAY.d, 8), at(DAY.d, 10), { deleted: true });
    await entry(ungrouped.id, at(DAY.d, 6), at(DAY.d, 14));
    await entry(prevDay.id, zonedWallTimeToUtc(2018, 3, DAY.d - 1, 23, 0, 0).toISOString(), zonedWallTimeToUtc(2018, 3, DAY.d - 1, 23, 59, 0).toISOString());
    await entry(deactivated.id, at(DAY.d, 7), at(DAY.d, 8));
    await entry(nextDayOnly.id, at(NEXT.d, 7), at(NEXT.d, 8));

    const groupCount = (totals: any, name: string) => totals?.groups?.find((g: any) => g.name === name)?.count;

    // -----------------------------------------------------------------
    // Counts for DAY
    // -----------------------------------------------------------------
    const r = await call("GET", `/api/inputs/employees?date=${DAY.str}`, supervisorToken);
    check(r.status === 200, "Supervisor can load the employees list with totals", r);
    const t = r.body?.workingTotals;
    check(t?.total === 4, "total = distinct employees with work: two-entries, manual, ungrouped, deactivated (4)", t);
    check(groupCount(t, locals.name) === 2, "Locals: 2 (the two-entry employee counted once, plus manual work)", t);
    check(groupCount(t, guys.name) === 1, "Greenhouse Guys: 1 (break-only, deleted-only, previous-day and next-day excluded; deactivated counted)", t);
    check(groupCount(t, empty.name) === 0, "a configured group with nobody working is listed with 0", t);
    check(groupCount(t, "Ungrouped") === 1 && t.groups[t.groups.length - 1].id === null, "Ungrouped: 1, listed last", t);
    const ourNames = t.groups.filter((g: any) => String(g.name).endsWith(String(RUN_ID))).map((g: any) => g.name);
    check(JSON.stringify(ourNames) === JSON.stringify([...ourNames].sort((a: string, b: string) => a.localeCompare(b))), "groups are alphabetical", ourNames);
    check(t.groups.reduce((sum: number, g: any) => sum + g.count, 0) === t.total, "group counts add up to the total", t);
    const sidebarIds = new Set((r.body?.employees ?? []).map((e: any) => e.id));
    check(sidebarIds.has(breakOnly.id), "the break-only employee is still in the sidebar (it lists any entry) but not counted as working");

    // -----------------------------------------------------------------
    // Search filters the sidebar, never the totals.
    // -----------------------------------------------------------------
    const searched = await call("GET", `/api/inputs/employees?date=${DAY.str}&search=${encodeURIComponent(`Two Entries ${RUN_ID}`)}`, supervisorToken);
    check((searched.body?.employees ?? []).length === 1, "search narrows the sidebar to one employee", searched.body?.employees);
    check(JSON.stringify(searched.body?.workingTotals) === JSON.stringify(t), "workingTotals are identical with and without a search", searched.body?.workingTotals);

    // -----------------------------------------------------------------
    // Date switching
    // -----------------------------------------------------------------
    const next = (await call("GET", `/api/inputs/employees?date=${NEXT.str}`, supervisorToken)).body?.workingTotals;
    check(next?.total === 1 && groupCount(next, guys.name) === 1 && groupCount(next, locals.name) === 0, "next day: only the next-day worker (Greenhouse Guys 1)", next);
    check(!next?.groups?.some((g: any) => g.id === null), "next day: no Ungrouped entry when nobody ungrouped worked", next);

    // -----------------------------------------------------------------
    // Adding and deleting work updates the totals.
    // -----------------------------------------------------------------
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [breakOnly.id, activityGroupId]);
    const added = await call("POST", "/api/inputs/activities", adminToken, {
      employeeId: breakOnly.id,
      date: DAY.str,
      activityId,
      startTime: at(DAY.d, 7),
      endTime: at(DAY.d, 11),
      reason: "Forgot phone",
    });
    check(added.status === 201, "adding work for the break-only employee", added);
    const afterAdd = (await call("GET", `/api/inputs/employees?date=${DAY.str}`, supervisorToken)).body?.workingTotals;
    check(afterAdd?.total === 5 && groupCount(afterAdd, guys.name) === 2, "after adding work: total 5, Greenhouse Guys 2", afterAdd);

    const ungroupedEntry = (await pool.query(`select id from time_entries where employee_id = $1 and deleted_at is null`, [ungrouped.id])).rows[0].id;
    const del = await call("POST", `/api/inputs/activity-runs/${ungroupedEntry}/delete`, adminToken, {});
    check(del.status === 200, "deleting the ungrouped employee's only work", del);
    const afterDelete = (await call("GET", `/api/inputs/employees?date=${DAY.str}`, supervisorToken)).body?.workingTotals;
    check(afterDelete?.total === 4 && !afterDelete?.groups?.some((g: any) => g.id === null), "after deleting: total 4 and Ungrouped disappears", afterDelete);
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const table of ["time_entry_corrections", "time_entry_deletions", "time_entries"]) {
        await client.query(`delete from ${table} where employee_id in (select id from employees where email like $1)`, [EMAIL_PATTERN]);
      }
      if (activityGroupId) {
        await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [activityGroupId]);
        await client.query(`delete from activity_group_activities where activity_group_id = $1`, [activityGroupId]);
      }
      if (activityId) await client.query(`delete from activities where id = $1`, [activityId]);
      if (activityGroupId) await client.query(`delete from activity_groups where id = $1`, [activityGroupId]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from employee_groups where id = any($1::uuid[])`, [groupIds]);
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
