// Integration test for GET /api/integrations/productive-tv/pruning-speed —
// the read-only, machine-authenticated endpoint an external Windows PC
// (Productive TV) polls to fold LabourLink employees into its own Pruning
// slide (a combined stems/hour ranking, Ridder- or LabourLink-tagged, no
// employee matching/deduplication on their side). Covers: bearer-token auth
// (missing/garbage/deactivated/valid, and that the raw token is never
// logged), date-range validation, the "Winding & Pruning" activity's
// missing/inactive/wrong-density-source configuration failures, the
// successful shape (and that it reuses the SAME attribution/speed functions
// Reports/Dashboard use, so an ambiguous/unresolved row is excluded exactly
// the way it already is everywhere else), the empty-vs-error distinction,
// and that no payroll field ever appears in the response.
//
// Same real-HTTP-against-real-database convention as
// rowCompletions.cycleGrouping.test.ts. This is the ONE test in the suite
// that legitimately needs an activity literally named "Winding & Pruning"
// (the endpoint matches that exact business name, not a QA-prefixed one) —
// any stale row left behind by a previously-aborted run is deleted before
// this test creates its own, and the row this test creates is deleted in
// the same `finally` cleanup as everything else.
//
// Run with: npm run test:integrations-productive-tv-pruning-speed
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { pool } from "../db";
import { zonedWallTimeToUtc } from "../lib/timezone";
import { generateIntegrationToken } from "../lib/integrationToken";
import integrationsRoutes, { PRUNING_ACTIVITY_NAME } from "./integrations";

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
  app.use("/api/integrations", integrationsRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(
    path: string,
    opts: { token?: string; noAuthHeader?: boolean; captureLogs?: boolean } = {}
  ): Promise<{ status: number; body: any; logs?: string[] }> {
    const logs: string[] = [];
    let restoreConsole: (() => void) | null = null;
    if (opts.captureLogs) {
      const origWarn = console.warn;
      const origError = console.error;
      console.warn = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      console.error = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      restoreConsole = () => {
        console.warn = origWarn;
        console.error = origError;
      };
    }
    try {
      const headers: Record<string, string> = {};
      if (!opts.noAuthHeader) headers.Authorization = `Bearer ${opts.token ?? ""}`;
      const res = await fetch(`${BASE}${path}`, { headers });
      const body = await res.json().catch(() => null);
      return { status: res.status, body, logs: opts.captureLogs ? logs : undefined };
    } finally {
      restoreConsole?.();
    }
  }

  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const rowIds: string[] = [];
  const timeEntryIds: string[] = [];
  const integrationTokenIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [
          `Productive TV ${label} ${RUN_ID}`,
          `qa-productive-tv-${label.toLowerCase()}-${RUN_ID}@test.local`,
          employeeRoleId,
          teamRoleId,
          fakePinHash,
        ]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Productive TV Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Productive TV Phase ${RUN_ID}`,
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

    async function insertWork(
      employeeId: string,
      activityId: string,
      rowId: string,
      startHour: number,
      startMinute: number,
      endHour: number,
      endMinute: number,
      densityCountPerRow: number
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 3, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 3, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', $6) returning id`,
        [employeeId, activityId, startedAt, endedAt, rowId, densityCountPerRow]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertToken(name: string, active: boolean): Promise<string> {
      const { token, tokenHash } = generateIntegrationToken();
      const { rows } = await pool.query(
        `insert into integration_tokens (name, token_hash, is_active) values ($1, $2, $3) returning id`,
        [name, tokenHash, active]
      );
      integrationTokenIds.push(rows[0].id);
      return token;
    }

    const FROM = "2019-06-01";
    const TO = "2019-06-07";

    const validToken = await insertToken(`QA Productive TV ${RUN_ID}`, true);
    const deactivatedToken = await insertToken(`QA Productive TV Deactivated ${RUN_ID}`, false);

    // -----------------------------------------------------------------
    // 1) Authentication — no session, no URL token, a dedicated bearer
    //    header only.
    // -----------------------------------------------------------------
    {
      const noHeader = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { noAuthHeader: true });
      check(noHeader.status === 401, "1) missing Authorization header is rejected (401)", noHeader);

      const garbage = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: "not-a-real-token" });
      check(garbage.status === 401, "1) an unrecognized bearer token is rejected (401)", garbage);

      const deactivated = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: deactivatedToken });
      check(deactivated.status === 401, "1) a deactivated token is rejected (401), same as an unknown one", deactivated);

      // The raw token must never appear in a log line, on success or failure.
      const captured = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, {
        token: "not-a-real-token-either",
        captureLogs: true,
      });
      check(
        !(captured.logs ?? []).some((line) => line.includes("not-a-real-token-either")),
        "1) an invalid token's raw value never appears in a log line",
        captured.logs
      );
    }

    // -----------------------------------------------------------------
    // 2) Date validation — before the activity is even configured, so
    //    these must fail on the request itself, independent of any
    //    downstream lookup.
    // -----------------------------------------------------------------
    {
      const missing = await call(`/api/integrations/productive-tv/pruning-speed`, { token: validToken });
      check(missing.status === 400, "2) missing from/to is rejected (400)", missing);

      const malformed = await call(`/api/integrations/productive-tv/pruning-speed?from=not-a-date&to=${TO}`, { token: validToken });
      check(malformed.status === 400, "2) a malformed date is rejected (400)", malformed);

      const backwards = await call(`/api/integrations/productive-tv/pruning-speed?from=${TO}&to=${FROM}`, { token: validToken });
      check(backwards.status === 400, "2) from after to is rejected (400)", backwards);

      const tooWide = await call(`/api/integrations/productive-tv/pruning-speed?from=2019-01-01&to=2019-06-01`, { token: validToken });
      check(tooWide.status === 400, "2) a range over 90 days is rejected (400)", tooWide);
    }

    // -----------------------------------------------------------------
    // 3) Activity configuration — fails clearly at each wrong state, using
    //    a non-2xx status distinct from a validation error (503, not 400).
    //    Defensive cleanup first: delete any "Winding & Pruning" row a
    //    previously-aborted run of this same test might have left behind,
    //    since activities.name is globally unique.
    // -----------------------------------------------------------------
    await pool.query(`delete from time_entries where activity_id in (select id from activities where name = $1)`, [PRUNING_ACTIVITY_NAME]);
    await pool.query(`delete from activities where name = $1`, [PRUNING_ACTIVITY_NAME]);

    const missingActivity = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
    check(missingActivity.status === 503, "3) no configured Winding & Pruning activity at all fails clearly (503, not a crash)", missingActivity.body);

    const { rows: inactiveActivityRows } = await pool.query(
      `insert into activities (name, is_active, density_source, sort_order) values ($1, false, 'stems', 0) returning id`,
      [PRUNING_ACTIVITY_NAME]
    );
    const pruningActivityId = inactiveActivityRows[0].id;
    activityIds.push(pruningActivityId);

    const inactive = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
    check(inactive.status === 503, "3) an inactive Winding & Pruning activity fails clearly (503)", inactive.body);

    await pool.query(`update activities set is_active = true, density_source = 'plants' where id = $1`, [pruningActivityId]);
    const wrongUnit = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
    check(wrongUnit.status === 503, "3) an active Winding & Pruning activity configured for plants (not stems) fails clearly (503)", wrongUnit.body);

    await pool.query(`update activities set density_source = 'stems' where id = $1`, [pruningActivityId]);

    // -----------------------------------------------------------------
    // 4) Correctly configured, but nobody has done any qualifying work in
    //    range yet — a genuine success, not an error.
    // -----------------------------------------------------------------
    {
      const empty = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
      check(empty.status === 200, "4) a correctly configured activity with no work in range is a 200, not an error", empty.body);
      check(Array.isArray(empty.body?.employees) && empty.body.employees.length === 0, "4) the employee list is a genuinely empty array", empty.body);
      check(empty.body?.unit === "stems_per_hour", "4) unit is stems_per_hour even on an empty result", empty.body);
      check(
        empty.body?.range?.from === FROM && empty.body?.range?.to === TO && typeof empty.body?.range?.timezone === "string",
        "4) range echoes back from/to and includes a timezone",
        empty.body?.range
      );
    }

    // -----------------------------------------------------------------
    // 5) One employee with a clean, unambiguous visit — verifies the
    //    response shape and that the numbers match aggregateDensitySpeed's
    //    own ratio-of-sums (quantity / (duration/3600)), not a re-derived
    //    calculation, and that no payroll field ever appears.
    // -----------------------------------------------------------------
    const rowClean = await insertRow(1);
    const empClean = await insertEmployee("Clean");
    {
      // 2 hours, 400 stems -> 200 stems/hour.
      await insertWork(empClean, pruningActivityId, rowClean, 8, 0, 10, 0, 400);

      const res = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
      check(res.status === 200, "5) a clean visit returns 200", res.body);
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empClean);
      check(entry !== undefined, "5) the employee appears in the result", res.body?.employees);
      check(entry?.employeeName?.includes("Clean"), "5) employeeName is populated", entry);
      check(entry?.stemsPerHour === 200, "5) stemsPerHour is the ratio-of-sums (400 stems / 2 hours = 200/hour)", entry);
      check(entry?.stemsCounted === 400, "5) stemsCounted is the raw summed quantity", entry);
      check(entry?.activityHours === 2, "5) activityHours is the employee's total hours in this activity", entry);
      check(
        entry && Object.keys(entry).sort().join(",") === ["activityHours", "employeeId", "employeeName", "stemsCounted", "stemsPerHour"].sort().join(","),
        "5) the response contains exactly the requested fields — no payroll fields (pay rate, break seconds, etc.)",
        entry
      );
    }

    // -----------------------------------------------------------------
    // 6) A second employee whose only row is genuinely ambiguous (two
    //    unbridged visits, same row+activity+density, no resolution) —
    //    must be EXCLUDED from the result entirely, the same way
    //    getActivityDensityAttribution already excludes it from Reports/
    //    Dashboard. Confirms this endpoint reuses that exclusion rather
    //    than re-deriving its own (looser) speed math.
    // -----------------------------------------------------------------
    const rowAmbiguous = await insertRow(2);
    const empAmbiguous = await insertEmployee("Ambiguous");
    {
      await insertWork(empAmbiguous, pruningActivityId, rowAmbiguous, 8, 0, 9, 0, 300);
      await insertWork(empAmbiguous, pruningActivityId, rowAmbiguous, 11, 0, 12, 0, 300);

      const res = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
      const entry = res.body?.employees?.find((e: any) => e.employeeId === empAmbiguous);
      check(entry === undefined, "6) an employee whose only work is an unresolved/ambiguous row is excluded, not shown with a fabricated speed", res.body?.employees);
      // The unambiguous employee from (5) must be completely unaffected.
      const cleanEntry = res.body?.employees?.find((e: any) => e.employeeId === empClean);
      check(cleanEntry?.stemsPerHour === 200, "6) the unrelated unambiguous employee's figure is untouched", cleanEntry);
    }

    // -----------------------------------------------------------------
    // 7) A valid token succeeds end-to-end (restates the auth check from
    //    (1) against the now-fully-configured activity, for completeness).
    // -----------------------------------------------------------------
    {
      const res = await call(`/api/integrations/productive-tv/pruning-speed?from=${FROM}&to=${TO}`, { token: validToken });
      check(res.status === 200, "7) a valid token against a correctly configured activity succeeds end-to-end", res.body);
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
    if (rowIds.length) await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
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
