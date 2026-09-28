// Integration tests for AUTOMATIC row completion (server/src/lib/
// rowCompletionAutomation.ts) — the moment an employee genuinely leaves a
// greenhouse-row work entry (a different row, a different activity, a break
// does NOT count, or Finish Work), that row's row_completions record is
// created/extended automatically, no admin confirmation required. Real
// router (mobileTime + inputs) over real HTTP against the real database,
// same RUN_ID-suffixed disposable-fixture convention as
// mobileTime.switchWarnings.test.ts / mobileTime.syncEvents.test.ts.
//
// Covers exactly the required scenarios:
//   1) Row A -> Row B completes Row A.
//   2) Row A -> a different work activity completes Row A.
//   3) Row A -> break -> resume Row A does not double-complete it.
//   4) Row A completed -> SAME employee re-enters -> leaves again -> the
//      original completion is superseded by ONE new completion covering
//      both visits (never two active completions).
//   5) Row A completed -> a DIFFERENT employee re-enters -> leaves -> ONE
//      combined completion spanning both employees.
//   6) A duplicate (replayed) offline sync event creates no duplicate
//      completion.
//   7) A late/out-of-order offline event still converges to the correct
//      single completion once applied in device_seq order.
//   8) A visit at least 7 calendar dates after an active completion's own
//      latest segment starts a genuinely separate cycle/completion.
//   9) A manual Inputs correction (soft-deleting a segment) is reflected
//      live in the completion's own duration — reconciliation is real-time
//      re-derivation, never a stale persisted total.
//
// Run with: npm run test:mobile-time-row-completion-automation
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import mobileTimeRouter from "./mobileTime";
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
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/inputs", inputsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function mobile(path: string, deviceIdentifier: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/mobile${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function sync(deviceIdentifier: string, events: unknown[]): Promise<{ status: number; body: any }> {
    return mobile("/sync/events", deviceIdentifier, { events });
  }
  async function admin(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/inputs${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let landId!: string;
  let phaseId!: string;
  let rowActivityId!: string;
  let otherActivityId!: string;
  let questionId!: string;

  // Named for what most call sites actually want — only the CURRENT,
  // authoritative completion(s) — genuinely filtered to status='active'
  // (never all-statuses; use allCompletions below for the full history).
  async function activeCompletions(rowId: string): Promise<{ id: string; status: string; source: string }[]> {
    const { rows } = await pool.query(
      `select id, status, source from row_completions where greenhouse_row_id = $1 and activity_id = $2 and status = 'active' order by created_at`,
      [rowId, rowActivityId]
    );
    return rows;
  }
  async function allCompletions(rowId: string): Promise<{ id: string; status: string; source: string; superseded_by_completion_id: string | null }[]> {
    const { rows } = await pool.query(
      `select id, status, source, superseded_by_completion_id from row_completions where greenhouse_row_id = $1 and activity_id = $2 order by created_at`,
      [rowId, rowActivityId]
    );
    return rows;
  }
  async function segmentsFor(completionId: string): Promise<string[]> {
    const { rows } = await pool.query(`select time_entry_id from row_completion_segments where row_completion_id = $1`, [completionId]);
    return rows.map((r) => r.time_entry_id as string);
  }

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");

    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`RowAuto Admin ${RUN_ID}`, `qa-rowauto-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    async function makeEmployeeWithDevice(label: string): Promise<{ employeeId: string; deviceIdentifier: string }> {
      const employeeId = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
           values ('QA', $1, $2, $3, $4, $5, true) returning id`,
          [`RowAuto ${label} ${RUN_ID}`, `qa-rowauto-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
        )
      ).rows[0].id;
      employeeIds.push(employeeId);
      const deviceIdentifier = randomUUID();
      const deviceRowId = (
        await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
          deviceIdentifier,
          `QA RowAuto ${label} Device ${RUN_ID}`,
        ])
      ).rows[0].id;
      deviceIds.push(deviceRowId);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRowId, employeeId]);
      return { employeeId, deviceIdentifier };
    }
    // A SECOND device for an employee who already has one — device_seq is
    // tracked per-device (device_sync_state), so a test section that needs
    // its own fresh 1-based sequence (rather than continuing on from
    // whatever an earlier section already advanced empA's main device to)
    // needs a device of its own. Only one ACTIVE device_assignment is
    // allowed per employee at a time (033_one_active_device_per_employee.sql)
    // — mirrors an employee switching phones by unassigning the old one
    // first, same as the real admin Devices page would.
    async function makeExtraDevice(employeeId: string, label: string): Promise<string> {
      await pool.query(`update device_assignments set unassigned_at = now() where employee_id = $1 and unassigned_at is null`, [
        employeeId,
      ]);
      const deviceIdentifier = randomUUID();
      const deviceRowId = (
        await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [
          deviceIdentifier,
          `QA RowAuto ${label} Device ${RUN_ID}`,
        ])
      ).rows[0].id;
      deviceIds.push(deviceRowId);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [deviceRowId, employeeId]);
      return deviceIdentifier;
    }

    const empA = await makeEmployeeWithDevice("A");
    const empB = await makeEmployeeWithDevice("B");
    // Dedicated to tests 6-8 (all offline/sync-events, all using synthetic
    // occurredAtUtc timestamps deliberately offset from real "now") — kept
    // entirely separate from empA/empB's real-time direct-route state so a
    // synthetic timestamp can never collide with openEntry()'s pre-rounding
    // collapse/void boundary check (mobileTime.ts), which compares a new
    // event's own boundary against whatever's CURRENTLY open — a comparison
    // only meaningful when both sides share the same "real vs. synthetic"
    // clock, which a shared employee crossing between test sections would
    // violate.
    const empC = await makeEmployeeWithDevice("C");
    // Dedicated to test 8 alone — a backdated (8-days-ago) event can't
    // close whatever's currently open for an employee if that employee has
    // ANY already-open entry more recent than the backdate target (the
    // server correctly rejects closing an entry before its own start —
    // detectClockAnomaly/EVENTS_GUARDED_AGAINST_ADMIN_END, mobileTime.ts),
    // so this needs its own never-before-touched employee, not empC (whose
    // tests 6-7 leave it with a real-ish-time open entry).
    const empD = await makeEmployeeWithDevice("D");

    const groupId = (
      await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA RowAuto Group ${RUN_ID}`])
    ).rows[0].id;

    rowActivityId = (
      await pool.query(
        `insert into activities (name, is_active, minimum_duration_minutes, density_source) values ($1, true, 0, 'stems') returning id`,
        [`QA RowAuto RowActivity ${RUN_ID}`]
      )
    ).rows[0].id;
    otherActivityId = (
      await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [
        `QA RowAuto OtherActivity ${RUN_ID}`,
      ])
    ).rows[0].id;
    questionId = (
      await pool.query(
        `insert into activity_questions (activity_id, question_type, label, is_required, sort_order)
         values ($1, 'greenhouse_row', 'Which row?', true, 0) returning id`,
        [rowActivityId]
      )
    ).rows[0].id;
    await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2), ($1, $3)`, [
      groupId,
      rowActivityId,
      otherActivityId,
    ]);
    await pool.query(
      `insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2), ($3, $2), ($4, $2), ($5, $2)`,
      [empA.employeeId, groupId, empB.employeeId, empC.employeeId, empD.employeeId]
    );

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 200, 100) returning id`, [
        `QA RowAuto Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 200, 100) returning id`, [
        landId,
        `QA RowAuto Phase ${RUN_ID}`,
      ])
    ).rows[0].id;
    // Shared for every row this test creates — the exact quantity doesn't
    // matter for these structural (segment-count/completion-existence)
    // assertions, only that resolveDensitySnapshot (activitySelection.ts)
    // can resolve a real, non-null density_count_per_row for each row, the
    // same way a real greenhouse row configured for this activity's
    // density_source would.
    const plantDensityId = (
      await pool.query(`insert into plant_densities (name, type, count_per_row) values ($1, 'stems', 636) returning id`, [
        `QA RowAuto Density ${RUN_ID}`,
      ])
    ).rows[0].id;

    let nextRowNumber = 1;
    async function makeRow(): Promise<string> {
      const rowId = (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, 3, 2, 20, 'horizontal') returning id`,
          [phaseId, nextRowNumber++]
        )
      ).rows[0].id;
      await pool.query(`insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, 'stems')`, [
        plantDensityId,
        rowId,
      ]);
      return rowId;
    }

    function answers(rowId: string) {
      return [{ questionId, greenhouseRowId: rowId }];
    }
    async function enterRow(deviceIdentifier: string, rowId: string): Promise<{ status: number; body: any }> {
      return mobile("/time-entries/work", deviceIdentifier, {
        activityId: rowActivityId,
        idempotencyKey: randomUUID(),
        answers: answers(rowId),
        confirmSwitch: true,
      });
    }
    async function switchToOther(deviceIdentifier: string): Promise<{ status: number; body: any }> {
      return mobile("/time-entries/work", deviceIdentifier, {
        activityId: otherActivityId,
        idempotencyKey: randomUUID(),
        confirmSwitch: true,
      });
    }

    // -----------------------------------------------------------------
    // 1) Row A -> Row B completes Row A.
    // -----------------------------------------------------------------
    {
      const rowA = await makeRow();
      const rowB = await makeRow();
      const enter = await enterRow(empA.deviceIdentifier, rowA);
      check(enter.status === 200, "1) entering Row A succeeds", enter.body);
      const switchToB = await enterRow(empA.deviceIdentifier, rowB);
      check(switchToB.status === 200, "1) switching to Row B succeeds", switchToB.body);

      const rowACompletions = await activeCompletions(rowA);
      check(rowACompletions.length === 1, "1) Row A now has exactly one completion", rowACompletions);
      check(rowACompletions[0]?.status === "active", "1) Row A's completion is active", rowACompletions);
      check(rowACompletions[0]?.source === "automatic", "1) Row A's completion is source='automatic'", rowACompletions);

      const rowBCompletions = await activeCompletions(rowB);
      check(rowBCompletions.length === 0, "1) Row B (still open/in-progress) has NO completion yet", rowBCompletions);
    }

    // -----------------------------------------------------------------
    // 2) Row A -> a different WORK ACTIVITY completes Row A.
    // -----------------------------------------------------------------
    {
      const rowC = await makeRow();
      await enterRow(empA.deviceIdentifier, rowC);
      const toOther = await switchToOther(empA.deviceIdentifier);
      check(toOther.status === 200, "2) switching to a different work activity succeeds", toOther.body);

      const completions = await activeCompletions(rowC);
      check(completions.length === 1 && completions[0].status === "active", "2) Row C is completed by the activity switch", completions);
    }

    // -----------------------------------------------------------------
    // 3) Row A -> break -> resume Row A does NOT double-complete it —
    //    only completes once the row is genuinely left afterward, and that
    //    one completion combines BOTH pre-break and post-break segments.
    // -----------------------------------------------------------------
    {
      const rowD = await makeRow();
      await enterRow(empA.deviceIdentifier, rowD);
      const breakStart = await mobile("/time-entries/break/start", empA.deviceIdentifier, { idempotencyKey: randomUUID() });
      check(breakStart.status === 200, "3) starting a break succeeds", breakStart.body);
      check((await activeCompletions(rowD)).length === 0, "3) Row D has no completion while on break", await activeCompletions(rowD));

      const resume = await mobile("/time-entries/break/end", empA.deviceIdentifier, { idempotencyKey: randomUUID() });
      check(resume.status === 200, "3) resuming (break/end) succeeds", resume.body);
      check(
        (await activeCompletions(rowD)).length === 0,
        "3) Row D still has no completion immediately after resuming — the break never completed it",
        await activeCompletions(rowD)
      );

      await switchToOther(empA.deviceIdentifier);
      const completions = await activeCompletions(rowD);
      check(completions.length === 1, "3) Row D has exactly ONE completion after finally leaving (never two)", completions);
      const segs = await segmentsFor(completions[0].id);
      check(segs.length === 2, "3) that one completion combines BOTH the pre-break and post-break segments", segs);
    }

    // -----------------------------------------------------------------
    // 4) Row A completed -> SAME employee re-enters -> leaves again -> the
    //    original completion is superseded by ONE new completion covering
    //    both visits.
    // -----------------------------------------------------------------
    {
      const rowE = await makeRow();
      await enterRow(empA.deviceIdentifier, rowE);
      await switchToOther(empA.deviceIdentifier); // completes Row E (visit 1)
      const firstRound = await activeCompletions(rowE);
      check(firstRound.length === 1, "4) Row E has one completion after the first visit", firstRound);
      const firstCompletionId = firstRound[0].id;

      await enterRow(empA.deviceIdentifier, rowE); // re-entry — same employee
      await switchToOther(empA.deviceIdentifier); // leaves again — should reopen+combine

      const allForRow = await pool.query(
        `select id, status, superseded_by_completion_id from row_completions where greenhouse_row_id = $1 and activity_id = $2 order by created_at`,
        [rowE, rowActivityId]
      );
      check(allForRow.rows.length === 2, "4) Row E's full history has exactly two records (original + replacement) — audit trail preserved", allForRow.rows);
      const original = allForRow.rows.find((r) => r.id === firstCompletionId);
      check(original?.status === "superseded", "4) the ORIGINAL completion is now superseded, never deleted", original);
      const active = allForRow.rows.filter((r) => r.status === "active");
      check(active.length === 1, "4) exactly ONE active completion remains for Row E — the physical row is counted once", allForRow.rows);
      check(original?.superseded_by_completion_id === active[0]?.id, "4) the superseded record points at its replacement", original);

      const segs = await segmentsFor(active[0].id);
      check(segs.length === 2, "4) the replacement completion combines both visits' segments", segs);
    }

    // -----------------------------------------------------------------
    // 5) Row A completed -> a DIFFERENT employee re-enters -> leaves -> ONE
    //    combined completion spanning both employees.
    // -----------------------------------------------------------------
    {
      const rowF = await makeRow();
      await enterRow(empA.deviceIdentifier, rowF);
      await switchToOther(empA.deviceIdentifier); // empA completes Row F

      await enterRow(empB.deviceIdentifier, rowF); // empB continues the SAME row
      await switchToOther(empB.deviceIdentifier); // empB leaves — should reopen+combine across employees

      const rows = await pool.query(
        `select id, status from row_completions where greenhouse_row_id = $1 and activity_id = $2 order by created_at`,
        [rowF, rowActivityId]
      );
      check(rows.rows.length === 2, "5) Row F has exactly two records (original + combined replacement)", rows.rows);
      const active = rows.rows.filter((r) => r.status === "active");
      check(active.length === 1, "5) exactly one active completion for Row F", rows.rows);

      const segRows = await pool.query(
        `select te.employee_id from row_completion_segments rcs join time_entries te on te.id = rcs.time_entry_id where rcs.row_completion_id = $1`,
        [active[0].id]
      );
      const distinctEmployees = new Set(segRows.rows.map((r) => r.employee_id));
      check(segRows.rows.length === 2, "5) the combined completion has both employees' segments (2 total)", segRows.rows);
      check(
        distinctEmployees.has(empA.employeeId) && distinctEmployees.has(empB.employeeId),
        "5) the combined completion spans BOTH empA and empB",
        [...distinctEmployees]
      );
    }

    // -----------------------------------------------------------------
    // 6) Duplicate (replayed) offline sync events create NO duplicate
    //    completion.
    // -----------------------------------------------------------------
    {
      const rowG = await makeRow();
      // Backdated, not "now" — these events' own started_at/ended_at must
      // stay safely in the PAST relative to whatever real wall-clock time
      // later direct-route calls (elsewhere in this file) run at, or their
      // own closeBoundary <= this-still-open-entry's-own-started_at check
      // (mobileTime.ts's pre-rounding collapse/void branch — meant for a
      // genuinely-just-rounded boundary, not a synthetic test timestamp)
      // would fire and silently rewrite this row's own entry in place
      // instead of ever truly closing it.
      const t0 = new Date(Date.now() - 10 * 60 * 1000);
      const t = (secondsOffset: number) => new Date(t0.getTime() + secondsOffset * 1000).toISOString();
      const eventEnter = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: t(0),
        activityId: rowActivityId,
        greenhouseRowId: rowG,
        answers: { [questionId]: { questionId, questionType: "greenhouse_row", greenhouseRowId: rowG } },
      };
      const eventLeave = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "activity_switch",
        occurredAtUtc: t(30),
        activityId: otherActivityId,
        answers: null,
      };

      const first = await sync(empC.deviceIdentifier, [eventEnter, eventLeave]);
      check(
        first.body?.results?.every((r: any) => r.status === "accepted"),
        "6) the original batch is fully accepted",
        first.body
      );
      const afterFirst = await activeCompletions(rowG);
      check(afterFirst.length === 1, "6) Row G has exactly one completion after the original batch", afterFirst);

      // A genuine replay — same clientEventId/deviceSeq on both events, as
      // a phone retrying a batch it never got a response for would send.
      const replay = await sync(empC.deviceIdentifier, [eventEnter, eventLeave]);
      check(
        replay.body?.results?.every((r: any) => r.status === "duplicate"),
        "6) the replayed batch reports 'duplicate' for both events, not a second 'accepted'",
        replay.body
      );
      const afterReplay = await activeCompletions(rowG);
      check(afterReplay.length === 1, "6) Row G still has exactly one completion after the replay — no duplicate created", afterReplay);
      check(afterReplay[0]?.id === afterFirst[0]?.id, "6) it's the SAME completion record, not a new one", afterReplay);
    }

    // -----------------------------------------------------------------
    // 7) Late/out-of-order offline events converge to the correct single
    //    completion once applied in device_seq order (never server
    //    arrival order).
    // -----------------------------------------------------------------
    {
      const rowH = await makeRow();
      // A fresh device — device_seq is per-device, and this section needs
      // its own 1-based sequence, not a continuation of empC's main device
      // (already advanced by test 6's own sync events).
      const deviceH = await makeExtraDevice(empC.employeeId, "H");
      // Backdated — see test 6's identical comment.
      const t0 = new Date(Date.now() - 8 * 60 * 1000);
      const t = (secondsOffset: number) => new Date(t0.getTime() + secondsOffset * 1000).toISOString();
      const eventEnter = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: t(0),
        activityId: rowActivityId,
        greenhouseRowId: rowH,
        answers: { [questionId]: { questionId, questionType: "greenhouse_row", greenhouseRowId: rowH } },
      };
      const eventLeave = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "activity_switch",
        occurredAtUtc: t(30),
        activityId: otherActivityId,
        answers: null,
      };

      // eventLeave ARRIVES AT THE SERVER FIRST (out of order) — held as a
      // sequence_gap, never applied.
      const gapAttempt = await sync(deviceH, [eventLeave]);
      check(gapAttempt.body?.results?.[0]?.status === "sequence_gap", "7) the out-of-order event is held as a sequence_gap", gapAttempt.body);
      check((await activeCompletions(rowH)).length === 0, "7) nothing completes yet — the gapped event was never applied", await activeCompletions(rowH));

      // eventEnter arrives (its own correct turn) — accepted, Row H now
      // open/in-progress, still no completion.
      const enterCall = await sync(deviceH, [eventEnter]);
      check(enterCall.body?.results?.[0]?.status === "accepted", "7) the correctly-ordered work_start is accepted", enterCall.body);
      check((await activeCompletions(rowH)).length === 0, "7) Row H is open but not yet completed", await activeCompletions(rowH));

      // The phone resends its still-pending queue — eventLeave is retried
      // and now applies in its correct chronological (device_seq) slot.
      const retry = await sync(deviceH, [eventLeave]);
      check(retry.body?.results?.[0]?.status === "accepted", "7) retrying the previously-gapped event now succeeds", retry.body);
      const completions = await activeCompletions(rowH);
      check(completions.length === 1, "7) Row H converges to exactly one completion despite the out-of-order arrival", completions);
    }

    // -----------------------------------------------------------------
    // 9) A manual Inputs correction (soft-deleting a segment) is reflected
    //    live in the completion's own duration — the attribution query
    //    re-derives from current (non-deleted) segments every time, never
    //    a stale persisted total. Uses empA (real-time direct routes
    //    throughout this file) — test 8's dedicated empC is the one left
    //    with a far-future "now" by design, never empA.
    // -----------------------------------------------------------------
    {
      const deviceJ = await makeExtraDevice(empA.employeeId, "J");
      const rowJ = await makeRow();
      // Two SEPARATE visits (not a break-split single run — Inputs'
      // "delete this activity run" resolves and deletes a run's FULL
      // contiguous chain at once, so a break-split visit can't be used to
      // isolate just one segment; see test 3, which already proves a break
      // never fragments one visit into two completions). A genuine re-entry
      // (test 4's own pattern) gives two independent runs/segments instead.
      await enterRow(deviceJ, rowJ);
      await switchToOther(deviceJ); // visit 1 — completes Row J
      await enterRow(deviceJ, rowJ); // re-entry — reopens
      await switchToOther(deviceJ); // visit 2 — combines into one completion

      const completions = await activeCompletions(rowJ);
      check(completions.length === 1, "9) Row J has one (combined) active completion after both visits", completions);
      const segsBefore = await segmentsFor(completions[0].id);
      check(segsBefore.length === 2, "9) that completion has two linked segments (one per visit) before any correction", segsBefore);

      // Soft-delete visit 2's own run via the real admin Inputs correction
      // endpoint — the run's own id is its (single, breakless) segment's
      // own time_entries id, matching what the Inputs UI would target.
      const del = await admin("POST", `/activity-runs/${segsBefore[1]}/delete`, adminToken);
      check(del.status === 200, "9) the manual correction (soft-delete) succeeds", del.body);

      const { rows: durationRows } = await pool.query(
        `select count(*) as n, sum(extract(epoch from (te.ended_at - te.started_at))) as duration_seconds
         from row_completion_segments rcs
         join time_entries te on te.id = rcs.time_entry_id
         where rcs.row_completion_id = $1 and te.deleted_at is null`,
        [completions[0].id]
      );
      check(Number(durationRows[0].n) === 1, "9) the completion's LIVE (non-deleted) segment count is now 1, reconciled automatically", durationRows[0]);
    }

    // -----------------------------------------------------------------
    // 8) A visit at least 7 calendar dates after an active completion's
    //    own latest segment starts a genuinely SEPARATE cycle/completion —
    //    the old one is left untouched, never combined. Uses empD (see its
    //    own declaration comment). Cycle 1 is BACKDATED 8 days (not cycle 2
    //    future-dated) — the server clamps any client-submitted timestamp
    //    more than 5 minutes in the future back to real "now"
    //    (resolveOriginalTimestamp's MAX_CLIENT_CLOCK_SKEW_FUTURE_MS, a
    //    genuine anti-clock-skew guard), so a far-future occurredAtUtc
    //    can't be used to simulate this from the other direction — but a
    //    PAST timestamp has no such clamp, and "cycle 1 eight days ago,
    //    cycle 2 today" is the same gap, evidence, and code path as "cycle
    //    1 today, cycle 2 eight days later."
    // -----------------------------------------------------------------
    {
      const rowI = await makeRow();
      const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const t1 = (minutesOffset: number) => new Date(past.getTime() + minutesOffset * 60000).toISOString();
      const pastDevice = await makeExtraDevice(empD.employeeId, "Past");

      const eventEnter1 = {
        clientEventId: randomUUID(),
        deviceSeq: 1,
        eventType: "work_start",
        occurredAtUtc: t1(0),
        activityId: rowActivityId,
        greenhouseRowId: rowI,
        answers: { [questionId]: { questionId, questionType: "greenhouse_row", greenhouseRowId: rowI } },
      };
      const eventLeave1 = {
        clientEventId: randomUUID(),
        deviceSeq: 2,
        eventType: "activity_switch",
        occurredAtUtc: t1(30),
        activityId: otherActivityId,
        answers: null,
      };
      const cycle1Result = await sync(pastDevice, [eventEnter1, eventLeave1]);
      check(
        cycle1Result.body?.results?.every((x: any) => x.status === "accepted"),
        "8) the backdated (8-days-ago) cycle 1 visit is accepted",
        cycle1Result.body
      );
      const cycle1 = await activeCompletions(rowI);
      check(cycle1.length === 1, "8) Row I has one completion after cycle 1", cycle1);
      const cycle1Id = cycle1[0]?.id;
      if (!cycle1Id) throw new Error("8) aborting — no cycle1 completion to continue from");

      // Cycle 2 — a genuinely separate visit TODAY (real time), well past
      // CYCLE_GAP_DAYS (7) from cycle 1's own 8-days-ago segment. A fresh
      // device for empD so this employee's own real-time state (unrelated
      // to pastDevice's backdated entries) starts clean.
      const deviceI = await makeExtraDevice(empD.employeeId, "I");
      const enter8 = await enterRow(deviceI, rowI);
      check(enter8.status === 200, "8) entering Row I (cycle 2, today) succeeds", enter8.body);
      const leave8 = await switchToOther(deviceI);
      check(leave8.status === 200, "8) leaving Row I (cycle 2) succeeds", leave8.body);

      const rows = await allCompletions(rowI);
      check(rows.length === 2, "8) Row I now has TWO independent completion records (two separate cycles)", rows);
      const stillActiveOriginal = rows.find((r2) => r2.id === cycle1Id);
      check(stillActiveOriginal?.status === "active", "8) the ORIGINAL cycle 1 completion is left untouched (still active, never superseded)", rows);
      const secondCycle = rows.find((r2) => r2.id !== cycle1Id);
      check(secondCycle?.status === "active", "8) the new cycle's own completion is also active", rows);
      check(
        rows.filter((r2) => r2.status === "active").length === 2,
        "8) BOTH completions are independently active — a new cycle is never merged into an old one",
        rows
      );
    }
  } finally {
    for (const rid of employeeIds) {
      await pool
        .query(
          `delete from row_completion_segments where time_entry_id in (select id from time_entries where employee_id = $1)`,
          [rid]
        )
        .catch(() => {});
    }
    await pool
      .query(`delete from row_completions where activity_id in (select id from activities where name like 'QA RowAuto%')`)
      .catch(() => {});
    // mobile_time_events.time_entry_id and time_entry_corrections.
    // time_entry_id both have no cascade from time_entries — must clear
    // both before the entries they reference, same dependency-order lesson
    // as row_completion_segments (see
    // reports.densityMultiRowAttribution.test.ts's identical comment).
    // time_entry_corrections rows come from test 9's own admin correction
    // (POST /activity-runs/:id/delete audits the deletion there).
    for (const rid of employeeIds) {
      await pool.query(`delete from mobile_time_events where employee_id = $1`, [rid]).catch(() => {});
      await pool
        .query(`delete from time_entry_corrections where time_entry_id in (select id from time_entries where employee_id = $1)`, [rid])
        .catch(() => {});
    }
    for (const rid of employeeIds) {
      await pool.query(`delete from time_entries where employee_id = $1`, [rid]).catch(() => {});
    }
    // time_entry_deletions audits test 9's own admin correction
    // (POST /activity-runs/:id/delete) — references both the deleted
    // entries' employee and the admin who deleted them, either of which
    // would otherwise block deleting those employees below.
    await pool
      .query(`delete from time_entry_deletions where deleted_by_employee_id = any($1::uuid[]) or employee_id = any($1::uuid[])`, [
        employeeIds,
      ])
      .catch(() => {});
    // activity_questions has no cascade from activities — must clear
    // before the activities it references, same lesson as the other
    // dependency-order fixes above.
    await pool
      .query(`delete from activity_questions where activity_id in (select id from activities where name like 'QA RowAuto%')`)
      .catch(() => {});
    await pool.query(`delete from activities where name like 'QA RowAuto%'`).catch(() => {});
    for (const did of deviceIds) {
      await pool.query(`delete from device_sync_state where device_id = $1`, [did]).catch(() => {});
      await pool.query(`delete from device_assignments where device_id = $1`, [did]).catch(() => {});
      await pool.query(`delete from devices where id = $1`, [did]).catch(() => {});
    }
    await pool.query(`delete from employee_activity_group_assignments where employee_id = any($1::uuid[])`, [employeeIds]).catch(() => {});
    await pool.query(`delete from activity_group_activities where activity_group_id in (select id from activity_groups where name like 'QA RowAuto%')`).catch(() => {});
    await pool.query(`delete from activity_groups where name like 'QA RowAuto%'`).catch(() => {});
    for (const eid of employeeIds) {
      await pool.query(`delete from employees where id = $1`, [eid]).catch(() => {});
    }
    if (phaseId) {
      // Cascades plant_density_rows for these rows (023_plant_densities.sql).
      await pool.query(`delete from greenhouse_rows where phase_id = $1`, [phaseId]).catch(() => {});
      await pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]).catch(() => {});
    }
    if (landId) await pool.query(`delete from greenhouse_lands where id = $1`, [landId]).catch(() => {});
    await pool.query(`delete from plant_densities where name like 'QA RowAuto%'`).catch(() => {});
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
