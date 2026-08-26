// Real-HTTP-against-real-database coverage for work-permit tracking:
// employees.ts's PATCH/POST extensions (server-side 6-month default,
// history on every expiry change, clearing expiry, DB constraints),
// workPermits.ts's acknowledge/renew/cancel-alert/history routes, and
// dashboard.ts's GET /work-permit-alerts (notification window, weekly
// recurrence, inactive-employee exclusion, sorting, permissions). See
// workPermits.test.ts for the pure date/severity math this all builds on.
//
// Run with: npm run test:work-permits-routes
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { calendarDateInAppTimezone, addDaysToDateStr } from "../lib/timezone";
import employeesRouter from "./employees";
import workPermitsRouter from "./workPermits";
import dashboardRouter from "./dashboard";

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
const TODAY = calendarDateInAppTimezone(new Date());

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employees", employeesRouter);
  app.use("/api/employees", workPermitsRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const employeeIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function makeEmployee(label: string, role: string, isActive = true): Promise<string> {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, $6) returning id`,
          [`Work Permit ${label} ${RUN_ID}`, `qa-work-permit-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash, isActive]
        )
      ).rows[0].id;
      employeeIds.push(id);
      return id;
    }

    const adminId = await makeEmployee("Admin", "Administrator");
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: `Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });
    const managerId = await makeEmployee("Manager", "Manager");
    const managerToken = signSession({ id: managerId, firstName: "QA", lastName: `Manager ${RUN_ID}`, securityRole: "Manager", teamRole: "Team Member" });
    const plainEmployeeId = await makeEmployee("Plain", "Employee");
    const plainToken = signSession({ id: plainEmployeeId, firstName: "QA", lastName: `Plain ${RUN_ID}`, securityRole: "Employee", teamRole: "Team Member" });

    // =====================================================================
    // 1) Server-side 6-month default when an expiry is entered with no lead
    // =====================================================================
    const targetA = await makeEmployee("TargetA", "Employee");
    const expiryFar = addDaysToDateStr(TODAY, 400);
    {
      const res = await call("PATCH", `/api/employees/${targetA}`, { token: adminToken, body: { workPermitExpiryDate: expiryFar } });
      check(res.status === 200, "1) setting an expiry date with no lead succeeds", res.body);
      check(res.body?.employee?.workPermitNotifyLeadMonths === 6, "1b) server defaults the lead to 6 months", res.body?.employee);
      check(res.body?.employee?.workPermitNotifyLeadDays === null, "1c) days stays null when the month default applies", res.body?.employee);
    }

    // =====================================================================
    // 2) Explicit month preset and explicit custom days are both honored
    // =====================================================================
    const targetB = await makeEmployee("TargetB", "Employee");
    {
      const res = await call("PATCH", `/api/employees/${targetB}`, {
        token: adminToken,
        body: { workPermitExpiryDate: expiryFar, workPermitNotifyLeadMonths: 3 },
      });
      check(res.body?.employee?.workPermitNotifyLeadMonths === 3, "2) an explicit month preset is honored, not defaulted", res.body?.employee);
    }
    const targetC = await makeEmployee("TargetC", "Employee");
    {
      const res = await call("PATCH", `/api/employees/${targetC}`, {
        token: adminToken,
        body: { workPermitExpiryDate: expiryFar, workPermitNotifyLeadDays: 45 },
      });
      check(res.body?.employee?.workPermitNotifyLeadDays === 45, "2b) an explicit custom day count is honored", res.body?.employee);
      check(res.body?.employee?.workPermitNotifyLeadMonths === null, "2c) months stays null when custom days is used", res.body?.employee);
    }

    // =====================================================================
    // 3) Mutual exclusivity and day-range validation (application layer)
    // =====================================================================
    {
      const res = await call("PATCH", `/api/employees/${targetC}`, {
        token: adminToken,
        body: { workPermitExpiryDate: expiryFar, workPermitNotifyLeadMonths: 6, workPermitNotifyLeadDays: 45 },
      });
      check(res.status === 400, "3) months and custom days together is rejected (400)", res.body);
    }
    {
      const res = await call("PATCH", `/api/employees/${targetC}`, {
        token: adminToken,
        body: { workPermitExpiryDate: expiryFar, workPermitNotifyLeadDays: 0 },
      });
      check(res.status === 400, "3b) zero custom days is rejected", res.body);
    }
    {
      const res = await call("PATCH", `/api/employees/${targetC}`, {
        token: adminToken,
        body: { workPermitExpiryDate: expiryFar, workPermitNotifyLeadDays: 3651 },
      });
      check(res.status === 400, "3c) an absurdly large custom day count (3651) is rejected", res.body);
    }

    // =====================================================================
    // 3d) Database-level validation — a raw SQL write bypassing the route
    //     entirely must ALSO be rejected (defense in depth, not only
    //     application validation).
    // =====================================================================
    {
      let rejected = false;
      try {
        await pool.query(
          `update employees set work_permit_expiry_date = $1, work_permit_notify_lead_months = 6, work_permit_notify_lead_days = 45 where id = $2`,
          [expiryFar, targetC]
        );
      } catch {
        rejected = true;
      }
      check(rejected, "3d) a raw SQL write with both months and days set is rejected by the DB constraint", rejected);
    }
    {
      let rejected = false;
      try {
        await pool.query(`update employees set work_permit_notify_lead_days = -5 where id = $1`, [targetC]);
      } catch {
        rejected = true;
      }
      check(rejected, "3e) a raw SQL write with a negative custom day count is rejected by the DB constraint", rejected);
    }

    // =====================================================================
    // 4) History: first-time set, correction (either direction), clearing
    // =====================================================================
    const targetD = await makeEmployee("TargetD", "Employee");
    const firstExpiry = addDaysToDateStr(TODAY, 400);
    await call("PATCH", `/api/employees/${targetD}`, { token: adminToken, body: { workPermitExpiryDate: firstExpiry } });
    {
      const hist = await call("GET", `/api/employees/${targetD}/history`, { token: adminToken });
      check(hist.body?.history?.length === 1, "4) first-time expiry set writes exactly one history row", hist.body);
      check(hist.body?.history?.[0]?.oldExpiryDate === null && hist.body?.history?.[0]?.newExpiryDate === firstExpiry, "4b) history row is null -> firstExpiry", hist.body?.history?.[0]);
    }
    // Ordinary profile editing may correct EARLIER — not just later.
    const earlierExpiry = addDaysToDateStr(firstExpiry, -10);
    await call("PATCH", `/api/employees/${targetD}`, { token: adminToken, body: { workPermitExpiryDate: earlierExpiry } });
    {
      const hist = await call("GET", `/api/employees/${targetD}/history`, { token: adminToken });
      check(hist.body?.history?.length === 2, "5) correcting the date via ordinary editing (earlier) writes a second history row", hist.body?.history);
      check(hist.body?.history?.[0]?.oldExpiryDate === firstExpiry && hist.body?.history?.[0]?.newExpiryDate === earlierExpiry, "5b) most recent history row reflects firstExpiry -> earlierExpiry", hist.body?.history?.[0]);
    }
    // Clearing stops alerts and records old -> null.
    await call("PATCH", `/api/employees/${targetD}`, { token: adminToken, body: { workPermitExpiryDate: null } });
    {
      const getRes = await call("GET", `/api/employees/${targetD}`, { token: adminToken });
      check(getRes.body?.employee?.workPermitExpiryDate === null, "6) clearing the expiry date nulls it out", getRes.body?.employee);
      check(getRes.body?.employee?.workPermitNotifyLeadMonths === null && getRes.body?.employee?.workPermitNotifyLeadDays === null, "6b) clearing also clears both lead fields", getRes.body?.employee);
      const hist = await call("GET", `/api/employees/${targetD}/history`, { token: adminToken });
      check(hist.body?.history?.[0]?.oldExpiryDate === earlierExpiry && hist.body?.history?.[0]?.newExpiryDate === null, "6c) clearing writes an audited old -> null history record", hist.body?.history?.[0]);
    }

    // =====================================================================
    // 7) Renewed: must be strictly later than the current expiry
    // =====================================================================
    const targetE = await makeEmployee("TargetE", "Employee");
    const renewBase = addDaysToDateStr(TODAY, 100);
    await call("PATCH", `/api/employees/${targetE}`, { token: adminToken, body: { workPermitExpiryDate: renewBase } });
    {
      const sameDate = await call("POST", `/api/employees/${targetE}/renew`, { token: adminToken, body: { newExpiryDate: renewBase } });
      check(sameDate.status === 422, "7) renewing to the SAME date is rejected", sameDate.body);
      const earlierDate = await call("POST", `/api/employees/${targetE}/renew`, { token: adminToken, body: { newExpiryDate: addDaysToDateStr(renewBase, -1) } });
      check(earlierDate.status === 422, "7b) renewing to an EARLIER date is rejected", earlierDate.body);
    }
    const renewedDate = addDaysToDateStr(renewBase, 365);
    {
      const res = await call("POST", `/api/employees/${targetE}/renew`, { token: adminToken, body: { newExpiryDate: renewedDate, reason: "New permit issued" } });
      check(res.status === 200, "8) a valid later renewal succeeds", res.body);
      const getRes = await call("GET", `/api/employees/${targetE}`, { token: adminToken });
      check(getRes.body?.employee?.workPermitExpiryDate === renewedDate, "8b) the employee's expiry date is updated", getRes.body?.employee);
      const hist = await call("GET", `/api/employees/${targetE}/history`, { token: adminToken });
      check(hist.body?.history?.[0]?.oldExpiryDate === renewBase && hist.body?.history?.[0]?.newExpiryDate === renewedDate, "8c) the previous expiry date is preserved in history", hist.body?.history?.[0]);
    }
    {
      const targetNoExpiry = await makeEmployee("TargetNoExpiry", "Employee");
      const res = await call("POST", `/api/employees/${targetNoExpiry}/renew`, { token: adminToken, body: { newExpiryDate: addDaysToDateStr(TODAY, 30) } });
      check(res.status === 409, "9) renewing an employee with no current expiry date is rejected", res.body);
    }

    // =====================================================================
    // 10) Permissions — Manager CAN act (unlike general employee editing,
    //     which is Administrator-only), plain Employee CANNOT
    // =====================================================================
    const targetPerm = await makeEmployee("TargetPerm", "Employee");
    await call("PATCH", `/api/employees/${targetPerm}`, { token: adminToken, body: { workPermitExpiryDate: addDaysToDateStr(TODAY, 10) } });
    {
      const ackByManager = await call("POST", `/api/employees/${targetPerm}/acknowledge`, { token: managerToken });
      check(ackByManager.status === 200, "10) a Manager CAN acknowledge a permit alert", ackByManager.body);
      const ackByPlain = await call("POST", `/api/employees/${targetPerm}/acknowledge`, { token: plainToken });
      check(ackByPlain.status === 403, "10b) a plain Employee CANNOT acknowledge a permit alert", ackByPlain.body);
      const cancelByPlain = await call("POST", `/api/employees/${targetPerm}/cancel-alert`, { token: plainToken });
      check(cancelByPlain.status === 403, "10c) a plain Employee CANNOT cancel a permit alert", cancelByPlain.body);
      const renewByPlain = await call("POST", `/api/employees/${targetPerm}/renew`, { token: plainToken, body: { newExpiryDate: addDaysToDateStr(TODAY, 200) } });
      check(renewByPlain.status === 403, "10d) a plain Employee CANNOT renew a permit", renewByPlain.body);
      const historyByPlain = await call("GET", `/api/employees/${targetPerm}/history`, { token: plainToken });
      check(historyByPlain.status === 403, "10e) a plain Employee CANNOT view permit history", historyByPlain.body);
      const alertsByPlain = await call("GET", `/api/dashboard/work-permit-alerts`, { token: plainToken });
      check(alertsByPlain.status === 403, "10f) a plain Employee CANNOT view the Dashboard work-permit-alerts endpoint", alertsByPlain.body);
    }

    // =====================================================================
    // 11) Acknowledge is idempotent within the 7-day snooze window —
    //     repeated/double-click/multi-tab requests never duplicate rows
    // =====================================================================
    const targetAck = await makeEmployee("TargetAck", "Employee");
    await call("PATCH", `/api/employees/${targetAck}`, { token: adminToken, body: { workPermitExpiryDate: addDaysToDateStr(TODAY, 10) } });
    {
      const first = await call("POST", `/api/employees/${targetAck}/acknowledge`, { token: adminToken });
      const second = await call("POST", `/api/employees/${targetAck}/acknowledge`, { token: adminToken });
      check(first.body?.id === second.body?.id, "11) a second Acknowledge within 7 days returns the SAME row, not a new one", { first: first.body, second: second.body });

      // Real concurrent duplicate-tab race — two requests fired together.
      const [raceA, raceB] = await Promise.all([
        call("POST", `/api/employees/${targetAck}/acknowledge`, { token: adminToken }),
        call("POST", `/api/employees/${targetAck}/acknowledge`, { token: adminToken }),
      ]);
      check(raceA.status === 200 && raceB.status === 200, "11b) two concurrent Acknowledge requests both succeed", { raceA: raceA.status, raceB: raceB.status });

      const countRes = await pool.query(`select count(*)::int as c from work_permit_alert_acknowledgements where employee_id = $1`, [targetAck]);
      check(countRes.rows[0].c === 1, "11c) exactly one acknowledgement row exists after repeated/concurrent requests within the snooze window", countRes.rows[0]);
    }

    // =====================================================================
    // 12) Weekly recurrence: an acknowledgement older than 7 days no
    //     longer snoozes — a fresh Acknowledge call creates a NEW row
    // =====================================================================
    {
      const currentExpiry = (await call("GET", `/api/employees/${targetAck}`, { token: adminToken })).body.employee.workPermitExpiryDate;
      await pool.query(
        `update work_permit_alert_acknowledgements set acknowledged_at = now() - interval '8 days' where employee_id = $1`,
        [targetAck]
      );
      const res = await call("POST", `/api/employees/${targetAck}/acknowledge`, { token: adminToken });
      check(res.status === 200, "12) acknowledging again after the snooze has lapsed succeeds", res.body);
      const countRes = await pool.query(`select count(*)::int as c from work_permit_alert_acknowledgements where employee_id = $1 and expiry_date = $2`, [targetAck, currentExpiry]);
      check(countRes.rows[0].c === 2, "12b) a genuinely new acknowledgement row is created once the 7-day window has passed", countRes.rows[0]);
    }

    // =====================================================================
    // 13) Cancel: scoped to the current expiry-date version, idempotent,
    //     and a later expiry-date change starts a new alert cycle
    // =====================================================================
    const targetCancel = await makeEmployee("TargetCancel", "Employee");
    const cancelExpiry1 = addDaysToDateStr(TODAY, 10);
    await call("PATCH", `/api/employees/${targetCancel}`, { token: adminToken, body: { workPermitExpiryDate: cancelExpiry1 } });
    {
      const res = await call("POST", `/api/employees/${targetCancel}/cancel-alert`, { token: adminToken, body: { reason: "Confirmed already renewed elsewhere" } });
      check(res.status === 200, "13) cancelling an alert succeeds", res.body);
      const again = await call("POST", `/api/employees/${targetCancel}/cancel-alert`, { token: adminToken, body: {} });
      check(again.status === 200, "13b) cancelling the same version again is a harmless no-op (idempotent)", again.body);
      const countRes = await pool.query(`select count(*)::int as c from work_permit_alert_cancellations where employee_id = $1`, [targetCancel]);
      check(countRes.rows[0].c === 1, "13c) exactly one cancellation row exists after a repeated cancel", countRes.rows[0]);
    }
    {
      // The employee is now cancelled for cancelExpiry1 — confirm it's
      // absent from the alert list, THEN change the expiry date and
      // confirm a fresh alert cycle starts automatically.
      const before = await call("GET", `/api/dashboard/work-permit-alerts`, { token: adminToken });
      check(!before.body.alerts.some((a: any) => a.employeeId === targetCancel), "14) a cancelled alert does not appear on the Dashboard", before.body.alerts);

      const newExpiry2 = addDaysToDateStr(cancelExpiry1, 5);
      await call("PATCH", `/api/employees/${targetCancel}`, { token: adminToken, body: { workPermitExpiryDate: newExpiry2 } });
      const after = await call("GET", `/api/dashboard/work-permit-alerts`, { token: adminToken });
      check(after.body.alerts.some((a: any) => a.employeeId === targetCancel), "14b) changing the expiry date automatically starts a new (uncancelled) alert cycle", after.body.alerts);
    }

    // =====================================================================
    // 15) Dashboard alerts: window boundary, severity, sort order,
    //     inactive-employee exclusion, expired
    // =====================================================================
    const targetWindow = await makeEmployee("TargetWindow", "Employee");
    // leadDays = 10, expiry = today + 10 -> windowStart is exactly TODAY.
    await call("PATCH", `/api/employees/${targetWindow}`, { token: adminToken, body: { workPermitExpiryDate: addDaysToDateStr(TODAY, 10), workPermitNotifyLeadDays: 10 } });
    const targetNotYet = await makeEmployee("TargetNotYet", "Employee");
    // leadDays = 10, expiry = today + 11 -> windowStart is TOMORROW, not yet open.
    await call("PATCH", `/api/employees/${targetNotYet}`, { token: adminToken, body: { workPermitExpiryDate: addDaysToDateStr(TODAY, 11), workPermitNotifyLeadDays: 10 } });
    const targetExpired = await makeEmployee("TargetExpired", "Employee");
    await call("PATCH", `/api/employees/${targetExpired}`, { token: adminToken, body: { workPermitExpiryDate: addDaysToDateStr(TODAY, -5), workPermitNotifyLeadDays: 10 } });
    const targetInactive = await makeEmployee("TargetInactive", "Employee");
    await call("PATCH", `/api/employees/${targetInactive}`, { token: adminToken, body: { workPermitExpiryDate: addDaysToDateStr(TODAY, 5), workPermitNotifyLeadDays: 10 } });
    await call("PATCH", `/api/employees/${targetInactive}`, { token: adminToken, body: { isActive: false } });

    {
      const res = await call("GET", `/api/dashboard/work-permit-alerts`, { token: adminToken });
      const ids = res.body.alerts.map((a: any) => a.employeeId);
      check(ids.includes(targetWindow), "16) an employee exactly at the notification window boundary (today == windowStart) IS shown", ids);
      check(!ids.includes(targetNotYet), "16b) an employee one day before the window opens is NOT shown yet", ids);
      check(ids.includes(targetExpired), "17) an expired permit still shows as an alert", ids);
      const expiredAlert = res.body.alerts.find((a: any) => a.employeeId === targetExpired);
      check(expiredAlert?.severity === "expired" && expiredAlert?.remainingDays < 0, "17b) the expired alert has severity 'expired' and negative remainingDays", expiredAlert);
      check(!ids.includes(targetInactive), "18) an inactive employee never generates an active Dashboard alert", ids);

      // Sort order: soonest expiry first among the active alerts we set up.
      const relevant = res.body.alerts.filter((a: any) => [targetWindow, targetExpired].includes(a.employeeId));
      const sorted = [...relevant].sort((a: any, b: any) => a.remainingDays - b.remainingDays);
      check(JSON.stringify(relevant) === JSON.stringify(sorted), "19) alerts are sorted soonest-expiry-first", relevant);
    }
    {
      // Inactive employee's history must remain fully available even
      // though they no longer generate an active alert.
      const hist = await call("GET", `/api/employees/${targetInactive}/history`, { token: adminToken });
      check(hist.status === 200 && hist.body.history.length >= 1, "20) an inactive employee's permit history remains available", hist.body);
    }

    // =====================================================================
    // 21) Do not automatically deactivate on expiry — targetExpired (set
    //     up above with a past expiry date) must still be active.
    // =====================================================================
    {
      const getRes = await call("GET", `/api/employees/${targetExpired}`, { token: adminToken });
      check(getRes.body?.employee?.isActive === true, "21) an expired work permit never auto-deactivates the employee", getRes.body?.employee);
    }
  } finally {
    for (const eid of employeeIds) {
      await pool.query(`delete from work_permit_alert_acknowledgements where employee_id = $1`, [eid]).catch(() => {});
      await pool.query(`delete from work_permit_alert_cancellations where employee_id = $1`, [eid]).catch(() => {});
      await pool.query(`delete from employee_work_permit_history where employee_id = $1 or changed_by_employee_id = $1`, [eid]).catch(() => {});
    }
    for (const eid of employeeIds) {
      await pool.query(`delete from employees where id = $1`, [eid]).catch(() => {});
    }
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
