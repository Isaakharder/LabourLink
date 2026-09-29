// Integration test for GET /api/integrations/productive-tv/picking-speed —
// the read-only, machine-authenticated endpoint Productive TV polls for its
// Picking slide. Deliberately built and tested to prove this feature is
// INDEPENDENT of the (not yet deployed) automatic row-completion feature:
// this whole suite runs against a database migrated only through
// 054_integration_tokens.sql (there is no migration 055 in this worktree at
// all, and row_completions has no `status` column) — the same schema
// production has today. If picking-speed (or the getActivityDensityAttribution/
// GET /daily queries it shares with the rest of the app) referenced
// row_completions.status anywhere, this suite would fail with a hard SQL
// error ("column rc.status does not exist"), not a wrong number.
//
// Covers, using the SAME rule as the existing, already-deployed
// pruning-speed endpoint (numerator = getActivityDensityAttribution's
// resolved quantity, denominator = that SAME attribution's own
// durationSeconds — never full Activity Hours):
//   1) auth, 2) date-range validation (incl. the configured max range),
//   3) activity configuration (missing/inactive/wrong density_source),
//   4) empty range, 5) a single clean row, 6) a same-cycle revisit
//   combined by an admin into ONE completion (counted once, not doubled),
//   7) a shared (multi-employee) completion split proportionally by
//   duration (conserves the row's total quantity, never double-counts),
//   8) breaks excluded from both numerator and denominator, 9) two visits
//   to the same row 8+ days apart — different cycles, each independently
//   resolved, 10) a row with no configured density — excluded, hours still
//   real but speed unavailable, 11) the weekly figure as a true ratio of
//   summed stems over summed hours across several days (never an average of
//   daily ratios), and 12) the response's echoed date range/timezone.
//
// Every "combined"/"shared" scenario also reads GET /api/inputs/daily for
// the same employee/date and compares its own completed-row speed display
// against this endpoint's number — documented where they're expected to
// match (a single-employee completion) and where they intentionally diverge
// (a shared completion: Inputs shows one blended per-row speed to every
// employee on it, Productive TV shows each employee their own
// duration-proportional share, since one is a per-ROW audit view and the
// other a per-EMPLOYEE ranking).
//
// Run with: npm run test:integrations-productive-tv-picking-speed
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { zonedWallTimeToUtc } from "../lib/timezone";
import { generateIntegrationToken } from "../lib/integrationToken";
import { signSession } from "../middleware/auth";
import integrationsRoutes, { PICKING_ACTIVITY_NAME } from "./integrations";
import inputsRoutes from "./inputs";

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
  app.use("/api/integrations", integrationsRoutes);
  app.use("/api/inputs", inputsRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(path: string, opts: { token?: string; noAuthHeader?: boolean } = {}): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};
    if (!opts.noAuthHeader) headers.Authorization = `Bearer ${opts.token ?? ""}`;
    const res = await fetch(`${BASE}${path}`, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function admin(path: string, adminToken: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/inputs${path}`, { headers: { Cookie: `labourlink_session=${adminToken}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const rowIds: string[] = [];
  const timeEntryIds: string[] = [];
  const rowCompletionIds: string[] = [];
  const integrationTokenIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const adminRoleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Picking TV ${label} ${RUN_ID}`, `qa-picking-tv-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }
    const adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Picking TV Admin ${RUN_ID}`, `qa-picking-tv-admin-${RUN_ID}@test.local`, adminRoleId, teamRoleId, fakePinHash]
      )
    ).rows[0].id;
    employeeIds.push(adminId);
    const adminToken = signSession({ id: adminId, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" });

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Picking TV Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Picking TV Phase ${RUN_ID}`,
      ])
    ).rows[0].id;

    let nextRowNumber = 1;
    async function insertRow(): Promise<string> {
      const rowNumber = nextRowNumber++;
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, rowNumber, rowNumber * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertWork(
      employeeId: string,
      activityId: string,
      rowId: string | null,
      day: number,
      startHour: number,
      startMinute: number,
      endHour: number,
      endMinute: number,
      densityCountPerRow: number | null
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, day, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, day, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7) returning id`,
        [employeeId, activityId, startedAt, endedAt, rowId, rowId && densityCountPerRow != null ? "stems" : null, densityCountPerRow]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBreak(employeeId: string, day: number, startHour: number, startMinute: number, endHour: number, endMinute: number): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, day, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, day, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source, is_paid)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual', false) returning id`,
        [employeeId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    // Mirrors POST /api/row-completions (the manual admin "combine these
    // registrations, this row is done" workflow) — the ONLY way a row gets
    // confirmed in this schema (no automatic completion here at all).
    async function confirmCompletion(rowId: string, activityId: string, quantityPerRow: number, segmentEntryIds: string[]): Promise<string> {
      const { rows } = await pool.query(
        `insert into row_completions (greenhouse_row_id, activity_id, density_type, quantity_per_row, confirmed_by_employee_id)
         values ($1, $2, 'stems', $3, $4) returning id`,
        [rowId, activityId, quantityPerRow, adminId]
      );
      const completionId = rows[0].id;
      rowCompletionIds.push(completionId);
      for (const entryId of segmentEntryIds) {
        await pool.query(`insert into row_completion_segments (time_entry_id, row_completion_id) values ($1, $2)`, [entryId, completionId]);
      }
      return completionId;
    }
    async function insertToken(name: string, active: boolean): Promise<string> {
      const { token, tokenHash } = generateIntegrationToken();
      const { rows } = await pool.query(`insert into integration_tokens (name, token_hash, is_active) values ($1, $2, $3) returning id`, [
        name,
        tokenHash,
        active,
      ]);
      integrationTokenIds.push(rows[0].id);
      return token;
    }

    const FROM = "2019-06-01";
    const TO = "2019-06-20";
    const PATH = `/api/integrations/productive-tv/picking-speed`;

    const validToken = await insertToken(`QA Picking TV ${RUN_ID}`, true);
    const deactivatedToken = await insertToken(`QA Picking TV Deactivated ${RUN_ID}`, false);

    // -----------------------------------------------------------------
    // 1) Auth.
    // -----------------------------------------------------------------
    {
      const noHeader = await call(`${PATH}?from=${FROM}&to=${TO}`, { noAuthHeader: true });
      check(noHeader.status === 401, "1) missing Authorization header is rejected (401)", noHeader);
      const garbage = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: "not-a-real-token" });
      check(garbage.status === 401, "1) an unrecognized bearer token is rejected (401)", garbage);
      const deactivated = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: deactivatedToken });
      check(deactivated.status === 401, "1) a deactivated token is rejected (401)", deactivated);
    }

    // -----------------------------------------------------------------
    // 2) Date-range validation, including the configured max range.
    // -----------------------------------------------------------------
    {
      const missing = await call(PATH, { token: validToken });
      check(missing.status === 400, "2) missing from/to is rejected (400)", missing);
      const backwards = await call(`${PATH}?from=${TO}&to=${FROM}`, { token: validToken });
      check(backwards.status === 400, "2) from after to is rejected (400)", backwards);
      const tooWide = await call(`${PATH}?from=2019-01-01&to=2019-06-01`, { token: validToken });
      check(tooWide.status === 400, "2) a range over the configured max is rejected (400)", tooWide);
    }

    // -----------------------------------------------------------------
    // 3) Activity configuration.
    // -----------------------------------------------------------------
    await pool.query(`delete from time_entries where activity_id in (select id from activities where name = $1)`, [PICKING_ACTIVITY_NAME]);
    await pool.query(`delete from activities where name = $1`, [PICKING_ACTIVITY_NAME]);

    const missingActivity = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
    check(missingActivity.status === 503 && missingActivity.body?.reason === "activity_missing", "3) no configured Picking Peppers activity fails clearly (503)", missingActivity.body);

    const { rows: inactiveRows } = await pool.query(
      `insert into activities (name, is_active, density_source, sort_order) values ($1, false, 'stems', 0) returning id`,
      [PICKING_ACTIVITY_NAME]
    );
    const pickingActivityId = inactiveRows[0].id;
    activityIds.push(pickingActivityId);

    const inactive = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
    check(inactive.status === 503 && inactive.body?.reason === "activity_inactive", "3) an inactive Picking Peppers activity fails clearly (503)", inactive.body);

    await pool.query(`update activities set is_active = true, density_source = null where id = $1`, [pickingActivityId]);
    const noDensitySource = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
    check(
      noDensitySource.status === 503 && noDensitySource.body?.reason === "density_source_not_stems",
      "3) Picking Peppers with density_source unset (still bin/carrier-tracked) fails clearly (503) — never silently falls back to bins",
      noDensitySource.body
    );

    await pool.query(`update activities set density_source = 'stems' where id = $1`, [pickingActivityId]);

    // -----------------------------------------------------------------
    // 4) Correctly configured, nobody has worked it yet.
    // -----------------------------------------------------------------
    {
      const empty = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      check(empty.status === 200, "4) a correctly configured activity with no work in range is 200, not an error", empty.body);
      check(Array.isArray(empty.body?.employees) && empty.body.employees.length === 0, "4) employees is a genuinely empty array", empty.body);
      check(empty.body?.unit === "stems_per_hour", "4) unit is stems_per_hour", empty.body);
    }

    // -----------------------------------------------------------------
    // 12) Response range echo — checked now while the activity is
    //     configured but before any of the scenario-specific data below
    //     could complicate the read.
    // -----------------------------------------------------------------
    {
      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      check(
        res.body?.range?.from === FROM && res.body?.range?.to === TO && res.body?.range?.timezone === "America/Toronto",
        "12) the response echoes the exact requested from/to and the app's configured timezone",
        res.body?.range
      );
      check(res.body?.activity?.id === pickingActivityId && res.body?.activity?.name === PICKING_ACTIVITY_NAME, "12) activity id/name are echoed", res.body?.activity);
    }

    // -----------------------------------------------------------------
    // 5) Single row, single employee, clean — and compared against the
    //    SAME figure Inputs' own completed-row speed display would show.
    // -----------------------------------------------------------------
    const rowClean = await insertRow();
    const empClean = await insertEmployee("Clean");
    let cleanEntryId!: string;
    {
      // 3 hours, 636 stems -> 212 stems/hour.
      cleanEntryId = await insertWork(empClean, pickingActivityId, rowClean, 3, 8, 0, 11, 0, 636);
      await confirmCompletion(rowClean, pickingActivityId, 636, [cleanEntryId]);

      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empClean);
      check(entry !== undefined, "5) the employee appears in the result", res.body?.employees);
      check(entry?.stemsPerHour === 212, "5) stemsPerHour is the ratio-of-sums (636 stems / 3 hours = 212/hour)", entry);
      check(entry?.stemsCounted === 636, "5) stemsCounted is the row's frozen quantity, counted once", entry);
      check(entry?.activityHours === 3, "5) activityHours matches the attributed duration for this single clean visit", entry);

      const daily = await admin(`/daily?employeeId=${empClean}&date=2019-06-03`, adminToken);
      const run = daily.body?.runs?.find((r: any) => r.rowCompletion != null);
      check(run?.rowCompletion?.quantityPerRow === 636, "5) Inputs' own completed-row display shows the same 636 stems", run);
      check(run?.calculatedSpeedPerHour?.value === 212, "5) Inputs' own completed-row speed matches Productive TV's figure exactly for a single-employee completion", run);
    }

    // -----------------------------------------------------------------
    // 6) Same-cycle revisit: the same physical row, left and re-entered by
    //    the SAME employee a few days later (still well within the 7-day
    //    cycle), combined by an admin into ONE completion — stems must
    //    count ONCE (not once per visit), duration is the SUM of both
    //    visits.
    // -----------------------------------------------------------------
    const rowRevisit = await insertRow();
    const empRevisit = await insertEmployee("Revisit");
    {
      // Visit 1: 2019-06-05, 1 hour. Visit 2: 2019-06-07 (2 days later,
      // same cycle), 2 hours. Combined: 636 stems / 3 hours = 212/hour —
      // same figure as (5), proving a revisit alone changes nothing once
      // properly combined.
      const seg1 = await insertWork(empRevisit, pickingActivityId, rowRevisit, 5, 8, 0, 9, 0, 636);
      const seg2 = await insertWork(empRevisit, pickingActivityId, rowRevisit, 7, 8, 0, 10, 0, 636);
      await confirmCompletion(rowRevisit, pickingActivityId, 636, [seg1, seg2]);

      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empRevisit);
      check(entry?.stemsCounted === 636, "6) a same-cycle revisit combined into one completion counts stems exactly ONCE (636, not 1272)", entry);
      check(entry?.activityHours === 3, "6) the combined completion's duration is the SUM of both visits (1h + 2h = 3h)", entry);
      check(entry?.stemsPerHour === 212, "6) the resulting speed (212/hour) is identical to a single 3-hour visit — a revisit never distorts speed once combined", entry);

      const daily5 = await admin(`/daily?employeeId=${empRevisit}&date=2019-06-05`, adminToken);
      const run5 = daily5.body?.runs?.find((r: any) => r.rowCompletion != null);
      check(run5?.rowCompletion?.segmentCount === 2, "6) Inputs' own display confirms 2 linked segments under one completion", run5);
      check(run5?.calculatedSpeedPerHour?.value === 212, "6) Inputs' own completed-row speed matches Productive TV's figure for this single-employee, multi-segment completion", run5);
    }

    // -----------------------------------------------------------------
    // 7) Shared row: two DIFFERENT employees' segments combined into one
    //    completion (e.g. one employee started it, another finished it) —
    //    quantity must split proportionally by each employee's own
    //    duration share, and the two shares must sum back to the row's
    //    full quantity (never double-counted, never lost).
    // -----------------------------------------------------------------
    const rowShared = await insertRow();
    const empSharedA = await insertEmployee("SharedA");
    const empSharedB = await insertEmployee("SharedB");
    {
      // A: 3 hours. B: 1 hour. Total 4 hours, 636 stems -> A gets 3/4 of
      // 636 = 477, B gets 1/4 = 159 (477 + 159 = 636 exactly).
      const segA = await insertWork(empSharedA, pickingActivityId, rowShared, 9, 8, 0, 11, 0, 636);
      const segB = await insertWork(empSharedB, pickingActivityId, rowShared, 9, 11, 0, 12, 0, 636);
      await confirmCompletion(rowShared, pickingActivityId, 636, [segA, segB]);

      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      const entryA = res.body?.employees?.find((e: any) => e.employeeId === empSharedA);
      const entryB = res.body?.employees?.find((e: any) => e.employeeId === empSharedB);
      check(entryA?.stemsCounted === 477, "7) the majority-duration employee (3h of 4h) gets 477 of the 636 stems (proportional)", entryA);
      check(entryB?.stemsCounted === 159, "7) the minority-duration employee (1h of 4h) gets 159 of the 636 stems", entryB);
      check((entryA?.stemsCounted ?? 0) + (entryB?.stemsCounted ?? 0) === 636, "7) the two shares sum back to the row's full quantity — never double-counted, never lost", { entryA, entryB });
      check(entryA?.activityHours === 3 && entryB?.activityHours === 1, "7) each employee's own hours are their own segment's duration, not the combined total", { entryA, entryB });

      // Inputs' own per-row display intentionally does NOT split — it shows
      // ONE blended completion speed to whichever employee's day is being
      // viewed (a per-ROW audit view, not a per-employee ranking), so this
      // is a documented, expected DIVERGENCE from Productive TV's
      // per-employee figures above, not a bug.
      const dailyA = await admin(`/daily?employeeId=${empSharedA}&date=2019-06-09`, adminToken);
      const runA = dailyA.body?.runs?.find((r: any) => r.rowCompletion != null);
      check(runA?.rowCompletion?.quantityPerRow === 636, "7) Inputs shows the FULL row quantity (636) to employee A, not their 477 share — a per-row view, deliberately unsplit", runA);
      check(runA?.calculatedSpeedPerHour?.value === 159, "7) Inputs' one blended speed (636 stems / 4 combined hours = 159/hour) differs from either employee's own Productive TV figure — expected, not a bug", runA);
    }

    // -----------------------------------------------------------------
    // 8) Breaks: a break sitting between two segments of the same visit
    //    must never contribute to duration or otherwise change the speed.
    // -----------------------------------------------------------------
    const rowBreak = await insertRow();
    const empBreak = await insertEmployee("Break");
    {
      // 1 hour work, 30 min break, 1 hour work -> completion combines the
      // two work segments (2 hours total); the break must not inflate
      // activityHours or otherwise appear anywhere in this calculation.
      const seg1 = await insertWork(empBreak, pickingActivityId, rowBreak, 11, 8, 0, 9, 0, 636);
      await insertBreak(empBreak, 11, 9, 0, 9, 30);
      const seg2 = await insertWork(empBreak, pickingActivityId, rowBreak, 11, 9, 30, 10, 30, 636);
      await confirmCompletion(rowBreak, pickingActivityId, 636, [seg1, seg2]);

      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empBreak);
      check(entry?.activityHours === 2, "8) activityHours is exactly the 2 hours of WORK (1h + 1h) — the 30-minute break is never counted", entry);
      check(entry?.stemsPerHour === 318, "8) speed is 636 stems / 2 hours = 318/hour, unaffected by the break in between", entry);
    }

    // -----------------------------------------------------------------
    // 9) Different cycles: the same employee visits the same row twice,
    //    8+ calendar days apart (beyond the 7-day row-work cycle) — never
    //    combined and never treated as ambiguous; each is its own
    //    independent, sole-candidate resolution.
    // -----------------------------------------------------------------
    const rowCycles = await insertRow();
    const empCycles = await insertEmployee("Cycles");
    {
      await insertWork(empCycles, pickingActivityId, rowCycles, 1, 8, 0, 9, 0, 300); // 2019-06-01, 1h, 300 stems -> 300/hr
      await insertWork(empCycles, pickingActivityId, rowCycles, 12, 8, 0, 9, 30, 450); // 2019-06-12 (11 days later), 1.5h, 450 stems -> 300/hr

      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empCycles);
      check(entry?.stemsCounted === 750, "9) two genuinely separate cycles both count in full (300 + 450 = 750) — neither excluded as ambiguous", entry);
      check(entry?.activityHours === 2.5, "9) both cycles' hours are summed (1h + 1.5h = 2.5h)", entry);
      check(entry?.stemsPerHour === 300, "9) the combined range figure is still the correct ratio-of-sums (750 / 2.5h = 300/hour)", entry);
    }

    // -----------------------------------------------------------------
    // 10) Missing density: a row with no configured stems density at all
    //     (density_type/density_count_per_row both null, exactly what
    //     resolveDensitySnapshot freezes when a row has no matching
    //     plant_density_rows mapping) — hours are real, but the row
    //     contributes no stems and is never shown with a fabricated speed.
    // -----------------------------------------------------------------
    const rowNoDensity = await insertRow();
    const empNoDensity = await insertEmployee("NoDensity");
    {
      await insertWork(empNoDensity, pickingActivityId, rowNoDensity, 13, 8, 0, 10, 0, null);

      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empNoDensity);
      check(entry === undefined, "10) an employee whose only row has no configured density is excluded — no fabricated speed", res.body?.employees);
    }

    // -----------------------------------------------------------------
    // 11) Weekly figure as a true ratio of SUMMED stems over SUMMED hours
    //     across several days — never an average of each day's own ratio.
    //     Two rows, three days, deliberately unequal daily speeds:
    //     day A: 1h / 100 stems (100/hr). day B: 2h / 600 stems (300/hr).
    //     A naive average-of-daily-ratios would give (100+300)/2 = 200/hr;
    //     the correct ratio-of-sums is 700 stems / 3 hours = 233.33/hr.
    // -----------------------------------------------------------------
    const rowWeekA = await insertRow();
    const rowWeekB = await insertRow();
    const empWeek = await insertEmployee("Week");
    {
      const segA = await insertWork(empWeek, pickingActivityId, rowWeekA, 15, 8, 0, 9, 0, 100);
      await confirmCompletion(rowWeekA, pickingActivityId, 100, [segA]);
      const segB = await insertWork(empWeek, pickingActivityId, rowWeekB, 17, 8, 0, 10, 0, 600);
      await confirmCompletion(rowWeekB, pickingActivityId, 600, [segB]);

      const res = await call(`${PATH}?from=${FROM}&to=${TO}`, { token: validToken });
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empWeek);
      check(entry?.stemsCounted === 700, "11) the week's stems are the plain sum across both rows (100 + 600 = 700)", entry);
      check(entry?.activityHours === 3, "11) the week's hours are the plain sum (1h + 2h = 3h)", entry);
      check(entry?.stemsPerHour === 233.33, "11) the weekly figure is the ratio of sums (700/3 = 233.33/hour), not the average of the two days' own 100/hr and 300/hr", entry);

      // A narrower range excluding day B must show ONLY day A's own figure —
      // confirms the range parameter genuinely scopes both the numerator
      // and denominator, not just a display filter over a fixed total.
      const narrow = await call(`${PATH}?from=2019-06-14&to=2019-06-16`, { token: validToken });
      const narrowEntry = narrow.body?.employees?.find((e: any) => e.employeeId === empWeek);
      check(narrowEntry?.stemsCounted === 100 && narrowEntry?.stemsPerHour === 100, "11) a narrower range scoped to just day A shows only that day's own 100 stems / 100 per hour", narrowEntry);
    }

    // -----------------------------------------------------------------
    // Regression: Winding & Pruning's own endpoint must still work exactly
    // as before, completely unaffected by anything above (proves this
    // release doesn't touch its behavior).
    // -----------------------------------------------------------------
    {
      const pruningRes = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
      check(pruningRes.status === 503, "regression) Pruning's own endpoint still responds normally (503 — no Winding & Pruning activity configured in this test) — untouched by Picking's test data", pruningRes.body);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (integrationTokenIds.length) await tryDelete("integration_tokens", () => pool.query(`delete from integration_tokens where id = any($1::uuid[])`, [integrationTokenIds]));
    if (rowCompletionIds.length) await tryDelete("row_completion_segments", () => pool.query(`delete from row_completion_segments where row_completion_id = any($1::uuid[])`, [rowCompletionIds]));
    if (rowCompletionIds.length) await tryDelete("row_completions", () => pool.query(`delete from row_completions where id = any($1::uuid[])`, [rowCompletionIds]));
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
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
