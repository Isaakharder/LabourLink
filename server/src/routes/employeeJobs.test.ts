// Direct employee → Job assignments (migration 067) through the real
// routers over real HTTP against the real database: the Employee form's
// save (create and edit, one/many/all/zero Jobs, atomic with the employee),
// validation (unknown, malformed and inactive Jobs), permissions, concurrent
// edits, deactivating a Job, removing an assignment without touching
// history, an offline phone event recorded before a Job was removed, a
// paired phone's Job list refreshing, the Inputs picker, employee
// deactivation, the legacy Activity Group endpoints answering a stale
// browser with 410, and the employee list's constant query count.
// RUN_ID-suffixed fixtures, removed in one cleanup transaction.
//
// Run with: npm run test:employee-jobs
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import employeesRouter from "./employees";
import activitiesRouter from "./activities";
import activityGroupsRouter from "./activityGroups";
import mobileTimeRouter from "./mobileTime";
import inputsRouter from "./inputs";

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
const tag = (s: string) => `QA Jobs ${s} ${RUN_ID}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", employeesRouter);
  app.use("/api/activities", activitiesRouter);
  app.use("/api/activity-groups", activityGroupsRouter);
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/inputs", inputsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Cookie = `labourlink_session=${token}`;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function phone(method: string, path: string, deviceIdentifier: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/mobile${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const deviceIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function actor(label: string, role: string) {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, security_role_id, team_role_id, is_active) values ($1, 'QA', $2, $3, true) returning id`,
          [tag(label), await roleId(role), teamRoleId]
        )
      ).rows[0].id;
      employeeIds.push(id);
      return { id, token: signSession({ id, firstName: "QA", lastName: label, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await actor("Admin", "Administrator");
    const manager = await actor("Manager", "Manager");
    const supervisor = await actor("Supervisor", "Supervisor");

    async function job(name: string, active = true) {
      const id = (await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, $2, 0) returning id`, [tag(name), active])).rows[0].id;
      activityIds.push(id);
      return id as string;
    }
    const general = await job("General");
    const picking = await job("Picking Peppers");
    const plant = await job("Plant Lowering");
    const winding = await job("Winding & Pruning");
    const packing = await job("Packing Bags");
    const retired = await job("Retired", false);
    const allActive = [general, picking, plant, winding, packing];

    const openJobs = async (employeeId: string) =>
      (
        await pool.query(
          `select activity_id from employee_activity_assignments where employee_id = $1 and unassigned_at is null order by activity_id`,
          [employeeId]
        )
      ).rows.map((r) => r.activity_id as string);
    const sorted = (xs: string[]) => [...xs].sort();
    const base = { lastName: "QA", startDate: "2026-01-01", nationality: "Canadian" };

    // ---------------------------------------------------------------
    // 1) Create with Jobs; edit to one / many / all / zero.
    // ---------------------------------------------------------------
    const created = await call("POST", "/api/employees", admin.token, { ...base, firstName: tag("Worker"), activityIds: [picking, general] });
    check(created.status === 201, "1) create with Jobs succeeds", created.body);
    const worker = created.body.employee.id as string;
    employeeIds.push(worker);
    check(
      JSON.stringify(created.body.employee.assignedActivities.map((a: { name: string }) => a.name)) ===
        JSON.stringify([tag("General"), tag("Picking Peppers")]),
      "1) the saved employee lists exactly its Jobs, alphabetically",
      created.body.employee.assignedActivities
    );
    check(JSON.stringify(created.body.employee.activityGroups) === "[]", "1) activityGroups is still present (always empty) for stale pages");
    const audit = await pool.query(`select assigned_by_employee_id, source from employee_activity_assignments where employee_id = $1`, [worker]);
    check(audit.rows.every((r) => r.assigned_by_employee_id === admin.id && r.source === "direct"), "1) who assigned each Job is recorded", audit.rows);

    const noJobsCreate = await call("POST", "/api/employees", admin.token, { ...base, firstName: tag("No jobs") });
    employeeIds.push(noJobsCreate.body.employee.id);
    check(noJobsCreate.status === 201 && noJobsCreate.body.employee.assignedActivities.length === 0, "1) creating without Jobs gives no Jobs");

    for (const [label, set] of [
      ["one", [winding]],
      ["many", [winding, plant, general]],
      ["all", allActive],
      ["zero", []],
    ] as [string, string[]][]) {
      const r = await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: set });
      check(r.status === 200, `1) edit to ${label} Job(s) succeeds`, r.body);
      check(JSON.stringify(await openJobs(worker)) === JSON.stringify(sorted(set)), `1) exactly ${label} Job(s) assigned afterwards`);
    }
    const zeroMobile = await pool.query(`select count(*)::int as n from employee_activity_assignments where employee_id = $1 and unassigned_at is null`, [worker]);
    check(zeroMobile.rows[0].n === 0, "1) zero selected Jobs means no Jobs, not all Jobs");

    // Absent activityIds leaves Jobs alone.
    await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: [general, picking] });
    await call("PATCH", `/api/employees/${worker}`, admin.token, { notes: "unrelated edit" });
    check(JSON.stringify(await openJobs(worker)) === JSON.stringify(sorted([general, picking])), "1) an edit without activityIds leaves Jobs unchanged");

    // ---------------------------------------------------------------
    // 2) Validation, atomic with the employee's own fields.
    // ---------------------------------------------------------------
    const foreign = randomUUID();
    const bad = await call("PATCH", `/api/employees/${worker}`, admin.token, { firstName: tag("Renamed"), activityIds: [general, foreign] });
    check(bad.status === 400 && /no longer exist/.test(bad.body?.errors?.activityIds ?? ""), "2) an unknown (e.g. another organization's) Job id is refused", bad.body);
    const nameAfter = (await pool.query(`select first_name from employees where id = $1`, [worker])).rows[0].first_name;
    check(nameAfter === tag("Worker"), "2) ...and the employee's other changes in that save are rolled back too");
    check(JSON.stringify(await openJobs(worker)) === JSON.stringify(sorted([general, picking])), "2) ...and the Jobs are unchanged");
    const inactive = await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: [retired] });
    check(inactive.status === 400 && inactive.body.errors.activityIds.includes(tag("Retired")), "2) an inactive Job can't be assigned", inactive.body);
    check((await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: ["not-a-uuid"] })).status === 400, "2) a malformed id is refused");
    check((await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: general })).status === 400, "2) a non-list is refused");
    const createBad = await call("POST", "/api/employees", admin.token, { ...base, firstName: tag("Bad create"), activityIds: [foreign] });
    check(createBad.status === 400, "2) creating with an unknown Job is refused");
    const createdAnyway = await pool.query(`select count(*)::int as n from employees where first_name = $1`, [tag("Bad create")]);
    check(createdAnyway.rows[0].n === 0, "2) ...and no employee is created");

    // ---------------------------------------------------------------
    // 3) Permissions: unchanged — only Administrators assign Jobs.
    // ---------------------------------------------------------------
    for (const who of [manager, supervisor]) {
      const r = await call("PATCH", `/api/employees/${worker}`, who.token, { activityIds: allActive });
      check(r.status === 403, `3) a ${who === manager ? "Manager" : "Supervisor"} can't change an employee's Jobs`, r.status);
    }
    check((await call("PATCH", `/api/employees/${worker}`, null, { activityIds: allActive })).status === 401, "3) signed out is refused");
    check(JSON.stringify(await openJobs(worker)) === JSON.stringify(sorted([general, picking])), "3) ...nothing changed");
    const mgrView = await call("GET", `/api/employees/${worker}`, manager.token);
    check(mgrView.status === 200 && mgrView.body.employee.assignedActivities.length === 2, "3) a Manager can still see an employee's Jobs");

    // ---------------------------------------------------------------
    // 4) Concurrent edits of the same employee: one complete set wins.
    // ---------------------------------------------------------------
    for (let round = 0; round < 5; round++) {
      const a = [general, plant];
      const b = [picking, winding, packing];
      const [ra, rb] = await Promise.all([
        call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: a }),
        call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: b }),
      ]);
      const now = JSON.stringify(await openJobs(worker));
      check(ra.status === 200 && rb.status === 200, "4) both concurrent saves succeed");
      check(now === JSON.stringify(sorted(a)) || now === JSON.stringify(sorted(b)), "4) the result is exactly one of the two sets, never a mix", now);
    }
    const dupes = await pool.query(
      `select 1 from employee_activity_assignments where employee_id = $1 and unassigned_at is null group by activity_id having count(*) > 1`,
      [worker]
    );
    check(dupes.rows.length === 0, "4) no duplicate open assignments");

    // ---------------------------------------------------------------
    // 5) Phone: paired device, Job list refreshes, deactivating a Job.
    // ---------------------------------------------------------------
    await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: [general, picking] });
    const deviceIdentifier = `qa-jobs-${RUN_ID}`;
    const deviceRowId = (await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [deviceIdentifier, tag("Phone")])).rows[0].id;
    deviceIds.push(deviceRowId);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRowId, worker]);
    const phoneJobs = async () => ((await phone("GET", "/activities", deviceIdentifier)).body?.activities ?? []).map((a: { id: string }) => a.id).sort();

    check(JSON.stringify(await phoneJobs()) === JSON.stringify(sorted([general, picking])), "5) the phone offers exactly the assigned active Jobs");
    await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: [general, picking, winding] });
    check(JSON.stringify(await phoneJobs()) === JSON.stringify(sorted([general, picking, winding])), "5) an already-paired phone sees a newly assigned Job on its next refresh");
    const inputsList = await call("GET", `/api/inputs/employee-activities?employeeId=${worker}`, admin.token);
    check(
      JSON.stringify(inputsList.body.activities.map((a: { id: string }) => a.id).sort()) === JSON.stringify(sorted([general, picking, winding])),
      "5) the Inputs manual-entry picker offers the same Jobs"
    );

    await call("PATCH", `/api/activities/${winding}`, admin.token, { isActive: false });
    check(JSON.stringify(await phoneJobs()) === JSON.stringify(sorted([general, picking])), "5) a deactivated Job disappears from the phone");
    const kept = await pool.query(`select 1 from employee_activity_assignments where employee_id = $1 and activity_id = $2 and unassigned_at is null`, [worker, winding]);
    check(kept.rows.length === 1, "5) ...but the employee's assignment is kept");
    const form = await call("GET", `/api/employees/${worker}`, admin.token);
    check(
      form.body.employee.assignedActivities.some((a: { id: string; isActive: boolean }) => a.id === winding && a.isActive === false),
      "5) the Employee form receives it flagged inactive (shown read-only)"
    );
    await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: [general] });
    const keptAfterSave = await pool.query(`select 1 from employee_activity_assignments where employee_id = $1 and activity_id = $2 and unassigned_at is null`, [worker, winding]);
    check(keptAfterSave.rows.length === 1, "5) saving the form (active Jobs only) leaves the inactive Job's assignment alone");
    const online = await phone("POST", "/time-entries/work", deviceIdentifier, { activityId: winding, idempotencyKey: randomUUID() });
    check(online.status === 400 || online.status === 422 || online.status === 409, "5) the phone can't start a deactivated Job", online);
    await call("PATCH", `/api/activities/${winding}`, admin.token, { isActive: true });
    check(JSON.stringify(await phoneJobs()) === JSON.stringify(sorted([general, winding])), "5) reactivating the Job gives it back to the same employee");
    const jobsList = await call("GET", "/api/activities?status=all", admin.token);
    const windingRow = jobsList.body.activities.find((a: { id: string }) => a.id === winding);
    check(windingRow?.assignedEmployeeCount === 1, "5) the Jobs list counts the employees assigned to a Job", windingRow);

    // ---------------------------------------------------------------
    // 6) Offline event recorded before the Job was removed; history.
    // ---------------------------------------------------------------
    await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: [general, picking] });
    await sleep(30);
    const whileAssigned = new Date().toISOString();
    await sleep(30);
    const pastEntry = (
      await pool.query(
        `insert into time_entries (employee_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, 'work', $2, gen_random_uuid(), now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 'manual')
         returning id, activity_id, started_at, ended_at`,
        [worker, picking]
      )
    ).rows[0];
    const removed = await call("PATCH", `/api/employees/${worker}`, admin.token, { activityIds: [general] });
    check(removed.status === 200, "6) removing a Job succeeds");
    const history = await pool.query(`select * from time_entries where id = $1`, [pastEntry.id]);
    check(
      history.rows[0]?.activity_id === picking && history.rows[0].started_at.getTime() === pastEntry.started_at.getTime() && history.rows[0].ended_at.getTime() === pastEntry.ended_at.getTime(),
      "6) removing the assignment leaves past time entries untouched"
    );
    const closedRow = await pool.query(
      `select unassigned_at, unassigned_by_employee_id from employee_activity_assignments where employee_id = $1 and activity_id = $2 order by assigned_at desc limit 1`,
      [worker, picking]
    );
    check(closedRow.rows[0]?.unassigned_at && closedRow.rows[0].unassigned_by_employee_id === admin.id, "6) the removal is recorded (when and by whom), not deleted");
    check(!(await phoneJobs()).includes(picking), "6) the phone no longer offers the removed Job");

    const ev1 = { clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: whileAssigned, activityId: picking, answers: null };
    const s1 = await phone("POST", "/sync/events", deviceIdentifier, { events: [ev1] });
    check(s1.body?.results?.[0]?.status === "accepted", "6) an offline event recorded while the Job was assigned still syncs", s1.body);
    const synced = await pool.query(`select activity_id from time_entries where idempotency_key = $1`, [ev1.clientEventId]);
    check(synced.rows[0]?.activity_id === picking, "6) ...and keeps its original Job");
    const ev2 = { clientEventId: randomUUID(), deviceSeq: 2, eventType: "end_day", occurredAtUtc: new Date().toISOString() };
    await phone("POST", "/sync/events", deviceIdentifier, { events: [ev2] });
    await sleep(20);
    const ev3 = { clientEventId: randomUUID(), deviceSeq: 3, eventType: "work_start", occurredAtUtc: new Date().toISOString(), activityId: picking, answers: null };
    const s3 = await phone("POST", "/sync/events", deviceIdentifier, { events: [ev3] });
    check(
      s3.body?.results?.[0]?.status === "permanent_conflict" && /not available/.test(s3.body.results[0].detail?.reason ?? ""),
      "6) an event recorded after the Job was removed is refused (kept as a sync conflict)",
      s3.body
    );
    const ev4 = { clientEventId: randomUUID(), deviceSeq: 4, eventType: "work_start", occurredAtUtc: "2020-01-01T08:00:00.000Z", activityId: plant, answers: null };
    const s4 = await phone("POST", "/sync/events", deviceIdentifier, { events: [ev4] });
    check(s4.body?.results?.[0]?.status === "permanent_conflict", "6) an event for a Job the employee never had is refused", s4.body);

    // ---------------------------------------------------------------
    // 7) Stale pre-deployment browser: legacy group endpoints answer 410.
    // ---------------------------------------------------------------
    const before7 = JSON.stringify(await openJobs(worker));
    const legacy: [string, string, unknown?][] = [
      ["GET", "/api/activity-groups?status=active"],
      ["POST", "/api/activity-groups", { name: "x", activityIds: allActive }],
      ["PATCH", `/api/activity-groups/${randomUUID()}`, { isActive: false }],
      ["POST", `/api/activity-groups/${randomUUID()}/assign-employees`, { employeeIds: [worker] }],
      ["DELETE", `/api/activity-groups/${randomUUID()}/employees/${worker}`],
      ["GET", `/api/employees/${worker}/activity-groups`],
      ["PUT", `/api/employees/${worker}/activity-groups`, { activityGroupIds: [] }],
    ];
    for (const [method, path, body] of legacy) {
      const r = await call(method, path, admin.token, body);
      check(r.status === 410 && /Refresh LabourLink/.test(r.body?.error ?? ""), `7) stale ${method} ${path.split("?")[0]} answers 410 "refresh LabourLink"`, r);
    }
    check(JSON.stringify(await openJobs(worker)) === before7, "7) ...and changes nothing");
    const staleCreate = await call("POST", "/api/employees", admin.token, { ...base, firstName: tag("Stale create") });
    employeeIds.push(staleCreate.body.employee.id);
    check(staleCreate.body.employee.assignedActivities.length === 0, "7) a stale page's create (no activityIds) gives no Jobs, never all");

    // ---------------------------------------------------------------
    // 8) Deactivating an employee ends their Jobs.
    // ---------------------------------------------------------------
    const target = (await call("POST", "/api/employees", admin.token, { ...base, firstName: tag("Leaving"), activityIds: [general, plant] })).body.employee.id;
    employeeIds.push(target);
    await call("PATCH", `/api/employees/${target}`, admin.token, { isActive: false });
    check((await openJobs(target)).length === 0, "8) deactivating an employee closes their Job assignments");
    const reactivated = await call("PATCH", `/api/employees/${target}`, admin.token, { isActive: true });
    check(reactivated.body.employee.assignedActivities.length === 0, "8) a reactivated employee starts with no Jobs (as with groups)");

    // ---------------------------------------------------------------
    // 9) Listing employees: Jobs come in the same query (no N+1).
    // ---------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = pool.query.bind(pool) as any;
    let queries = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: any[]) => {
      queries++;
      return original(...args);
    };
    await call("GET", "/api/employees", admin.token);
    const first = queries;
    for (let i = 0; i < 4; i++) {
      const r = await call("POST", "/api/employees", admin.token, { ...base, firstName: tag(`Bulk ${i}`), activityIds: allActive });
      employeeIds.push(r.body.employee.id);
    }
    queries = 0;
    const list = await call("GET", "/api/employees", admin.token);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = original;
    check(queries === first, "9) the employee list runs the same number of queries regardless of how many employees/Jobs", { first, after: queries });
    const bulk = list.body.employees.find((e: { firstName: string }) => e.firstName === tag("Bulk 0"));
    check(bulk?.assignedActivities.length === allActive.length, "9) ...and each employee in it carries their Jobs");
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[]) or employee_id = any($2::uuid[])`, [deviceIds, employeeIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employee_activity_assignments where employee_id = any($1::uuid[]) or activity_id = any($2::uuid[])`, [employeeIds, activityIds]);
      await client.query(`delete from web_sessions where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from activities where id = any($1::uuid[])`, [activityIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup failed, nothing removed:", err);
      fail++;
    } finally {
      client.release();
    }
    const orphans = await pool.query(`select count(*)::int as n from employees where first_name like $1`, [`QA Jobs % ${RUN_ID}`]);
    check(orphans.rows[0].n === 0, "cleanup removed every fixture employee");
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
