// Integration tests for the "employee appears twice in the Employees list"
// bug: GET /api/employees (employees.ts) previously left device_assignments
// unaggregated in its join, so an employee with more than one simultaneously
// -active assignment fanned out into duplicate rows sharing one UUID (real
// case: Shaima Qasimi, two active devices). Covers the three-part fix —
// employees.ts's device join now picks a single row, devices.ts's pairing
// approval now closes an employee's other active device (not just the
// target device's prior occupant), and migrations/033 adds a DB-level
// partial unique index as the last line of defense against a race between
// two concurrent approvals.
//
// Same convention as inputs.manualEntries.test.ts / workEndRounding.test.ts:
// runs the real routers over real HTTP against the real database with
// disposable QA fixtures, since no test-DB harness exists in this repo.
// Unlike those files, cleanup here runs as one transaction (begin/commit)
// instead of independently-caught steps — the earlier per-step approach
// left two runs' worth of orphaned QA employees/devices/time_entries in
// production when a couple of its cleanup steps silently failed, which is
// exactly the kind of drift a device-assignment test should not repeat.
//
// Run with: npm run test:device-assignment
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import employeesRouter from "./employees";
import devicesRouter from "./devices";

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
  app.use("/api/employees", employeesRouter);
  app.use("/api/devices", devicesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function callAdmin(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  let adminActor!: { id: string; first_name: string; last_name: string };
  let target!: { id: string; first_name: string; last_name: string; email: string };
  let target2!: { id: string };
  let target3!: { id: string };
  // Every pairing request and device this run creates, tracked so cleanup
  // can find them regardless of which assertions passed or failed.
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const pairingRequestIds: string[] = [];

  async function createPairingRequest(): Promise<{ requestId: string }> {
    const { rows } = await pool.query(
      `insert into pairing_requests (pairing_code, device_identifier, status, expires_at)
       values ($1, $2, 'pending', now() + interval '10 minutes')
       returning id`,
      [`QA-${randomUUID().slice(0, 8)}`, randomUUID()]
    );
    pairingRequestIds.push(rows[0].id);
    return { requestId: rows[0].id };
  }

  function activeDeviceRows(employeeId: string) {
    return pool.query(
      `select device_id, unassigned_at from device_assignments where employee_id = $1 and unassigned_at is null`,
      [employeeId]
    );
  }

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    async function createEmployee(label: string, role: string) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true)
         returning id, first_name, last_name, email`,
        [
          "QA",
          `Device Assignment ${label} ${RUN_ID}`,
          `qa-device-assignment-${label.toLowerCase()}-${RUN_ID}@test.local`,
          await roleId(role),
          teamRoleId,
          fakePinHash,
        ]
      );
      employeeIds.push(rows[0].id);
      return rows[0];
    }

    adminActor = await createEmployee("admin", "Administrator");
    target = await createEmployee("target", "Employee");
    target2 = await createEmployee("target2", "Employee");
    target3 = await createEmployee("target3", "Employee");

    const adminToken = signSession({
      id: adminActor.id,
      firstName: adminActor.first_name,
      lastName: adminActor.last_name,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });

    // -----------------------------------------------------------------
    // 1) Re-pairing an employee to a new device closes their previous
    //    active device assignment.
    // -----------------------------------------------------------------
    const pr1 = await createPairingRequest();
    const approve1 = await callAdmin("POST", `/api/devices/pairing-requests/${pr1.requestId}/approve`, adminToken, {
      deviceName: `QA Device A ${RUN_ID}`,
      employeeId: target.id,
    });
    check(approve1.status === 200, "A) first pairing approved", approve1.body);
    const deviceAId = approve1.body?.deviceId;
    if (deviceAId) deviceIds.push(deviceAId);

    const pr2 = await createPairingRequest();
    const approve2 = await callAdmin("POST", `/api/devices/pairing-requests/${pr2.requestId}/approve`, adminToken, {
      deviceName: `QA Device B ${RUN_ID}`,
      employeeId: target.id,
    });
    check(approve2.status === 200, "B) re-pairing to a second device approved", approve2.body);
    const deviceBId = approve2.body?.deviceId;
    if (deviceBId) deviceIds.push(deviceBId);

    const activeAfterRepair = (await activeDeviceRows(target.id)).rows;
    check(
      activeAfterRepair.length === 1 && activeAfterRepair[0].device_id === deviceBId,
      "C) exactly one active device for the employee after re-pairing, and it's the new one",
      activeAfterRepair
    );

    // -----------------------------------------------------------------
    // 2) Employee with assignment history (one closed, one active)
    //    appears exactly once in GET /api/employees.
    // -----------------------------------------------------------------
    const list = await callAdmin(
      "GET",
      `/api/employees?search=${encodeURIComponent(target.email)}`,
      adminToken
    );
    const matches = (list.body?.employees ?? []).filter((e: any) => e.id === target.id);
    check(list.status === 200 && matches.length === 1, "D) employee with assignment history appears exactly once", {
      status: list.status,
      matchCount: matches.length,
    });
    check(
      matches[0]?.device?.id === deviceBId,
      "E) the one listed row reflects the current (most recent) active device",
      matches[0]?.device
    );

    // -----------------------------------------------------------------
    // 3) Reassigning a device closes the device's previous employee
    //    assignment.
    // -----------------------------------------------------------------
    const pr3 = await createPairingRequest();
    // Re-approve the SAME device identifier (device A, currently inactive
    // for `target`) but for a different employee — devices.ts upserts by
    // device_identifier, so this exercises the device-side reassignment.
    const deviceAIdentifierRow = await pool.query(`select device_identifier from devices where id = $1`, [deviceAId]);
    await pool.query(`update pairing_requests set device_identifier = $1 where id = $2`, [
      deviceAIdentifierRow.rows[0].device_identifier,
      pr3.requestId,
    ]);
    const approve3 = await callAdmin("POST", `/api/devices/pairing-requests/${pr3.requestId}/approve`, adminToken, {
      deviceName: `QA Device A ${RUN_ID}`,
      employeeId: target2.id,
    });
    check(approve3.status === 200, "F) reassigning device A to a second employee approved", approve3.body);

    const deviceAActiveEmployees = await pool.query(
      `select employee_id from device_assignments where device_id = $1 and unassigned_at is null`,
      [deviceAId]
    );
    check(
      deviceAActiveEmployees.rows.length === 1 && deviceAActiveEmployees.rows[0].employee_id === target2.id,
      "G) device A's only active assignment now belongs to the new employee",
      deviceAActiveEmployees.rows
    );
    const target2Active = (await activeDeviceRows(target2.id)).rows;
    check(
      target2Active.length === 1 && target2Active[0].device_id === deviceAId,
      "H) the second employee now shows exactly one active device",
      target2Active
    );

    // -----------------------------------------------------------------
    // 4) Two concurrent approvals cannot leave one employee actively
    //    assigned to two devices. Two acceptable outcomes exist depending
    //    on how the requests actually interleave at the DB: either the
    //    second request's own "close this employee's other active
    //    assignment" step legitimately closes the first (both 200, one
    //    winner), or the two inserts truly race and the unique index
    //    forces the loser's insert to fail (one 200, one 500). What must
    //    never happen, under either interleaving, is the employee ending
    //    up with two simultaneously-active rows — that's the only
    //    invariant asserted below.
    // -----------------------------------------------------------------
    const pr4 = await createPairingRequest();
    const pr5 = await createPairingRequest();
    const [raceA, raceB] = await Promise.all([
      callAdmin("POST", `/api/devices/pairing-requests/${pr4.requestId}/approve`, adminToken, {
        deviceName: `QA Device C ${RUN_ID}`,
        employeeId: target2.id,
      }),
      callAdmin("POST", `/api/devices/pairing-requests/${pr5.requestId}/approve`, adminToken, {
        deviceName: `QA Device D ${RUN_ID}`,
        employeeId: target2.id,
      }),
    ]);
    for (const r of [raceA, raceB]) {
      const id = r.body?.deviceId;
      if (id) deviceIds.push(id);
    }
    check(
      [raceA.status, raceB.status].every((s) => s === 200 || s === 500),
      "I) both concurrent approvals resolve (either succeeds, or fails cleanly rather than corrupting state)",
      { raceA: raceA.status, raceB: raceB.status }
    );
    const target2ActiveAfterRace = (await activeDeviceRows(target2.id)).rows;
    check(
      target2ActiveAfterRace.length === 1,
      "J) employee has exactly one active device after the concurrent approvals, never two",
      target2ActiveAfterRace
    );

    // Force the actual race the app-level "close other assignments" step
    // can't see coming: two raw, truly-overlapping transactions inserting
    // an active assignment for the same employee outside any request
    // handler. The second insert must block behind the first's uncommitted
    // row and then fail once it commits — proving the unique index itself
    // (not just devices.ts's cooperative close-before-insert logic) is
    // what ultimately makes "two active devices for one employee"
    // impossible.
    const raceDevice1 = await pool.query(
      `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
      [randomUUID(), `QA Race Device 1 ${RUN_ID}`]
    );
    const raceDevice2 = await pool.query(
      `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
      [randomUUID(), `QA Race Device 2 ${RUN_ID}`]
    );
    deviceIds.push(raceDevice1.rows[0].id, raceDevice2.rows[0].id);

    const raceClientA = await pool.connect();
    const raceClientB = await pool.connect();
    let rawRaceLoserViolatedUnique = false;
    try {
      await raceClientA.query("begin");
      await raceClientA.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [
        raceDevice1.rows[0].id,
        target3.id,
      ]);
      // Left uncommitted on purpose — raceClientB's insert below must
      // block on it rather than see an empty index.
      await raceClientB.query("begin");
      const blockedInsert = raceClientB
        .query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [
          raceDevice2.rows[0].id,
          target3.id,
        ])
        .catch((err) => err);
      // Give raceClientB's insert time to actually reach Postgres and
      // start waiting on raceClientA's uncommitted row before committing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await raceClientA.query("commit");
      const result = await blockedInsert;
      rawRaceLoserViolatedUnique = result instanceof Error && (result as any).code === "23505";
    } finally {
      await raceClientB.query("rollback").catch(() => {});
      raceClientA.release();
      raceClientB.release();
    }
    check(
      rawRaceLoserViolatedUnique,
      "K) under true concurrent transactions, the second raw insert is rejected by the unique index once the first commits"
    );

    // -----------------------------------------------------------------
    // 5) The database unique index itself rejects a duplicate active
    //    assignment inserted directly (belt-and-suspenders below the API),
    //    even outside of any concurrency — a plain sequential second insert
    //    while one is already active.
    // -----------------------------------------------------------------
    const directDevice = await pool.query(
      `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
      [randomUUID(), `QA Direct Device ${RUN_ID}`]
    );
    deviceIds.push(directDevice.rows[0].id);
    let uniqueViolation = false;
    try {
      // target2 already has one active assignment at this point — a second
      // direct insert should be rejected by idx_device_assignments_active_
      // per_employee, not silently accepted.
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [
        directDevice.rows[0].id,
        target2.id,
      ]);
    } catch (err: any) {
      uniqueViolation = err?.code === "23505";
    }
    check(uniqueViolation, "L) direct insert of a second active assignment hits the unique index (code 23505)");
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `delete from time_entry_corrections where employee_id = any($1::uuid[]) or changed_by_employee_id = any($1::uuid[])`,
        [employeeIds]
      );
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      // pairing_requests references both devices(resulting_device_id) and
      // employees(approved_by_employee_id) — must go before either.
      await client.query(`delete from pairing_requests where id = any($1::uuid[])`, [pairingRequestIds]);
      await client.query(
        `delete from device_assignments where employee_id = any($1::uuid[]) or device_id = any($2::uuid[])`,
        [employeeIds, deviceIds]
      );
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }

    // Prove cleanup actually worked rather than trusting the transaction
    // alone — this is the exact class of bug (silently orphaned QA
    // fixtures) this test suite exists to guard against elsewhere in the
    // app, so it shouldn't reintroduce it itself.
    const leftover = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    check(Number(leftover.rows[0].count) === 0, "M) all QA fixtures cleaned up, none left orphaned");

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
