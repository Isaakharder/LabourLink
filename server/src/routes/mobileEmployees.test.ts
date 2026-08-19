// Integration tests for GET /api/mobile/employees/live — the mobile
// Employees screen's aggregated feed. Covers: every currently clocked-in
// employee (working AND on break, unlike dashboard.ts's /cards which only
// covers "work" entries on Dashboard-selected activities), row/carrier/
// missing-location rendering, ratio-of-sums weekly speed with the correct
// frozen unit, the no-speed-metric vs not-enough-data distinction, break
// entries excluded from weekly-speed math, deleted entries excluded, and
// working-before-break-then-alphabetical sort order. Same real-HTTP-
// against-real-database convention as dashboard.test.ts (its closest
// analog — same underlying calculations, reused here through device-paired
// auth instead of a desktop session cookie).
//
// Run with: npm run test:mobile-employees
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import mobileEmployeesRouter from "./mobileEmployees";

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
const testNow = new Date();
function hoursAgo(n: number): Date {
  return new Date(testNow.getTime() - n * 3600000);
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/mobile/employees", mobileEmployeesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function callDevice(method: string, path: string, deviceIdentifier: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "X-Device-Id": deviceIdentifier },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];
  const rowIds: string[] = [];
  const carrierIds: string[] = [];
  const densityIds: string[] = [];
  const completionIds: string[] = [];
  const breakProfileIds: string[] = [];
  const breakProfileItemIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const employeeRoleId = await roleId("Employee");
    const administratorRoleId = await roleId("Administrator");

    async function insertEmployee(label: string, securityRoleId: string = employeeRoleId): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        [
          "QA",
          `Mobile Emp ${label} ${RUN_ID}`,
          `qa-mobile-emp-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`,
          securityRoleId,
          teamRoleId,
          fakePinHash,
        ]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function pairDevice(employeeId: string, label: string): Promise<string> {
      const identifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [identifier, `QA Mobile Employees Device ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return identifier;
    }

    async function insertActivity(label: string, densitySource: "plants" | "stems" | null, speedUnit: string | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into activities (name, is_active, density_source, speed_unit) values ($1, true, $2, $3) returning id`,
        [`QA Mobile Emp ${label} ${RUN_ID}`, densitySource, speedUnit]
      );
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Mobile Emp Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Mobile Emp Phase ${RUN_ID}`,
      ])
    ).rows[0].id;

    async function insertRow(rowNumber: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, rowNumber, rowNumber * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertDensity(countPerRow: number, linkedRowIds: string[]): Promise<void> {
      const { rows } = await pool.query(`insert into plant_densities (name, type, count_per_row) values ($1, 'stems', $2) returning id`, [
        `QA Mobile Emp Density ${RUN_ID}-${densityIds.length}`,
        countPerRow,
      ]);
      densityIds.push(rows[0].id);
      for (const rowId of linkedRowIds) {
        await pool.query(`insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, 'stems')`, [rows[0].id, rowId]);
      }
    }

    async function insertWork(
      employeeId: string,
      activityId: string,
      start: Date,
      end: Date | null,
      extra: { rowId?: string; densityCountPerRow?: number; carrierId?: string; deleted?: boolean } = {}
    ): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row, carrier_id,
                                    deleted_at, deleted_by_employee_id, deletion_reason)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7, $8, $9, $10, $11)
         returning id`,
        [
          employeeId,
          activityId,
          start,
          end,
          extra.rowId ?? null,
          extra.densityCountPerRow != null ? "stems" : null,
          extra.densityCountPerRow ?? null,
          extra.carrierId ?? null,
          extra.deleted ? new Date() : null,
          extra.deleted ? employeeId : null,
          extra.deleted ? "QA test deletion" : null,
        ]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, start: Date, end: Date | null, breakProfileItemId: string | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, break_profile_item_id)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual', $4)
         returning id`,
        [employeeId, start, end, breakProfileItemId]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function confirmRowCompletion(rowId: string, quantityPerRow: number, confirmedBy: string, segmentIds: string[]): Promise<void> {
      const { rows } = await pool.query(
        `insert into row_completions (greenhouse_row_id, density_type, quantity_per_row, confirmed_by_employee_id) values ($1, 'stems', $2, $3) returning id`,
        [rowId, quantityPerRow, confirmedBy]
      );
      for (const segId of segmentIds) {
        await pool.query(`insert into row_completion_segments (time_entry_id, row_completion_id) values ($1, $2)`, [segId, rows[0].id]);
      }
    }

    async function insertCarrier(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA Mobile Emp Carrier ${label} ${RUN_ID}`]);
      carrierIds.push(rows[0].id);
      return rows[0].id;
    }

    async function confirmCarrierCompletion(carrierId: string, confirmedBy: string, segmentIds: string[]): Promise<void> {
      const { rows } = await pool.query(`insert into carrier_completions (carrier_id, confirmed_by_employee_id) values ($1, $2) returning id`, [
        carrierId,
        confirmedBy,
      ]);
      completionIds.push(rows[0].id);
      for (const segId of segmentIds) {
        await pool.query(`insert into carrier_completion_segments (time_entry_id, carrier_completion_id) values ($1, $2)`, [segId, rows[0].id]);
      }
    }

    const adminId = await insertEmployee("Admin", administratorRoleId);
    const adminDevice = await pairDevice(adminId, "admin");
    const employeeOnlyId = await insertEmployee("PlainEmployee");
    const employeeOnlyDevice = await pairDevice(employeeOnlyId, "plainEmployee");

    const rowStemActivity = await insertActivity("Row Stem", "stems", "stems/hour");
    const pickingActivity = await insertActivity("Picking", null, "bins/hour");
    const noMetricActivity = await insertActivity("No Metric", null, null);

    // -----------------------------------------------------------------
    // requireDeviceRole gate: a general Employee's device must never see
    // this data.
    // -----------------------------------------------------------------
    {
      const res = await callDevice("GET", "/api/mobile/employees/live", employeeOnlyDevice);
      check(res.status === 403, "a general Employee's device is rejected from GET /live", res.body);
    }

    // -----------------------------------------------------------------
    // 4), 5), 6), 8) Row/stem working employee: confirmed completion this
    // week (500 stems / 1 hour = 500/hr), currently open on a different row
    // -> row location label, speed "ok".
    // -----------------------------------------------------------------
    const empRowStem = await insertEmployee("Row Stem Worker");
    {
      const rowA = await insertRow(1);
      const rowOpen = await insertRow(2);
      await insertDensity(500, [rowA]);
      const completedEntry = await insertWork(empRowStem, rowStemActivity, hoursAgo(3), hoursAgo(2), { rowId: rowA, densityCountPerRow: 500 });
      await confirmRowCompletion(rowA, 500, adminId, [completedEntry]);
      await insertWork(empRowStem, rowStemActivity, hoursAgo(1), null, { rowId: rowOpen });
    }

    // -----------------------------------------------------------------
    // 6) Picking working employee: confirmed bin completion (1 bin / 1 hour
    // = 1 bin/hour), currently open on a carrier -> carrier location label.
    // -----------------------------------------------------------------
    const empPicking = await insertEmployee("Picking Worker");
    {
      const carrierA = await insertCarrier("A");
      const carrierOpen = await insertCarrier("Open");
      const completedEntry = await insertWork(empPicking, pickingActivity, hoursAgo(2), hoursAgo(1), { carrierId: carrierA });
      await confirmCarrierCompletion(carrierA, adminId, [completedEntry]);
      await insertWork(empPicking, pickingActivity, hoursAgo(0.5), null, { carrierId: carrierOpen });
    }

    // -----------------------------------------------------------------
    // 6) An activity with no speed concept at all (density_source and
    // speed_unit both null) and no row/carrier -> "No speed metric",
    // locationType "none" (the missing-location case).
    // -----------------------------------------------------------------
    const empNoMetric = await insertEmployee("No Metric Worker");
    await insertWork(empNoMetric, noMetricActivity, hoursAgo(1), null);

    // -----------------------------------------------------------------
    // 8), 9) Below the minimum-duration floor -> "Not enough data", not a
    // noisy number. A DELETED entry with a huge quantity is inserted in the
    // same window to prove it's excluded from the ratio, not just small.
    // -----------------------------------------------------------------
    const empNotEnoughData = await insertEmployee("Not Enough Data Worker");
    {
      const rowShort = await insertRow(3);
      const rowDeleted = await insertRow(4);
      const rowOpen = await insertRow(5);
      await insertDensity(100, [rowShort]);
      await insertDensity(99999, [rowDeleted]);
      const shortEntry = await insertWork(empNotEnoughData, rowStemActivity, hoursAgo(0.05), hoursAgo(0.0167), { rowId: rowShort, densityCountPerRow: 100 }); // ~5 minutes, well under the 15-minute floor
      await confirmRowCompletion(rowShort, 100, adminId, [shortEntry]);
      // A deleted work entry with a huge completed quantity — if this were
      // wrongly included, it would swamp the ratio and produce a large
      // speed instead of null.
      const deletedEntry = await insertWork(empNotEnoughData, rowStemActivity, hoursAgo(0.2), hoursAgo(0.03), {
        rowId: rowDeleted,
        densityCountPerRow: 99999,
        deleted: true,
      });
      await confirmRowCompletion(rowDeleted, 99999, adminId, [deletedEntry]);
      await insertWork(empNotEnoughData, rowStemActivity, hoursAgo(0.01), null, { rowId: rowOpen });
    }

    // -----------------------------------------------------------------
    // 7) On-break employee, WITH a scheduled break type name, whose prior
    // work segment ends exactly at the break's start -> resumingActivityName
    // is reliably resolved (never guessed).
    // -----------------------------------------------------------------
    const empOnBreakWithResume = await insertEmployee("On Break Resume");
    {
      const breakProfile = await pool.query(
        `insert into break_profiles (name, is_active) values ($1, true) returning id`,
        [`QA Mobile Emp Break Profile ${RUN_ID}`]
      );
      breakProfileIds.push(breakProfile.rows[0].id);
      const breakItem = await pool.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, fixed_break, auto_add, sort_order)
         values ($1, $2, '12:00', '12:30', false, false, false, 1) returning id`,
        [breakProfile.rows[0].id, `Lunch ${RUN_ID}`]
      );
      breakProfileItemIds.push(breakItem.rows[0].id);

      const workEnd = hoursAgo(0.5);
      const row = await insertRow(6);
      await insertWork(empOnBreakWithResume, rowStemActivity, hoursAgo(1.5), workEnd, { rowId: row });
      await insertBreak(empOnBreakWithResume, workEnd, null, breakItem.rows[0].id);
    }

    // -----------------------------------------------------------------
    // 7) On-break employee with NO break_profile_item (an unscheduled
    // manual break) and no reliably-resolvable prior work (a backdated
    // break whose start doesn't exactly match any prior segment's end) ->
    // breakType falls back to "Break", resumingActivityName stays null
    // rather than guessing.
    // -----------------------------------------------------------------
    const empOnBreakUnscheduled = await insertEmployee("On Break Unscheduled");
    await insertBreak(empOnBreakUnscheduled, hoursAgo(0.25), null, null);

    const res = await callDevice("GET", "/api/mobile/employees/live", adminDevice);
    check(res.status === 200, "GET /live succeeds for an Administrator's device", res.body);
    const employees: any[] = res.body?.employees ?? [];
    const byId = new Map(employees.map((e) => [e.employeeId, e]));

    // -----------------------------------------------------------------
    // 4) Every currently clocked-in employee appears, regardless of
    // activity type — including on-break employees.
    // -----------------------------------------------------------------
    check(
      byId.has(empRowStem) &&
        byId.has(empPicking) &&
        byId.has(empNoMetric) &&
        byId.has(empNotEnoughData) &&
        byId.has(empOnBreakWithResume) &&
        byId.has(empOnBreakUnscheduled),
      "4) every currently clocked-in employee (working or on break) appears",
      [...byId.keys()]
    );

    // -----------------------------------------------------------------
    // 5), 6), 8) Row/stem card: correct status, location, speed, unit.
    // -----------------------------------------------------------------
    const rowStemCard = byId.get(empRowStem);
    check(rowStemCard?.status === "working", "5) row/stem employee shows status working", rowStemCard);
    check(rowStemCard?.locationType === "row" && !!rowStemCard?.rowLabel, "6) row/stem employee has a row location label", rowStemCard);
    check(rowStemCard?.speedState === "ok" && Math.abs((rowStemCard?.speedValue ?? 0) - 500) < 0.01, "8) row/stem speed is the ratio-of-sums 500/hr", rowStemCard);
    check(rowStemCard?.speedUnit === "stems/hour", "8) row/stem speed unit is exactly stems/hour, matching the activity's own frozen unit", rowStemCard?.speedUnit);

    // -----------------------------------------------------------------
    // 5), 6), 8) Picking card: correct status, carrier location, speed,
    // unit.
    // -----------------------------------------------------------------
    const pickingCard = byId.get(empPicking);
    check(pickingCard?.status === "working", "5) picking employee shows status working", pickingCard);
    check(pickingCard?.locationType === "carrier" && !!pickingCard?.carrierName, "6) picking employee has a carrier location label", pickingCard);
    check(pickingCard?.speedState === "ok" && Math.abs((pickingCard?.speedValue ?? 0) - 1) < 0.01, "8) picking speed is the ratio-of-sums 1 bin/hr", pickingCard);
    check(pickingCard?.speedUnit === "bins/hour", "8) picking speed unit is exactly bins/hour", pickingCard?.speedUnit);

    // -----------------------------------------------------------------
    // 6) No-metric card: no speed concept at all, no location.
    // -----------------------------------------------------------------
    const noMetricCard = byId.get(empNoMetric);
    check(noMetricCard?.speedState === "no_metric" && noMetricCard?.speedValue === null, "6) an activity with no configured speed concept shows 'No speed metric', not a guess", noMetricCard);
    check(noMetricCard?.locationType === "none", "6) an activity with no row/carrier shows the missing-location state", noMetricCard);

    // -----------------------------------------------------------------
    // 8), 9) Below-floor card: not enough data, deleted entry excluded.
    // -----------------------------------------------------------------
    const notEnoughDataCard = byId.get(empNotEnoughData);
    check(
      notEnoughDataCard?.speedState === "not_enough_data" && notEnoughDataCard?.speedValue === null,
      "8) below the minimum-duration floor shows 'Not enough data', not a noisy number",
      notEnoughDataCard
    );
    check(
      notEnoughDataCard?.speedValue !== 99999 && notEnoughDataCard?.speedState !== "ok",
      "9) a deleted entry's huge quantity never leaks into the speed calculation",
      notEnoughDataCard
    );

    // -----------------------------------------------------------------
    // 7) Break cards: status on_break, correct break type, resuming
    // activity resolved only when reliably determinable.
    // -----------------------------------------------------------------
    const breakResumeCard = byId.get(empOnBreakWithResume);
    check(breakResumeCard?.status === "on_break", "7) on-break employee is clearly labeled on_break", breakResumeCard);
    check(breakResumeCard?.breakType === `Lunch ${RUN_ID}`, "7) the scheduled break's own type name is shown", breakResumeCard?.breakType);
    check(
      breakResumeCard?.resumingActivityName === `QA Mobile Emp Row Stem ${RUN_ID}`,
      "7) the resuming activity is resolved via the exact ended_at = break.started_at boundary match",
      breakResumeCard
    );

    const breakUnscheduledCard = byId.get(empOnBreakUnscheduled);
    check(breakUnscheduledCard?.status === "on_break", "7) an unscheduled break still shows status on_break", breakUnscheduledCard);
    check(breakUnscheduledCard?.breakType === "Break", "7) an unscheduled break with no profile item falls back to the honest generic label 'Break'", breakUnscheduledCard?.breakType);
    check(
      breakUnscheduledCard?.resumingActivityName === null,
      "7) resumingActivityName is never guessed when no exact boundary match exists",
      breakUnscheduledCard
    );

    // -----------------------------------------------------------------
    // Sort order: working employees first, then on break, then
    // alphabetical within each group.
    // -----------------------------------------------------------------
    const thisRunEmployees = employees.filter((e) =>
      [empRowStem, empPicking, empNoMetric, empNotEnoughData, empOnBreakWithResume, empOnBreakUnscheduled].includes(e.employeeId)
    );
    const firstBreakIndex = thisRunEmployees.findIndex((e) => e.status === "on_break");
    const lastWorkingIndex = (() => {
      let idx = -1;
      thisRunEmployees.forEach((e, i) => {
        if (e.status === "working") idx = i;
      });
      return idx;
    })();
    check(firstBreakIndex === -1 || lastWorkingIndex < firstBreakIndex, "working employees sort before on-break employees", thisRunEmployees.map((e) => e.status));

    const workingNames = thisRunEmployees.filter((e) => e.status === "working").map((e) => `${e.employeeFirstName} ${e.employeeLastName}`.toLowerCase());
    const sortedWorkingNames = [...workingNames].sort((a, b) => a.localeCompare(b));
    check(JSON.stringify(workingNames) === JSON.stringify(sortedWorkingNames), "working employees are alphabetically ordered within their group", workingNames);
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (completionIds.length) {
      await tryDelete("carrier_completion_segments", () => pool.query(`delete from carrier_completion_segments where carrier_completion_id = any($1::uuid[])`, [completionIds]));
      await tryDelete("carrier_completions", () => pool.query(`delete from carrier_completions where id = any($1::uuid[])`, [completionIds]));
    }
    if (rowIds.length) {
      await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
      await tryDelete("plant_density_rows", () => pool.query(`delete from plant_density_rows where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    }
    if (densityIds.length) await tryDelete("plant_densities", () => pool.query(`delete from plant_densities where id = any($1::uuid[])`, [densityIds]));
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (breakProfileItemIds.length) await tryDelete("break_profile_items", () => pool.query(`delete from break_profile_items where id = any($1::uuid[])`, [breakProfileItemIds]));
    if (breakProfileIds.length) await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = any($1::uuid[])`, [breakProfileIds]));
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
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
