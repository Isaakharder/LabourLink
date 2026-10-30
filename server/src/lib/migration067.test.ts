// Migration 067 (direct employee → Job assignments): the backfill and the
// transition sync preserve every employee's Jobs exactly.
//
// Everything runs inside ONE transaction that is rolled back at the end, so
// the database is left exactly as it was. Fixtures are written with the 067
// triggers switched off (session_replication_role = replica, test database
// only), the direct table is emptied inside the transaction, and the
// backfill statement is taken verbatim from the migration file. "Before" is
// the old Activity Group rule exactly as the previous
// loadEmployeeActivitiesWithQuestions applied it; "after" is the real
// current loader and validator.
//
// Covers: one employee in one group; overlapping groups (union, no
// duplicates); a Job in two groups; an inactive group; an inactive Job
// (not usable, but kept so reactivating restores it); a closed group
// assignment; an inactive employee; an employee with no group; then the old
// application's group edits after the migration (assign, unassign,
// deactivate group, add/remove a group's Job, deactivate an employee),
// checking old rule == new rule after each.
//
// Run with: npm run test:migration-067
import "dotenv/config";
import fs from "fs";
import path from "path";
import { PoolClient } from "pg";
import { pool } from "../db";
import { loadEmployeeActivitiesWithQuestions, validateActivityAndAnswers } from "./activitySelection";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const RUN_ID = Date.now();
const MIGRATION = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "067_employee_activity_assignments.sql"), "utf8");
const BACKFILL = (() => {
  const start = MIGRATION.indexOf("insert into employee_activity_assignments (employee_id, activity_id, assigned_at");
  return MIGRATION.slice(start, MIGRATION.indexOf(";", start) + 1);
})();

// The rule the application used before 067 (origin/master
// lib/activitySelection.ts): active Jobs in active groups the employee has
// an open assignment to.
async function oldRule(c: PoolClient, employeeId: string): Promise<string[]> {
  const { rows } = await c.query(
    `select distinct a.id
     from employee_activity_group_assignments eaga
     join activity_groups ag on ag.id = eaga.activity_group_id and ag.is_active = true
     join activity_group_activities aga on aga.activity_group_id = ag.id
     join activities a on a.id = aga.activity_id and a.is_active = true
     where eaga.employee_id = $1 and eaga.unassigned_at is null`,
    [employeeId]
  );
  return rows.map((r) => r.id as string).sort();
}

async function newRule(c: PoolClient, employeeId: string): Promise<string[]> {
  return (await loadEmployeeActivitiesWithQuestions(c, employeeId)).activities.map((a) => a.id).sort();
}

async function main() {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");

    const teamRoleId = (await c.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await c.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const job = async (name: string, active = true) =>
      (await c.query(`insert into activities (name, is_active) values ($1, $2) returning id`, [`QA 067 ${name} ${RUN_ID}`, active])).rows[0].id as string;
    const group = async (name: string, jobs: string[], active = true) => {
      const id = (await c.query(`insert into activity_groups (name, is_active) values ($1, $2) returning id`, [`QA 067 ${name} ${RUN_ID}`, active])).rows[0].id as string;
      for (const j of jobs) await c.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [id, j]);
      return id;
    };
    const employee = async (name: string, active = true) =>
      (
        await c.query(
          `insert into employees (first_name, last_name, security_role_id, team_role_id, is_active) values ($1, 'QA067', $2, $3, $4) returning id`,
          [`${name} ${RUN_ID}`, roleId, teamRoleId, active]
        )
      ).rows[0].id as string;
    const assign = async (e: string, g: string, assignedAt: string, closed = false) =>
      c.query(
        `insert into employee_activity_group_assignments (employee_id, activity_group_id, assigned_at, unassigned_at)
         values ($1, $2, $3, $4)`,
        [e, g, assignedAt, closed ? new Date().toISOString() : null]
      );

    const J1 = await job("General");
    const J2 = await job("Picking");
    const J3 = await job("Pruning");
    const J4 = await job("Lowering");
    const J5 = await job("Old Packing", false);
    const G1 = await group("Crew", [J1, J2]);
    const G2 = await group("Pickers", [J2, J3]);
    const G3 = await group("Retired", [J4], false);
    const G4 = await group("With inactive", [J1, J5]);

    const one = await employee("One group");
    const overlap = await employee("Overlapping");
    const inactiveGroupOnly = await employee("Inactive group only");
    const none = await employee("No group");
    const closed = await employee("Closed assignment");
    const inactiveEmp = await employee("Inactive employee", false);
    const withInactiveJob = await employee("Inactive job");
    const mixed = await employee("Mixed");
    const all = [one, overlap, inactiveGroupOnly, none, closed, inactiveEmp, withInactiveJob, mixed];

    await assign(one, G1, "2026-01-05T10:00:00Z");
    await assign(overlap, G1, "2026-02-01T10:00:00Z");
    await assign(overlap, G2, "2026-01-10T10:00:00Z");
    await assign(inactiveGroupOnly, G3, "2026-01-01T10:00:00Z");
    await assign(closed, G1, "2026-01-01T10:00:00Z", true);
    await assign(inactiveEmp, G2, "2026-01-01T10:00:00Z");
    await assign(withInactiveJob, G4, "2026-03-01T10:00:00Z");
    await assign(mixed, G1, "2026-01-01T10:00:00Z");
    await assign(mixed, G2, "2026-01-01T10:00:00Z", true);
    await assign(mixed, G3, "2026-01-01T10:00:00Z");

    const before = new Map<string, string[]>();
    for (const e of all) before.set(e, await oldRule(c, e));

    // --- Backfill, verbatim from the migration ---
    await c.query("delete from employee_activity_assignments");
    await c.query(BACKFILL);

    const sorted = (xs: string[]) => [...xs].sort();
    const expected: [string, string, string[]][] = [
      ["one employee in one group", one, [J1, J2]],
      ["overlapping groups give the union", overlap, [J1, J2, J3]],
      ["only an inactive group gives nothing", inactiveGroupOnly, []],
      ["no group gives nothing (never all Jobs)", none, []],
      ["a closed group assignment gives nothing", closed, []],
      ["an inactive employee keeps the same rule as before", inactiveEmp, [J2, J3]],
      ["an inactive Job is not usable", withInactiveJob, [J1]],
      ["open active group + closed group + inactive group", mixed, [J1, J2]],
    ];
    for (const [label, e, jobs] of expected) {
      const after = await newRule(c, e);
      check(JSON.stringify(after) === JSON.stringify(sorted(jobs)), `backfill: ${label}`, { after, expected: sorted(jobs) });
      check(JSON.stringify(after) === JSON.stringify(before.get(e)), `backfill: ${label} — identical to the old rule`);
    }

    // Exact access, not just the list: every (employee, Job) pair is
    // accepted or refused exactly as before.
    for (const e of all) {
      for (const j of [J1, J2, J3, J4, J5]) {
        const v = await validateActivityAndAnswers(c, j, e, undefined);
        check(v.ok === (before.get(e) ?? []).includes(j), "backfill: server accepts exactly the old Jobs", { e, j, v });
      }
    }

    const dupes = await c.query(
      `select employee_id, activity_id from employee_activity_assignments where employee_id = any($1::uuid[])
       group by 1, 2 having count(*) > 1`,
      [all]
    );
    check(dupes.rows.length === 0, "backfill: a Job in two of an employee's groups appears once");
    const overlapJ2 = await c.query(
      `select assigned_at, source from employee_activity_assignments where employee_id = $1 and activity_id = $2`,
      [overlap, J2]
    );
    check(
      new Date(overlapJ2.rows[0].assigned_at).toISOString() === "2026-01-10T10:00:00.000Z" && overlapJ2.rows[0].source === "activity_group_backfill",
      "backfill: assigned_at is the earliest contributing group assignment",
      overlapJ2.rows[0]
    );
    const latent = await c.query(
      `select count(*)::int as n from employee_activity_assignments where employee_id = $1 and activity_id = $2 and unassigned_at is null`,
      [withInactiveJob, J5]
    );
    check(latent.rows[0].n === 1, "backfill: the inactive Job's assignment is kept (reactivating it restores access, as before)");
    await c.query(`update activities set is_active = true where id = $1`, [J5]);
    check(JSON.stringify(await newRule(c, withInactiveJob)) === JSON.stringify(sorted([J1, J5])), "reactivating that Job gives it back");
    check(JSON.stringify(await oldRule(c, withInactiveJob)) === JSON.stringify(sorted([J1, J5])), "...exactly as the group rule would");
    await c.query(`update activities set is_active = false where id = $1`, [J5]);

    // --- Old application keeps editing groups after 067 (triggers on) ---
    await c.query("set local session_replication_role = origin");
    const steps: [string, string, unknown[]][] = [
      ["old app adds an employee to a group", `insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [none, G2]],
      ["old app removes an employee from a group", `update employee_activity_group_assignments set unassigned_at = now() where employee_id = $1 and activity_group_id = $2 and unassigned_at is null`, [overlap, G1]],
      ["old app deactivates a group", `update activity_groups set is_active = false where id = $1`, [G2]],
      ["old app reactivates it", `update activity_groups set is_active = true where id = $1`, [G2]],
      ["old app adds a Job to a group", `insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [G1, J4]],
      ["old app removes a Job from a group", `delete from activity_group_activities where activity_group_id = $1 and activity_id = $2`, [G1, J2]],
      ["old app deactivates an employee (ends their groups)", `update employee_activity_group_assignments set unassigned_at = now() where employee_id = $1 and unassigned_at is null`, [mixed]],
      ["old app activates a retired group", `update activity_groups set is_active = true where id = $1`, [G3]],
    ];
    for (const [label, sql, params] of steps) {
      await c.query(sql, params);
      for (const e of all) {
        const o = await oldRule(c, e);
        const n = await newRule(c, e);
        check(JSON.stringify(o) === JSON.stringify(n), `after "${label}": same Jobs under old and new rule`, { e, o, n });
      }
    }
    const openDupes = await c.query(
      `select 1 from employee_activity_assignments where unassigned_at is null and employee_id = any($1::uuid[])
       group by employee_id, activity_id having count(*) > 1`,
      [all]
    );
    check(openDupes.rows.length === 0, "transition sync never creates duplicate open assignments");
    const closedKept = await c.query(
      `select count(*)::int as n from employee_activity_assignments where employee_id = $1 and unassigned_at is not null`,
      [mixed]
    );
    check(closedKept.rows[0].n > 0, "removed access is closed (kept as history), not deleted");
  } finally {
    await c.query("rollback");
    c.release();
  }
  const leftovers = await pool.query(`select count(*)::int as n from activities where name like $1`, [`QA 067 % ${RUN_ID}`]);
  check(leftovers.rows[0].n === 0, "everything was rolled back");
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
