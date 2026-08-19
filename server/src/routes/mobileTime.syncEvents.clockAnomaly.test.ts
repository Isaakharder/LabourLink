// Integration tests for device-clock anomaly detection (mobileTime.ts's
// detectClockAnomaly, wired into POST /sync/events) — the offline-first
// plan's "detect significant device-clock changes; store occurrence
// time+sequence for review" requirement. Covers: a backward clock jump
// (this device's own occurred_at_utc running earlier than its own
// previously-accepted event) flags the event as 'accepted' WITH a
// conflict_reason/detail rather than rejecting it (occurrence time is
// still preserved, never silently dropped); a forward clock jump (way
// ahead of the server) is flagged the same way; small, ordinary jitter is
// NOT flagged; a flagged event surfaces on the admin Sync Conflicts list
// (mobileSyncConflicts.ts's REVIEWABLE_CONDITION) and can be resolved
// there; and a replay of an already-flagged event still reports the same
// anomaly detail, not a bare "duplicate" with the flag silently dropped.
//
// Run with: npm run test:mobile-time-sync-events-clock-anomaly
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import mobileTimeRouter from "./mobileTime";
import mobileSyncConflictsRouter from "./mobileSyncConflicts";

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
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/mobile-sync", mobileSyncConflictsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function sync(deviceIdentifier: string, events: unknown[]): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/mobile/sync/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify({ events }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function callAdmin(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let groupId!: string;
  let activityId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    const employee = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Clock Anomaly ${RUN_ID}`, `qa-clock-anomaly-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(employee.id);
    const employeeId: string = employee.id;

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Clock Anomaly Admin ${RUN_ID}`, `qa-clock-anomaly-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Clock Anomaly Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    const deviceIdentifier = randomUUID();
    const deviceRow = (
      await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
        deviceIdentifier,
        `QA Clock Anomaly Device ${RUN_ID}`,
      ])
    ).rows[0];
    deviceIds.push(deviceRow.id);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRow.id, employeeId]);

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA Clock Anomaly Group ${RUN_ID}`])
    ).rows[0].id;
    activityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Clock Anomaly Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [groupId, activityId]);
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
      employeeId,
      groupId,
    ]);

    const t0 = new Date(Date.now() - 60 * 60 * 1000); // an hour ago

    // -----------------------------------------------------------------
    // A) a normal, non-anomalous work_start is accepted with NO anomaly
    //    flag at all (baseline — nothing should be flagged just because
    //    it's offline/old).
    // -----------------------------------------------------------------
    const event1 = { clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: t0.toISOString(), activityId, answers: null };
    const r1 = await sync(deviceIdentifier, [event1]);
    check(r1.body?.results?.[0]?.status === "accepted", "A) baseline work_start accepted", r1.body);
    check(r1.body?.results?.[0]?.detail === undefined, "A) no anomaly detail on an ordinary accepted event", r1.body);

    // -----------------------------------------------------------------
    // B) small forward jitter (a few seconds ahead of the previous event,
    //    well within tolerance) is NOT flagged.
    // -----------------------------------------------------------------
    const event2 = {
      clientEventId: randomUUID(),
      deviceSeq: 2,
      eventType: "activity_switch",
      occurredAtUtc: new Date(t0.getTime() + 5000).toISOString(),
      activityId,
      answers: null,
    };
    const r2 = await sync(deviceIdentifier, [event2]);
    check(r2.body?.results?.[0]?.status === "accepted" && r2.body?.results?.[0]?.detail === undefined, "B) small forward jitter is not flagged", r2.body);

    // -----------------------------------------------------------------
    // C) end_day closes everything — employee is now idle, nothing open
    //    to violate ordering against.
    // -----------------------------------------------------------------
    const event3 = { clientEventId: randomUUID(), deviceSeq: 3, eventType: "end_day", occurredAtUtc: new Date(t0.getTime() + 10000).toISOString() };
    const r3 = await sync(deviceIdentifier, [event3]);
    check(r3.body?.results?.[0]?.status === "accepted", "C) end_day accepted, employee now idle", r3.body);

    // -----------------------------------------------------------------
    // D) a backward clock jump that does NOT collide with anything open
    //    (employee is idle — nothing to close) is accepted (occurrence
    //    time still preserved) but flagged with a clock-anomaly reason.
    // -----------------------------------------------------------------
    const event4 = {
      clientEventId: randomUUID(),
      deviceSeq: 4,
      eventType: "work_start",
      occurredAtUtc: new Date(t0.getTime() - 10 * 60 * 1000).toISOString(), // 10 minutes BEFORE event1
      activityId,
      answers: null,
    };
    const r4 = await sync(deviceIdentifier, [event4]);
    check(r4.body?.results?.[0]?.status === "accepted", "D) backward-clock work_start is still accepted (nothing open to violate)", r4.body);
    check(
      typeof r4.body?.results?.[0]?.detail?.regressionMs === "number" && r4.body.results[0].detail.regressionMs > 0,
      "D) the response carries a positive regressionMs in its anomaly detail",
      r4.body
    );

    const storedRow4 = await pool.query(`select processing_status, conflict_reason, occurred_at_utc from mobile_time_events where client_event_id = $1`, [
      event4.clientEventId,
    ]);
    check(storedRow4.rows[0]?.processing_status === "accepted", "D) stored ledger row is 'accepted', not 'permanent_conflict'");
    check(
      typeof storedRow4.rows[0]?.conflict_reason === "string" && storedRow4.rows[0].conflict_reason.includes("backward"),
      "D) stored conflict_reason describes the backward jump",
      storedRow4.rows[0]
    );
    check(
      new Date(storedRow4.rows[0]?.occurred_at_utc).getTime() === new Date(event4.occurredAtUtc).getTime(),
      "D) the true (backward) occurrence time is still exactly what got stored — never silently corrected"
    );

    // -----------------------------------------------------------------
    // E) a forward clock jump (implausibly ahead of the SERVER's clock)
    //    while something IS open is also flagged — forward jumps never
    //    collide with the ordering constraint (they land after whatever
    //    they might close), so this stays 'accepted', unlike case F below.
    // -----------------------------------------------------------------
    const event5 = {
      clientEventId: randomUUID(),
      deviceSeq: 5,
      eventType: "activity_switch",
      occurredAtUtc: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour in the future
      activityId,
      answers: null,
    };
    const r5 = await sync(deviceIdentifier, [event5]);
    check(r5.body?.results?.[0]?.status === "accepted", "E) forward-clock event is still accepted", r5.body);
    check(
      typeof r5.body?.results?.[0]?.detail?.forwardSkewMs === "number" && r5.body.results[0].detail.forwardSkewMs > 0,
      "E) the response carries a positive forwardSkewMs in its anomaly detail",
      r5.body
    );

    // -----------------------------------------------------------------
    // F) a SEVERE backward jump that WOULD close the just-opened entry
    //    (event5) before it started is rejected outright as a
    //    permanent_conflict — retrying an internally-contradictory
    //    timestamp can never succeed, so this must never become a
    //    forever-stuck retryable_failure. The conflict reason names the
    //    clock anomaly, not just a generic DB error.
    // -----------------------------------------------------------------
    const event6 = {
      clientEventId: randomUUID(),
      deviceSeq: 6,
      eventType: "activity_switch",
      occurredAtUtc: t0.toISOString(), // WAY before event5, which is currently open
      activityId,
      answers: null,
    };
    const r6 = await sync(deviceIdentifier, [event6]);
    check(r6.body?.results?.[0]?.status === "permanent_conflict", "F) an ordering-violating backward jump is a permanent_conflict, not stuck retrying", r6.body);
    check(
      typeof r6.body?.results?.[0]?.detail?.regressionMs === "number",
      "F) the conflict detail still carries the clock-anomaly regression info",
      r6.body
    );
    const storedRow6 = await pool.query(`select processing_status from mobile_time_events where client_event_id = $1`, [event6.clientEventId]);
    check(storedRow6.rows[0]?.processing_status === "permanent_conflict", "F) stored as permanent_conflict — not silently applied, not stuck pending forever");

    // A later, ordinary event (seq 7) still applies normally — the device
    // isn't permanently blocked just because event6 was rejected.
    const event7 = { clientEventId: randomUUID(), deviceSeq: 7, eventType: "end_day", occurredAtUtc: new Date(Date.now() + 65 * 60 * 1000).toISOString() };
    const r7 = await sync(deviceIdentifier, [event7]);
    check(r7.body?.results?.[0]?.status === "accepted", "F) a later event still applies normally after the rejected one", r7.body);

    // -----------------------------------------------------------------
    // G) the flagged events (D and E) show up on the admin Sync
    //    Conflicts list, with their reason — this is the actual "for
    //    review" requirement, not just a hidden DB column.
    // -----------------------------------------------------------------
    const list = await callAdmin("GET", "/api/mobile-sync/conflicts", adminToken);
    check(list.status === 200, "G) admin can list conflicts including clock anomalies", list.body);
    const listedIds = (list.body.conflicts as any[]).map((c) => c.clientEventId);
    check(listedIds.includes(event4.clientEventId), "G) the backward-clock event appears in the admin review list", list.body);
    check(listedIds.includes(event5.clientEventId), "G) the forward-clock event appears in the admin review list", list.body);
    check(listedIds.includes(event6.clientEventId), "G) the rejected ordering-violation event appears in the admin review list", list.body);
    check(!listedIds.includes(event1.clientEventId), "G) the ordinary, non-anomalous event1 does NOT appear in the review list");
    const listedRow4 = (list.body.conflicts as any[]).find((c) => c.clientEventId === event4.clientEventId);
    check(listedRow4?.processingStatus === "accepted", "G) event4's listed row processingStatus is 'accepted', distinguishing it from a real conflict", listedRow4);
    const listedRow6 = (list.body.conflicts as any[]).find((c) => c.clientEventId === event6.clientEventId);
    check(listedRow6?.processingStatus === "permanent_conflict", "G) event6's listed row processingStatus is 'permanent_conflict'", listedRow6);

    // -----------------------------------------------------------------
    // H) resolving a clock-anomaly row works exactly like resolving a
    //    real conflict — it's the same review queue.
    // -----------------------------------------------------------------
    const resolve = await callAdmin("POST", `/api/mobile-sync/conflicts/${listedRow4.id}/resolve`, adminToken, {
      note: "Employee's phone had the wrong date set — corrected in phone settings.",
    });
    check(resolve.status === 200 && resolve.body.conflict?.resolvedAt !== null, "H) a clock-anomaly row can be marked reviewed", resolve.body);
    const listAfterResolve = await callAdmin("GET", "/api/mobile-sync/conflicts", adminToken);
    check(
      !(listAfterResolve.body.conflicts as any[]).some((c) => c.clientEventId === event4.clientEventId),
      "H) the resolved clock-anomaly row drops out of the default (unresolved) list"
    );

    // -----------------------------------------------------------------
    // I) replaying event5 (already recorded, still unresolved) returns
    //    'duplicate' but still carries its original anomaly detail — the
    //    flag isn't silently lost on a replay.
    // -----------------------------------------------------------------
    const replay = await sync(deviceIdentifier, [event5]);
    check(replay.body?.results?.[0]?.status === "duplicate", "I) replaying event5 reports 'duplicate'", replay.body);
    check(
      typeof replay.body?.results?.[0]?.detail?.forwardSkewMs === "number",
      "I) the replayed duplicate still carries the original forwardSkewMs anomaly detail",
      replay.body
    );
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_sync_state where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activity_group_activities where activity_group_id = $1`, [groupId ?? null]);
      await client.query(`delete from activities where id = any($1::uuid[])`, [[activityId].filter(Boolean)]);
      if (groupId) await client.query(`delete from activity_groups where id = $1`, [groupId]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }

    const leftover = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    check(Number(leftover.rows[0].count) === 0, "Z) all QA fixtures cleaned up, none left orphaned");

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
