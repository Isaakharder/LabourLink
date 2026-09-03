// Real-HTTP-against-real-database coverage for Employment Timeline:
// employmentPeriods.ts's create/update/delete/list/history routes,
// employees.ts's expanded nationality set, and the 050_employment_timeline
// migration's DB-level guarantees (overlap exclusion, backfill). See
// employmentPeriods.test.ts (lib) for the pure computePeriodStatuses math
// this builds on.
//
// Run with: npm run test:employment-periods
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { calendarDateInAppTimezone, addDaysToDateStr } from "../lib/timezone";
import employeesRouter from "./employees";
import employmentPeriodsRouter from "./employmentPeriods";

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
  app.use("/api/employment-periods", employmentPeriodsRouter);
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

    async function makeEmployee(label: string, role: string, extra: Record<string, unknown> = {}): Promise<string> {
      const nationality = extra.nationality ?? null;
      const isActive = extra.isActive ?? true;
      const startDate = extra.startDate === undefined ? "2020-01-01" : extra.startDate;
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, nationality, start_date)
           values ('QA', $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [
            `EmpTimeline ${label} ${RUN_ID}`,
            `qa-emp-timeline-${label.toLowerCase()}-${RUN_ID}@test.local`,
            await roleId(role),
            teamRoleId,
            fakePinHash,
            isActive,
            nationality,
            startDate,
          ]
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
    // 1) Every Employment Type round-trips
    // =====================================================================
    for (const employmentType of ["Permanent", "Temporary", "Seasonal", "Other"]) {
      const target = await makeEmployee(`Type${employmentType}`, "Employee");
      const res = await call("POST", "/api/employment-periods", {
        token: adminToken,
        body: { employeeId: target, startDate: "2026-01-01", employmentType },
      });
      check(res.status === 201 && res.body?.period?.employmentType === employmentType, `1) Employment Type '${employmentType}' round-trips`, res.body);
    }

    // =====================================================================
    // 2) Every Work Group + Other with/without description; rejection when
    //    a description is set without workGroup === 'Other'
    // =====================================================================
    for (const workGroup of ["Greenhouse", "Warehouse", "Outdoor", "Maintenance", "Management"]) {
      const target = await makeEmployee(`WG${workGroup}`, "Employee");
      const res = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: target, startDate: "2026-01-01", workGroup } });
      check(res.status === 201 && res.body?.period?.workGroup === workGroup, `2) Work Group '${workGroup}' round-trips`, res.body);
    }
    {
      const target = await makeEmployee("WGOtherWith", "Employee");
      const res = await call("POST", "/api/employment-periods", {
        token: adminToken,
        body: { employeeId: target, startDate: "2026-01-01", workGroup: "Other", workGroupOtherDescription: "Packhouse line lead" },
      });
      check(res.status === 201 && res.body?.period?.workGroupOtherDescription === "Packhouse line lead", "2b) Work Group 'Other' with a description round-trips", res.body);
    }
    {
      const target = await makeEmployee("WGOtherWithout", "Employee");
      const res = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: target, startDate: "2026-01-01", workGroup: "Other" } });
      check(res.status === 201 && res.body?.period?.workGroupOtherDescription === null, "2c) Work Group 'Other' with no description is allowed (optional)", res.body);
    }
    {
      const target = await makeEmployee("WGDescRejected", "Employee");
      const res = await call("POST", "/api/employment-periods", {
        token: adminToken,
        body: { employeeId: target, startDate: "2026-01-01", workGroup: "Greenhouse", workGroupOtherDescription: "Should be rejected" },
      });
      check(res.status === 400, "2d) a description is rejected when Work Group is not 'Other'", res.body);
    }

    // =====================================================================
    // 3) All 4 new nationalities accepted; old 2 still accepted; invalid rejected
    // =====================================================================
    for (const nationality of ["Canadian", "Mexican", "Jamaican", "Guatemalan", "Filipino", "Thai"]) {
      const res = await call("POST", "/api/employees", {
        token: adminToken,
        body: { firstName: "QA", lastName: `Nat ${nationality} ${RUN_ID}`, startDate: "2026-01-01", nationality },
      });
      check(res.status === 201 && res.body?.employee?.nationality === nationality, `3) nationality '${nationality}' is accepted on create`, res.body);
      if (res.body?.employee?.id) employeeIds.push(res.body.employee.id);
    }
    {
      const res = await call("POST", "/api/employees", {
        token: adminToken,
        body: { firstName: "QA", lastName: `Nat Invalid ${RUN_ID}`, startDate: "2026-01-01", nationality: "Martian" },
      });
      check(res.status === 400, "3b) an invalid nationality is still rejected", res.body);
    }

    // =====================================================================
    // 4) Backfilled employee (via the migration's own INSERT statement, not
    //    the route) shows exactly one Unspecified/open-ended period
    // =====================================================================
    {
      const target = await makeEmployee("BackfillTarget", "Employee", { startDate: "2024-03-15" });
      // Simulate the migration's backfill INSERT directly, since that
      // employee already existed before this test employee did — this
      // exercises the same statement 050_employment_timeline.sql runs.
      await pool.query(`insert into employee_employment_periods (employee_id, start_date) values ($1, $2)`, [target, "2024-03-15"]);
      const res = await call("GET", `/api/employment-periods?employeeId=${target}`, { token: adminToken });
      const periods = res.body?.employees?.[0]?.periods ?? [];
      check(periods.length === 1, "4) a backfilled employee shows exactly one period", periods);
      check(periods[0]?.employmentType === null && periods[0]?.workGroup === null, "4b) the backfilled period's classification is Unspecified (null), not 'Other'", periods[0]);
      check(periods[0]?.statuses?.includes("current"), "4c) the backfilled open-ended period reads as current", periods[0]);
    }

    // =====================================================================
    // 5) Multiple periods / leave-and-return: a closed period, then a new
    //    one starting the day after
    // =====================================================================
    const returnEmp = await makeEmployee("Returning", "Employee");
    {
      const first = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: returnEmp, startDate: "2024-01-01", actualFinishDate: "2024-06-30" } });
      check(first.status === 201, "5) first stint (closed) creates successfully", first.body);
      const second = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: returnEmp, startDate: "2024-07-01" } });
      check(second.status === 201, "5b) second stint starting the day after the first's finish creates successfully", second.body);
      const list = await call("GET", `/api/employment-periods?employeeId=${returnEmp}`, { token: adminToken });
      check(list.body?.employees?.[0]?.periods?.length === 2, "5c) both periods are returned for the returning employee", list.body);
    }

    // =====================================================================
    // 6) Expected vs actual finish; is_active never touched by any mutation
    // =====================================================================
    const expVsActual = await makeEmployee("ExpVsActual", "Employee");
    let expVsActualPeriodId = "";
    {
      const isActiveBefore = (await call("GET", `/api/employees/${expVsActual}`, { token: adminToken })).body.employee.isActive;
      const created = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: expVsActual, startDate: "2026-01-01", expectedFinishDate: addDaysToDateStr(TODAY, 5) } });
      expVsActualPeriodId = created.body.period.id;
      check(created.body?.period?.statuses?.includes("finishingSoon"), "6) an expected finish 5 days out reads as finishingSoon", created.body?.period);

      const patched = await call("PATCH", `/api/employment-periods/${expVsActualPeriodId}`, { token: adminToken, body: { actualFinishDate: TODAY } });
      check(patched.status === 200 && patched.body?.period?.statuses?.includes("completed"), "6b) recording an actual finish flips status to completed", patched.body);

      const isActiveAfter = (await call("GET", `/api/employees/${expVsActual}`, { token: adminToken })).body.employee.isActive;
      check(isActiveBefore === true && isActiveAfter === true, "6c) recording an actual finish does NOT touch employees.is_active", { isActiveBefore, isActiveAfter });
    }

    // =====================================================================
    // 7) Overlap rejection incl. exact boundary; open-ended blocks any later
    // =====================================================================
    const overlapEmp = await makeEmployee("OverlapRoute", "Employee");
    {
      const a = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: overlapEmp, startDate: "2026-01-01", actualFinishDate: "2026-01-10" } });
      check(a.status === 201, "7) base period A [Jan 1, Jan 10] creates successfully", a.body);
      const sameDay = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: overlapEmp, startDate: "2026-01-10" } });
      check(sameDay.status === 409, "7b) a period starting the SAME day as A's finish is rejected (409)", sameDay.body);
      const dayAfter = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: overlapEmp, startDate: "2026-01-11" } });
      check(dayAfter.status === 201, "7c) a period starting the day AFTER A's finish is accepted", dayAfter.body);
    }
    const openEndedEmp = await makeEmployee("OpenEndedRoute", "Employee");
    {
      const open = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: openEndedEmp, startDate: "2026-01-01" } });
      check(open.status === 201, "7d) an open-ended period (no finish at all) creates successfully", open.body);
      const later = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: openEndedEmp, startDate: "2027-01-01" } });
      check(later.status === 409, "7e) any later period is rejected while the prior one is still open-ended", later.body);
    }
    // PATCH can also trigger the overlap constraint, not just POST — a
    // fresh employee with two well-separated periods, then move the second
    // one's start date to overlap the first.
    const patchOverlapEmp = await makeEmployee("PatchOverlap", "Employee");
    {
      const p1 = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: patchOverlapEmp, startDate: "2026-01-01", actualFinishDate: "2026-01-10" } });
      const p2 = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: patchOverlapEmp, startDate: "2026-02-01", actualFinishDate: "2026-02-10" } });
      check(p1.status === 201 && p2.status === 201, "7f-setup) two non-overlapping periods create successfully", { p1: p1.status, p2: p2.status });
      const patchOverlap = await call("PATCH", `/api/employment-periods/${p2.body.period.id}`, { token: adminToken, body: { startDate: "2026-01-05" } });
      check(patchOverlap.status === 409, "7f) PATCH can also trigger the overlap constraint (not just POST)", patchOverlap.body);
    }

    // =====================================================================
    // 8) Combined filters: Guatemalan + Greenhouse + Seasonal
    // =====================================================================
    const fullMatch = await makeEmployee("FullMatch", "Employee", { nationality: "Guatemalan" });
    await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: fullMatch, startDate: "2026-01-01", workGroup: "Greenhouse", employmentType: "Seasonal" } });
    const partialNationalityOnly = await makeEmployee("PartialNat", "Employee", { nationality: "Guatemalan" });
    await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: partialNationalityOnly, startDate: "2026-01-01", workGroup: "Warehouse", employmentType: "Permanent" } });
    const partialWorkGroupOnly = await makeEmployee("PartialWG", "Employee", { nationality: "Filipino" });
    await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: partialWorkGroupOnly, startDate: "2026-01-01", workGroup: "Greenhouse", employmentType: "Seasonal" } });
    {
      const res = await call(
        "GET",
        `/api/employment-periods?nationality=Guatemalan&workGroup=Greenhouse&employmentType=Seasonal`,
        { token: adminToken }
      );
      const ids = res.body.employees.map((e: any) => e.id);
      check(ids.includes(fullMatch), "8) the full match (Guatemalan + Greenhouse + Seasonal) IS returned", ids);
      check(!ids.includes(partialNationalityOnly), "8b) an employee matching only nationality is NOT returned", ids);
      check(!ids.includes(partialWorkGroupOnly), "8c) an employee matching only Work Group/Employment Type (wrong nationality) is NOT returned", ids);
    }
    // OR-within-category: two Work Group values returns employees matching either.
    {
      const res = await call("GET", `/api/employment-periods?workGroup=Greenhouse,Warehouse&employeeId=${fullMatch},${partialNationalityOnly}`, { token: adminToken });
      const ids = res.body.employees.map((e: any) => e.id);
      check(ids.includes(fullMatch) && ids.includes(partialNationalityOnly), "9) selecting two Work Group values returns employees matching EITHER (OR within category)", ids);
    }
    // "Unspecified" filter value includes employees with no classification.
    {
      const unspecified = await makeEmployee("UnspecifiedWG", "Employee");
      await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: unspecified, startDate: "2026-01-01" } });
      const res = await call("GET", `/api/employment-periods?workGroup=Unspecified&employeeId=${unspecified}`, { token: adminToken });
      const ids = res.body.employees.map((e: any) => e.id);
      check(ids.includes(unspecified), "10) the literal 'Unspecified' filter value includes an employee with no Work Group classification", ids);
    }

    // =====================================================================
    // 11) Permit marker matches getWorkPermitStatus-equivalent data exactly
    // =====================================================================
    const permitEmp = await makeEmployee("PermitMarker", "Employee");
    const permitExpiry = addDaysToDateStr(TODAY, 30);
    await call("PATCH", `/api/employees/${permitEmp}`, { token: adminToken, body: { workPermitExpiryDate: permitExpiry } });
    await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: permitEmp, startDate: "2026-01-01" } });
    {
      const res = await call("GET", `/api/employment-periods?employeeId=${permitEmp}`, { token: adminToken });
      const workPermit = res.body.employees[0]?.workPermit;
      check(workPermit?.expiryDate === permitExpiry, "11) the timeline read endpoint's workPermit.expiryDate matches the employee's actual permit expiry", workPermit);
    }

    // =====================================================================
    // 12) Role restrictions
    // =====================================================================
    {
      const listByPlain = await call("GET", "/api/employment-periods", { token: plainToken });
      check(listByPlain.status === 401 || listByPlain.status === 403, "12) a plain Employee CANNOT view the timeline list", listByPlain.status);
      const listByManager = await call("GET", "/api/employment-periods", { token: managerToken });
      check(listByManager.status === 200, "12b) a Manager CAN view the timeline list", listByManager.status);
      const createByManager = await call("POST", "/api/employment-periods", { token: managerToken, body: { employeeId: permitEmp, startDate: "2030-01-01" } });
      check(createByManager.status === 403, "12c) a Manager CANNOT create a period (Administrator-only)", createByManager.body);
      const historyByManager = await call("GET", `/api/employment-periods/${permitEmp}/history`, { token: managerToken });
      check(historyByManager.status === 403, "12d) a Manager CANNOT view audit history (Administrator-only)", historyByManager.body);
      const historyByAdmin = await call("GET", `/api/employment-periods/${permitEmp}/history`, { token: adminToken });
      check(historyByAdmin.status === 200, "12e) an Administrator CAN view audit history", historyByAdmin.status);
    }

    // =====================================================================
    // 13) Audit history: created / updated / deleted, incl. reason
    //     requirement on delete and survival after the period is gone
    // =====================================================================
    const auditEmp = await makeEmployee("AuditTrail", "Employee");
    let auditPeriodId = "";
    {
      const created = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: auditEmp, startDate: "2026-01-01", employmentType: "Temporary" } });
      auditPeriodId = created.body.period.id;
      const patched = await call("PATCH", `/api/employment-periods/${auditPeriodId}`, { token: adminToken, body: { employmentType: "Permanent" } });
      check(patched.status === 200, "13) extend/edit succeeds", patched.body);

      const noReason = await call("DELETE", `/api/employment-periods/${auditPeriodId}`, { token: adminToken, body: {} });
      check(noReason.status === 400, "13b) deleting without a reason is rejected (400)", noReason.body);
      const withReason = await call("DELETE", `/api/employment-periods/${auditPeriodId}`, { token: adminToken, body: { reason: "Entered in error" } });
      check(withReason.status === 204, "13c) deleting with a reason succeeds", withReason.status);

      const hist = await call("GET", `/api/employment-periods/${auditEmp}/history`, { token: adminToken });
      const types = hist.body.history.map((h: any) => h.changeType).sort();
      check(JSON.stringify(types) === JSON.stringify(["created", "deleted", "updated"]), "13d) exactly created/updated/deleted history rows exist", types);
      const deletedRow = hist.body.history.find((h: any) => h.changeType === "deleted");
      check(deletedRow?.reason === "Entered in error", "13e) the delete's reason is recorded", deletedRow);
      check(deletedRow?.oldValue?.employment_type === "Permanent", "13f) the delete's oldValue snapshot reflects the most recent edit", deletedRow?.oldValue);
      // The history row survives even though the period itself is now gone
      // (on delete set null on employment_period_id, not cascade).
      const getDeleted = await call("PATCH", `/api/employment-periods/${auditPeriodId}`, { token: adminToken, body: { notes: "x" } });
      check(getDeleted.status === 404, "13g) the deleted period itself now 404s", getDeleted.status);
      check(hist.status === 200, "13h) history remains fully fetchable after the period is deleted", hist.status);
    }

    // =====================================================================
    // 14) Timezone-safety: date strings round-trip byte-for-byte
    // =====================================================================
    {
      const target = await makeEmployee("TzSafe", "Employee");
      const dstAdjacent = "2026-03-08"; // a DST-transition-adjacent date in APP_TIMEZONE
      const res = await call("POST", "/api/employment-periods", { token: adminToken, body: { employeeId: target, startDate: dstAdjacent } });
      check(res.body?.period?.startDate === dstAdjacent, "14) a DST-transition-adjacent date string round-trips byte-for-byte, no shift", res.body?.period);
    }

    // =====================================================================
    // 15) Large-list smoke test — bounded response time with many employees
    // =====================================================================
    {
      const bulkCount = 300;
      // Bulk-insert via a single multi-row statement rather than N round
      // trips — a pure test-setup performance concern, not part of the
      // feature under test.
      const employeeRoleId = await roleId("Employee");
      const rows = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, start_date)
         select 'QA', 'Bulk ' || g || ' ${RUN_ID}', 'qa-bulk-' || g || '-${RUN_ID}@test.local', $1, $2, $3, '2020-01-01'
         from generate_series(1, ${bulkCount}) g
         returning id`,
        [employeeRoleId, teamRoleId, fakePinHash]
      );
      const bulkIds = rows.rows.map((r) => r.id);
      employeeIds.push(...bulkIds);
      await pool.query(
        `insert into employee_employment_periods (employee_id, start_date)
         select unnest($1::uuid[]), '2020-01-01'`,
        [bulkIds]
      );

      const startedAt = Date.now();
      const res = await call("GET", "/api/employment-periods", { token: adminToken });
      const elapsedMs = Date.now() - startedAt;
      check(res.status === 200 && res.body.employees.length >= bulkCount, "15) the full-list read returns all bulk-inserted employees", res.body.employees.length);
      check(elapsedMs < 5000, "15b) the full-list read completes within a generous bound (< 5s) with 300+ employees", elapsedMs);
    }
  } finally {
    for (const eid of employeeIds) {
      await pool
        .query(`delete from employee_employment_period_history where employee_id = $1 or changed_by_employee_id = $1`, [eid])
        .catch(() => {});
      await pool.query(`delete from employee_employment_periods where employee_id = $1`, [eid]).catch(() => {});
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
