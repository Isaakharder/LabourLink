// Integration test for Employee Groups (056_employee_groups.sql):
// /api/employee-groups CRUD, assigning a group on employee create/edit,
// persistence on reload, the Inputs employee list carrying the group, the
// server-side guarantee that an employee can only point at a group that
// exists in this deployment (single-tenant — see the migration), and that
// group changes never touch time entries or employment periods.
//
// Run with: npm run test:employee-groups
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
import employeesRouter from "./employees";
import employeeGroupsRouter from "./employeeGroups";
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
const tag = (s: string) => `QA EG ${s} ${RUN_ID}`;

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", employeesRouter);
  app.use("/api/employee-groups", employeeGroupsRouter);
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

  const emailLike = `qa-eg-%-${RUN_ID}@test.local`;
  const groupIds: string[] = [];
  let activityId: string | null = null;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function insertActor(label: string, role: string) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, start_date, nationality)
         values ('QA', $1, $2, $3, $4, 'x', true, '2026-01-01', 'Canadian') returning id`,
        [tag(label), `qa-eg-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId]
      );
      const id = rows[0].id as string;
      return { id, token: signSession({ id, firstName: "QA", lastName: label, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await insertActor("Admin", "Administrator");
    const manager = await insertActor("Manager", "Manager");
    const supervisor = await insertActor("Supervisor", "Supervisor");

    // ---- 1) Create / validate ------------------------------------------
    const pickers = await call("POST", "/api/employee-groups", admin.token, { name: `  ${tag("Pickers")}  ` });
    check(pickers.status === 201 && pickers.body?.group?.name === tag("Pickers"), "1) a group is created (name trimmed)", pickers);
    if (pickers.body?.group?.id) groupIds.push(pickers.body.group.id);
    const pruners = await call("POST", "/api/employee-groups", admin.token, { name: tag("Pruners") });
    if (pruners.body?.group?.id) groupIds.push(pruners.body.group.id);
    const P = pickers.body.group.id as string;
    const R = pruners.body.group.id as string;

    check((await call("POST", "/api/employee-groups", admin.token, { name: "   " })).status === 400, "1) a blank name is refused");
    check((await call("POST", "/api/employee-groups", admin.token, {})).status === 400, "1) a missing name is refused");
    const dup = await call("POST", "/api/employee-groups", admin.token, { name: ` ${tag("pickers").toUpperCase()} ` });
    check(dup.status === 409 && /already exists/.test(dup.body?.errors?.name ?? ""), "1) a duplicate name (any case/spacing) is refused", dup);
    check((await call("POST", "/api/employee-groups", admin.token, { name: "x".repeat(101) })).status === 400, "1) an over-long name is refused");

    // ---- 2) Rename -----------------------------------------------------
    const renamed = await call("PATCH", `/api/employee-groups/${R}`, admin.token, { name: tag("Pruning Crew") });
    check(renamed.status === 200 && renamed.body?.group?.name === tag("Pruning Crew"), "2) a group can be renamed", renamed);
    const renameDup = await call("PATCH", `/api/employee-groups/${R}`, admin.token, { name: tag("Pickers") });
    check(renameDup.status === 409, "2) renaming to another group's name is refused", renameDup);
    check((await call("PATCH", `/api/employee-groups/${R}`, admin.token, { name: "" })).status === 400, "2) renaming to blank is refused");
    check((await call("PATCH", `/api/employee-groups/${randomUUID()}`, admin.token, { name: tag("Ghost") })).status === 404, "2) renaming a missing group is 404");
    const sameName = await call("PATCH", `/api/employee-groups/${R}`, admin.token, { name: tag("Pruning Crew") });
    check(sameName.status === 200, "2) saving a group under its own current name is fine", sameName);

    // ---- 3) Assign on create / edit, persistence -------------------------
    const base = { lastName: "Worker", startDate: "2026-08-10", nationality: "Mexican" };
    const createdIn = await call("POST", "/api/employees", admin.token, {
      ...base,
      firstName: tag("Ana"),
      email: `qa-eg-ana-${RUN_ID}@test.local`,
      employeeGroupId: P,
    });
    check(createdIn.status === 201 && createdIn.body?.employee?.employeeGroup?.id === P, "3) Add Employee saves the chosen group", createdIn.body?.employee?.employeeGroup);
    const ana = createdIn.body.employee.id as string;
    const createdUngrouped = await call("POST", "/api/employees", admin.token, {
      ...base,
      firstName: tag("Ben"),
      email: `qa-eg-ben-${RUN_ID}@test.local`,
    });
    check(createdUngrouped.status === 201 && createdUngrouped.body?.employee?.employeeGroup === null, "3) Ungrouped is the default");
    const ben = createdUngrouped.body.employee.id as string;

    const moved = await call("PATCH", `/api/employees/${ben}`, admin.token, { employeeGroupId: R });
    check(moved.status === 200 && moved.body?.employee?.employeeGroup?.name === tag("Pruning Crew"), "3) Edit Employee changes the group", moved.body?.employee?.employeeGroup);
    const reload = await call("GET", `/api/employees/${ben}`, admin.token);
    check(reload.body?.employee?.employeeGroup?.id === R, "3) the assignment persists on reload", reload.body?.employee?.employeeGroup);
    const unrelated = await call("PATCH", `/api/employees/${ben}`, admin.token, { firstName: tag("Benjamin") });
    check(unrelated.body?.employee?.employeeGroup?.id === R, "3) editing other fields leaves the group alone");
    const back = await call("PATCH", `/api/employees/${ben}`, admin.token, { employeeGroupId: "" });
    check(back.body?.employee?.employeeGroup === null, "3) choosing Ungrouped clears the group");
    await call("PATCH", `/api/employees/${ben}`, admin.token, { employeeGroupId: R });

    // ---- 4) Only groups that exist here ----------------------------------
    const foreign = await call("PATCH", `/api/employees/${ben}`, admin.token, { employeeGroupId: randomUUID() });
    check(foreign.status === 400 && foreign.body?.errors?.employeeGroupId === "Employee group not found", "4) a group id that isn't in this deployment is refused", foreign);
    const malformed = await call("POST", "/api/employees", admin.token, { ...base, firstName: tag("Cy"), employeeGroupId: "nope" });
    check(malformed.status === 400 && malformed.body?.errors?.employeeGroupId, "4) a malformed group id is refused", malformed);
    check((await call("GET", `/api/employees/${ben}`, admin.token)).body?.employee?.employeeGroup?.id === R, "4) ...and the employee's group is unchanged");

    // ---- 5) Counts --------------------------------------------------------
    const list = await call("GET", "/api/employee-groups", admin.token);
    const byId = new Map((list.body?.groups ?? []).map((g: any) => [g.id, g]));
    check((byId.get(P) as any)?.employeeCount === 1 && (byId.get(R) as any)?.employeeCount === 1, "5) each group shows its assigned employee count", list.body?.groups);
    check(typeof list.body?.ungrouped?.employeeCount === "number", "5) the Ungrouped count is reported too");

    // ---- 6) Inputs list carries the group ----------------------------------
    const D = "2026-09-15";
    activityId = (await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [tag("Activity")])).rows[0].id;
    const entry = await pool.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
       values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual') returning id`,
      [ben, activityId, zonedWallTimeToUtc(2026, 9, 15, 8, 0, 0), zonedWallTimeToUtc(2026, 9, 15, 9, 0, 0)]
    );
    // The whole row, every column, to compare after all the group changes.
    const snapshot = async (id: string) => (await pool.query(`select to_jsonb(te)::text as row from time_entries te where id = $1`, [id])).rows[0].row as string;
    const entryBefore = await snapshot(entry.rows[0].id);
    await pool.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
       values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')`,
      [ana, activityId, zonedWallTimeToUtc(2026, 9, 15, 8, 0, 0), zonedWallTimeToUtc(2026, 9, 15, 9, 30, 0)]
    );
    const inputs = await call("GET", `/api/inputs/employees?date=${D}&search=${encodeURIComponent(`QA EG`)}`, supervisor.token);
    const benRow = (inputs.body?.employees ?? []).find((e: any) => e.id === ben);
    const anaRow = (inputs.body?.employees ?? []).find((e: any) => e.id === ana);
    check(benRow?.employeeGroup?.name === tag("Pruning Crew") && anaRow?.employeeGroup?.id === P, "6) the Inputs employee list includes each employee's group", { benRow, anaRow });
    check(benRow?.paidSeconds === 3600, "6) ...alongside their hours, unchanged", benRow);

    // ---- 7) History is never touched ---------------------------------------
    const periodsBefore = (await pool.query(`select count(*)::int as n from employee_employment_periods where employee_id = $1`, [ben])).rows[0].n;
    const historyBefore = (await pool.query(`select count(*)::int as n from employee_employment_period_history where employee_id = $1`, [ben])).rows[0].n;
    await call("PATCH", `/api/employees/${ben}`, admin.token, { employeeGroupId: P });
    await call("PATCH", `/api/employees/${ben}`, admin.token, { employeeGroupId: R });

    // ---- 8) Delete: employees become Ungrouped, never deleted --------------
    const del = await call("DELETE", `/api/employee-groups/${R}`, admin.token);
    check(del.status === 200 && del.body?.ungroupedEmployees === 1, "8) deleting a group reports how many employees became Ungrouped", del);
    const benAfter = await call("GET", `/api/employees/${ben}`, admin.token);
    check(benAfter.status === 200 && benAfter.body?.employee?.employeeGroup === null, "8) its employee still exists and is now Ungrouped", benAfter.body?.employee?.employeeGroup);
    check((await call("GET", `/api/employees/${ana}`, admin.token)).body?.employee?.employeeGroup?.id === P, "8) other groups' employees are untouched");
    check((await call("DELETE", `/api/employee-groups/${R}`, admin.token)).status === 404, "8) deleting it again is 404");

    const entryAfter = await snapshot(entry.rows[0].id);
    check(entryAfter === entryBefore, "7) assigning, moving and deleting groups never touched the employee's time entry (every column identical)", {
      entryBefore,
      entryAfter,
    });
    const periodsAfter = (await pool.query(`select count(*)::int as n from employee_employment_periods where employee_id = $1`, [ben])).rows[0].n;
    const historyAfter = (await pool.query(`select count(*)::int as n from employee_employment_period_history where employee_id = $1`, [ben])).rows[0].n;
    check(periodsAfter === periodsBefore && historyAfter === historyBefore, "7) ...nor employment periods or their history", { periodsBefore, periodsAfter, historyBefore, historyAfter });

    // ---- 9) Permissions ----------------------------------------------------
    check((await call("GET", "/api/employee-groups", manager.token)).status === 200, "9) a Manager can view groups");
    check((await call("POST", "/api/employee-groups", manager.token, { name: tag("Nope") })).status === 403, "9) a Manager can't create groups");
    check((await call("PATCH", `/api/employee-groups/${P}`, manager.token, { name: tag("Nope") })).status === 403, "9) ...or rename them");
    check((await call("DELETE", `/api/employee-groups/${P}`, manager.token)).status === 403, "9) ...or delete them");
    check((await call("GET", "/api/employee-groups", supervisor.token)).status === 403, "9) a Supervisor can't open employee management");
    check((await call("PATCH", `/api/employees/${ana}`, manager.token, { employeeGroupId: null })).status === 403, "9) a Manager can't reassign an employee's group");
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }
    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1 or last_name like $2)`, [emailLike, `%${RUN_ID}`])
    );
    await tryDelete("employment periods", () =>
      pool.query(
        `delete from employee_employment_period_history where employee_id in (select id from employees where email like $1 or last_name like $2)`,
        [emailLike, `%${RUN_ID}`]
      )
    );
    await tryDelete("employment periods", () =>
      pool.query(`delete from employee_employment_periods where employee_id in (select id from employees where email like $1 or last_name like $2)`, [
        emailLike,
        `%${RUN_ID}`,
      ])
    );
    await tryDelete("employees", () => pool.query(`delete from employees where email like $1 or first_name like $2`, [emailLike, `QA EG % ${RUN_ID}`]));
    await tryDelete("employee_groups", () => pool.query(`delete from employee_groups where name like $1`, [`QA EG % ${RUN_ID}`]));
    if (activityId) await tryDelete("activities", () => pool.query(`delete from activities where id = $1`, [activityId]));
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
