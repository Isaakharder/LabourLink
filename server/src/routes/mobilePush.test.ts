import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { loadActiveRegistrations, sendPushForRecipients } from "../lib/pushDelivery";
import mobilePushRouter from "./mobilePush";

// POST /api/mobile/push/register for all three platforms — including the
// iOS app's 'ios_apns' — and the delivery-side read of what was stored.
// Requires a migrated LOCAL database (DATABASE_URL); creates its own QA
// employee/device and removes them at the end.

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
const APNS_TOKEN = "A1B2C3D4".repeat(8);

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/mobile", mobilePushRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let employeeId: string | null = null;
  let deviceId: string | null = null;
  const identifier = randomUUID();

  async function register(body: unknown) {
    const res = await fetch(`${BASE}/api/mobile/push/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": identifier },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }
  async function activeRows() {
    const { rows } = await pool.query(
      `select platform, fcm_token, web_push_endpoint, apns_token, apns_environment
       from device_push_registrations where device_id = $1 and disabled_at is null`,
      [deviceId]
    );
    return rows;
  }

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0]?.id
      ?? (await pool.query(`select id from security_roles order by name limit 1`)).rows[0].id;
    employeeId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active)
         values ('QA', $1, $2, $3, $4, true) returning id`,
        [`Push ${RUN_ID}`, `qa-push-${RUN_ID}@test.local`, roleId, teamRoleId]
      )
    ).rows[0].id;
    deviceId = (
      await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [identifier, `QA Push Device ${RUN_ID}`]
      )
    ).rows[0].id;
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceId, employeeId]);

    // --- validation ---
    const unknown = await register({ platform: "ios", apnsToken: APNS_TOKEN });
    check(unknown.status === 400, "unknown platform is rejected", unknown);
    const missing = await register({ platform: "ios_apns" });
    check(missing.status === 400, "ios_apns without a token is rejected", missing);
    const notHex = await register({ platform: "ios_apns", apnsToken: "not-a-hex-token-zzzzzzzzzzzzzzzzzzzzzzzzzz" });
    check(notHex.status === 400, "non-hex APNs token is rejected", notHex);
    const fcmField = await register({ platform: "ios_apns", fcmToken: APNS_TOKEN });
    check(fcmField.status === 400, "an iOS token sent in the FCM field is rejected", fcmField);

    // --- iOS registration ---
    const ios = await register({ platform: "ios_apns", apnsToken: APNS_TOKEN });
    check(ios.status === 204, "ios_apns registers", ios);
    let rows = await activeRows();
    check(rows.length === 1 && rows[0].platform === "ios_apns", "one active ios_apns row", rows);
    check(rows[0]?.apns_token === APNS_TOKEN.toLowerCase(), "APNs token stored lowercase", rows[0]);
    check(rows[0]?.fcm_token === null && rows[0]?.apns_environment === null, "no FCM token, environment unknown yet", rows[0]);

    const regs = await loadActiveRegistrations([employeeId!]);
    check(
      regs.length === 1 && regs[0].platform === "ios_apns" && regs[0].apnsToken === APNS_TOKEN.toLowerCase(),
      "delivery sees the iOS registration",
      regs
    );

    // With no APNs credentials configured, a send fails without disabling the device.
    const apnsEnv = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"].some((k) => process.env[k]);
    if (!apnsEnv) {
      const summary = await sendPushForRecipients(randomUUID(), [employeeId!]);
      check(summary.attempted === 1 && summary.failed === 1, "unconfigured APNs counts as a failed send", summary);
      rows = await activeRows();
      check(rows.length === 1, "unconfigured APNs never disables the registration", rows);
    }

    // --- switching platforms keeps exactly one active row (unchanged behaviour) ---
    const android = await register({ platform: "android_fcm", fcmToken: "fcm-token-qa" });
    check(android.status === 204, "android_fcm still registers", android);
    rows = await activeRows();
    check(rows.length === 1 && rows[0].platform === "android_fcm" && rows[0].apns_token === null, "re-register replaces the iOS row", rows);

    const web = await register({
      platform: "web_push",
      subscription: { endpoint: "https://push.example.test/qa", keys: { p256dh: "p", auth: "a" } },
    });
    check(web.status === 204, "web_push still registers", web);
    rows = await activeRows();
    check(rows.length === 1 && rows[0].platform === "web_push", "web_push replaces the Android row", rows);

    // --- the DB itself refuses a malformed ios_apns row ---
    let rejected = false;
    try {
      await pool.query(`insert into device_push_registrations (device_id, platform, fcm_token, disabled_at) values ($1, 'ios_apns', 'x', now())`, [deviceId]);
    } catch {
      rejected = true;
    }
    check(rejected, "DB constraint rejects ios_apns without apns_token");
  } finally {
    server.close();
    if (deviceId) {
      await pool.query(`delete from device_push_registrations where device_id = $1`, [deviceId]);
      await pool.query(`delete from device_assignments where device_id = $1`, [deviceId]);
      await pool.query(`delete from devices where id = $1`, [deviceId]);
    }
    if (employeeId) await pool.query(`delete from employees where id = $1`, [employeeId]);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
