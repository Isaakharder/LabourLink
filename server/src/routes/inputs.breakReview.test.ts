// Midnight-closed break review: a break the system closed at the end of the
// day (midnight cut-off, or the end-of-day backstop) is flagged in Inputs
// and kept out of productivity until an Inputs user reviews it.
//
//  1. Until reviewed: productivity keeps the work recorded during the break;
//     payroll and every time entry stay exactly as recorded; Inputs flags
//     the break (daily view and the Breaks to review list).
//  2. A correction needs an explicit confirmation and a typed reason; both
//     are refused otherwise, with nothing written.
//  3. A confirmed correction goes through the existing audited break
//     correction: the reason is stored in time_entry_corrections, payroll
//     and productivity both use the corrected break, and the flag clears.
//  4. "Confirm as recorded" changes no time entry and no payroll figure,
//     records the review with its reason, and productivity then subtracts
//     the break as recorded.
//  5. Ordinary breaks are unaffected: corrected without a reason, as before.
//  6. Permissions follow Inputs access, not a separate review role: every
//     role that can open and correct break records in Inputs (Administrator,
//     Manager, Supervisor) can list, preview and review them, recorded as
//     themselves; roles without Inputs access (Employee, Crew Leader) are
//     refused on every review route, with nothing written.
//
// Run with: npm run test:inputs-break-review
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import inputsRouter from "./inputs";
import { getActivityReportDataWithAttribution, getPayrollReportData } from "../lib/reportQueries";
import { getDayBoundsUtc } from "../lib/timezone";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const RUN_ID = Date.now();
const DAY = "2026-11-10";
// Local wall-clock time on DAY (no DST change on Nov 10).
const at = (h: number, m = 0) => new Date(getDayBoundsUtc(DAY).start.getTime() + (h * 60 + m) * 60_000);
const MIDNIGHT = getDayBoundsUtc(DAY).end;

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/inputs", inputsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}/api/inputs${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  const employeeIds: string[] = [];
  let activityId: string | undefined;
  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
    async function employee(role: string, label: string) {
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [`BRV ${label} ${RUN_ID}`, `qa-brv-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
        )
      ).rows[0].id as string;
      employeeIds.push(id);
      return { id, token: signSession({ id, firstName: "QA", lastName: label, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await employee("Administrator", "Admin");
    const worker = await employee("Employee", "Worker");
    const supervisor = await employee("Supervisor", "Sup");
    const manager = await employee("Manager", "Mgr");
    const crewLeader = await employee("Crew Leader", "Crew");
    const dee = await employee("Employee", "Dee");
    const ana = await employee("Employee", "Ana");
    const ben = await employee("Employee", "Ben");
    const cy = await employee("Employee", "Cy");
    activityId = (await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA BRV Job ${RUN_ID}`])).rows[0].id;

    const work = async (employeeId: string, from: Date, to: Date) =>
      (
        await pool.query(
          `insert into time_entries (employee_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
           values ($1, 'work', $2, gen_random_uuid(), $3, $4, 'manual') returning id`,
          [employeeId, activityId, from, to]
        )
      ).rows[0].id as string;
    const brk = async (employeeId: string, from: Date, to: Date, autoClosed = false) =>
      (
        await pool.query(
          `insert into time_entries (employee_id, entry_type, idempotency_key, started_at, ended_at, source, is_paid, auto_closed_at)
           values ($1, 'break', gen_random_uuid(), $2, $3, 'manual', false, $4) returning id`,
          [employeeId, from, to, autoClosed ? to : null]
        )
      ).rows[0].id as string;

    // Ana: work 07:00-15:00, an unpaid break from 12:00 closed by the midnight cut-off.
    await work(ana.id, at(7), at(15));
    const anaBreak = await brk(ana.id, at(12), MIDNIGHT);
    await pool.query(
      `insert into time_entry_corrections (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
       values ($1, $2, null, 'ended_at', 'null', $3, 'midnight_cutoff')`,
      [anaBreak, ana.id, MIDNIGHT.toISOString()]
    );
    // Ben: work 07:00-15:00, an unpaid break from 14:00 closed by the end-of-day backstop at 23:59:59.
    await work(ben.id, at(7), at(15));
    const benBreak = await brk(ben.id, at(14), new Date(MIDNIGHT.getTime() - 1000), true);
    // Dee: work 07:00-15:00, an unpaid break from 13:00 closed by the midnight cut-off.
    await work(dee.id, at(7), at(15));
    const deeBreak = await brk(dee.id, at(13), MIDNIGHT);
    // Cy: work 07:00-15:00, an ordinary 10:00-10:15 break.
    await work(cy.id, at(7), at(10));
    await work(cy.id, at(10, 15), at(15));
    const cyBreak = await brk(cy.id, at(10), at(10, 15));

    const activitySeconds = async (employeeId: string) => {
      const r = await getActivityReportDataWithAttribution(activityId!, DAY, DAY, { employeeIds: [employeeId] });
      return r?.data.employeeTotals.find((e) => e.employeeId === employeeId)?.workSeconds ?? null;
    };
    const payroll = async (employeeId: string) => JSON.stringify((await getPayrollReportData(DAY, DAY, { employeeIds: [employeeId] })).rows);
    const paidSeconds = async (employeeId: string) => (await getPayrollReportData(DAY, DAY, { employeeIds: [employeeId] })).rows[0]?.paidSeconds ?? null;
    const entries = async (employeeId: string) =>
      JSON.stringify((await pool.query(`select id, entry_type, started_at, ended_at, deleted_at, auto_closed_at from time_entries where employee_id = $1 order by started_at, id`, [employeeId])).rows);
    const corrections = async (entryId: string) =>
      (await pool.query(`select field_name, old_value, new_value, reason, changed_by_employee_id from time_entry_corrections where time_entry_id = $1 order by changed_at`, [entryId])).rows;

    // ---- 1. Until reviewed ----
    check((await activitySeconds(ana.id)) === 8 * 3600, "unreviewed midnight-closed break: productivity keeps all 8 h of recorded work", await activitySeconds(ana.id));
    check((await activitySeconds(ben.id)) === 8 * 3600, "unreviewed end-of-day backstop break: productivity keeps all 8 h", await activitySeconds(ben.id));
    check((await activitySeconds(cy.id)) === 7.75 * 3600, "ordinary break: unchanged (7 h 45 min)", await activitySeconds(cy.id));
    const anaPayroll0 = await payroll(ana.id);
    const anaPaid0 = await paidSeconds(ana.id);
    const anaEntries0 = await entries(ana.id);
    let daily = (await call(admin.token, "GET", `/daily?employeeId=${ana.id}&date=${DAY}`)).body;
    check(daily?.breaks?.find((b: any) => b.id === anaBreak)?.needsReview === true, "Inputs daily flags the break", daily?.breaks);
    daily = (await call(admin.token, "GET", `/daily?employeeId=${cy.id}&date=${DAY}`)).body;
    check(daily?.breaks?.find((b: any) => b.id === cyBreak)?.needsReview === false, "an ordinary break isn't flagged", daily?.breaks);
    let list = await call(admin.token, "GET", `/break-reviews`);
    const listed = (id: string) => (list.body?.breaks ?? []).find((b: any) => b.breakId === id);
    check(list.status === 200 && !!listed(anaBreak) && !!listed(benBreak) && !listed(cyBreak), "Breaks to review lists both cut-off breaks, not the ordinary one", list.body);
    check(listed(anaBreak)?.overlappedWorkSeconds === 3 * 3600 && listed(anaBreak)?.date === DAY && listed(anaBreak)?.isPaid === false, "the list shows the work recorded during the break", listed(anaBreak));
    check((await call(worker.token, "GET", `/break-reviews`)).status === 403, "an Employee can't list breaks to review");

    // ---- 2. Refused without confirmation and reason ----
    let res = await call(admin.token, "PATCH", `/breaks/${anaBreak}`, { startTime: at(12).toISOString(), endTime: at(12, 30).toISOString() });
    check(res.status === 422, "no confirmation, no reason: refused", res);
    res = await call(admin.token, "PATCH", `/breaks/${anaBreak}`, { startTime: at(12).toISOString(), endTime: at(12, 30).toISOString(), reason: "Lunch 30 min" });
    check(res.status === 422, "a reason without confirmation: refused", res);
    res = await call(admin.token, "PATCH", `/breaks/${anaBreak}`, { startTime: at(12).toISOString(), endTime: at(12, 30).toISOString(), confirmed: true, reason: " x " });
    check(res.status === 422, "a too-short reason: refused", res);
    check((await entries(ana.id)) === anaEntries0 && (await payroll(ana.id)) === anaPayroll0 && (await corrections(anaBreak)).length === 1, "refusals change nothing", await corrections(anaBreak));

    // ---- 3. A confirmed correction ----
    res = await call(admin.token, "PATCH", `/breaks/${anaBreak}`, {
      startTime: at(12).toISOString(),
      endTime: at(12, 30).toISOString(),
      confirmed: true,
      reason: "Confirmed with Ana: lunch ended 12:30",
    });
    check(res.status === 200, "confirmed correction saved", res);
    const anaCorr = await corrections(anaBreak);
    check(
      anaCorr.length === 2 && anaCorr[1].reason === "Confirmed with Ana: lunch ended 12:30" && anaCorr[1].changed_by_employee_id === admin.id && anaCorr[1].field_name === "ended_at",
      "the correction and its reason are in the break's audit history",
      anaCorr
    );
    check((await activitySeconds(ana.id)) === 7.5 * 3600, "productivity now uses the corrected 30-minute break (7 h 30 min)", await activitySeconds(ana.id));
    const anaPaid1 = await paidSeconds(ana.id);
    check(anaPaid0 !== null && anaPaid1 === 7.5 * 3600 && anaPaid1 > anaPaid0, "payroll uses the corrected break too, only after the explicit correction", { anaPaid0, anaPaid1 });
    daily = (await call(admin.token, "GET", `/daily?employeeId=${ana.id}&date=${DAY}`)).body;
    check(daily?.breaks?.find((b: any) => b.id === anaBreak)?.needsReview === false, "the flag clears", daily?.breaks);
    list = await call(admin.token, "GET", `/break-reviews`);
    check(!listed(anaBreak) && !!listed(benBreak), "Ana's break leaves the list; Ben's stays");

    // ---- 4. Confirm as recorded ----
    const benEntries0 = await entries(ben.id);
    const benPayroll0 = await payroll(ben.id);
    res = await call(admin.token, "PATCH", `/breaks/${benBreak}`, { confirmAsRecorded: true, reason: "Ben left at 14:00; work after it was a phone left running" });
    check(res.status === 422, "confirm as recorded also needs the confirmation", res);
    res = await call(admin.token, "PATCH", `/breaks/${benBreak}`, { confirmAsRecorded: true, confirmed: true, reason: "Ben left at 14:00; work after it was a phone left running" });
    check(res.status === 200 && res.body?.confirmedAsRecorded === true, "confirmed as recorded", res);
    check((await entries(ben.id)) === benEntries0, "confirming as recorded changes no time entry");
    check((await payroll(ben.id)) === benPayroll0, "confirming as recorded changes no payroll figure");
    const benCorr = await corrections(benBreak);
    check(benCorr.length === 1 && benCorr[0].old_value === benCorr[0].new_value && benCorr[0].changed_by_employee_id === admin.id && benCorr[0].reason.startsWith("Ben left"), "the review is in the audit history, times unchanged", benCorr);
    check((await activitySeconds(ben.id)) === 7 * 3600, "productivity now subtracts the reviewed break (7 h)", await activitySeconds(ben.id));
    list = await call(admin.token, "GET", `/break-reviews`);
    check(!listed(benBreak), "Ben's break leaves the list");
    res = await call(admin.token, "PATCH", `/breaks/${cyBreak}`, { confirmAsRecorded: true, confirmed: true, reason: "Not needed" });
    check(res.status === 409, "an ordinary break can't be 'confirmed as recorded'", res);

    // ---- 6. Permissions: Inputs access decides, not a review-only role ----
    const deeEntries0 = await entries(dee.id);
    for (const who of [worker, crewLeader]) {
      const label = who === worker ? "Employee" : "Crew Leader";
      check((await call(who.token, "GET", `/break-reviews`)).status === 403, `${label}: can't list breaks to review`);
      check((await call(who.token, "GET", `/daily?employeeId=${dee.id}&date=${DAY}`)).status === 403, `${label}: can't open the break record in Inputs either`);
      check(
        (await call(who.token, "POST", `/breaks/${deeBreak}/correction-preview`, { startTime: at(13).toISOString(), endTime: at(13, 30).toISOString() })).status === 403,
        `${label}: can't preview a correction`
      );
      check(
        (await call(who.token, "PATCH", `/breaks/${deeBreak}`, { startTime: at(13).toISOString(), endTime: at(13, 30).toISOString(), confirmed: true, reason: "Trying anyway" })).status === 403,
        `${label}: can't correct`
      );
      check(
        (await call(who.token, "PATCH", `/breaks/${deeBreak}`, { confirmAsRecorded: true, confirmed: true, reason: "Trying anyway" })).status === 403,
        `${label}: can't confirm as recorded`
      );
    }
    check((await entries(dee.id)) === deeEntries0 && (await corrections(deeBreak)).length === 0, "refused users wrote nothing");
    for (const who of [supervisor, manager]) {
      const label = who === supervisor ? "Supervisor" : "Manager";
      const l = await call(who.token, "GET", `/break-reviews`);
      check(l.status === 200 && (l.body?.breaks ?? []).some((b: any) => b.breakId === deeBreak), `${label}: lists Dee's break`, l.status);
      const pv = await call(who.token, "POST", `/breaks/${deeBreak}/correction-preview`, { startTime: at(13).toISOString(), endTime: at(13, 30).toISOString() });
      check(pv.status === 200 && Array.isArray(pv.body?.messages) && pv.body.messages.some((m: string) => /shorten|resume|remove/i.test(m)), `${label}: sees the warning for the overlapping work entry`, pv.body);
    }
    res = await call(supervisor.token, "PATCH", `/breaks/${deeBreak}`, { startTime: at(13).toISOString(), endTime: at(13, 30).toISOString(), confirmed: true, reason: "Dee says lunch was 30 min" });
    check(res.status === 200, "a Supervisor can review and correct", res);
    const deeCorr = await corrections(deeBreak);
    check(deeCorr.length === 1 && deeCorr[0].changed_by_employee_id === supervisor.id && deeCorr[0].reason === "Dee says lunch was 30 min", "the audit history names the Supervisor and their reason", deeCorr);
    check((await activitySeconds(dee.id)) === 7.5 * 3600, "Dee's productivity uses the Supervisor's corrected break", await activitySeconds(dee.id));

    // ---- 5. Ordinary breaks: as before ----
    res = await call(admin.token, "PATCH", `/breaks/${cyBreak}`, { endTime: at(10, 20).toISOString() });
    check(res.status === 200, "an ordinary break is corrected without a reason, as before", res);
    const cyCorr = await corrections(cyBreak);
    check(cyCorr.length === 1 && cyCorr[0].reason === "Time corrected from Inputs page", "with the usual recorded reason", cyCorr);
  } finally {
    server.close();
    const del = async (sql: string, params: unknown[]) => {
      try {
        await pool.query(sql, params);
      } catch (e) {
        console.error("cleanup:", sql, e instanceof Error ? e.message : e);
      }
    };
    await del(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds]);
    await del(`delete from time_entry_deletions where employee_id = any($1::uuid[])`, [employeeIds]);
    await del(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
    if (activityId) await del(`delete from activities where id = $1`, [activityId]);
    await del(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
    await pool.end();
  }
  console.log(`inputs break review: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
