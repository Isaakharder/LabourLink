// Integration test for GET /api/integrations/productive-tv/picking-speed —
// Productive TV's Picking Peppers stems/hour source. Verifies the endpoint
// returns exactly the Activity Report's own per-employee figure
// (getActivityReportData's employeeTotals: attributed stems / Activity
// Hours) across a realistic multi-employee week: a solo completed row, a
// row completion shared by two employees, a sole unresolved visit, an
// in-progress visit, an ambiguous row, breaks, a soft-deleted (corrected)
// entry, a reopened completion, and work either side of the week's local
// midnight boundaries. Also covers the 503 when Picking Peppers has no
// stems density source (never a bins or estimated fallback).
//
// Runs against either attribution version: before 055_row_completion_
// automation.sql (what production runs today) a row completion shared by two
// employees is excluded entirely, and there is no "reopened" state; from 055
// on, a shared completion is split by each employee's share of its time and
// a reopened completion never counts. Expectations follow the schema found.
//
// Picking Peppers is seeded by 003_activities_and_time_entries.sql, so this
// test borrows the existing row, records its original configuration and
// restores it in `finally` rather than deleting it.
//
// Run with: npm run test:integrations-productive-tv-picking-speed
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { pool } from "../db";
import { zonedWallTimeToUtc } from "../lib/timezone";
import { generateIntegrationToken } from "../lib/integrationToken";
import { getActivityReportData } from "../lib/reportQueries";
import integrationsRoutes, { PICKING_ACTIVITY_NAME } from "./integrations";

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
// A Monday-to-Sunday week, as Productive TV's "this week" requests it.
const FROM = "2019-06-03";
const TO = "2019-06-09";

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations", integrationsRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(path: string, token: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const url = (from = FROM, to = TO) => `/api/integrations/productive-tv/picking-speed?from=${from}&to=${to}`;

  const employeeIds: string[] = [];
  const rowIds: string[] = [];
  const timeEntryIds: string[] = [];
  const completionIds: string[] = [];
  const integrationTokenIds: string[] = [];
  let landId!: string;
  let phaseId!: string;
  let pickingActivityId: string | null = null;
  let createdActivity = false;
  let originalConfig: { is_active: boolean; density_source: string | null; speed_unit: string | null } | null = null;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Picking ${label} ${RUN_ID}`, `qa-picking-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Picking Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Picking Phase ${RUN_ID}`,
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

    type Wall = [day: number, hour: number, minute: number];
    const at = ([day, hour, minute]: Wall) => zonedWallTimeToUtc(2019, 6, day, hour, minute, 0);

    async function insertWork(employeeId: string, rowId: string | null, start: Wall, end: Wall | null, stems: number | null): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7) returning id`,
        [employeeId, pickingActivityId, at(start), end ? at(end) : null, rowId, stems == null ? null : "stems", stems]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, start: Wall, end: Wall): Promise<void> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, is_paid)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual', false) returning id`,
        [employeeId, at(start), at(end)]
      );
      timeEntryIds.push(rows[0].id);
    }

    const hasCompletionStatus =
      (await pool.query(`select 1 from information_schema.columns where table_name = 'row_completions' and column_name = 'status'`)).rowCount === 1;

    async function insertCompletion(rowId: string, quantity: number, segmentIds: string[], status = "active"): Promise<void> {
      const { rows } = hasCompletionStatus
        ? await pool.query(
            `insert into row_completions (greenhouse_row_id, activity_id, density_type, quantity_per_row, status)
             values ($1, $2, 'stems', $3, $4) returning id`,
            [rowId, pickingActivityId, quantity, status]
          )
        : await pool.query(
            `insert into row_completions (greenhouse_row_id, activity_id, density_type, quantity_per_row)
             values ($1, $2, 'stems', $3) returning id`,
            [rowId, pickingActivityId, quantity]
          );
      completionIds.push(rows[0].id);
      for (const segId of segmentIds) {
        await pool.query(`insert into row_completion_segments (time_entry_id, row_completion_id) values ($1, $2)`, [segId, rows[0].id]);
      }
    }

    const { token: validToken, tokenHash } = generateIntegrationToken();
    integrationTokenIds.push(
      (
        await pool.query(`insert into integration_tokens (name, token_hash, is_active) values ($1, $2, true) returning id`, [
          `QA Picking ${RUN_ID}`,
          tokenHash,
        ])
      ).rows[0].id
    );

    // -----------------------------------------------------------------
    // 1) Picking Peppers with no stems density source (how it's seeded,
    //    and the state where Picking only has bins/hour) must be a clear
    //    503 density_source_not_stems — never bins, never an estimate.
    // -----------------------------------------------------------------
    const existing = await pool.query(
      `select id, is_active, density_source, speed_unit from activities where lower(trim(name)) = lower(trim($1))`,
      [PICKING_ACTIVITY_NAME]
    );
    if (existing.rows[0]) {
      pickingActivityId = existing.rows[0].id;
      originalConfig = {
        is_active: existing.rows[0].is_active,
        density_source: existing.rows[0].density_source,
        speed_unit: existing.rows[0].speed_unit,
      };
    } else {
      pickingActivityId = (
        await pool.query(`insert into activities (name, is_active, density_source, sort_order) values ($1, true, null, 0) returning id`, [
          PICKING_ACTIVITY_NAME,
        ])
      ).rows[0].id;
      createdActivity = true;
    }

    await pool.query(`update activities set is_active = true, density_source = null, speed_unit = 'bins/hour' where id = $1`, [pickingActivityId]);
    {
      const res = await call(url(), validToken);
      check(res.status === 503, "1) Picking Peppers without a stems density source is a 503", res);
      check(res.body?.reason === "density_source_not_stems", "1) the 503 names the missing configuration", res.body);
      check(res.body?.employees === undefined, "1) no employee list (no bins fallback) is returned", res.body);
    }

    await pool.query(`update activities set is_active = false, density_source = 'stems', speed_unit = 'stems/hour' where id = $1`, [pickingActivityId]);
    {
      const res = await call(url(), validToken);
      check(res.status === 503 && res.body?.reason === "activity_inactive", "1) an inactive Picking Peppers is a 503 activity_inactive", res);
    }
    await pool.query(`update activities set is_active = true where id = $1`, [pickingActivityId]);

    // Date validation reuses the pruning endpoint's rules.
    {
      const backwards = await call(url(TO, FROM), validToken);
      check(backwards.status === 400, "1) from after to is rejected (400)", backwards);
      const noAuth = await fetch(`${BASE}${url()}`);
      check(noAuth.status === 401, "1) a missing bearer token is rejected (401)");
    }

    // -----------------------------------------------------------------
    // 2) A realistic week of Picking Peppers work.
    // -----------------------------------------------------------------
    const [row1, row2, row3, row4, row5, row6, row7, row8, row9, row10] = await Promise.all(
      [101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map((n) => insertRow(n))
    );
    const solo = await insertEmployee("Solo");
    const sharedA = await insertEmployee("SharedA");
    const sharedB = await insertEmployee("SharedB");
    const noSpeed = await insertEmployee("NoSpeed");
    const corrected = await insertEmployee("Corrected");
    const lateSunday = await insertEmployee("LateSunday");
    const nextWeek = await insertEmployee("NextWeek");

    // Solo: one confirmed row, 400 stems in 2h. A 30-min unpaid break
    // afterwards must not add to the denominator. -> 200 stems/h
    const soloSeg = await insertWork(solo, row1, [3, 8, 0], [3, 10, 0], 400);
    await insertCompletion(row1, 400, [soloSeg]);
    await insertBreak(solo, [3, 10, 0], [3, 10, 30]);

    // Shared row: one 600-stem completion, A picks 1h then B picks 2h.
    // Split by duration: A 200, B 400. A also has a sole unresolved visit on
    // row3 (300 stems, 1h) which counts once. A: 500 / 2h = 250; B: 400 / 2h = 200.
    const sharedSegA = await insertWork(sharedA, row2, [4, 7, 0], [4, 8, 0], 600);
    const sharedSegB = await insertWork(sharedB, row2, [4, 8, 0], [4, 10, 0], 600);
    await insertCompletion(row2, 600, [sharedSegA, sharedSegB]);
    await insertWork(sharedA, row3, [4, 9, 0], [4, 10, 0], 300);

    // NoSpeed: an ambiguous row (two unbridged visits to the same row, no
    // completion) plus a still-open visit — hours but no attributable stems.
    await insertWork(noSpeed, row4, [5, 8, 0], [5, 9, 0], 350);
    await insertWork(noSpeed, row4, [5, 11, 0], [5, 12, 0], 350);
    await insertWork(noSpeed, row5, [5, 13, 0], null, 350);

    // Corrected: a confirmed 300-stem row (1h); from 055, a row whose
    // completion was reopened (not counted, and its hour still counts as
    // Activity Hours); and a soft-deleted entry with a big stems count
    // (neither stems nor hours count). -> 300 / 2h = 150 (055), 300 / 1h before.
    const corrSeg = await insertWork(corrected, row6, [6, 8, 0], [6, 9, 0], 300);
    await insertCompletion(row6, 300, [corrSeg]);
    if (hasCompletionStatus) {
      const reopenedSeg = await insertWork(corrected, row7, [6, 9, 0], [6, 10, 0], 500);
      await insertCompletion(row7, 500, [reopenedSeg], "reopened");
    }
    const deletedSeg = await insertWork(corrected, row8, [6, 10, 0], [6, 13, 0], 999);
    await pool.query(`update time_entries set deleted_at = now(), deleted_by_employee_id = $2, deletion_reason = 'QA picking correction' where id = $1`, [deletedSeg, corrected]);

    // LateSunday: last local 45 minutes of the week, 150 stems -> 200/h.
    const lateSeg = await insertWork(lateSunday, row9, [9, 23, 0], [9, 23, 45], 150);
    await insertCompletion(row9, 150, [lateSeg]);

    // NextWeek: 00:30 local on the following Monday — outside the week.
    const nextSeg = await insertWork(nextWeek, row10, [10, 0, 30], [10, 2, 30], 400);
    await insertCompletion(row10, 400, [nextSeg]);

    const res = await call(url(), validToken);
    check(res.status === 200, "2) a configured Picking Peppers week returns 200", res.body);
    check(res.body?.unit === "stems_per_hour", "2) unit is stems_per_hour", res.body?.unit);
    check(res.body?.range?.from === FROM && res.body?.range?.to === TO && typeof res.body?.range?.timezone === "string", "2) range echoes the request with its timezone", res.body?.range);
    check(res.body?.activity?.name === PICKING_ACTIVITY_NAME, "2) activity is Picking Peppers", res.body?.activity);

    const byId = new Map<string, any>((res.body?.employees ?? []).map((e: any) => [e.employeeId, e]));
    const expect = (id: string, label: string, stemsPerHour: number, stems: number, hours: number) => {
      const e = byId.get(id);
      check(e?.stemsPerHour === stemsPerHour, `2) ${label}: stemsPerHour ${stemsPerHour}`, e);
      check(e?.stemsCounted === stems, `2) ${label}: stemsCounted ${stems}`, e);
      check(e?.activityHours === hours, `2) ${label}: activityHours ${hours}`, e);
    };
    expect(solo, "solo row, break excluded", 200, 400, 2);
    if (hasCompletionStatus) {
      expect(sharedA, "shared row split by duration + sole unresolved visit", 250, 500, 2);
      expect(sharedB, "other half of the shared row", 200, 400, 2);
      expect(corrected, "reopened completion and deleted entry excluded", 150, 300, 2);
    } else {
      // Pre-055: the shared completion counts for nobody; its hours still do.
      expect(sharedA, "shared row excluded, sole unresolved visit counted", 150, 300, 2);
      check(!byId.has(sharedB), "2) pre-055: an employee whose only stems are in a shared row is omitted, not shown as 0", byId.get(sharedB));
      expect(corrected, "deleted entry excluded", 300, 300, 1);
    }
    expect(lateSunday, "Sunday 23:00-23:45 local is inside the week", 200, 150, 0.75);

    check(!byId.has(noSpeed), "2) an employee with hours but no attributable stems is omitted, never shown as 0", byId.get(noSpeed));
    check(!byId.has(nextWeek), "2) next Monday 00:30 local is outside the week", byId.get(nextWeek));
    const expectedWithoutSpeed = hasCompletionStatus ? 1 : 2;
    check(res.body?.employeesWithoutSpeed === expectedWithoutSpeed, "2) employeesWithoutSpeed counts the omitted employees", res.body?.employeesWithoutSpeed);
    check([...byId.values()].every((e) => e.stemsPerHour > 0), "2) no returned employee has a zero speed", res.body?.employees);
    check(
      [...byId.values()].every((e) => Math.abs(e.stemsPerHour - e.stemsCounted / e.activityHours) < 0.01),
      "2) stemsPerHour always equals stemsCounted / activityHours",
      res.body?.employees
    );
    const soloEntry = byId.get(solo);
    check(
      soloEntry && Object.keys(soloEntry).sort().join(",") === ["activityHours", "employeeId", "employeeName", "stemsCounted", "stemsPerHour"].sort().join(","),
      "2) employee entries carry no payroll fields",
      soloEntry
    );

    // The endpoint's figure is the Activity Report's own figure, not a
    // parallel calculation.
    const report = await getActivityReportData(pickingActivityId!, FROM, TO, { employeeIds });
    for (const total of report?.employeeTotals ?? []) {
      const e = byId.get(total.employeeId);
      if (total.averageSpeed == null) {
        check(e === undefined, `2) report has no speed for ${total.employeeName}, endpoint omits them`, e);
      } else {
        check(e?.stemsPerHour === Math.round(total.averageSpeed * 100) / 100, `2) endpoint matches the Activity Report for ${total.employeeName}`, { e, total });
      }
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
    if (completionIds.length) await tryDelete("row_completions", () => pool.query(`delete from row_completions where id = any($1::uuid[])`, [completionIds]));
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (pickingActivityId && createdActivity) {
      await tryDelete("activities", () => pool.query(`delete from activities where id = $1`, [pickingActivityId]));
    } else if (pickingActivityId && originalConfig) {
      const cfg = originalConfig;
      await tryDelete("activities restore", () =>
        pool.query(`update activities set is_active = $2, density_source = $3, speed_unit = $4 where id = $1`, [
          pickingActivityId,
          cfg.is_active,
          cfg.density_source,
          cfg.speed_unit,
        ])
      );
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
