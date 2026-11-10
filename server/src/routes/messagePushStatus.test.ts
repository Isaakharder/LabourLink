// Regression tests for message delivery status and push registration
// (2026-11-10 investigation: a message to an employee whose paired,
// clocked-in phone had never registered for push was reported "not
// delivered, no device" on the sender's phone and "Sent" on the web).
//
// Covers: missing devices, a paired phone with no push registration, stale
// and refreshed tokens, duplicate device records after a re-pair or
// reinstall, notifications turned off, offline phones, FCM rejection
// (permanent and transient), later retrieval, idempotent sends and
// acknowledgements, and the statuses the web and mobile screens receive.
//
// FCM is replaced by an in-process fake (pushDelivery.setFcmSenderForTesting),
// so no real push is ever sent. Same conventions as mobileMessages.test.ts:
// real routers over real HTTP against the configured database, RUN_ID-
// suffixed QA fixtures, every send uses recipientMode "selected" at those
// fixtures only, one-transaction cleanup.
//
// Run with: npm run test:message-push-status
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { sendPushForRecipients, setFcmSenderForTesting } from "../lib/pushDelivery";
import mobileMessagesRouter from "./mobileMessages";
import mobilePushRouter from "./mobilePush";
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

// Fake FCM: records every token it was asked to send to, and answers per
// token: accept, a permanent "not registered" rejection, or a transient
// server error.
const fcmCalls: string[] = [];
const fcmBehaviour = new Map<string, "accept" | "unregistered" | "transient">();
setFcmSenderForTesting(async (m) => {
  fcmCalls.push(m.token);
  const b = fcmBehaviour.get(m.token) ?? "accept";
  if (b === "unregistered") {
    throw Object.assign(new Error("Requested entity was not found."), { code: "messaging/registration-token-not-registered" });
  }
  if (b === "transient") {
    throw Object.assign(new Error("Internal error"), { code: "messaging/internal-error" });
  }
  return "projects/qa/messages/1";
});

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileMessagesRouter);
  app.use("/api/mobile", mobilePushRouter);
  app.use("/api/messages", messagesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function callDevice(method: string, path: string, deviceIdentifier: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  async function callSession(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const messageIds: string[] = [];

  const deviceRowId = new Map<string, string>(); // identifier -> devices.id
  async function pairDevice(employeeId: string, label: string): Promise<string> {
    const identifier = randomUUID();
    const { rows } = await pool.query(
      `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
      [identifier, `QA Push Status ${label} ${RUN_ID}`]
    );
    deviceIds.push(rows[0].id);
    deviceRowId.set(identifier, rows[0].id);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
    return identifier;
  }
  // Re-pair: what devices.ts's approve route does for a NEW identifier
  // (reinstall / Clear data): the old assignment ends, the old device row
  // stays active, a new device row is assigned.
  async function repairOnNewDevice(employeeId: string, label: string): Promise<string> {
    await pool.query(
      `update device_assignments set unassigned_at = now() where employee_id = $1 and unassigned_at is null`,
      [employeeId]
    );
    return pairDevice(employeeId, label);
  }
  const register = (identifier: string, token: string) =>
    callDevice("POST", "/api/mobile/push/register", identifier, { platform: "android_fcm", fcmToken: token });

  async function recipientRow(messageId: string, employeeId: string) {
    const { rows } = await pool.query(
      `select * from employee_message_recipients where message_id = $1 and employee_id = $2`,
      [messageId, employeeId]
    );
    return rows[0];
  }

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function createEmployee(label: string, role: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Push Status ${label} ${RUN_ID}`, `qa-push-status-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id as string;
    }

    const adminId = await createEmployee("Admin", "Administrator");
    const adminDevice = await pairDevice(adminId, "admin");
    const adminToken = signSession({
      id: adminId,
      firstName: "QA",
      lastName: `Push Status Admin ${RUN_ID}`,
      securityRole: "Administrator",
      teamRole: "Team Member",
    });
    const send = (employeeIds: string[], idempotencyKey = randomUUID()) =>
      callDevice("POST", "/api/mobile/messages/send", adminDevice, {
        messageText: `QA push status ${RUN_ID}`,
        recipientMode: "selected",
        employeeIds,
        idempotencyKey,
      });

    // ---------------------------------------------------------------
    // 1) Missing device: saved, honestly reported, retrievable later.
    // ---------------------------------------------------------------
    const noDeviceId = await createEmployee("NoDevice", "Employee");
    {
      const res = await send([noDeviceId]);
      messageIds.push(res.body?.messageId);
      check(res.status === 201 && res.body.saved === true, "1) message to an employee with no device is saved", res.body);
      check(res.body.notificationStatus === "no_device", "1) sender is told no registered device is available", res.body);
      check(res.body.noDeviceCount === 1 && res.body.pushAcceptedCount === 0, "1) counts are per employee", res.body);
      const row = await recipientRow(res.body.messageId, noDeviceId);
      check(row?.push_status === "no_device" && row.push_attempted_at && !row.push_sent_at, "1) recipient row records no_device", row);

      // The employee pairs a phone later (offline at send time) and fetches.
      const later = await pairDevice(noDeviceId, "nodevice-later");
      const out = await callDevice("GET", "/api/mobile/messages/outstanding", later);
      check(
        out.body?.messages?.some((m: { messageId: string }) => m.messageId === res.body.messageId),
        "1) the saved message is retrieved when the phone next fetches",
        out.body
      );
      const after = await recipientRow(res.body.messageId, noDeviceId);
      check(!!after.delivered_at && after.push_status === "no_device", "1) retrieval sets delivered_at; push outcome unchanged", after);
    }

    // ---------------------------------------------------------------
    // 2) Paired and working, but never registered for push (the
    //    2026-11-10 case): no_device, and still retrievable.
    // ---------------------------------------------------------------
    const unregisteredId = await createEmployee("PairedNoPush", "Employee");
    const unregisteredDevice = await pairDevice(unregisteredId, "paired-no-push");
    {
      const recips = await callDevice("GET", "/api/mobile/messages/recipients", adminDevice);
      const e = recips.body?.employees?.find((x: { id: string }) => x.id === unregisteredId);
      check(e && e.hasActiveDevice === false && e.pushRegistered === false, "2) picker shows a paired phone without push as not notifiable", e);
      const status = await callDevice("GET", "/api/mobile/push/status", unregisteredDevice);
      check(status.status === 200 && status.body.registered === false, "2) the phone can see it has no registration", status.body);
      const res = await send([unregisteredId]);
      messageIds.push(res.body.messageId);
      check(res.body.notificationStatus === "no_device", "2) paired-but-unregistered reports no_device", res.body);
      const out = await callDevice("GET", "/api/mobile/messages/outstanding", unregisteredDevice);
      check(out.body.messages.length === 1, "2) and the phone still retrieves it", out.body);
    }

    // ---------------------------------------------------------------
    // 3) FCM accepts: 'accepted', but never claimed as delivered.
    // ---------------------------------------------------------------
    const okId = await createEmployee("PushOk", "Employee");
    const okDevice = await pairDevice(okId, "push-ok");
    const tokenOk1 = `qa-tok-ok1-${RUN_ID}`;
    let okMessageId = "";
    {
      const r = await register(okDevice, tokenOk1);
      check(r.status === 204, "3) registration accepted", r.body);
      fcmCalls.length = 0;
      const res = await send([okId]);
      okMessageId = res.body.messageId;
      messageIds.push(okMessageId);
      check(res.body.notificationStatus === "sent" && res.body.pushAcceptedCount === 1, "3) sender told notification sent", res.body);
      check(fcmCalls.length === 1 && fcmCalls[0] === tokenOk1, "3) exactly one FCM call to the current token", fcmCalls);
      const row = await recipientRow(okMessageId, okId);
      check(row.push_status === "accepted" && !!row.push_sent_at, "3) recipient row records accepted", row);
      check(row.delivered_at === null, "3) FCM acceptance is NOT recorded as delivered to the phone", row);
    }

    // ---------------------------------------------------------------
    // 4) Idempotent registration and token refresh.
    // ---------------------------------------------------------------
    {
      const countRows = async () =>
        Number((await pool.query(`select count(*) from device_push_registrations where device_id = $1`, [deviceRowId.get(okDevice)])).rows[0].count);
      const before = await countRows();
      await register(okDevice, tokenOk1);
      await register(okDevice, tokenOk1);
      check((await countRows()) === before, "4) re-registering an unchanged token (launch/resume) adds no rows", { before });

      const tokenOk2 = `qa-tok-ok2-${RUN_ID}`;
      await register(okDevice, tokenOk2);
      const active = await pool.query(
        `select fcm_token from device_push_registrations where device_id = $1 and disabled_at is null`,
        [deviceRowId.get(okDevice)]
      );
      check(active.rows.length === 1 && active.rows[0].fcm_token === tokenOk2, "4) a refreshed token replaces the stale one", active.rows.length);
      fcmCalls.length = 0;
      const res = await send([okId]);
      messageIds.push(res.body.messageId);
      check(fcmCalls.length === 1 && fcmCalls[0] === tokenOk2, "4) sends use only the refreshed token", fcmCalls);
    }

    // ---------------------------------------------------------------
    // 5) Idempotent send replay: no duplicate message, recipient or push.
    // ---------------------------------------------------------------
    {
      const key = randomUUID();
      fcmCalls.length = 0;
      const first = await send([okId], key);
      messageIds.push(first.body.messageId);
      const second = await send([okId], key);
      check(second.status === 201 && second.body.messageId === first.body.messageId, "5) replay resolves to the same message", second.body);
      check(second.body.replayed === true && second.body.notificationStatus === "sent", "5) replay reports the recorded outcome", second.body);
      check(fcmCalls.length === 1, "5) replay never pushes a second time", fcmCalls);
      const count = await pool.query(`select count(*) from employee_messages where idempotency_key = $1`, [key]);
      const recips = await pool.query(`select count(*) from employee_message_recipients where message_id = $1`, [first.body.messageId]);
      check(Number(count.rows[0].count) === 1 && Number(recips.rows[0].count) === 1, "5) exactly one message and one recipient row");
    }

    // ---------------------------------------------------------------
    // 6) Acknowledgement is idempotent and scoped.
    // ---------------------------------------------------------------
    {
      const out = await callDevice("GET", "/api/mobile/messages/outstanding", okDevice);
      const target = out.body.messages.find((m: { messageId: string }) => m.messageId === okMessageId);
      const a1 = await callDevice("POST", `/api/mobile/messages/${target.recipientId}/acknowledge`, okDevice);
      const a2 = await callDevice("POST", `/api/mobile/messages/${target.recipientId}/acknowledge`, okDevice);
      check(a1.status === 200 && a2.status === 200 && a1.body.acknowledgedAt === a2.body.acknowledgedAt, "6) a retried acknowledge keeps the first time", [a1.body, a2.body]);
      const other = await callDevice("POST", `/api/mobile/messages/${target.recipientId}/acknowledge`, unregisteredDevice);
      check(other.status === 404, "6) another employee's phone cannot acknowledge it", other.body);
    }

    // ---------------------------------------------------------------
    // 7) Permanent FCM rejection: failed, registration disabled, and the
    //    phone re-registers (even with the same token) on its next launch.
    // ---------------------------------------------------------------
    const rejectId = await createEmployee("PushRejected", "Employee");
    const rejectDevice = await pairDevice(rejectId, "push-rejected");
    const tokenRejected = `qa-tok-rejected-${RUN_ID}`;
    {
      await register(rejectDevice, tokenRejected);
      fcmBehaviour.set(tokenRejected, "unregistered");
      const res = await send([rejectId]);
      messageIds.push(res.body.messageId);
      check(res.body.notificationStatus === "failed" && res.body.pushFailedCount === 1, "7) sender told notification delivery failed", res.body);
      const row = await recipientRow(res.body.messageId, rejectId);
      check(row.push_status === "failed" && row.push_sent_at === null, "7) recipient row records failed", row);
      const status = await callDevice("GET", "/api/mobile/push/status", rejectDevice);
      check(status.body.registered === false, "7) the disabled registration is visible to the phone", status.body);
      const out = await callDevice("GET", "/api/mobile/messages/outstanding", rejectDevice);
      check(out.body.messages.some((m: { messageId: string }) => m.messageId === res.body.messageId), "7) message still retrievable", out.body);

      fcmBehaviour.set(tokenRejected, "accept");
      await register(rejectDevice, tokenRejected);
      const status2 = await callDevice("GET", "/api/mobile/push/status", rejectDevice);
      check(status2.body.registered === true, "7) re-registering the same token restores it", status2.body);
      const res2 = await send([rejectId]);
      messageIds.push(res2.body.messageId);
      check(res2.body.notificationStatus === "sent", "7) next message is accepted again", res2.body);
    }

    // ---------------------------------------------------------------
    // 8) Transient FCM error: failed, registration kept for next time.
    // ---------------------------------------------------------------
    {
      fcmBehaviour.set(tokenRejected, "transient");
      const res = await send([rejectId]);
      messageIds.push(res.body.messageId);
      check(res.body.notificationStatus === "failed", "8) transient error reported as failed", res.body);
      const status = await callDevice("GET", "/api/mobile/push/status", rejectDevice);
      check(status.body.registered === true, "8) a transient error never removes the registration", status.body);

      // Never downgrade: once accepted on a retry, a later failure for the
      // same message does not flip it back.
      fcmBehaviour.set(tokenRejected, "accept");
      await sendPushForRecipients(res.body.messageId, [rejectId]);
      fcmBehaviour.set(tokenRejected, "transient");
      await sendPushForRecipients(res.body.messageId, [rejectId]);
      const row = await recipientRow(res.body.messageId, rejectId);
      check(row.push_status === "accepted", "8) an accepted outcome is never downgraded by a later failure", row);
      fcmBehaviour.set(tokenRejected, "accept");
    }

    // ---------------------------------------------------------------
    // 9) Duplicate device records: reinstall / re-pair under a new
    //    identifier. The old device row stays active with its old token.
    // ---------------------------------------------------------------
    const repairId = await createEmployee("Repaired", "Employee");
    const oldDevice = await pairDevice(repairId, "repair-old");
    const tokenOld = `qa-tok-old-install-${RUN_ID}`;
    {
      await register(oldDevice, tokenOld);
      const newDevice = await repairOnNewDevice(repairId, "repair-new");

      // 9a) New install has not registered yet: no_device even though the
      //     old row still holds an active token.
      fcmCalls.length = 0;
      const r1 = await send([repairId]);
      messageIds.push(r1.body.messageId);
      check(r1.body.notificationStatus === "no_device" && fcmCalls.length === 0, "9a) a stale token on an unassigned old device is never used", { body: r1.body, fcmCalls });

      // 9b) Reinstall with a NEW token: only the new device is notified.
      const tokenNew = `qa-tok-new-install-${RUN_ID}`;
      await register(newDevice, tokenNew);
      fcmCalls.length = 0;
      const r2 = await send([repairId]);
      messageIds.push(r2.body.messageId);
      check(r2.body.notificationStatus === "sent" && fcmCalls.join() === tokenNew, "9b) the newer device is used, never the stale one", fcmCalls);

      // 9c) Same token re-appearing on a different device row (phone
      //     re-paired under a new identifier without a token change): the
      //     old row's copy is disabled so it can't notify whoever that old
      //     row is later assigned to.
      const otherId = await createEmployee("Reassigned", "Employee");
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRowId.get(oldDevice), otherId]);
      await register(newDevice, tokenOld);
      const oldActive = await pool.query(
        `select count(*) from device_push_registrations where device_id = $1 and disabled_at is null`,
        [deviceRowId.get(oldDevice)]
      );
      check(Number(oldActive.rows[0].count) === 0, "9c) the same token on an older device row is disabled");
      fcmCalls.length = 0;
      const r3 = await send([otherId]);
      messageIds.push(r3.body.messageId);
      check(r3.body.notificationStatus === "no_device" && fcmCalls.length === 0, "9c) the old row's new owner is not notified on this phone", { body: r3.body, fcmCalls });
    }

    // ---------------------------------------------------------------
    // 10) Notifications turned off on the phone -> unregister -> no_device.
    // ---------------------------------------------------------------
    {
      const off = await callDevice("POST", "/api/mobile/push/unregister", okDevice);
      check(off.status === 204, "10) unregister accepted", off.body);
      const res = await send([okId]);
      messageIds.push(res.body.messageId);
      check(res.body.notificationStatus === "no_device", "10) disabled notifications report no registered device", res.body);
    }

    // ---------------------------------------------------------------
    // 11) Mixed recipients, and the desktop (web) view of each stage.
    // ---------------------------------------------------------------
    {
      const res = await send([noDeviceId, rejectId]);
      messageIds.push(res.body.messageId);
      check(res.body.notificationStatus === "partial", "11) mixed outcomes are reported as partial", res.body);

      const list = await callSession("GET", "/api/messages", adminToken);
      const summary = list.body.messages.find((m: { id: string }) => m.id === res.body.messageId);
      check(
        summary && summary.pushAcceptedCount === 1 && summary.pushNoDeviceCount === 1 && summary.pushFailedCount === 0 &&
          summary.retrievedCount === 0 && summary.status === "pending",
        "11) web list separates push outcome, retrieval and acknowledgement",
        summary
      );
      const detail = await callSession("GET", `/api/messages/${res.body.messageId}`, adminToken);
      const byId = new Map(detail.body.message.recipients.map((r: { employeeId: string }) => [r.employeeId, r]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nd = byId.get(noDeviceId) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = byId.get(rejectId) as any;
      check(nd.pushStatus === "no_device" && !!nd.savedAt && nd.deliveredAt === null, "11) web detail: saved, no device, not retrieved", nd);
      check(ok.pushStatus === "accepted" && ok.deliveredAt === null && ok.acknowledgedAt === null, "11) web detail: accepted is not shown as retrieved", ok);
    }

    // ---------------------------------------------------------------
    // 12) Desktop send (fire-and-forget push) records outcomes too.
    // ---------------------------------------------------------------
    {
      const res = await callSession("POST", "/api/messages", adminToken, {
        messageText: `QA desktop push status ${RUN_ID}`,
        recipientMode: "selected",
        employeeIds: [unregisteredId],
      });
      const id = res.body?.message?.id;
      messageIds.push(id);
      let row = null;
      for (let i = 0; i < 50 && !row?.push_status; i++) {
        row = await recipientRow(id, unregisteredId);
        if (!row?.push_status) await new Promise((r) => setTimeout(r, 100));
      }
      check(row?.push_status === "no_device", "12) desktop sends record the push outcome", row);
    }
  } finally {
    server.close();
    setFcmSenderForTesting(null);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const ids = messageIds.filter(Boolean);
      await client.query(`delete from employee_message_recipients where message_id = any($1::uuid[])`, [ids]);
      await client.query(`delete from employee_messages where id = any($1::uuid[])`, [ids]);
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
    const leftover = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    check(Number(leftover.rows[0].count) === 0, "all QA fixtures cleaned up");
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
