// Integration tests for the mobile Administrator messaging feature —
// server/src/routes/mobileMessages.ts's new /messages/recipients and
// /messages/send routes, plus a regression check that the desktop
// server/src/routes/messages.ts route (refactored to share
// lib/employeeMessages.ts with the new mobile routes) is unaffected.
//
// SAFETY NOTE — recipientMode "all" is deliberately never exercised through
// a live HTTP send in this file. This test suite runs against the real
// shared dev database (same convention as every other *.test.ts in this
// repo) — an actual "all employees" send would push-notify and create a
// mandatory acknowledgment overlay for every real employee's real paired
// phone in the org, which is an unacceptable side effect for an automated
// test. "All employees" resolution is instead verified directly against
// lib/employeeMessages.ts's resolveRecipients("all") (a plain function
// call, no HTTP, no recipient rows ever inserted) cross-checked against a
// raw query — see check (K) below. Every live send in this file uses
// recipientMode "selected" pointed at QA-only fixture employees.
//
// Same convention as nfcTags.test.ts: real router over real HTTP against
// the real database, disposable RUN_ID-suffixed QA fixtures, one-transaction
// cleanup with a final "nothing orphaned" assertion.
//
// Run with: npm run test:mobile-messages
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { resolveRecipients } from "../lib/employeeMessages";
import mobileMessagesRouter from "./mobileMessages";
import messagesRouter from "./messages";

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
  app.use("/api/mobile", mobileMessagesRouter);
  app.use("/api/messages", messagesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function callDevice(
    method: string,
    path: string,
    deviceIdentifier: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function callSession(
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
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const messageIds: string[] = [];

  async function pairDevice(employeeId: string, label: string): Promise<string> {
    const identifier = randomUUID();
    const { rows } = await pool.query(
      `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
      [identifier, `QA Mobile Messages Device ${label} ${RUN_ID}`]
    );
    deviceIds.push(rows[0].id);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
    return identifier;
  }

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    async function createEmployee(
      label: string,
      role: string,
      opts: { active?: boolean; preferredLanguage?: string } = {}
    ): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, preferred_language)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          "QA",
          `Mobile Msg ${label} ${RUN_ID}`,
          `qa-mobile-msg-${label.toLowerCase()}-${RUN_ID}@test.local`,
          await roleId(role),
          teamRoleId,
          fakePinHash,
          opts.active ?? true,
          opts.preferredLanguage ?? null,
        ]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id as string;
    }

    const adminId = await createEmployee("Admin", "Administrator");
    const managerId = await createEmployee("Manager", "Manager");
    const employeeId = await createEmployee("Employee", "Employee", { preferredLanguage: "Spanish" });
    const targetNoDeviceId = await createEmployee("TargetNoDevice", "Employee");
    const targetWithDeviceId = await createEmployee("TargetWithDevice", "Employee");
    const inactiveTargetId = await createEmployee("Inactive", "Employee", { active: false });

    const adminDevice = await pairDevice(adminId, "admin");
    const managerDevice = await pairDevice(managerId, "manager");
    const employeeDevice = await pairDevice(employeeId, "employee");
    const targetWithDeviceDevice = await pairDevice(targetWithDeviceId, "targetWithDevice");
    // targetNoDeviceId deliberately has NO device — used for the
    // noActiveDeviceCount assertions below.

    // Unconfigured (no FIREBASE_SERVICE_ACCOUNT_JSON in this dev
    // environment — see server/.env) android_fcm registration: a real send
    // attempt hits pushDelivery.ts's "messaging not configured" branch,
    // which is fast, makes no real network call, and deterministically
    // counts as failed — exactly what's needed to test "push failed but
    // the message is still stored" (#15) without depending on any real
    // push infrastructure being reachable.
    await pool.query(
      `insert into device_push_registrations (device_id, platform, fcm_token) values ($1, 'android_fcm', $2)`,
      [deviceIds[deviceIds.length - 1], `qa-fake-fcm-token-${RUN_ID}`]
    );

    const adminToken = signSession({
      id: adminId,
      firstName: "QA",
      lastName: `Mobile Msg Admin ${RUN_ID}`,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });

    // -----------------------------------------------------------------
    // 3) Direct unauthorized route/API access is rejected.
    // -----------------------------------------------------------------
    {
      const res = await callDevice("GET", "/api/mobile/messages/recipients", employeeDevice);
      check(res.status === 403, "3) a general Employee's device is rejected from GET /messages/recipients", res.body);
    }
    {
      const res = await callDevice("POST", "/api/mobile/messages/send", employeeDevice, {
        messageText: "should be rejected",
        recipientMode: "selected",
        employeeIds: [targetNoDeviceId],
        idempotencyKey: randomUUID(),
      });
      check(res.status === 403, "3) a general Employee's device is rejected from POST /messages/send", res.body);
    }
    {
      const res = await callDevice("POST", "/api/mobile/messages/send", managerDevice, {
        messageText: "should be rejected",
        recipientMode: "selected",
        employeeIds: [targetNoDeviceId],
        idempotencyKey: randomUUID(),
      });
      check(
        res.status === 403,
        "3) a Manager's device is rejected from POST /messages/send — Messages is Administrator-only, matching desktop's POST /api/messages",
        res.body
      );
    }

    // -----------------------------------------------------------------
    // GET /messages/recipients — Administrator can list active
    // employees with device reachability.
    // -----------------------------------------------------------------
    {
      const res = await callDevice("GET", "/api/mobile/messages/recipients", adminDevice);
      check(res.status === 200, "GET /messages/recipients succeeds for an Administrator", res.body);
      const list: any[] = res.body.employees;
      const withDevice = list.find((e) => e.id === targetWithDeviceId);
      const noDevice = list.find((e) => e.id === targetNoDeviceId);
      const inactive = list.find((e) => e.id === inactiveTargetId);
      check(withDevice?.hasActiveDevice === true, "the recipient with a registered device shows hasActiveDevice: true", withDevice);
      check(noDevice?.hasActiveDevice === false, "the recipient with no device shows hasActiveDevice: false", noDevice);
      check(!inactive, "an inactive employee never appears in the recipient candidate list", inactive);
    }

    // -----------------------------------------------------------------
    // 12) Send to selected employees only. 16) recipient/device delivery
    // summary is accurate.
    // -----------------------------------------------------------------
    let firstIdempotencyKey!: string;
    {
      firstIdempotencyKey = randomUUID();
      const res = await callDevice("POST", "/api/mobile/messages/send", adminDevice, {
        messageText: `QA mobile message ${RUN_ID}`,
        recipientMode: "selected",
        employeeIds: [targetNoDeviceId, targetWithDeviceId],
        idempotencyKey: firstIdempotencyKey,
      });
      check(res.status === 201, "12) POST /messages/send to two selected employees succeeds", res.body);
      messageIds.push(res.body.messageId);
      check(res.body.recipientCount === 2, "12) recipientCount matches the two selected employees", res.body);
      check(
        res.body.recipientCount === res.body.noActiveDeviceCount + res.body.pushSucceeded + res.body.pushFailed,
        "16) recipientCount === noActiveDeviceCount + pushSucceeded + pushFailed (conservation of recipients)",
        res.body
      );
      check(res.body.noActiveDeviceCount === 1, "16) exactly the one device-less recipient is reported as no-device", res.body);
      check(res.body.pushFailed >= 1, "16) the unconfigured FCM registration counts as a push failure, not silently ignored", res.body);
    }

    // -----------------------------------------------------------------
    // 15) Stored message remains available when push delivery fails —
    // both recipients can retrieve it via GET /messages/outstanding
    // regardless of whether their own push attempt succeeded.
    // -----------------------------------------------------------------
    {
      const noDeviceOutstanding = await pool.query(
        `select emr.id from employee_message_recipients emr
         join employee_messages em on em.id = emr.message_id
         where emr.employee_id = $1 and em.id = $2`,
        [targetNoDeviceId, messageIds[0]]
      );
      check(noDeviceOutstanding.rows.length === 1, "15) the device-less recipient's message row is stored regardless of push", noDeviceOutstanding.rows);

      const withDeviceRes = await callDevice("GET", "/api/mobile/messages/outstanding", targetWithDeviceDevice);
      const found = withDeviceRes.body?.messages?.find((m: any) => m.messageId === messageIds[0]);
      check(!!found, "15) the recipient whose push failed still sees the message via the mandatory outstanding fetch", withDeviceRes.body);
      check(found?.messageText === `QA mobile message ${RUN_ID}`, "15) the stored message text is exactly what was sent", found);
    }

    // -----------------------------------------------------------------
    // 19) A Spanish-preference employee still sees the Administrator's
    // original message unchanged — sent to this employee specifically to
    // confirm no translation path touches message content.
    // -----------------------------------------------------------------
    {
      const spanishKey = randomUUID();
      const distinctiveText = `No traducir esto — QA ${RUN_ID}`;
      const res = await callDevice("POST", "/api/mobile/messages/send", adminDevice, {
        messageText: distinctiveText,
        recipientMode: "selected",
        employeeIds: [employeeId],
        idempotencyKey: spanishKey,
      });
      check(res.status === 201, "19) send to the Spanish-preference employee succeeds", res.body);
      messageIds.push(res.body.messageId);

      const outstanding = await callDevice("GET", "/api/mobile/messages/outstanding", employeeDevice);
      const found = outstanding.body?.messages?.find((m: any) => m.messageId === res.body.messageId);
      check(
        found?.messageText === distinctiveText,
        "19) the Spanish-preference employee receives the exact original text, byte-for-byte, never translated",
        found
      );
    }

    // -----------------------------------------------------------------
    // 14) No duplicate message from double taps or request retries — the
    // same idempotencyKey sent twice must never create a second message.
    // -----------------------------------------------------------------
    {
      const retryRes = await callDevice("POST", "/api/mobile/messages/send", adminDevice, {
        messageText: `QA mobile message ${RUN_ID}`,
        recipientMode: "selected",
        employeeIds: [targetNoDeviceId, targetWithDeviceId],
        idempotencyKey: firstIdempotencyKey, // same key as the very first send above
      });
      check(retryRes.status === 201, "14) a retried send with the same idempotencyKey still succeeds (not an error)", retryRes.body);
      check(retryRes.body.messageId === messageIds[0], "14) the retry resolves to the SAME message id, not a new one", retryRes.body);

      const dupCount = await pool.query(`select count(*) from employee_messages where idempotency_key = $1`, [firstIdempotencyKey]);
      check(Number(dupCount.rows[0].count) === 1, "14) exactly one employee_messages row exists for this idempotencyKey, never two", dupCount.rows);

      const dupRecipients = await pool.query(
        `select count(*) from employee_message_recipients where message_id = $1`,
        [messageIds[0]]
      );
      check(Number(dupRecipients.rows[0].count) === 2, "14) the retry did not insert duplicate recipient rows either", dupRecipients.rows);
    }

    // -----------------------------------------------------------------
    // 17) Isolation between employees — an inactive employee is never a
    // valid recipient even when explicitly requested, and one employee
    // can never see/acknowledge another employee's message (pre-existing
    // scoping in mobileMessages.ts's acknowledge route, re-confirmed
    // here since it directly bears on "isolation"). This codebase has no
    // multi-tenant/organization_id concept (single-org deployment) — this
    // is the closest verifiable analog.
    // -----------------------------------------------------------------
    {
      const res = await callDevice("POST", "/api/mobile/messages/send", adminDevice, {
        messageText: "should be rejected — inactive recipient",
        recipientMode: "selected",
        employeeIds: [inactiveTargetId],
        idempotencyKey: randomUUID(),
      });
      check(res.status === 400, "17) a deactivated employee id is rejected as a recipient, even if explicitly selected", res.body);
    }
    {
      // targetWithDeviceId's own device tries to acknowledge a recipient
      // row that belongs to targetNoDeviceId — must 404, never succeed.
      const foreignRecipient = await pool.query(
        `select id from employee_message_recipients where message_id = $1 and employee_id = $2`,
        [messageIds[0], targetNoDeviceId]
      );
      const res = await callDevice(
        "POST",
        `/api/mobile/messages/${foreignRecipient.rows[0].id}/acknowledge`,
        targetWithDeviceDevice
      );
      check(res.status === 404, "17) one employee's device cannot acknowledge a different employee's message", res.body);
    }

    // -----------------------------------------------------------------
    // 11) Send to all active employees — verified at the resolveRecipients
    // function level only, never via a live send (see the file header's
    // safety note).
    // -----------------------------------------------------------------
    {
      const resolved = await resolveRecipients("all");
      check(resolved.ok, "11) resolveRecipients('all') succeeds", resolved);
      if (resolved.ok) {
        const direct = await pool.query(`select id from employees where is_active = true`);
        const directIds = new Set(direct.rows.map((r) => r.id));
        const resolvedIds = new Set(resolved.employeeIds);
        check(
          directIds.size === resolvedIds.size && [...directIds].every((id) => resolvedIds.has(id)),
          "11) 'all' resolves to exactly every currently-active employee, matching a direct query 1:1",
          { directCount: directIds.size, resolvedCount: resolvedIds.size }
        );
        // The QA fixtures created above are themselves active employees,
        // so they must be included — confirms this isn't accidentally
        // scoped to some other subset.
        check(resolvedIds.has(adminId) && resolvedIds.has(targetNoDeviceId), "11) QA active fixtures are included in the 'all' resolution");
        check(!resolvedIds.has(inactiveTargetId), "11) the inactive QA fixture is excluded from the 'all' resolution");
      }
    }

    // -----------------------------------------------------------------
    // 20) Existing desktop messaging remains unaffected by the
    // lib/employeeMessages.ts refactor — same session-cookie auth, same
    // response shape, same selected-recipient validation, still never
    // "all" mode here for the same safety reason as above.
    // -----------------------------------------------------------------
    {
      const res = await callSession("POST", "/api/messages", adminToken, {
        messageText: `QA desktop message ${RUN_ID}`,
        recipientMode: "selected",
        employeeIds: [targetNoDeviceId],
      });
      check(res.status === 201, "20) desktop POST /api/messages still succeeds after the shared-lib refactor", res.body);
      messageIds.push(res.body.message.id);
      check(res.body.message.recipientCount === 1, "20) desktop response shape (recipientCount) is unchanged", res.body);
      check(res.body.message.status === "pending", "20) desktop response shape (status) is unchanged", res.body);

      const detail = await callSession("GET", `/api/messages/${res.body.message.id}`, adminToken);
      check(detail.status === 200, "20) desktop GET /api/messages/:id still works for a message created via the shared lib", detail.body);
      check(
        detail.body.message.recipients?.[0]?.employeeId === targetNoDeviceId,
        "20) desktop message detail shows the correct recipient",
        detail.body
      );

      const managerToken = signSession({
        id: managerId,
        firstName: "QA",
        lastName: `Mobile Msg Manager ${RUN_ID}`,
        securityRole: "Manager",
        teamRole: "Team Member",
      });
      const desktopManagerRes = await callSession("POST", "/api/messages", managerToken, {
        messageText: "should be rejected — Manager can't send on desktop either",
        recipientMode: "selected",
        employeeIds: [targetNoDeviceId],
      });
      check(
        desktopManagerRes.status === 403,
        "20) desktop POST /api/messages still rejects a Manager after the shared-lib refactor (requireRole(\"Administrator\") unchanged)",
        desktopManagerRes.body
      );
    }
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from employee_message_recipients where message_id = any($1::uuid[])`, [messageIds]);
      await client.query(`delete from employee_messages where id = any($1::uuid[])`, [messageIds]);
      await client.query(`delete from device_push_registrations where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
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

    const leftoverEmployees = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    const leftoverMessages = await pool.query(`select count(*) from employee_messages where id = any($1::uuid[])`, [messageIds]);
    check(
      Number(leftoverEmployees.rows[0].count) === 0 && Number(leftoverMessages.rows[0].count) === 0,
      "all QA fixtures cleaned up, none left orphaned"
    );

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
