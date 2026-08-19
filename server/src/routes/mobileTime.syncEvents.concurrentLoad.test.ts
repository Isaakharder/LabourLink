// Stage 6 scenario coverage: "35 devices reconnecting together" — the
// offline-first plan's requirement that a batch of devices regaining
// signal at the same instant doesn't deadlock, corrupt each other's data,
// or lose events. 35 disposable QA employees/devices, each syncing a
// small multi-event batch CONCURRENTLY (Promise.all, not sequentially) —
// verifies every device's batch fully succeeds, no cross-device
// interference, and no duplicate/missing time_entries anywhere.
//
// This test exercises server-side concurrency handling only — the actual
// backoff/jitter spreading (so 35 real phones don't all retry in lockstep)
// lives client-side in syncEngine.ts and isn't something a server
// integration test can observe; what this DOES prove is that the server
// itself has no shared-state bug that breaks under concurrent load from
// many devices at once (each device's own rows are independently locked —
// see openEntry's per-employee transaction — so nothing here should ever
// need to serialize across devices).
//
// Run with: npm run test:mobile-time-sync-events-concurrent-load
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import mobileTimeRouter from "./mobileTime";

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
const DEVICE_COUNT = 35;

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
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

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let groupId!: string;
  let activityId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [
        `QA Concurrent Load Group ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA Concurrent Load Activity ${RUN_ID}`,
      ])
    ).rows[0].id;

    // 35 independent employee/device pairs, each with its own 3-event
    // offline batch (work_start -> activity_switch -> end_day) referencing
    // the SAME shared activity — deliberately, so any accidental
    // cross-device locking/contention on the activity row itself (as
    // opposed to each employee's own time_entries) would surface here.
    const devices: { deviceIdentifier: string; employeeId: string; events: unknown[] }[] = [];
    for (let i = 0; i < DEVICE_COUNT; i++) {
      const employee = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [`Concurrent ${i} ${RUN_ID}`, `qa-concurrent-${i}-${RUN_ID}@test.local`, roleId, teamRoleId, fakePinHash]
        )
      ).rows[0];
      employeeIds.push(employee.id);
      await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [
        employee.id,
        groupId,
      ]);

      const deviceIdentifier = randomUUID();
      const deviceRow = (
        await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
          deviceIdentifier,
          `QA Concurrent Device ${i} ${RUN_ID}`,
        ])
      ).rows[0];
      deviceIds.push(deviceRow.id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRow.id, employee.id]);

      const base = new Date(Date.now() - (i + 1) * 60 * 60 * 1000); // stagger start times slightly
      devices.push({
        deviceIdentifier,
        employeeId: employee.id,
        events: [
          { clientEventId: randomUUID(), deviceSeq: 1, eventType: "work_start", occurredAtUtc: base.toISOString(), activityId, answers: null },
          {
            clientEventId: randomUUID(),
            deviceSeq: 2,
            eventType: "activity_switch",
            occurredAtUtc: new Date(base.getTime() + 20 * 60000).toISOString(),
            activityId,
            answers: null,
          },
          {
            clientEventId: randomUUID(),
            deviceSeq: 3,
            eventType: "end_day",
            occurredAtUtc: new Date(base.getTime() + 40 * 60000).toISOString(),
          },
        ],
      });
    }

    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [groupId, activityId]);

    // -----------------------------------------------------------------
    // The actual "35 devices reconnecting together" moment — every
    // device's batch fired at once via Promise.all, not one after
    // another, and with NO client-side jitter at all (a real fleet's
    // syncEngine.ts staggers retries per-device specifically so this
    // never happens quite this abruptly) — i.e. deliberately harder than
    // the real scenario. If the server had any shared-mutable-state bug
    // (a global instead of a per-device counter, a missing WHERE
    // device_id clause, a lock held too broadly), this is what would
    // expose it.
    //
    // The server's own DB pool is capped at 10 connections (server/src/
    // db.ts — Supabase's pooler on this project hard-caps at 15 total
    // client connections across the whole app, not just this endpoint),
    // so a genuinely simultaneous burst from 35 devices can legitimately
    // exceed that and produce some retryable_failure results under
    // connection-acquisition timeouts. That's expected and safe: a
    // retryable_failure never applies, never gets duplicated, and just
    // means that device's queue stays pending for the next attempt —
    // exactly what a real device would do. The retry loop below proves
    // the system reaches full, correct consistency once connections free
    // up, without ever corrupting anything in between.
    // -----------------------------------------------------------------
    const t0 = Date.now();
    const results = await Promise.all(devices.map((d) => sync(d.deviceIdentifier, d.events)));
    const firstPassElapsedMs = Date.now() - t0;
    const firstPassFailures = results.filter(
      (r) => r.status !== 200 || !(r.body?.results as any[])?.every((res) => res.status === "accepted")
    ).length;
    console.log(
      `[concurrent-load] 35 devices x 3 events, first concurrent pass: ${firstPassElapsedMs}ms, ${firstPassFailures} device(s) needed a retry`
    );

    // Realistic retry loop — matches what syncEngine.ts's own backoff
    // actually does: re-submit a device's full event set (idempotent —
    // anything already accepted just comes back 'duplicate') until its
    // device_sync_state catches up to 3, or the retry budget runs out.
    const MAX_RETRY_PASSES = 5;
    for (let attempt = 0; attempt < MAX_RETRY_PASSES; attempt++) {
      const states = await pool.query(
        `select device_id, last_processed_seq from device_sync_state where device_id = any($1::uuid[])`,
        [deviceIds]
      );
      const behindDeviceIds = new Set(states.rows.filter((r) => Number(r.last_processed_seq) < 3).map((r) => r.device_id));
      if (behindDeviceIds.size === 0) break;

      const behindDevices = devices.filter((_, i) => behindDeviceIds.has(deviceIds[i]));
      await Promise.all(behindDevices.map((d) => sync(d.deviceIdentifier, d.events)));
    }

    // After however many retry passes it took, every device must have
    // reached full consistency — this is the actual pass/fail bar, not
    // "zero failures on the very first simultaneous attempt."
    const finalStates = await pool.query(
      `select device_id, last_processed_seq from device_sync_state where device_id = any($1::uuid[])`,
      [deviceIds]
    );
    const allAtThree = finalStates.rows.every((r) => Number(r.last_processed_seq) === 3);
    check(allAtThree, "1) every device reached full consistency (device_seq 3) after realistic retries, even though some needed one", {
      wrong: finalStates.rows.filter((r) => Number(r.last_processed_seq) !== 3),
    });

    // No duplicates anywhere: exactly 2 time_entries per employee — the
    // work_start and the activity_switch each open a row; end_day only
    // CLOSES the currently-open one, it never inserts a third (35 * 2 =
    // 70 total) — and exactly one ledger row per client_event_id (checked
    // separately below, since the ledger tracks EVENTS, 3 per device,
    // regardless of how many of them happened to open a new row).
    const entryCounts = await pool.query(
      `select employee_id, count(*) as c from time_entries where employee_id = any($1::uuid[]) group by employee_id`,
      [employeeIds]
    );
    const allTwoEach = entryCounts.rows.length === DEVICE_COUNT && entryCounts.rows.every((r) => Number(r.c) === 2);
    check(allTwoEach, "2) every employee ended up with exactly 2 time_entries rows — no duplicates, none missing", {
      count: entryCounts.rows.length,
      wrong: entryCounts.rows.filter((r) => Number(r.c) !== 2),
    });

    const ledgerCount = await pool.query(`select count(*) from mobile_time_events where device_id = any($1::uuid[])`, [deviceIds]);
    check(Number(ledgerCount.rows[0].count) === DEVICE_COUNT * 3, "3) exactly 105 ledger rows total (35 devices x 3 events) — no duplicates from the concurrency or the retries");

    const distinctIdempotencyKeys = await pool.query(
      `select count(distinct idempotency_key) as distinct_count, count(*) as total_count
       from time_entries where employee_id = any($1::uuid[])`,
      [employeeIds]
    );
    check(
      distinctIdempotencyKeys.rows[0].distinct_count === distinctIdempotencyKeys.rows[0].total_count,
      "4) every time_entries row has a distinct idempotency_key — no duplicates anywhere, confirmed at the constraint level too",
      distinctIdempotencyKeys.rows[0]
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
    check(Number(leftover.rows[0].count) === 0, "Z) all 35 QA fixtures cleaned up, none left orphaned");

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
