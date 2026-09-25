// Covers the Activity Report "daily metric + weekly totals" persistence
// model that replaced the old flat {metrics} checkbox list for Activity
// reports (Payroll keeps {metrics} unchanged — see reports.ts's
// ACTIVITY_DAILY_METRIC_ELIGIBLE/ACTIVITY_WEEKLY_TOTAL_ELIGIBLE and their
// web/src/lib/reportTypes.ts mirrors, DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS/
// WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS):
//
//  - POST an Activity report requires a valid dailyMetric (one of the
//    daily-eligible metrics) and a non-empty valid weeklyTotals array
//    (daily-eligible metrics PLUS "employeePaidTime") — never accepts the
//    old {metrics} shape for this report type.
//  - "employeePaidTime" is accepted in weeklyTotals but rejected as
//    dailyMetric (it's a whole-shift figure, never meaningful per
//    activity-day — see ACTIVITY_METRICS' own comment).
//  - PATCH can update either field independently, validates each the same
//    way POST does, and only ever touches an Activity report's own
//    dailyMetric/weeklyTotals (a Payroll report's PATCH with these fields
//    is silently a no-op — Payroll only ever reads/writes {metrics}).
//  - GET reads back exactly what was persisted, unfiltered.
//
// Run with: npm run test:reports-metric-configuration
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import reportsRouter from "./reports";

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
  app.use("/api/reports", reportsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const reportIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ReportMetricConfig Admin ${RUN_ID}`, `qa-report-metric-config-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA ReportMetricConfig Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);

    async function createActivityReport(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
      const res = await call("POST", "/api/reports", adminToken, {
        name: `QA MetricConfig ${RUN_ID} ${Math.random()}`,
        reportType: "activity",
        activityId,
        ...body,
      });
      if (res.status === 201 && res.body?.id) reportIds.push(res.body.id);
      return res;
    }

    // -----------------------------------------------------------------
    // 1) A valid dailyMetric + weeklyTotals creates the report and is
    //    persisted/read back exactly.
    // -----------------------------------------------------------------
    {
      const res = await createActivityReport({ dailyMetric: "workTime", weeklyTotals: ["activityHours", "employeePaidTime"] });
      check(res.status === 201, "1) valid dailyMetric + weeklyTotals creates the report", res.body);
      const get = await call("GET", `/api/reports/${res.body.id}`, adminToken);
      check(get.body?.report?.configuration?.dailyMetric === "workTime", "1) GET reads back the exact saved dailyMetric", get.body);
      check(
        JSON.stringify(get.body?.report?.configuration?.weeklyTotals) === JSON.stringify(["activityHours", "employeePaidTime"]),
        "1) GET reads back the exact saved weeklyTotals, in order",
        get.body
      );
      check(get.body?.report?.configuration?.metrics === undefined, "1) the old flat {metrics} key is never written for an Activity report", get.body);
    }

    // -----------------------------------------------------------------
    // 2) Missing dailyMetric, missing weeklyTotals, or an empty
    //    weeklyTotals array are all rejected with 400s naming the field.
    // -----------------------------------------------------------------
    {
      const missingDaily = await createActivityReport({ weeklyTotals: ["activityHours"] });
      check(missingDaily.status === 400 && !!missingDaily.body?.errors?.dailyMetric, "2) missing dailyMetric is rejected", missingDaily.body);

      const missingWeekly = await createActivityReport({ dailyMetric: "workTime" });
      check(missingWeekly.status === 400 && !!missingWeekly.body?.errors?.weeklyTotals, "2) missing weeklyTotals is rejected", missingWeekly.body);

      const emptyWeekly = await createActivityReport({ dailyMetric: "workTime", weeklyTotals: [] });
      check(emptyWeekly.status === 400 && !!emptyWeekly.body?.errors?.weeklyTotals, "2) an empty weeklyTotals array is rejected", emptyWeekly.body);
    }

    // -----------------------------------------------------------------
    // 3) "employeePaidTime" is valid in weeklyTotals but rejected as
    //    dailyMetric — it's a whole-shift figure, never meaningful as a
    //    per-activity-day value.
    // -----------------------------------------------------------------
    {
      const asDaily = await createActivityReport({ dailyMetric: "employeePaidTime", weeklyTotals: ["activityHours"] });
      check(asDaily.status === 400 && !!asDaily.body?.errors?.dailyMetric, "3) employeePaidTime is rejected as dailyMetric", asDaily.body);

      const asWeekly = await createActivityReport({ dailyMetric: "workTime", weeklyTotals: ["employeePaidTime"] });
      check(asWeekly.status === 201, "3) employeePaidTime alone is a valid weeklyTotals entry", asWeekly.body);
    }

    // -----------------------------------------------------------------
    // 4) A garbage/unknown metric key in either field is rejected.
    // -----------------------------------------------------------------
    {
      const badDaily = await createActivityReport({ dailyMetric: "notARealMetric", weeklyTotals: ["activityHours"] });
      check(badDaily.status === 400 && !!badDaily.body?.errors?.dailyMetric, "4) an unknown dailyMetric key is rejected", badDaily.body);

      const badWeekly = await createActivityReport({ dailyMetric: "workTime", weeklyTotals: ["notARealMetric"] });
      check(badWeekly.status === 400 && !!badWeekly.body?.errors?.weeklyTotals, "4) an unknown weeklyTotals key is rejected", badWeekly.body);
    }

    // -----------------------------------------------------------------
    // 5) PATCH can update dailyMetric and weeklyTotals independently.
    // -----------------------------------------------------------------
    {
      const created = await createActivityReport({ dailyMetric: "workTime", weeklyTotals: ["activityHours"] });
      const reportId = created.body.id;

      const patchDaily = await call("PATCH", `/api/reports/${reportId}`, adminToken, { dailyMetric: "averageSpeed" });
      check(patchDaily.status === 200, "5) PATCH dailyMetric alone succeeds", patchDaily.body);
      let get = await call("GET", `/api/reports/${reportId}`, adminToken);
      check(get.body?.report?.configuration?.dailyMetric === "averageSpeed", "5) dailyMetric was updated", get.body);
      check(
        JSON.stringify(get.body?.report?.configuration?.weeklyTotals) === JSON.stringify(["activityHours"]),
        "5) weeklyTotals is untouched by a dailyMetric-only PATCH",
        get.body
      );

      const patchWeekly = await call("PATCH", `/api/reports/${reportId}`, adminToken, { weeklyTotals: ["employeePaidTime", "quantityWorked"] });
      check(patchWeekly.status === 200, "5) PATCH weeklyTotals alone succeeds", patchWeekly.body);
      get = await call("GET", `/api/reports/${reportId}`, adminToken);
      check(get.body?.report?.configuration?.dailyMetric === "averageSpeed", "5) dailyMetric is untouched by a weeklyTotals-only PATCH", get.body);
      check(
        JSON.stringify(get.body?.report?.configuration?.weeklyTotals) === JSON.stringify(["employeePaidTime", "quantityWorked"]),
        "5) weeklyTotals was updated",
        get.body
      );

      const patchBadDaily = await call("PATCH", `/api/reports/${reportId}`, adminToken, { dailyMetric: "employeePaidTime" });
      check(patchBadDaily.status === 400 && !!patchBadDaily.body?.errors?.dailyMetric, "5) PATCH rejects employeePaidTime as dailyMetric too", patchBadDaily.body);
      const patchEmptyWeekly = await call("PATCH", `/api/reports/${reportId}`, adminToken, { weeklyTotals: [] });
      check(patchEmptyWeekly.status === 400 && !!patchEmptyWeekly.body?.errors?.weeklyTotals, "5) PATCH rejects an empty weeklyTotals array", patchEmptyWeekly.body);
    }

    // -----------------------------------------------------------------
    // 6) A Payroll report ignores dailyMetric/weeklyTotals entirely on
    //    PATCH (only an Activity report's configuration accepts them) —
    //    its own {metrics} remains the only writable field, unaffected by
    //    this redesign.
    // -----------------------------------------------------------------
    {
      const payrollRes = await call("POST", "/api/reports", adminToken, {
        name: `QA MetricConfig Payroll ${RUN_ID}`,
        reportType: "payroll",
        metrics: ["employee", "workTime"],
      });
      check(payrollRes.status === 201, "6) creating the payroll report succeeds", payrollRes.body);
      const payrollId = payrollRes.body.id;
      reportIds.push(payrollId);

      const patchIgnored = await call("PATCH", `/api/reports/${payrollId}`, adminToken, {
        dailyMetric: "workTime",
        weeklyTotals: ["activityHours"],
      });
      check(patchIgnored.status === 200, "6) PATCHing dailyMetric/weeklyTotals on a Payroll report is a harmless no-op, not an error", patchIgnored.body);
      const get = await call("GET", `/api/reports/${payrollId}`, adminToken);
      check(get.body?.report?.configuration?.dailyMetric === undefined, "6) a Payroll report's configuration never gains a dailyMetric key", get.body);
      check(get.body?.report?.configuration?.weeklyTotals === undefined, "6) a Payroll report's configuration never gains a weeklyTotals key", get.body);
      check(
        JSON.stringify(get.body?.report?.configuration?.metrics) === JSON.stringify(["employee", "workTime"]),
        "6) the Payroll report's own {metrics} is unchanged",
        get.body
      );
    }
  } finally {
    for (const rid of reportIds) await pool.query("delete from saved_reports where id = $1", [rid]).catch(() => {});
    if (activityIds.length) await pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]).catch(() => {});
    if (employeeIds.length) await pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]).catch(() => {});
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
