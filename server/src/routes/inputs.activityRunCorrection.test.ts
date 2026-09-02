// Regression + feature test for the general "Activity Time Correction"
// workflow (computeActivityRunCorrectionPlan in inputs.ts), which replaces
// the narrow end-time-only correction: administrators can now correct a
// displayed activity run's START and/or END time, and the server
// atomically reconciles every underlying segment — trimming/soft-deleting
// what's shortened away, creating continuation entries for anything newly
// expanded into (including across a protected break, which is always split
// around rather than absorbed), and trimming/splitting/soft-deleting any
// DIFFERENT activity's entries the corrected range now overlaps.
//
// Run with: npm run test:inputs-activity-run-correction
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession, SESSION_COOKIE } from "../middleware/auth";
import inputsRouter from "./inputs";

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
  app.use("/api/inputs", inputsRouter);
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
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const responseBody = await res.json().catch(() => null);
    return { status: res.status, body: responseBody };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];
  const deviceIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const adminRoleId = await roleId("Administrator");
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ActivityCorrection Admin ${RUN_ID}`, `qa-activity-correction-admin-${RUN_ID}@test.local`, adminRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });
    const employeeToken = signSession({ id: randomUUID(), firstName: "QA", lastName: "NonPriv", securityRole: "Employee", teamRole: "Team Member" });

    const activityIdA = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Correction Activity A ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityIdA);
    const activityIdB = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Correction Activity B ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityIdB);
    const packingPeppersId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Packing Peppers ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(packingPeppersId);

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`ActivityCorrection-${label}-${RUN_ID}`, `qa-activity-correction-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertDevice(employeeId: string, label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [randomUUID(), `QA ActivityCorrection Device ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return rows[0].id;
    }
    async function insertWork(
      empId: string,
      deviceId: string,
      startedAt: string,
      endedAt: string | null,
      opts?: { activityId?: string }
    ): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, $2, 'work', $3, $4, $5, $6, 'manual') returning id`,
        [empId, deviceId, opts?.activityId ?? activityIdA, randomUUID(), startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBreak(empId: string, deviceId: string, startedAt: string, endedAt: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source)
         values ($1, $2, 'break', $3, $4, $5, 'manual') returning id`,
        [empId, deviceId, randomUUID(), startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function getEntry(id: string): Promise<any> {
      const { rows } = await pool.query(
        `select id, activity_id, started_at, ended_at, deleted_at, actual_started_at, actual_ended_at, created_by_employee_id, creation_reason
         from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }
    async function correctionsFor(id: string): Promise<any[]> {
      const { rows } = await pool.query(
        `select field_name, old_value, new_value, reason from time_entry_corrections where time_entry_id = $1 order by changed_at asc`,
        [id]
      );
      return rows;
    }
    async function deletionsFor(ids: string[]): Promise<any[]> {
      const { rows } = await pool.query(
        `select deletion_type, affected_time_entry_ids, reason from time_entry_deletions where affected_time_entry_ids && $1::uuid[]`,
        [ids]
      );
      return rows;
    }
    function preview(runId: string, body: { startTime?: string; endTime?: string }, token = adminToken) {
      return call("POST", `/api/inputs/activity-runs/${runId}/correction-preview`, token, body);
    }
    function apply(runId: string, body: { startTime?: string; endTime?: string; fingerprint: string }, token = adminToken) {
      return call("PATCH", `/api/inputs/activity-runs/${runId}/correction`, token, body);
    }
    async function previewThenApply(runId: string, body: { startTime?: string; endTime?: string }) {
      const previewRes = await preview(runId, body);
      if (previewRes.status !== 200) return { previewRes, applyRes: null as any };
      const applyRes = await apply(runId, { ...body, fingerprint: previewRes.body.fingerprint });
      return { previewRes, applyRes };
    }
    async function findEntriesForEmployeeDay(empId: string, dateStr: string): Promise<any[]> {
      const { rows } = await pool.query(
        `select id, entry_type, activity_id, started_at, ended_at, deleted_at, created_by_employee_id, creation_reason from time_entries
         where employee_id = $1 and started_at >= $2::timestamptz and started_at < ($2::timestamptz + interval '1 day') and deleted_at is null
         order by started_at asc`,
        [empId, `${dateStr}T00:00:00Z`]
      );
      return rows;
    }

    // -----------------------------------------------------------------
    // 1) END ONLY, shortening a single-segment run — ordinary trim.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("EndOnlyShorten");
      const deviceId = await insertDevice(empId, "EndOnlyShorten");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T12:00:00.000Z", "2026-08-28T18:00:00.000Z");

      const { previewRes, applyRes } = await previewThenApply(entryId, { endTime: "2026-08-28T17:00:00.000Z" });
      check(previewRes.status === 200, "1) preview succeeds for end-only shorten", previewRes);
      check(previewRes.body.workedSecondsDelta === -3600, "1) preview reports -1h worked delta", previewRes.body.workedSecondsDelta);
      check(applyRes.status === 200, "1) apply succeeds", applyRes);
      const entry = await getEntry(entryId);
      check(entry.ended_at.toISOString() === "2026-08-28T17:00:00.000Z", "1) end trimmed to exactly 5:00 PM", entry.ended_at);
      check(entry.started_at.toISOString() === "2026-08-28T12:00:00.000Z", "1) start untouched by an end-only correction", entry.started_at);
    }

    // -----------------------------------------------------------------
    // 2) START ONLY, expanding into an empty gap — creates a continuation.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("StartOnlyExpand");
      const deviceId = await insertDevice(empId, "StartOnlyExpand");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T13:00:00.000Z", "2026-08-28T17:00:00.000Z");

      const { previewRes, applyRes } = await previewThenApply(entryId, { startTime: "2026-08-28T12:00:00.000Z" });
      check(previewRes.status === 200, "2) preview succeeds for start-only expand", previewRes);
      check(previewRes.body.workedSecondsDelta === 3600, "2) preview reports +1h worked delta", previewRes.body.workedSecondsDelta);
      check(applyRes.status === 200, "2) apply succeeds", applyRes);
      const original = await getEntry(entryId);
      check(original.started_at.toISOString() === "2026-08-28T13:00:00.000Z", "2) original entry's own start is untouched (never grown outward)", original.started_at);
      const dayRows = await findEntriesForEmployeeDay(empId, "2026-08-28");
      check(dayRows.length === 2, "2) exactly one new continuation entry created", dayRows.length);
      const gapFill = dayRows.find((r) => r.id !== entryId);
      check(gapFill && gapFill.started_at.toISOString() === "2026-08-28T12:00:00.000Z" && gapFill.ended_at.toISOString() === "2026-08-28T13:00:00.000Z", "2) continuation exactly fills 12:00-1:00 PM", gapFill);
      check(gapFill.created_by_employee_id === adminId, "2) continuation records the administrator", gapFill.created_by_employee_id);
    }

    // -----------------------------------------------------------------
    // 3) BOTH start and end edited in one correction.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("BothEdited");
      const deviceId = await insertDevice(empId, "BothEdited");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T13:00:00.000Z", "2026-08-28T17:00:00.000Z");

      const { previewRes, applyRes } = await previewThenApply(entryId, {
        startTime: "2026-08-28T12:00:00.000Z",
        endTime: "2026-08-28T18:00:00.000Z",
      });
      check(previewRes.status === 200, "3) preview succeeds for a combined start+end correction", previewRes);
      check(applyRes.status === 200, "3) apply succeeds", applyRes);
      const dayRows = await findEntriesForEmployeeDay(empId, "2026-08-28");
      check(dayRows.length === 3, "3) two new gap-fill continuations created (before start, after end)", dayRows.length);
      const total = dayRows.reduce((sum, r) => sum + (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()), 0);
      check(total === 6 * 3600 * 1000, "3) combined coverage is exactly 12:00 PM-6:00 PM (6h)", total);
    }

    // -----------------------------------------------------------------
    // 4) Shortening from the start removes a fully-covered leftover
    //    segment of a merged multi-segment run entirely.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ShortenRemovesSeg");
      const deviceId = await insertDevice(empId, "ShortenRemovesSeg");
      const segA = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-28T09:00:00.000Z", "2026-08-28T11:00:00.000Z");

      const { applyRes } = await previewThenApply(segB, { startTime: "2026-08-28T09:30:00.000Z" });
      check(applyRes.status === 200, "4) apply succeeds", applyRes);
      const a = await getEntry(segA);
      check(a.deleted_at !== null, "4) segment A (now entirely before the new start) is soft-deleted", a.deleted_at);
      const b = await getEntry(segB);
      check(b.started_at.toISOString() === "2026-08-28T09:30:00.000Z", "4) segment B trimmed to the new start", b.started_at);
      const dels = await deletionsFor([segA]);
      check(dels.length === 1 && dels[0].reason === "Removed — outside the corrected time range", "4) deletion audit uses the outside-range reason", dels);
    }

    // -----------------------------------------------------------------
    // 5) Expanding across a SINGLE protected break — split around it.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("SingleBreakSplit");
      const deviceId = await insertDevice(empId, "SingleBreakSplit");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T12:45:00.000Z", "2026-08-28T16:00:00.000Z", { activityId: packingPeppersId });
      const brk = await insertBreak(empId, deviceId, "2026-08-28T16:00:00.000Z", "2026-08-28T17:00:00.000Z");

      const { previewRes, applyRes } = await previewThenApply(entryId, { endTime: "2026-08-28T22:00:00.000Z" });
      check(previewRes.status === 200, "5) preview succeeds expanding across a break", previewRes);
      check(applyRes.status === 200, "5) apply succeeds", applyRes);

      const original = await getEntry(entryId);
      check(original.ended_at.toISOString() === "2026-08-28T16:00:00.000Z", "5) original segment's end is untouched (still meets the break exactly)", original.ended_at);
      const breakRow = await getEntry(brk);
      check(breakRow.deleted_at === null, "5) the break is never touched", breakRow.deleted_at);
      check(breakRow.started_at.toISOString() === "2026-08-28T16:00:00.000Z" && breakRow.ended_at.toISOString() === "2026-08-28T17:00:00.000Z", "5) the break's own boundaries are unchanged", breakRow);

      const dayRows = await findEntriesForEmployeeDay(empId, "2026-08-28");
      const continuation = dayRows.find((r) => r.id !== entryId && r.entry_type === "work");
      check(!!continuation && continuation.started_at.toISOString() === "2026-08-28T17:00:00.000Z" && continuation.ended_at.toISOString() === "2026-08-28T22:00:00.000Z", "5) continuation resumes exactly at break-end through the new end", continuation);
      check(continuation.activity_id === packingPeppersId, "5) continuation copies the corrected activity", continuation.activity_id);
    }

    // -----------------------------------------------------------------
    // 6) Expanding across MULTIPLE breaks — split into multiple pieces,
    //    every break preserved.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("MultiBreakSplit");
      const deviceId = await insertDevice(empId, "MultiBreakSplit");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      const brk1 = await insertBreak(empId, deviceId, "2026-08-28T09:00:00.000Z", "2026-08-28T09:15:00.000Z");
      const brk2 = await insertBreak(empId, deviceId, "2026-08-28T12:00:00.000Z", "2026-08-28T13:00:00.000Z");

      const { applyRes } = await previewThenApply(entryId, { endTime: "2026-08-28T17:00:00.000Z" });
      check(applyRes.status === 200, "6) apply succeeds spanning two breaks", applyRes);

      const b1 = await getEntry(brk1);
      const b2 = await getEntry(brk2);
      check(b1.deleted_at === null && b2.deleted_at === null, "6) both breaks survive untouched", { b1: b1.deleted_at, b2: b2.deleted_at });

      const dayRows = await findEntriesForEmployeeDay(empId, "2026-08-28");
      const workRows = dayRows.filter((r) => r.entry_type === "work").sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
      check(workRows.length === 3, "6) three work segments total: original + two gap-fill continuations", workRows.length);
      check(
        workRows[0].started_at.toISOString() === "2026-08-28T07:00:00.000Z" && workRows[0].ended_at.toISOString() === "2026-08-28T09:00:00.000Z",
        "6) segment 1 unchanged",
        workRows[0]
      );
      check(
        workRows[1].started_at.toISOString() === "2026-08-28T09:15:00.000Z" && workRows[1].ended_at.toISOString() === "2026-08-28T12:00:00.000Z",
        "6) segment 2 fills the gap between the two breaks",
        workRows[1]
      );
      check(
        workRows[2].started_at.toISOString() === "2026-08-28T13:00:00.000Z" && workRows[2].ended_at.toISOString() === "2026-08-28T17:00:00.000Z",
        "6) segment 3 fills the gap after the last break through the new end",
        workRows[2]
      );
    }

    // -----------------------------------------------------------------
    // 7) Same-activity/row/carrier/density entry elsewhere in the day is
    //    merged into the corrected run rather than duplicated.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("MergeSameActivity");
      const deviceId = await insertDevice(empId, "MergeSameActivity");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      // A separate, pre-existing same-activity entry sitting exactly where
      // expansion will reach — must be absorbed (trimmed/kept), not
      // duplicated by a redundant new continuation.
      const nearby = await insertWork(empId, deviceId, "2026-08-28T10:00:00.000Z", "2026-08-28T12:00:00.000Z");

      const { applyRes } = await previewThenApply(entryId, { endTime: "2026-08-28T12:00:00.000Z" });
      check(applyRes.status === 200, "7) apply succeeds", applyRes);

      const dayRows = await findEntriesForEmployeeDay(empId, "2026-08-28");
      const workRows = dayRows.filter((r) => r.entry_type === "work");
      check(workRows.length === 3, "7) exactly one gap-fill continuation added (9-10 AM), nearby entry reused not duplicated", workRows.length);
      const nearbyAfter = await getEntry(nearby);
      check(nearbyAfter.deleted_at === null, "7) the nearby same-activity entry survives, absorbed rather than replaced", nearbyAfter.deleted_at);
    }

    // -----------------------------------------------------------------
    // 8) Different activity — overlap only a boundary — trimmed.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ForeignBoundaryTrim");
      const deviceId = await insertDevice(empId, "ForeignBoundaryTrim");
      const foreign = await insertWork(empId, deviceId, "2026-08-28T08:00:00.000Z", "2026-08-28T11:00:00.000Z", { activityId: activityIdB });
      const entryId = await insertWork(empId, deviceId, "2026-08-28T14:00:00.000Z", "2026-08-28T16:00:00.000Z");

      const { previewRes, applyRes } = await previewThenApply(entryId, { startTime: "2026-08-28T10:00:00.000Z" });
      check(previewRes.body.messages.some((m: string) => /trimmed/.test(m)), "8) preview mentions the foreign activity being trimmed", previewRes.body.messages);
      check(applyRes.status === 200, "8) apply succeeds", applyRes);
      const foreignAfter = await getEntry(foreign);
      check(foreignAfter.ended_at.toISOString() === "2026-08-28T10:00:00.000Z", "8) foreign entry's end trimmed to the new start", foreignAfter.ended_at);
      check(foreignAfter.deleted_at === null, "8) foreign entry itself survives (only trimmed)", foreignAfter.deleted_at);
    }

    // -----------------------------------------------------------------
    // 9) Different activity — entirely covered — soft-deleted.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ForeignCoveredDelete");
      const deviceId = await insertDevice(empId, "ForeignCoveredDelete");
      const foreign = await insertWork(empId, deviceId, "2026-08-28T10:00:00.000Z", "2026-08-28T11:00:00.000Z", { activityId: activityIdB });
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");

      const { applyRes } = await previewThenApply(entryId, { endTime: "2026-08-28T12:00:00.000Z" });
      check(applyRes.status === 200, "9) apply succeeds", applyRes);
      const foreignAfter = await getEntry(foreign);
      check(foreignAfter.deleted_at !== null, "9) fully-covered foreign entry is soft-deleted", foreignAfter.deleted_at);
      const dels = await deletionsFor([foreign]);
      check(dels.length === 1 && dels[0].reason === "Removed — fully covered by a time correction", "9) deletion audit uses the foreign-covered reason", dels);
    }

    // -----------------------------------------------------------------
    // 10) Different activity — entirely CONTAINS the corrected range —
    //     split: trimmed short, plus its own continuation resumes after.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ForeignSplit");
      const deviceId = await insertDevice(empId, "ForeignSplit");
      const foreign = await insertWork(empId, deviceId, "2026-08-28T06:00:00.000Z", "2026-08-28T18:00:00.000Z", { activityId: activityIdB });
      const entryId = await insertWork(empId, deviceId, "2026-08-28T10:00:00.000Z", "2026-08-28T10:00:01.000Z");

      const { previewRes, applyRes } = await previewThenApply(entryId, { startTime: "2026-08-28T10:00:00.000Z", endTime: "2026-08-28T14:00:00.000Z" });
      check(previewRes.body.messages.some((m: string) => /will continue/.test(m)), "10) preview mentions the foreign activity's continuation", previewRes.body.messages);
      check(applyRes.status === 200, "10) apply succeeds", applyRes);
      const foreignAfter = await getEntry(foreign);
      check(foreignAfter.ended_at.toISOString() === "2026-08-28T10:00:00.000Z", "10) foreign entry trimmed short at the corrected range's start", foreignAfter.ended_at);
      const dayRows = await findEntriesForEmployeeDay(empId, "2026-08-28");
      const foreignContinuation = dayRows.find((r) => r.activity_id === activityIdB && r.id !== foreign);
      check(!!foreignContinuation && foreignContinuation.started_at.toISOString() === "2026-08-28T14:00:00.000Z" && foreignContinuation.ended_at.toISOString() === "2026-08-28T18:00:00.000Z", "10) foreign continuation resumes exactly at the corrected range's end", foreignContinuation);
    }

    // -----------------------------------------------------------------
    // 11) Workday-boundary changes: the corrected activity becomes the
    //     day's LAST work of the day — worked total and displayed end
    //     update automatically (computeWorkdayTotals, no separate field).
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("WorkdayBoundary");
      const deviceId = await insertDevice(empId, "WorkdayBoundary");
      const morning = await insertWork(empId, deviceId, "2026-08-28T11:00:00.000Z", "2026-08-28T13:00:00.000Z");
      const brk = await insertBreak(empId, deviceId, "2026-08-28T13:00:00.000Z", "2026-08-28T14:00:00.000Z");

      const dailyBefore = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=2026-08-28`, adminToken);
      check(dailyBefore.body.totals.workedSeconds === 7200, "11) before correction, worked = 2h (span 11-1, no work after break)", dailyBefore.body.totals.workedSeconds);

      const { applyRes } = await previewThenApply(morning, { endTime: "2026-08-28T18:00:00.000Z" });
      check(applyRes.status === 200, "11) apply succeeds", applyRes);

      const dailyAfter = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=2026-08-28`, adminToken);
      check(dailyAfter.body.totals.workedSeconds === 7 * 3600 - 3600, "11) worked total now spans 11 AM-6 PM minus the 1h break = 6h", dailyAfter.body.totals.workedSeconds);
      const lastRun = dailyAfter.body.runs[dailyAfter.body.runs.length - 1];
      check(lastRun.endedAt === "2026-08-28T18:00:00.000Z", "11) the displayed run's own end now shows the new workday end (6 PM)", lastRun.endedAt);
      void brk;
    }

    // -----------------------------------------------------------------
    // 12) Exact boundary contact — new end exactly equals the next
    //     entry's start — valid, neighbor untouched.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ExactContact");
      const deviceId = await insertDevice(empId, "ExactContact");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      const neighbor = await insertWork(empId, deviceId, "2026-08-28T10:00:00.000Z", "2026-08-28T11:00:00.000Z", { activityId: activityIdB });

      const { applyRes } = await previewThenApply(entryId, { endTime: "2026-08-28T10:00:00.000Z" });
      check(applyRes.status === 200, "12) extending exactly to the next entry's start is accepted", applyRes);
      const neighborAfter = await getEntry(neighbor);
      check(neighborAfter.started_at.toISOString() === "2026-08-28T10:00:00.000Z" && neighborAfter.deleted_at === null, "12) neighbor entry is completely untouched", neighborAfter);
    }

    // -----------------------------------------------------------------
    // 13) Rollback: a concurrent change to a would-be-trimmed row (direct
    //     update, bypassing the lock convention) must be caught by the
    //     fingerprint check and roll back the WHOLE plan atomically.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("RollbackTest");
      const deviceId = await insertDevice(empId, "RollbackTest");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");

      const previewRes = await preview(entryId, { endTime: "2026-08-28T10:00:00.000Z" });
      check(previewRes.status === 200, "13) preview succeeds", previewRes);

      // Someone else changes the entry's own end between preview and Save.
      await pool.query(`update time_entries set ended_at = $1 where id = $2`, ["2026-08-28T09:30:00.000Z", entryId]);

      const applyRes = await apply(entryId, { endTime: "2026-08-28T10:00:00.000Z", fingerprint: previewRes.body.fingerprint });
      check(applyRes.status === 409, "13) stale fingerprint is rejected with 409", applyRes);
      const after = await getEntry(entryId);
      check(after.ended_at.toISOString() === "2026-08-28T09:30:00.000Z", "13) the concurrent change is preserved, correction never applied on top of it", after.ended_at);
      check((await correctionsFor(entryId)).length === 0, "13) no correction audit row was written", entryId);
    }

    // -----------------------------------------------------------------
    // 14) Stale preview: previewing once, then a DIFFERENT correction
    //     changes the day, then applying the OLD preview's fingerprint
    //     must be rejected.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("StalePreview");
      const deviceId = await insertDevice(empId, "StalePreview");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");

      const firstPreview = await preview(entryId, { endTime: "2026-08-28T10:00:00.000Z" });
      check(firstPreview.status === 200, "14) first preview succeeds", firstPreview);

      // A different, legitimate correction (through the real route) changes
      // the day before the admin gets back to confirming the first one —
      // this is itself an extension, so it lands as a brand-new
      // continuation row (see test 2's own comment: an existing row is
      // never grown outward), not a trim of entryId's own row.
      const otherPreview = await preview(entryId, { endTime: "2026-08-28T09:45:00.000Z" });
      const otherApply = await apply(entryId, { endTime: "2026-08-28T09:45:00.000Z", fingerprint: otherPreview.body.fingerprint });
      check(otherApply.status === 200, "14) the newer correction applies fine", otherApply);
      const afterOther = await findEntriesForEmployeeDay(empId, "2026-08-28");
      check(
        afterOther.length === 2 && afterOther.some((r) => r.ended_at.toISOString() === "2026-08-28T09:45:00.000Z"),
        "14) the newer correction's continuation is present, ending at 9:45",
        afterOther
      );

      const staleApply = await apply(entryId, { endTime: "2026-08-28T10:00:00.000Z", fingerprint: firstPreview.body.fingerprint });
      check(staleApply.status === 409, "14) applying the now-stale first preview is rejected", staleApply);
      const after = await findEntriesForEmployeeDay(empId, "2026-08-28");
      check(after.length === 2, "14) the stale apply added nothing — still exactly the original entry plus the one continuation", after.length);
    }

    // -----------------------------------------------------------------
    // 15) Double Save: two identical apply calls fired at once — exactly
    //     one succeeds, the plan is applied exactly once.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("DoubleSave");
      const deviceId = await insertDevice(empId, "DoubleSave");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");

      const previewRes = await preview(entryId, { endTime: "2026-08-28T10:00:00.000Z" });
      const body = { endTime: "2026-08-28T10:00:00.000Z", fingerprint: previewRes.body.fingerprint };
      const [r1, r2] = await Promise.all([apply(entryId, body), apply(entryId, body)]);
      const statuses = [r1.status, r2.status].sort();
      check(statuses[0] === 200 && statuses[1] !== 200, "15) exactly one of two concurrent Saves succeeds", { r1: r1.status, r2: r2.status });
      // A pure extension creates one new continuation row rather than
      // trimming entryId's own row (see test 2) — "applied exactly once"
      // means exactly one such continuation exists, not two.
      const dayRows = await findEntriesForEmployeeDay(empId, "2026-08-28");
      check(dayRows.length === 2, "15) the plan was applied exactly once (one continuation, not two)", dayRows.length);
      const continuation = dayRows.find((r) => r.id !== entryId);
      check(!!continuation && continuation.ended_at.toISOString() === "2026-08-28T10:00:00.000Z", "15) the single continuation ends at exactly 10:00", continuation);
    }

    // -----------------------------------------------------------------
    // 16) Concurrency across two DIFFERENT employees — independent
    //     corrections never block or interfere with each other.
    // -----------------------------------------------------------------
    {
      const empA = await insertEmployee("ConcurrentA");
      const devA = await insertDevice(empA, "ConcurrentA");
      const entryA = await insertWork(empA, devA, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      const empB = await insertEmployee("ConcurrentB");
      const devB = await insertDevice(empB, "ConcurrentB");
      const entryB = await insertWork(empB, devB, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");

      const [resA, resB] = await Promise.all([
        previewThenApply(entryA, { endTime: "2026-08-28T10:00:00.000Z" }),
        previewThenApply(entryB, { endTime: "2026-08-28T11:00:00.000Z" }),
      ]);
      check(resA.applyRes.status === 200 && resB.applyRes.status === 200, "16) both independent employees' corrections succeed concurrently", {
        a: resA.applyRes.status,
        b: resB.applyRes.status,
      });
    }

    // -----------------------------------------------------------------
    // 17) Audits: correction rows for both started_at/ended_at field
    //     types, deletion audit content, and continuation provenance.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("AuditContent");
      const deviceId = await insertDevice(empId, "AuditContent");
      // Both boundaries SHORTENED (start moves later, end moves earlier) —
      // both are trims of the same existing row, unlike an expansion (see
      // test 2's own comment on why growth is always a new row instead).
      const entryId = await insertWork(empId, deviceId, "2026-08-28T08:00:00.000Z", "2026-08-28T12:00:00.000Z");

      await previewThenApply(entryId, { startTime: "2026-08-28T09:00:00.000Z", endTime: "2026-08-28T11:00:00.000Z" });
      const corrections = await correctionsFor(entryId);
      check(corrections.some((c) => c.field_name === "started_at" && c.old_value === "2026-08-28T08:00:00.000Z" && c.new_value === "2026-08-28T09:00:00.000Z"), "17) started_at correction audit row is exact", corrections);
      check(corrections.some((c) => c.field_name === "ended_at" && c.old_value === "2026-08-28T12:00:00.000Z" && c.new_value === "2026-08-28T11:00:00.000Z"), "17) ended_at correction audit row is exact", corrections);
      check(corrections.every((c) => c.reason === "Time corrected from Inputs page"), "17) every correction row carries the fixed audit reason", corrections);
    }

    // -----------------------------------------------------------------
    // 18) In-progress (open) entry overlapping the range — rejected.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("OpenEntryReject");
      const deviceId = await insertDevice(empId, "OpenEntryReject");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      await insertWork(empId, deviceId, "2026-08-28T10:00:00.000Z", null, { activityId: activityIdB });

      const res = await preview(entryId, { endTime: "2026-08-28T12:00:00.000Z" });
      check(res.status === 409, "18) an in-progress overlapping entry is rejected clearly", res);
    }

    // -----------------------------------------------------------------
    // 19) In-progress break inside the range — rejected.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("OpenBreakReject");
      const deviceId = await insertDevice(empId, "OpenBreakReject");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source)
         values ($1, $2, 'break', $3, $4, null, 'manual') returning id`,
        [empId, deviceId, randomUUID(), "2026-08-28T10:00:00.000Z"]
      );

      const res = await preview(entryId, { endTime: "2026-08-28T12:00:00.000Z" });
      check(res.status === 409, "19) an in-progress break inside the range is rejected clearly", res);
    }

    // -----------------------------------------------------------------
    // 20) Entire corrected range covered by a break — nothing to correct.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("EntireRangeBreak");
      const deviceId = await insertDevice(empId, "EntireRangeBreak");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      await insertBreak(empId, deviceId, "2026-08-28T09:00:00.000Z", "2026-08-28T10:00:00.000Z");

      // Both boundaries set to exactly the break's own span — the
      // requested [start, end) is nothing but that break.
      const res = await preview(entryId, { startTime: "2026-08-28T09:00:00.000Z", endTime: "2026-08-28T10:00:00.000Z" });
      check(res.status === 422, "20) a range entirely covered by a break is rejected", res);
    }

    // -----------------------------------------------------------------
    // 21) Role enforcement — an Employee-role session is rejected.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("RoleCheck");
      const deviceId = await insertDevice(empId, "RoleCheck");
      const entryId = await insertWork(empId, deviceId, "2026-08-28T07:00:00.000Z", "2026-08-28T09:00:00.000Z");
      const res = await preview(entryId, { endTime: "2026-08-28T10:00:00.000Z" }, employeeToken);
      check(res.status === 403, "21) an Employee-role session is rejected on preview", res);
    }

    // -----------------------------------------------------------------
    // 22) Lemuel's exact real-world case, reproduced with a disposable
    //     fixture: Packing Peppers 8:45 AM-12:00 PM, break 12:00-1:00 PM,
    //     nothing after. Correct the run's END to 6:00 PM.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("Lemuel");
      const deviceId = await insertDevice(empId, "Lemuel");
      const morning = await insertWork(empId, deviceId, "2026-08-28T12:45:00.000Z", "2026-08-28T16:00:00.000Z", { activityId: packingPeppersId });
      await insertBreak(empId, deviceId, "2026-08-28T16:00:00.000Z", "2026-08-28T17:00:00.000Z");

      const { previewRes, applyRes } = await previewThenApply(morning, { endTime: "2026-08-28T22:00:00.000Z" });
      check(previewRes.status === 200, "22) Lemuel: preview succeeds", previewRes);
      check(applyRes.status === 200, "22) Lemuel: apply succeeds", applyRes);

      const dailyRes = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=2026-08-28`, adminToken);
      check(dailyRes.body.workStartTime === "2026-08-28T12:45:00.000Z", "22) Lemuel: work start remains 8:45 AM", dailyRes.body.workStartTime);
      check(dailyRes.body.totals.workedSeconds === 29700, "22) Lemuel: worked = 8:15:00 (29700s)", dailyRes.body.totals.workedSeconds);
      check(dailyRes.body.totals.breakSeconds === 3600, "22) Lemuel: break = 1:00:00 (3600s)", dailyRes.body.totals.breakSeconds);
      // groupIntoActivityRuns merges the two Packing Peppers segments back
      // into ONE displayed run across the break — it's transparent because
      // the continuation resumes exactly at the break's own end with the
      // same activity/row/carrier/density (see activityRuns.ts).
      check(dailyRes.body.runs.length === 1, "22) Lemuel: one merged Packing Peppers run displayed (break is transparent)", dailyRes.body.runs.length);
      const run = dailyRes.body.runs[0];
      check(run.endedAt === "2026-08-28T22:00:00.000Z", "22) Lemuel: workday end now shows 6:00 PM", run.endedAt);
      check(run.durationSeconds === 29700, "22) Lemuel: the run's own duration is 8:15:00, matching Worked", run.durationSeconds);
    }

    console.log(`ACTIVITY_CORRECTION reason sanity: audit rows verified above`);
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      const maxAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await fn();
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
      fail++;
      console.error(`FAIL: cleanup step "${label}" failed after ${maxAttempts} attempts:`, lastErr);
    }

    if (employeeIds.length) {
      await tryDelete("time_entry_deletions (by employee)", () =>
        pool.query(`delete from time_entry_deletions where employee_id = any($1::uuid[])`, [employeeIds])
      );
    }
    if (timeEntryIds.length) {
      await tryDelete("time_entry_corrections", () =>
        pool.query(`delete from time_entry_corrections where time_entry_id = any($1::uuid[])`, [timeEntryIds])
      );
    }
    if (employeeIds.length) {
      await tryDelete("time_entry_corrections (by employee)", () =>
        pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("time_entries (by employee)", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
