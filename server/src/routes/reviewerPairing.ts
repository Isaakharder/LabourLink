// App-store reviewer access (see migrations/058_reviewer_pairing.sql).
//
// LabourLink is single-tenant, so reviewers never touch the production
// instance's data: the "demo organization" is a separate deployment of this
// same API with its own database of fictional records. A reviewer phone:
//   1. asks the PRODUCTION API where the demo API is
//      (GET /api/pairing/reviewer-target — returns only a public URL), then
//   2. redeems a reviewer code against the DEMO API
//      (POST /api/pairing/reviewer), and from then on sends every request to
//      the demo API only (web/src/lib/apiTarget.ts).
//
// The normal pairing flow (6-digit code, admin approval, 10-minute expiry —
// routes/pairing.ts and devices.ts) is untouched on every instance.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import {
  configuredDemoApiUrl,
  hasDemoInstanceMarker,
  hashReviewerCode,
  isDemoInstanceEnabled,
  normalizeReviewerCode,
} from "../lib/demoInstance";
import { fingerprintDeviceIdentifier } from "../middleware/device";

const router = Router();

export const REVIEWER_WELCOME_MESSAGE =
  "Welcome to the LabourLink demo. Everyone and everything here is fictional sample data. " +
  "Tap Choose a job and pick a job (Picking asks for a row and a cart). Tap the job name to switch jobs, " +
  "use Start Break and End Break, then End Work. Tap Acknowledge to close this message.";

// Failed-code throttle, instance-wide. Reviewer codes carry ~59 bits of
// entropy, so this is defence in depth against a runaway client rather than
// the main protection. Resets on restart, which is fine for that purpose.
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 30;
let failureWindowStart = 0;
let failuresInWindow = 0;

function throttled(now: number): boolean {
  if (now - failureWindowStart > FAILURE_WINDOW_MS) {
    failureWindowStart = now;
    failuresInWindow = 0;
  }
  return failuresInWindow >= MAX_FAILURES_PER_WINDOW;
}

export function _resetReviewerThrottleForTests(): void {
  failureWindowStart = 0;
  failuresInWindow = 0;
}

router.get("/reviewer-target", (_req, res) => {
  // A demo instance never points at another one.
  const apiUrl = isDemoInstanceEnabled() ? null : configuredDemoApiUrl();
  if (!apiUrl) return res.status(404).json({ error: "Reviewer access is not available", code: "REVIEWER_ACCESS_UNAVAILABLE" });
  res.json({ apiUrl });
});

router.post(
  "/reviewer",
  asyncHandler(async (req, res) => {
    // Checked before touching the database at all: on any instance not
    // explicitly started as a demo instance this endpoint does not exist.
    if (!isDemoInstanceEnabled()) {
      return res.status(404).json({ error: "Not found" });
    }

    const { deviceIdentifier, code } = req.body as { deviceIdentifier?: unknown; code?: unknown };
    if (typeof deviceIdentifier !== "string" || deviceIdentifier.length < 8 || deviceIdentifier.length > 200) {
      return res.status(400).json({ error: "deviceIdentifier is required" });
    }
    if (typeof code !== "string" || code.length > 100) {
      return res.status(400).json({ error: "An access code is required", code: "INVALID_REVIEWER_CODE" });
    }

    if (throttled(Date.now())) {
      return res.status(429).json({ error: "Too many attempts. Wait a minute and try again.", code: "REVIEWER_CODE_THROTTLED" });
    }

    if (!(await hasDemoInstanceMarker(pool))) {
      console.error("[reviewer-pairing] LABOURLINK_DEMO_INSTANCE=true but this database has no demo_instance row — refusing");
      return res.status(404).json({ error: "Not found" });
    }

    const fingerprint = fingerprintDeviceIdentifier(deviceIdentifier);
    const normalized = normalizeReviewerCode(code);

    const client = await pool.connect();
    try {
      await client.query("begin");
      // Serializes reviewer pairings so device counting and reviewer
      // numbering can't race between two phones redeeming at once.
      await client.query("select pg_advisory_xact_lock(hashtext('labourlink_reviewer_pairing'))");

      const credRow = await client.query(
        `select id, max_devices from reviewer_pairing_credentials
         where code_hash = $1 and revoked_at is null`,
        [hashReviewerCode(normalized)]
      );
      const credential = credRow.rows[0] as { id: string; max_devices: number } | undefined;
      if (!credential) {
        await client.query("rollback");
        failuresInWindow++;
        console.warn(`[reviewer-pairing] rejected device=${fingerprint} code=INVALID_REVIEWER_CODE`);
        return res.status(401).json({ error: "That access code is not valid.", code: "INVALID_REVIEWER_CODE" });
      }

      const existing = await client.query(
        `select d.id, d.is_active, e.first_name, e.last_name
         from devices d
         left join device_assignments da on da.device_id = d.id and da.unassigned_at is null
         left join employees e on e.id = da.employee_id
         where d.device_identifier = $1`,
        [deviceIdentifier]
      );
      const device = existing.rows[0] as
        | { id: string; is_active: boolean; first_name: string | null; last_name: string | null }
        | undefined;

      if (device && !device.is_active) {
        await client.query("rollback");
        console.warn(`[reviewer-pairing] rejected device=${fingerprint} code=DEVICE_INACTIVE`);
        return res.status(403).json({ error: "This device has been deactivated.", code: "DEVICE_INACTIVE" });
      }
      if (device && device.first_name !== null) {
        // Already paired (the reviewer entered the code again) — idempotent.
        await client.query("commit");
        return res.json({ paired: true, employee: { firstName: device.first_name, lastName: device.last_name } });
      }

      if (!device) {
        const used = await client.query(
          `select count(*)::int as n from devices where paired_via_reviewer_credential_id = $1`,
          [credential.id]
        );
        if (used.rows[0].n >= credential.max_devices) {
          await client.query("rollback");
          console.warn(`[reviewer-pairing] rejected device=${fingerprint} code=REVIEWER_CODE_DEVICE_LIMIT`);
          return res
            .status(403)
            .json({ error: "This access code has reached its device limit.", code: "REVIEWER_CODE_DEVICE_LIMIT" });
        }
      }

      // One active device per employee (migration 033), so every reviewer
      // device gets its own fictional reviewer employee. Administrator role
      // so the reviewer can reach every screen in the app, including
      // Administrator Tools (employee list, sending messages, NFC tag tools)
      // — all of it scoped to this demo database. No email or PIN, so it
      // has no web-dashboard login.
      const numberRow = await client.query(
        `select coalesce(max(substring(employee_number from 5)::int), 0) + 1 as n
         from employees where employee_number ~ '^REV-[0-9]+$'`
      );
      const n: number = numberRow.rows[0].n;
      const employeeNumber = `REV-${String(n).padStart(4, "0")}`;
      const lastName = `Reviewer ${n}`;

      const employee = await client.query(
        `insert into employees (first_name, last_name, employee_number, security_role_id, team_role_id,
                                preferred_language, break_profile_id, employee_group_id, start_date, notes)
         values ('Demo', $1, $2,
                 (select id from security_roles where name = 'Administrator'),
                 (select id from team_roles where name = 'Team Member'),
                 'English',
                 (select id from break_profiles where is_active order by created_at limit 1),
                 (select id from employee_groups where name = 'Reviewers' limit 1),
                 current_date,
                 'Fictional account created automatically for app review.')
         returning id`,
        [lastName, employeeNumber]
      );
      const employeeId: string = employee.rows[0].id;

      await client.query(
        `insert into employee_activity_group_assignments (employee_id, activity_group_id)
         select $1, id from activity_groups where is_active`,
        [employeeId]
      );

      let deviceId: string;
      if (device) {
        deviceId = device.id;
        await client.query(
          `update devices set paired_via_reviewer_credential_id = $2, date_paired = now(), last_seen = now()
           where id = $1`,
          [deviceId, credential.id]
        );
      } else {
        const inserted = await client.query(
          `insert into devices (device_identifier, device_name, is_active, date_paired, last_seen,
                                paired_via_reviewer_credential_id)
           values ($1, $2, true, now(), now(), $3)
           returning id`,
          [deviceIdentifier, `Reviewer device ${n}`, credential.id]
        );
        deviceId = inserted.rows[0].id;
      }
      await client.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [
        deviceId,
        employeeId,
      ]);

      const sender = await client.query(
        `select e.id from employees e join security_roles sr on sr.id = e.security_role_id
         where sr.name = 'Administrator' and e.is_active and e.employee_number not like 'REV-%'
         order by e.created_at limit 1`
      );
      if (sender.rows[0]) {
        const message = await client.query(
          `insert into employee_messages (message_text, created_by_employee_id) values ($1, $2) returning id`,
          [REVIEWER_WELCOME_MESSAGE, sender.rows[0].id]
        );
        await client.query(`insert into employee_message_recipients (message_id, employee_id) values ($1, $2)`, [
          message.rows[0].id,
          employeeId,
        ]);
      }

      await client.query(`update reviewer_pairing_credentials set last_used_at = now() where id = $1`, [credential.id]);
      await client.query("commit");

      console.log(`[reviewer-pairing] device=${fingerprint} paired to ${employeeNumber} via credential=${credential.id}`);
      res.json({ paired: true, employee: { firstName: "Demo", lastName } });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

export default router;
