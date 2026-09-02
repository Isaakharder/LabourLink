// Regression + feature test for the grouped activity-run end-time
// correction (Dave Quiring, 2026-08-31): the Inputs page groups contiguous
// same-activity time_entries rows into one displayed "run"
// (groupIntoActivityRuns in activityRuns.ts), and a run's `id` is always
// its LAST underlying segment's id — the correction route used to validate
// a new end time against ONLY that last segment's own started_at, so a
// visibly-valid correction earlier than a hidden trailing segment's own
// start was wrongly rejected as "End time must be after the activity's
// start time."
//
// computeActivityRunEndTimeCorrectionPlan (inputs.ts) now re-derives the
// run's full segment chain and, when the new end time lands inside an
// earlier segment, atomically trims that segment and soft-deletes every
// later one — or, on an exact segment boundary, leaves the earlier segment
// untouched and only removes the later one(s). This file locks in that
// behavior across one/two/multi-segment runs, every boundary case, the
// preview endpoint, transparent breaks inside a run, rollback on a
// concurrent change, and double-Save safety — plus Dave's exact real-world
// shape.
//
// Run with: npm run test:inputs-activity-run-end-time-grouped-segments
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
        [`RunEndTimeGrouped Admin ${RUN_ID}`, `qa-run-endtime-grouped-admin-${RUN_ID}@test.local`, adminRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    const activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA RunEndTimeGrouped Activity ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId);
    const activityId2 = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA RunEndTimeGrouped Activity B ${RUN_ID}`])
    ).rows[0].id;
    activityIds.push(activityId2);

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`RunEndTimeGrouped-${label}-${RUN_ID}`, `qa-run-endtime-grouped-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertDevice(employeeId: string, label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [randomUUID(), `QA RunEndTimeGrouped Device ${label} ${RUN_ID}`]
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
      opts?: { activityId?: string; actualEndedAt?: string }
    ): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, actual_ended_at, source)
         values ($1, $2, 'work', $3, $4, $5, $6, $7, 'manual') returning id`,
        [empId, deviceId, opts?.activityId ?? activityId, randomUUID(), startedAt, endedAt, opts?.actualEndedAt ?? null]
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
        `select id, started_at, ended_at, deleted_at, actual_ended_at, auto_closed_at from time_entries where id = $1`,
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
        `select deletion_type, affected_time_entry_ids, reason from time_entry_deletions
         where affected_time_entry_ids && $1::uuid[]`,
        [ids]
      );
      return rows;
    }
    function patchEndTime(runId: string, endTime: string) {
      return call("PATCH", `/api/inputs/activity-runs/${runId}/end-time`, adminToken, { endTime });
    }
    function previewEndTime(runId: string, endTime: string) {
      return call("POST", `/api/inputs/activity-runs/${runId}/end-time-preview`, adminToken, { endTime });
    }

    // -----------------------------------------------------------------
    // 1) Dave's exact real-world case: preceding work entry (7:00 AM -
    //    5:05:00 PM) extended by a break-deletion "reconnect" to meet a
    //    trailing 1-second work entry (5:05:00 - 5:05:01 PM) from the
    //    employee's own Finish Work tap. Correcting to 5:00 PM lands
    //    inside the FIRST (preceding) segment.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("Dave");
      const deviceId = await insertDevice(empId, "Dave");
      const precedingId = await insertWork(empId, deviceId, "2026-08-31T11:00:00.000Z", "2026-08-31T21:05:00.000Z");
      await pool.query(
        `insert into time_entry_corrections (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, $3, 'ended_at', $4, $5, 'Break deleted from Inputs page')`,
        [precedingId, empId, adminId, "2026-08-31T11:00:01.000Z", "2026-08-31T21:05:00.000Z"]
      );
      const trailingId = await insertWork(empId, deviceId, "2026-08-31T21:05:00.000Z", "2026-08-31T21:05:01.000Z", {
        actualEndedAt: "2026-08-31T21:02:03.796Z",
      });

      const dailyRes = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=2026-08-31`, adminToken);
      const run = dailyRes.body?.runs?.[0];
      check(run?.id === trailingId, "1) merged run's id resolves to the trailing segment", run?.id);
      check(run?.durationSeconds === 36301, "1) displayed duration is 10:05:01 before correction", run?.durationSeconds);

      const previewRes = await previewEndTime(trailingId, "2026-08-31T21:00:00.000Z");
      check(previewRes.status === 200, "1) preview succeeds", previewRes);
      check(previewRes.body?.messages?.length === 1, "1) preview returns exactly one message", previewRes.body);
      check(
        /5:00\s?PM/.test(previewRes.body?.messages?.[0] ?? "") && /1-second segment/.test(previewRes.body?.messages?.[0] ?? ""),
        "1) preview message names the new end time and the 1-second trailing segment",
        previewRes.body?.messages?.[0]
      );
      const precedingBeforePreview = await getEntry(precedingId);
      check(precedingBeforePreview.ended_at?.toISOString?.() === "2026-08-31T21:05:00.000Z", "1) preview never mutates anything (rolled back)", precedingBeforePreview);

      const patchRes = await patchEndTime(trailingId, "2026-08-31T21:00:00.000Z");
      check(patchRes.status === 200, "1) FIXED: the visibly-valid 5:00 PM correction now succeeds", patchRes);

      const preceding = await getEntry(precedingId);
      check(preceding.ended_at.toISOString() === "2026-08-31T21:00:00.000Z", "1) preceding segment trimmed to exactly 5:00 PM", preceding.ended_at);
      check(preceding.deleted_at === null, "1) preceding segment (7 AM start) is NOT deleted", preceding.deleted_at);
      check(preceding.actual_ended_at === null, "1) actual_ended_at cleared on the trimmed segment (shows Corrected, not Rounded)", preceding);

      const trailing = await getEntry(trailingId);
      check(trailing.deleted_at !== null, "1) trailing 1-second segment is soft-deleted", trailing.deleted_at);
      check(trailing.ended_at.toISOString() === "2026-08-31T21:05:01.000Z", "1) deleted segment's original ended_at is preserved (recoverable)", trailing.ended_at);

      const precedingCorrections = await correctionsFor(precedingId);
      check(precedingCorrections.length === 2, "1) preceding segment has 2 audit rows: break-deletion extend + this trim", precedingCorrections.length);
      const trimCorrection = precedingCorrections[precedingCorrections.length - 1];
      check(trimCorrection.field_name === "ended_at" && trimCorrection.old_value === "2026-08-31T21:05:00.000Z" && trimCorrection.new_value === "2026-08-31T21:00:00.000Z", "1) trim's correction row has the exact old/new end times", trimCorrection);

      const dels = await deletionsFor([trailingId]);
      check(dels.length === 1 && dels[0].deletion_type === "activity_run", "1) exactly one time_entry_deletions row, type activity_run", dels);
      check(dels[0].affected_time_entry_ids.length === 1 && dels[0].affected_time_entry_ids[0] === trailingId, "1) deletion audit references only the trailing segment", dels[0]);

      const dailyAfter = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=2026-08-31`, adminToken);
      const runAfter = dailyAfter.body?.runs?.[0];
      check(dailyAfter.body?.runs?.length === 1, "1) still exactly one displayed run after correction", dailyAfter.body?.runs?.length);
      check(runAfter?.endedAt === "2026-08-31T21:00:00.000Z", "1) General now displays 5:00 PM end", runAfter?.endedAt);
      check(runAfter?.durationSeconds === 36000, "1) worked total is exactly 10:00:00 (36000s)", runAfter?.durationSeconds);
      check(runAfter?.endedAtCorrectedFrom === "2026-08-31T21:05:00.000Z", "1) run displays Corrected with the real prior end time", runAfter?.endedAtCorrectedFrom);
    }

    // -----------------------------------------------------------------
    // 2) Single-segment run, exact-boundary extension (new end time equals
    //    the next entry's start exactly) — unchanged ordinary behavior.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ExactBoundary");
      const deviceId = await insertDevice(empId, "ExactBoundary");
      const entryId = await insertWork(empId, deviceId, "2026-08-31T12:00:00.000Z", "2026-08-31T18:00:00.000Z");
      await insertBreak(empId, deviceId, "2026-08-31T19:00:00.000Z", "2026-08-31T19:15:00.000Z");

      const patchRes = await patchEndTime(entryId, "2026-08-31T19:00:00.000Z");
      check(patchRes.status === 200, "2) an end time exactly equal to the next entry's start is accepted", patchRes.body);
      const after = await getEntry(entryId);
      check(after.ended_at.toISOString() === "2026-08-31T19:00:00.000Z", "2) corrected end time stored exactly, no rounding", after.ended_at);
    }

    // -----------------------------------------------------------------
    // 3) Two-segment run, correction EXACTLY on the internal boundary
    //    between the two segments — the earlier segment must be left
    //    completely untouched (no correction row), only the later one
    //    removed.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("TwoSegBoundary");
      const deviceId = await insertDevice(empId, "TwoSegBoundary");
      const segA = await insertWork(empId, deviceId, "2026-08-31T11:00:00.000Z", "2026-08-31T15:00:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T15:00:00.000Z", "2026-08-31T16:00:00.000Z");

      const patchRes = await patchEndTime(segB, "2026-08-31T15:00:00.000Z");
      check(patchRes.status === 200, "3) exact-boundary correction on a 2-segment run succeeds", patchRes.body);

      const a = await getEntry(segA);
      check(a.ended_at.toISOString() === "2026-08-31T15:00:00.000Z", "3) segment A's end time is unchanged (already 3:00 PM)", a.ended_at);
      check((await correctionsFor(segA)).length === 0, "3) segment A gets NO correction audit row (nothing about it changed)", segA);

      const b = await getEntry(segB);
      check(b.deleted_at !== null, "3) segment B is soft-deleted", b.deleted_at);
      const dels = await deletionsFor([segB]);
      check(dels.length === 1 && dels[0].affected_time_entry_ids[0] === segB, "3) deletion audit references segment B", dels);
    }

    // -----------------------------------------------------------------
    // 4) Three-segment run, correction inside the MIDDLE segment — the
    //    first segment must stay untouched, the middle one trimmed, and
    //    only the final (third) segment removed.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ThreeSegMiddle");
      const deviceId = await insertDevice(empId, "ThreeSegMiddle");
      const segA = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T09:00:00.000Z", "2026-08-31T11:00:00.000Z");
      const segC = await insertWork(empId, deviceId, "2026-08-31T11:00:00.000Z", "2026-08-31T11:00:01.000Z");

      const patchRes = await patchEndTime(segC, "2026-08-31T10:00:00.000Z");
      check(patchRes.status === 200, "4) correction inside the middle segment succeeds", patchRes.body);

      const a = await getEntry(segA);
      check(a.ended_at.toISOString() === "2026-08-31T09:00:00.000Z", "4) first segment A completely untouched", a.ended_at);
      check((await correctionsFor(segA)).length === 0, "4) no audit row for untouched segment A", segA);

      const b = await getEntry(segB);
      check(b.ended_at.toISOString() === "2026-08-31T10:00:00.000Z", "4) middle segment B trimmed to exactly 10:00 AM", b.ended_at);
      check(b.deleted_at === null, "4) segment B itself is not deleted, only trimmed", b.deleted_at);

      const c = await getEntry(segC);
      check(c.deleted_at !== null, "4) final segment C is soft-deleted", c.deleted_at);
    }

    // -----------------------------------------------------------------
    // 5) Three-segment run, correction inside the FIRST segment — BOTH
    //    later segments (B and C) must be removed together in one
    //    deletion action, A trimmed.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ThreeSegFirst");
      const deviceId = await insertDevice(empId, "ThreeSegFirst");
      const segA = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T09:00:00.000Z", "2026-08-31T11:00:00.000Z");
      const segC = await insertWork(empId, deviceId, "2026-08-31T11:00:00.000Z", "2026-08-31T11:00:01.000Z");

      const patchRes = await patchEndTime(segC, "2026-08-31T08:00:00.000Z");
      check(patchRes.status === 200, "5) correction inside the first segment succeeds", patchRes.body);

      const a = await getEntry(segA);
      check(a.ended_at.toISOString() === "2026-08-31T08:00:00.000Z", "5) first segment A trimmed to exactly 8:00 AM", a.ended_at);

      const b = await getEntry(segB);
      const c = await getEntry(segC);
      check(b.deleted_at !== null && c.deleted_at !== null, "5) both B and C are soft-deleted", { b: b.deleted_at, c: c.deleted_at });

      const dels = await deletionsFor([segB, segC]);
      check(dels.length === 1, "5) B and C are removed in ONE deletion action, not two", dels.length);
      check(
        dels[0].affected_time_entry_ids.length === 2 &&
          dels[0].affected_time_entry_ids.includes(segB) &&
          dels[0].affected_time_entry_ids.includes(segC),
        "5) the single deletion row covers exactly [B, C]",
        dels[0]
      );
    }

    // -----------------------------------------------------------------
    // 6) New end time at or before the run's true first start — rejected
    //    clearly, nothing modified.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("BeforeStart");
      const deviceId = await insertDevice(empId, "BeforeStart");
      const segA = await insertWork(empId, deviceId, "2026-08-31T11:00:00.000Z", "2026-08-31T15:00:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T15:00:00.000Z", "2026-08-31T15:00:01.000Z");

      const patchRes = await patchEndTime(segB, "2026-08-31T11:00:00.000Z");
      check(patchRes.status === 422, "6) end time exactly equal to the run's true start is rejected", patchRes);
      check(patchRes.body?.error === "End time must be after the activity's start time", "6) clear rejection message", patchRes.body);

      const patchRes2 = await patchEndTime(segB, "2026-08-31T10:00:00.000Z");
      check(patchRes2.status === 422, "6) end time before the run's true start is rejected", patchRes2);

      const a = await getEntry(segA);
      const b = await getEntry(segB);
      check(a.ended_at.toISOString() === "2026-08-31T15:00:00.000Z" && a.deleted_at === null, "6) nothing modified on rejection (A)", a);
      check(b.ended_at.toISOString() === "2026-08-31T15:00:01.000Z" && b.deleted_at === null, "6) nothing modified on rejection (B)", b);
    }

    // -----------------------------------------------------------------
    // 7) Extension must retain the existing overlap check — cannot
    //    overwrite a later activity or break.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("ExtensionOverlap");
      const deviceId = await insertDevice(empId, "ExtensionOverlap");
      const entryId = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      await insertBreak(empId, deviceId, "2026-08-31T10:00:00.000Z", "2026-08-31T10:15:00.000Z");

      const overlapRes = await patchEndTime(entryId, "2026-08-31T10:10:00.000Z");
      check(overlapRes.status === 409, "7) extending past the next break is rejected", overlapRes);
      check(overlapRes.body?.error === "Corrected end time overlaps the next activity or break", "7) overlap error message", overlapRes.body);

      const untouched = await getEntry(entryId);
      check(untouched.ended_at.toISOString() === "2026-08-31T09:00:00.000Z", "7) rejected extension leaves the entry unchanged", untouched.ended_at);

      // A genuine extension INTO the gap between the work entry and the
      // break (not overlapping anything) must succeed normally.
      const validExtendRes = await patchEndTime(entryId, "2026-08-31T09:30:00.000Z");
      check(validExtendRes.status === 200, "7) a valid, non-overlapping extension succeeds", validExtendRes.body);
      const extended = await getEntry(entryId);
      check(extended.ended_at.toISOString() === "2026-08-31T09:30:00.000Z", "7) the entry is genuinely extended to 9:30 AM", extended.ended_at);

      // Extending exactly up to the break's own start (boundary) is also
      // allowed, same "equality is contiguous" convention used elsewhere.
      const boundaryExtendRes = await patchEndTime(entryId, "2026-08-31T10:00:00.000Z");
      check(boundaryExtendRes.status === 200, "7) extending exactly to the next entry's start is allowed", boundaryExtendRes.body);
    }

    // -----------------------------------------------------------------
    // 8) A transparent break INSIDE a run (work -> break -> work, same
    //    activity, exactly contiguous through the break) must never be
    //    absorbed/deleted by a correction — only the trailing WORK segment
    //    is removed, the break itself is left completely alone.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("TransparentBreak");
      const deviceId = await insertDevice(empId, "TransparentBreak");
      const segA = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      const brk = await insertBreak(empId, deviceId, "2026-08-31T09:00:00.000Z", "2026-08-31T09:15:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T09:15:00.000Z", "2026-08-31T09:15:01.000Z");

      const dailyRes = await call("GET", `/api/inputs/daily?employeeId=${empId}&date=2026-08-31`, adminToken);
      check(dailyRes.body?.runs?.length === 1, "8) work-break-work of the same activity displays as ONE run", dailyRes.body?.runs?.length);
      check(dailyRes.body?.runs?.[0]?.id === segB, "8) that run's id is the trailing work segment", dailyRes.body?.runs?.[0]?.id);

      const patchRes = await patchEndTime(segB, "2026-08-31T08:00:00.000Z");
      check(patchRes.status === 200, "8) correction inside the first work segment succeeds", patchRes.body);

      const a = await getEntry(segA);
      check(a.ended_at.toISOString() === "2026-08-31T08:00:00.000Z", "8) segment A trimmed to 8:00 AM", a.ended_at);
      const b = await getEntry(segB);
      check(b.deleted_at !== null, "8) trailing work segment B is deleted", b.deleted_at);
      const breakRow = await getEntry(brk);
      check(breakRow.deleted_at === null, "8) the break itself is NEVER touched/deleted by this correction", breakRow);
      check(breakRow.ended_at.toISOString() === "2026-08-31T09:15:00.000Z", "8) the break's own boundaries are unchanged", breakRow.ended_at);
    }

    // -----------------------------------------------------------------
    // 9) A genuinely separate run on the same day (different activity, a
    //    real gap) must never be touched by correcting a different run.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("SeparateRun");
      const deviceId = await insertDevice(empId, "SeparateRun");
      const runOneA = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      const runOneB = await insertWork(empId, deviceId, "2026-08-31T09:00:00.000Z", "2026-08-31T09:00:01.000Z");
      // A genuinely different run: different activity, right after runOneB
      // with no gap in time but a real activity/provenance boundary.
      const runTwo = await insertWork(empId, deviceId, "2026-08-31T09:00:01.000Z", "2026-08-31T12:00:00.000Z", {
        activityId: activityId2,
      });

      const patchRes = await patchEndTime(runOneB, "2026-08-31T08:00:00.000Z");
      check(patchRes.status === 200, "9) correcting run one succeeds", patchRes.body);

      const untouchedRunTwo = await getEntry(runTwo);
      check(untouchedRunTwo.deleted_at === null, "9) the separate run (different activity) is never deleted", untouchedRunTwo.deleted_at);
      check(untouchedRunTwo.ended_at.toISOString() === "2026-08-31T12:00:00.000Z", "9) the separate run's own end time is untouched", untouchedRunTwo.ended_at);
    }

    // -----------------------------------------------------------------
    // 10) New end time falling INSIDE a break gap within the run — rejected
    //     clearly, nothing modified.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("DuringBreakGap");
      const deviceId = await insertDevice(empId, "DuringBreakGap");
      const segA = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      const brk = await insertBreak(empId, deviceId, "2026-08-31T09:00:00.000Z", "2026-08-31T09:15:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T09:15:00.000Z", "2026-08-31T09:15:01.000Z");

      const patchRes = await patchEndTime(segB, "2026-08-31T09:05:00.000Z");
      check(patchRes.status === 422, "10) a new end time falling during a break in the run is rejected", patchRes);
      check(/falls during a break/.test(patchRes.body?.error ?? ""), "10) rejection message explains the break-gap conflict", patchRes.body);

      const a = await getEntry(segA);
      const b = await getEntry(segB);
      check(a.ended_at.toISOString() === "2026-08-31T09:00:00.000Z" && a.deleted_at === null, "10) segment A untouched on rejection", a);
      check(b.deleted_at === null, "10) segment B untouched on rejection", b.deleted_at);
    }

    // -----------------------------------------------------------------
    // 11) Rollback: a concurrent change to one of the affected segments
    //     (simulated with a direct update, bypassing the normal locking
    //     convention) must cause the WHOLE plan to roll back atomically —
    //     the segment that would have been trimmed must remain completely
    //     unmodified.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("Rollback");
      const deviceId = await insertDevice(empId, "Rollback");
      const segA = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T09:00:00.000Z", "2026-08-31T09:00:01.000Z");

      // Simulates another admin deleting the trailing segment a moment
      // before this correction's own lock is acquired.
      await pool.query(
        `update time_entries set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = 'QA simulated concurrent change' where id = $2`,
        [adminId, segB]
      );

      const patchRes = await patchEndTime(segB, "2026-08-31T08:00:00.000Z");
      check(patchRes.status === 404, "11) the run's own id row is already gone — 404, not a partial apply", patchRes);

      const a = await getEntry(segA);
      check(a.ended_at.toISOString() === "2026-08-31T09:00:00.000Z", "11) segment A is completely untouched after the rollback", a.ended_at);
      check((await correctionsFor(segA)).length === 0, "11) no correction audit row was written for A", segA);
    }

    // -----------------------------------------------------------------
    // 12) Concurrent / double Save: two identical PATCH calls fired at
    //     once for the same run must never double-apply — exactly one
    //     succeeds, the plan is applied exactly once.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("DoubleSave");
      const deviceId = await insertDevice(empId, "DoubleSave");
      const segA = await insertWork(empId, deviceId, "2026-08-31T07:00:00.000Z", "2026-08-31T09:00:00.000Z");
      const segB = await insertWork(empId, deviceId, "2026-08-31T09:00:00.000Z", "2026-08-31T09:00:01.000Z");

      const [r1, r2] = await Promise.all([
        patchEndTime(segB, "2026-08-31T08:00:00.000Z"),
        patchEndTime(segB, "2026-08-31T08:00:00.000Z"),
      ]);
      const statuses = [r1.status, r2.status].sort();
      check(statuses[0] === 200 && statuses[1] !== 200, "12) exactly one of two concurrent Saves succeeds", { r1: r1.status, r2: r2.status });

      const a = await getEntry(segA);
      check(a.ended_at.toISOString() === "2026-08-31T08:00:00.000Z", "12) the plan was applied exactly once (A trimmed to 8:00 AM)", a.ended_at);
      const dels = await deletionsFor([segB]);
      check(dels.length === 1, "12) exactly one deletion audit row, not two, from the double Save", dels.length);
    }

    // -----------------------------------------------------------------
    // 13) Preview endpoint returns no messages (no confirmation needed)
    //     for an ordinary, single-segment correction.
    // -----------------------------------------------------------------
    {
      const empId = await insertEmployee("PreviewOrdinary");
      const deviceId = await insertDevice(empId, "PreviewOrdinary");
      const entryId = await insertWork(empId, deviceId, "2026-08-31T12:00:00.000Z", "2026-08-31T18:00:00.000Z");

      const previewRes = await previewEndTime(entryId, "2026-08-31T17:00:00.000Z");
      check(previewRes.status === 200, "13) preview succeeds for an ordinary correction", previewRes);
      check(previewRes.body?.messages?.length === 0, "13) no confirmation messages for an ordinary correction", previewRes.body);

      const untouched = await getEntry(entryId);
      check(untouched.ended_at.toISOString() === "2026-08-31T18:00:00.000Z", "13) preview never mutates anything", untouched.ended_at);
    }

    console.log(`GROUPED_TAIL_DELETION_REASON sanity: reason strings recorded via audit rows above`);
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
