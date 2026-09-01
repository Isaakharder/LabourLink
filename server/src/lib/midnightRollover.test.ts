// Integration test for midnight rollover (midnightRollover.ts) — real
// router/lib functions over the real database, RUN_ID-suffixed disposable
// QA fixtures, cleanup in a `finally` block regardless of pass/fail. Same
// convention as inputs.badgeReviewConsistency.test.ts / dailyCutoff.test.ts.
//
// Covers every scenario the midnight-rollover requirements call out:
// working through midnight, on-break through midnight, several missed
// days, simultaneous server/client rollover, retry, timezone/DST boundary
// math, a rounding-enabled employee's synthetic boundaries staying
// unrounded, a real employee tap landing exactly at the boundary, row/
// carrier/density continuity, no false Row Completion Review items, the
// request-time wiring (GET /api/mobile/me), and dailyCutoff's new
// outer-fallback threshold.
//
// Run with: npm run test:midnight-rollover
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { computeRolloverBoundary, reconcileMidnightRollover, runMidnightRolloverSweep } from "./midnightRollover";
import { runDailyCutoff, DAILY_CUTOFF_STALE_DAYS } from "./dailyCutoff";
import { getUnresolvedRunsForRow } from "./rowCompletionCandidates";
import { getLongOpenShiftAlerts, getOrgSettings, setLongOpenShiftAlertThresholdHours } from "./longOpenShiftAlerts";
import { addDaysToDateStr, calendarDateInAppTimezone, getDayBoundsUtc, zonedWallTimeToUtc } from "./timezone";
import mobileTimeRouter from "../routes/mobileTime";

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

// ---------------------------------------------------------------------------
// Pure boundary math (no DB) — same DST cases dailyCutoff.test.ts already
// proves against getDayBoundsUtc directly; computeRolloverBoundary is that
// exact same primitive, reused verbatim, so this is a direct cross-check
// rather than a re-derivation.
// ---------------------------------------------------------------------------
check(
  computeRolloverBoundary("2026-08-05").toISOString() === "2026-08-06T04:00:00.000Z",
  "ordinary summer date rolls to exactly the next local midnight",
  computeRolloverBoundary("2026-08-05").toISOString()
);
check(
  computeRolloverBoundary("2026-03-07").toISOString() === "2026-03-08T05:00:00.000Z",
  "day before spring-forward uses the pre-DST (EST/UTC-5) offset",
  computeRolloverBoundary("2026-03-07").toISOString()
);
check(
  computeRolloverBoundary("2026-03-08").toISOString() === "2026-03-09T04:00:00.000Z",
  "spring-forward day itself uses the post-DST (EDT/UTC-4) offset",
  computeRolloverBoundary("2026-03-08").toISOString()
);
check(
  computeRolloverBoundary("2026-10-31").toISOString() === "2026-11-01T04:00:00.000Z",
  "day before fall-back uses the pre-transition (EDT/UTC-4) offset",
  computeRolloverBoundary("2026-10-31").toISOString()
);
check(
  computeRolloverBoundary("2026-11-01").toISOString() === "2026-11-02T05:00:00.000Z",
  "fall-back day itself uses the post-transition (EST/UTC-5) offset",
  computeRolloverBoundary("2026-11-01").toISOString()
);
for (const d of ["2026-01-01", "2026-06-15", "2026-12-31", "2026-03-08", "2026-11-01"]) {
  check(
    computeRolloverBoundary(d).getTime() === getDayBoundsUtc(d).end.getTime(),
    `computeRolloverBoundary("${d}") equals getDayBoundsUtc(d).end exactly`
  );
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function callMobile(
    method: string,
    path: string,
    deviceIdentifier: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const timeEntryIds: string[] = [];
  const activityIds: string[] = [];
  const rowIds: string[] = [];
  const carrierIds: string[] = [];
  let breakProfileId!: string;
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Rollover-${label}-${RUN_ID}`, `qa-rollover-${label.toLowerCase()}-${RUN_ID}@test.local`, roleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertDevice(employeeId: string, label: string): Promise<{ deviceRowId: string; deviceIdentifier: string }> {
      const deviceIdentifier = randomUUID();
      const { rows } = await pool.query(
        `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
        [deviceIdentifier, `QA Rollover Device ${label} ${RUN_ID}`]
      );
      deviceIds.push(rows[0].id);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
      return { deviceRowId: rows[0].id, deviceIdentifier };
    }

    // Every scenario below gets its OWN fresh employee (+ device) rather
    // than sharing one across scenarios — fetchChain/fetchOpenEntry filter
    // by a date range, and reusing one employee across scenarios whose
    // fixture dates happen to fall in overlapping windows would let one
    // scenario's already-closed, already-verified rows leak into another
    // scenario's "no gaps"/"exactly one open entry" assertions, which isn't
    // a real gap at all — just two unrelated chains interleaved by
    // timestamp. Full isolation per scenario avoids that entirely.
    let fixtureCounter = 0;
    async function freshFixture(label: string): Promise<{ employeeId: string; deviceRowId: string; deviceIdentifier: string }> {
      fixtureCounter++;
      const employeeId = await insertEmployee(`${label}${fixtureCounter}`);
      const { deviceRowId, deviceIdentifier } = await insertDevice(employeeId, `${label}${fixtureCounter}`);
      return { employeeId, deviceRowId, deviceIdentifier };
    }

    const activityId = (
      await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [
        `QA Rollover Activity ${RUN_ID}`,
      ])
    ).rows[0].id;
    activityIds.push(activityId);

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [
        `QA Rollover Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`,
        [landId, `QA Rollover Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    async function insertRow(rowNumber: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, rowNumber, rowNumber * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }
    const rowId = await insertRow(501);
    const rowIdAmbiguous = await insertRow(502);
    // Dedicated to test 11 only — getUnresolvedRunsForRow scans globally by
    // (row, activity, densityType) across every employee, not scoped to one
    // test's own fixtures, so reusing rowIdAmbiguous here would pick up
    // test 10's own (unrelated, still-unresolved) touch on that same row.
    const rowId11 = await insertRow(503);

    const carrierId = (
      await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA Rollover Carrier ${RUN_ID}`])
    ).rows[0].id;
    carrierIds.push(carrierId);

    // Break profile with ALL THREE rounding settings enabled, for the
    // "rounding-enabled employee" scenario — used only via direct
    // reconciliation calls below (empA/empB stay unrounded so the ordinary
    // tests aren't affected).
    breakProfileId = (
      await pool.query(
        `insert into break_profiles
           (name, is_active, work_start_rounding_enabled, work_start_rounding_direction, work_start_rounding_interval_minutes,
            work_end_rounding_enabled, work_end_rounding_direction, work_end_rounding_interval_minutes,
            break_rounding_enabled, break_rounding_direction, break_rounding_interval_minutes)
         values ($1, true, true, 'clockwise', 15, true, 'clockwise', 15, true, 'clockwise', 15)
         returning id`,
        [`QA Rollover Rounding Profile ${RUN_ID}`]
      )
    ).rows[0].id;
    const empRounding = await insertEmployee("Rounding");
    await pool.query(`update employees set break_profile_id = $1 where id = $2`, [breakProfileId, empRounding]);

    // Helper: insert a raw OPEN time_entries row directly (bypassing
    // openEntry()) with a real-relative-past started_at — the exact
    // shape a genuinely-stale, never-reconciled entry has.
    async function insertOpenEntry(opts: {
      employeeId: string;
      deviceId: string;
      entryType: "work" | "break";
      activityId?: string | null;
      startedAt: Date;
      greenhouseRowId?: string | null;
      carrierId?: string | null;
      densityType?: "plants" | "stems" | null;
      densityCountPerRow?: number | null;
    }): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries
           (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at,
            greenhouse_row_id, carrier_id, density_type, density_count_per_row, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual')
         returning id`,
        [
          opts.employeeId,
          opts.deviceId,
          opts.entryType,
          opts.activityId ?? null,
          randomUUID(),
          opts.startedAt,
          opts.greenhouseRowId ?? null,
          opts.carrierId ?? null,
          opts.densityType ?? null,
          opts.densityCountPerRow ?? null,
        ]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    function daysAgo(n: number, hour: number): Date {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - n);
      // Keep this well inside the local day regardless of DST — noon UTC is
      // always mid-afternoon/morning in APP_TIMEZONE, never crossing its
      // own local midnight due to the UTC offset alone.
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    }

    async function fetchEntry(id: string) {
      const { rows } = await pool.query(
        `select id, entry_type, activity_id, started_at, ended_at, greenhouse_row_id, carrier_id,
                density_type, density_count_per_row, source, rollover_of_entry_id, device_id,
                actual_started_at, actual_ended_at, auto_closed_at, idempotency_key
         from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }
    async function fetchOpenEntry(employeeId: string) {
      const { rows } = await pool.query(
        `select id, entry_type, activity_id, started_at, ended_at, greenhouse_row_id, carrier_id,
                density_type, density_count_per_row, source, rollover_of_entry_id
         from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
        [employeeId]
      );
      return rows[0];
    }
    async function fetchChain(employeeId: string, startedAt: Date) {
      const { rows } = await pool.query(
        `select id, entry_type, started_at, ended_at, rollover_of_entry_id, source
         from time_entries where employee_id = $1 and deleted_at is null and started_at >= $2
         order by started_at asc`,
        [employeeId, startedAt]
      );
      return rows;
    }

    // -----------------------------------------------------------------
    // 1) Working straight through ONE midnight (started yesterday local —
    //    a single hop reaches today): one continuation entry, exact
    //    boundary, same activity/row/carrier/density.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Working");
      const started = daysAgo(1, 14);
      const original = await insertOpenEntry({
        employeeId,
        deviceId: deviceRowId,
        entryType: "work",
        activityId,
        startedAt: started,
        greenhouseRowId: rowId,
        carrierId,
        densityType: "stems",
        densityCountPerRow: 400,
      });
      await reconcileMidnightRollover(employeeId);

      const originalAfter = await fetchEntry(original);
      const open = await fetchOpenEntry(employeeId);
      check(originalAfter.ended_at !== null, "1) original entry got closed");
      check(open !== undefined, "1) a new open entry now exists for the employee", open);
      check(open?.rollover_of_entry_id === original, "1) new entry's rollover_of_entry_id points at the original", open?.rollover_of_entry_id);
      check(open?.source === "midnight_rollover", "1) new entry's source is midnight_rollover");
      check(
        new Date(originalAfter.ended_at).getTime() === new Date(open.started_at).getTime(),
        "1) shared boundary — closed entry's ended_at exactly equals the new entry's started_at (no gap/overlap)"
      );
      check(open?.activity_id === activityId, "1) activity preserved verbatim");
      check(open?.greenhouse_row_id === rowId, "1) greenhouse row preserved verbatim");
      check(open?.carrier_id === carrierId, "1) carrier preserved verbatim");
      check(open?.density_type === "stems" && open?.density_count_per_row === 400, "1) density snapshot preserved verbatim");
      check(open?.entry_type === "work", "1) still a work entry, never silently converted");

      await pool.query(`update time_entries set ended_at = now() where id = $1`, [open.id]);
      timeEntryIds.push(open.id);
    }

    // -----------------------------------------------------------------
    // 2) On break through midnight: break continues as a break, never
    //    silently becomes work.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("OnBreak");
      const started = daysAgo(1, 15);
      const original = await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "break", startedAt: started });
      await reconcileMidnightRollover(employeeId);
      const open = await fetchOpenEntry(employeeId);
      check(open?.entry_type === "break", "2) continuation is still a break, not converted to work", open);
      check(open?.activity_id === null, "2) break continuation has no activity_id");
      check(open?.rollover_of_entry_id === original, "2) continuation links back to the original break");
      await pool.query(`update time_entries set ended_at = now() where id = $1`, [open.id]);
      timeEntryIds.push(open.id);
    }

    // -----------------------------------------------------------------
    // 3) Several missed midnights reconstructed in ONE call.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("MissedDays");
      const started = daysAgo(4, 10); // 4 local days ago
      await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await reconcileMidnightRollover(employeeId);
      const chain = await fetchChain(employeeId, started);
      // 4 real days elapsed since `started`'s own local day -> at least 4
      // closed segments (one per crossed midnight) plus one final open one.
      check(chain.length >= 5, "3) several missed midnights produce a full chain, not just one hop", chain.length);
      const closed = chain.filter((r: any) => r.ended_at !== null);
      const open = chain.find((r: any) => r.ended_at === null);
      check(open !== undefined, "3) the chain ends with exactly one still-open entry");
      // No gaps: every closed entry's ended_at exactly matches the NEXT
      // entry's started_at, all the way down the chain.
      let noGaps = true;
      for (let i = 0; i < chain.length - 1; i++) {
        if (new Date(chain[i].ended_at).getTime() !== new Date(chain[i + 1].started_at).getTime()) noGaps = false;
      }
      check(noGaps, "3) no gap or overlap anywhere across the reconstructed chain", chain);
      // Every closed boundary is exactly a local midnight.
      const allBoundariesAreMidnight = closed.every((r: any) => {
        const localDate = calendarDateInAppTimezone(new Date(r.started_at));
        return new Date(r.ended_at).getTime() === computeRolloverBoundary(localDate).getTime();
      });
      check(allBoundariesAreMidnight, "3) every intermediate close lands exactly on a local midnight boundary");
      if (open) {
        await pool.query(`update time_entries set ended_at = now() where id = $1`, [open.id]);
        timeEntryIds.push(open.id);
      }
    }

    // -----------------------------------------------------------------
    // 4) Simultaneous server-sweep + request-time reconciliation race for
    //    the same employee — advisory lock serializes, exactly one chain.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Race");
      const started = daysAgo(2, 9);
      await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await Promise.all([reconcileMidnightRollover(employeeId), runMidnightRolloverSweep()]);
      const chain = await fetchChain(employeeId, started);
      const openRows = chain.filter((r: any) => r.ended_at === null);
      check(openRows.length === 1, "4) exactly one open entry survives a concurrent sweep+request-time race", chain);
      let noGaps = true;
      for (let i = 0; i < chain.length - 1; i++) {
        if (new Date(chain[i].ended_at).getTime() !== new Date(chain[i + 1].started_at).getTime()) noGaps = false;
      }
      check(noGaps, "4) no duplicate/gapped rows from the race");
      if (openRows[0]) {
        await pool.query(`update time_entries set ended_at = now() where id = $1`, [openRows[0].id]);
        timeEntryIds.push(openRows[0].id);
      }
    }

    // -----------------------------------------------------------------
    // 5) Retry: calling reconciliation twice for the same already-resolved
    //    state is fully idempotent (no duplicate rows).
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Retry");
      const started = daysAgo(2, 11);
      await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: started });
      await reconcileMidnightRollover(employeeId);
      const afterFirst = await fetchChain(employeeId, started);
      await reconcileMidnightRollover(employeeId); // pure retry — nothing left to do
      const afterSecond = await fetchChain(employeeId, started);
      check(
        afterFirst.length === afterSecond.length,
        "5) a retry with nothing new to reconcile creates no additional rows",
        { first: afterFirst.length, second: afterSecond.length }
      );
      check(
        JSON.stringify(afterFirst.map((r: any) => r.id)) === JSON.stringify(afterSecond.map((r: any) => r.id)),
        "5) the exact same row ids exist after the retry"
      );
      const open = afterSecond.find((r: any) => r.ended_at === null);
      if (open) {
        await pool.query(`update time_entries set ended_at = now() where id = $1`, [open.id]);
        timeEntryIds.push(open.id);
      }
    }

    // -----------------------------------------------------------------
    // 8) Rounding-enabled employee: synthetic boundaries are never rounded
    //    — the continuation's started_at is exactly the boundary, not
    //    snapped to the profile's 15-minute interval. Single hop (started
    //    yesterday) so the expected final boundary is unambiguous.
    // -----------------------------------------------------------------
    {
      const started = daysAgo(1, 13);
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, source)
         values ($1, null, 'work', $2, $3, $4, 'manual') returning id`,
        [empRounding, activityId, randomUUID(), started]
      );
      const before = await pool.query(
        `select id from time_entries where employee_id = $1 and ended_at is null and deleted_at is null`,
        [empRounding]
      );
      timeEntryIds.push(before.rows[0].id);
      await reconcileMidnightRollover(empRounding);
      const open = await fetchOpenEntry(empRounding);
      const localDate = calendarDateInAppTimezone(started);
      check(
        new Date(open.started_at).getTime() === computeRolloverBoundary(localDate).getTime(),
        "8) rounding-enabled employee's synthetic boundary is exact, never snapped to the 15-minute rounding interval",
        { got: open?.started_at, expected: computeRolloverBoundary(localDate).toISOString() }
      );
      await pool.query(`update time_entries set ended_at = now() where id = $1`, [open.id]);
      timeEntryIds.push(open.id);
    }

    // -----------------------------------------------------------------
    // 10) Row/carrier/density continuity — explicit, dedicated check
    //     (also covered incidentally by test 1, verified again here on a
    //     second row/density combination, plus device provenance).
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId } = await freshFixture("Continuity");
      const started = daysAgo(1, 8);
      const original = await insertOpenEntry({
        employeeId,
        deviceId: deviceRowId,
        entryType: "work",
        activityId,
        startedAt: started,
        greenhouseRowId: rowIdAmbiguous,
        carrierId,
        densityType: "stems",
        densityCountPerRow: 777,
      });
      await reconcileMidnightRollover(employeeId);
      const open = await fetchOpenEntry(employeeId);
      check(open?.greenhouse_row_id === rowIdAmbiguous, "10) row id preserved exactly");
      check(open?.carrier_id === carrierId, "10) carrier id preserved exactly");
      check(open?.density_count_per_row === 777, "10) exact density quantity preserved");
      const origRow = await fetchEntry(original);
      check(origRow.device_id === deviceRowId, "10) original device attribution untouched on the closed entry");
      await pool.query(`update time_entries set ended_at = now() where id = $1`, [open.id]);
      timeEntryIds.push(open.id);
    }

    // -----------------------------------------------------------------
    // 11) No false Row Completion Review items: a single employee's visit
    //     to rowIdAmbiguous spanning 2 real midnights must NOT be reported
    //     as multiple separate unresolved candidates (which would
    //     incorrectly flag it ambiguous) — and a genuinely-separate second
    //     employee's visit to the SAME row+type must still be correctly
    //     detected as real ambiguity (negative control: the fix isn't
    //     overly permissive).
    // -----------------------------------------------------------------
    {
      const { employeeId: emp11a, deviceRowId: dev11a } = await freshFixture("Visit11A");
      const { employeeId: emp11b, deviceRowId: dev11b } = await freshFixture("Visit11B");
      const started = daysAgo(3, 9);
      await insertOpenEntry({
        employeeId: emp11a,
        deviceId: dev11a,
        entryType: "work",
        activityId,
        startedAt: started,
        greenhouseRowId: rowId11,
        densityType: "stems",
        densityCountPerRow: 250,
      });
      await reconcileMidnightRollover(emp11a);
      const openA = await fetchOpenEntry(emp11a);

      const soleCandidates = await getUnresolvedRunsForRow(rowId11, activityId, "stems");
      check(
        soleCandidates.length === 1,
        "11) a single visit spanning multiple real midnights is exactly ONE candidate, not one per day (no false ambiguity)",
        soleCandidates.map((c) => ({ runId: c.runId, startedAt: c.startedAt, endedAt: c.endedAt }))
      );
      if (soleCandidates.length === 1) {
        check(
          new Date(soleCandidates[0].startedAt).getTime() === started.getTime(),
          "11) the merged candidate's startedAt is the TRUE visit origin (first day), not the latest day's boundary",
          soleCandidates[0].startedAt
        );
        check(
          soleCandidates[0].segmentIds.length >= 3,
          "11) the merged candidate's segmentIds include every day's segment across the whole chain",
          soleCandidates[0].segmentIds.length
        );
      }

      // Negative control: a genuinely separate employee also touches the
      // same row — now there SHOULD be real ambiguity (2 distinct visits),
      // proving the fix merges only true same-employee continuations.
      await insertOpenEntry({
        employeeId: emp11b,
        deviceId: dev11b,
        entryType: "work",
        activityId,
        startedAt: daysAgo(1, 6),
        greenhouseRowId: rowId11,
        densityType: "stems",
        densityCountPerRow: 250,
      });
      const withRealAmbiguity = await getUnresolvedRunsForRow(rowId11, activityId, "stems");
      check(
        withRealAmbiguity.length === 2,
        "11) a genuinely separate second employee's visit IS still detected as real ambiguity (negative control)",
        withRealAmbiguity.map((c) => c.employeeId)
      );

      if (openA) {
        await pool.query(`update time_entries set ended_at = now() where id = $1`, [openA.id]);
        timeEntryIds.push(openA.id);
      }
      const openB = await fetchOpenEntry(emp11b);
      if (openB) {
        await pool.query(`update time_entries set ended_at = now() where id = $1`, [openB.id]);
        timeEntryIds.push(openB.id);
      }
    }

    // -----------------------------------------------------------------
    // 13) Long-open-shift alert: never fires under threshold; correctly
    //     fires OVER threshold for a shift whose CURRENT row's own
    //     started_at is recent (just rolled over) but whose true
    //     continuous streak — walked back across the rollover boundary —
    //     exceeds it; never touches/closes the entry; org_settings
    //     threshold read/write round-trips.
    // -----------------------------------------------------------------
    {
      const settingsBefore = await getOrgSettings();
      check(
        settingsBefore.longOpenShiftAlertThresholdHours === 16,
        "13) org_settings defaults to a 16-hour threshold",
        settingsBefore
      );

      const { employeeId: empUnder, deviceRowId: devUnder } = await freshFixture("AlertUnder");
      const shortShiftEntry = await insertOpenEntry({
        employeeId: empUnder,
        deviceId: devUnder,
        entryType: "work",
        activityId,
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
      });
      const underAlerts = await getLongOpenShiftAlerts(pool, 16, new Date());
      check(
        !underAlerts.some((a) => a.employeeId === empUnder),
        "13) a shift well under the threshold does not alert"
      );

      // A shift that started 3 real days ago and rolled forward across
      // those midnights — the CURRENT open row's own started_at is only
      // hours old (today's boundary), but the true continuous streak is
      // ~3 days, which must still trip a 16h threshold. This is exactly
      // the bug a naive "check the current row's own started_at" alert
      // would miss.
      const { employeeId: empOver, deviceRowId: devOver } = await freshFixture("AlertOver");
      await insertOpenEntry({
        employeeId: empOver,
        deviceId: devOver,
        entryType: "work",
        activityId,
        startedAt: daysAgo(3, 9),
      });
      await reconcileMidnightRollover(empOver);
      const rolledOpen = await fetchOpenEntry(empOver);
      // Was a hardcoded "< 16h" window — genuinely time-of-day-dependent:
      // a just-rolled entry's own age since local midnight is however many
      // hours have elapsed TODAY, which exceeds 16h for anyone running the
      // suite in the evening (a real failure this exact bug caused, not a
      // flake). Fixed to an exact equality against the computed boundary
      // instead of a window — deterministic at any time of day, and a
      // strictly stronger check than "recent" ever was.
      const todayLocalForSanity = calendarDateInAppTimezone(new Date());
      check(
        new Date(rolledOpen.started_at).getTime() === getDayBoundsUtc(todayLocalForSanity).start.getTime(),
        "13) sanity check — the CURRENT row's own started_at is EXACTLY today's local-midnight boundary (just rolled), regardless of what time of day this runs",
        { got: rolledOpen.started_at, expected: getDayBoundsUtc(todayLocalForSanity).start.toISOString() }
      );

      const overAlerts = await getLongOpenShiftAlerts(pool, 16, new Date());
      const alertForEmpOver = overAlerts.find((a) => a.employeeId === empOver);
      check(
        alertForEmpOver !== undefined,
        "13) a shift whose TRUE continuous streak (walked across rollover boundaries) exceeds 16h DOES alert",
        overAlerts.map((a) => ({ employeeId: a.employeeId, openHours: a.openHours }))
      );
      check(
        (alertForEmpOver?.openHours ?? 0) > 60,
        "13) the alert's reported openHours reflects the full multi-day streak, not just the current row's partial hours",
        alertForEmpOver?.openHours
      );

      const stillOpenAfterAlert = await fetchOpenEntry(empOver);
      check(stillOpenAfterAlert !== undefined && stillOpenAfterAlert.id === rolledOpen.id, "13) the alert never closes or otherwise touches the entry — review only");

      // Threshold read/write round-trip, restored to the default afterward
      // so this test never leaves shared org-wide config mutated.
      await setLongOpenShiftAlertThresholdHours(20, empOver);
      const settingsAfterSet = await getOrgSettings();
      check(settingsAfterSet.longOpenShiftAlertThresholdHours === 20, "13) threshold write round-trips through getOrgSettings");
      await setLongOpenShiftAlertThresholdHours(16, empOver);

      timeEntryIds.push(shortShiftEntry);
      await pool.query(`update time_entries set ended_at = now() where id = $1`, [shortShiftEntry]);
      await pool.query(`update time_entries set ended_at = now() where id = $1`, [rolledOpen.id]);
      timeEntryIds.push(rolledOpen.id);
    }

    // -----------------------------------------------------------------
    // 12) dailyCutoff's new outer-fallback threshold: does NOT fire on an
    //     entry only 1 real day stale (rollover should have already
    //     handled it), but DOES fire well past DAILY_CUTOFF_STALE_DAYS.
    // -----------------------------------------------------------------
    {
      const { employeeId: emp12a, deviceRowId: dev12a } = await freshFixture("CutoffRecent");
      const { employeeId: emp12b, deviceRowId: dev12b } = await freshFixture("CutoffStale");
      const recentlyStale = await insertOpenEntry({
        employeeId: emp12a,
        deviceId: dev12a,
        entryType: "work",
        activityId,
        startedAt: daysAgo(1, 10),
      });
      const veryStale = await insertOpenEntry({
        employeeId: emp12b,
        deviceId: dev12b,
        entryType: "work",
        activityId,
        startedAt: daysAgo(DAILY_CUTOFF_STALE_DAYS + 2, 10),
      });

      const result = await runDailyCutoff();
      const recentlyStaleAfter = await fetchEntry(recentlyStale);
      const veryStaleAfter = await fetchEntry(veryStale);
      check(recentlyStaleAfter.ended_at === null, "12) a 1-day-stale entry is left alone — rollover's job, not dailyCutoff's");
      check(veryStaleAfter.ended_at !== null, "12) an entry well past the outer-fallback threshold IS closed", result);
      check(veryStaleAfter.source !== "midnight_rollover", "12) dailyCutoff's own close never creates a rollover-tagged row");
      // recentlyStale is still open — cleanup below (timeEntryIds already
      // tracks it via insertOpenEntry's own push).
    }

    // -----------------------------------------------------------------
    // 6/7/9) Timezone-boundary + real-tap-at-boundary, exercised together
    // through the real HTTP request-time path (GET /api/mobile/me) —
    // proves the wiring (mobileTime.ts's serializeStatus call), not just
    // the lib function in isolation.
    // -----------------------------------------------------------------
    {
      const { employeeId, deviceRowId, deviceIdentifier } = await freshFixture("Boundary");
      // 6) An entry started just 15 minutes before ITS OWN local midnight,
      // yesterday — still must roll forward correctly (the boundary math
      // has no "too close to midnight" special case). Built via
      // zonedWallTimeToUtc directly (exact local wall-clock time), not
      // manual UTC-offset arithmetic.
      const yesterdayLocal = addDaysToDateStr(calendarDateInAppTimezone(new Date()), -1);
      const [y, mo, da] = yesterdayLocal.split("-").map(Number);
      const justBeforeMidnightLocal = zonedWallTimeToUtc(y, mo, da, 23, 45, 0);
      await insertOpenEntry({ employeeId, deviceId: deviceRowId, entryType: "work", activityId, startedAt: justBeforeMidnightLocal });

      const res = await callMobile("GET", "/api/mobile/me", deviceIdentifier);
      check(res.status === 200, "6/9) GET /api/mobile/me succeeds and triggers request-time reconciliation", res.body);
      check(res.body?.status === "work", "9) the employee still shows as actively working after reconciliation (real action preserved)");
      const open = await fetchOpenEntry(employeeId);
      check(open?.source === "midnight_rollover", "6) an entry started minutes before its own local midnight still rolls forward correctly");
      check(
        new Date(open.started_at).getTime() === computeRolloverBoundary(yesterdayLocal).getTime(),
        "6/7) resulting entry's started_at is exactly the local midnight boundary, not the original near-midnight tap",
        { got: open?.started_at, expected: computeRolloverBoundary(yesterdayLocal).toISOString() }
      );

      await pool.query(`update time_entries set ended_at = now() where id = $1`, [open.id]);
      timeEntryIds.push(open.id);
    }
  } finally {
    // Retries transient failures (a dropped pooled connection, a momentary
    // lock) up to 3 times, but a step that's still failing after that is
    // NOT swallowed — it counts as a real test failure (fail++, non-zero
    // exit) instead of being silently logged and moved past. A silent
    // catch here is exactly how the 2026-08-31 QA-fixture leak happened:
    // the employees/break_profiles deletes failed, were logged to stderr
    // (never persisted anywhere), and the run still reported success.
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

    // Corrections/deletions rows reference time_entries — clean those first.
    if (timeEntryIds.length) {
      await tryDelete("time_entry_corrections", () =>
        pool.query(`delete from time_entry_corrections where time_entry_id = any($1::uuid[])`, [timeEntryIds])
      );
    }
    // Any rows created directly by reconciliation but never explicitly
    // tracked above (e.g. intermediate chain links from test 3/4) — sweep
    // by employee id instead, which catches everything.
    if (employeeIds.length) {
      await tryDelete("time_entry_corrections (by employee)", () =>
        pool.query(`delete from time_entry_corrections where employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("row_completion_segments", () =>
        pool.query(
          `delete from row_completion_segments where time_entry_id in (select id from time_entries where employee_id = any($1::uuid[]))`,
          [employeeIds]
        )
      );
      await tryDelete("time_entries (by employee)", () => pool.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]));
    }
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (deviceIds.length) {
      await tryDelete("device_assignments", () => pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]));
      await tryDelete("devices", () => pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]));
    }
    if (employeeIds.length) {
      // org_settings.updated_by_employee_id (set by test 13's threshold
      // round-trip) otherwise blocks the employees delete below with a FK
      // violation — which, since the delete is one bulk statement, would
      // silently fail EVERY employee in the batch, not just the one
      // org_settings references, cascading into break_profiles below still
      // being referenced by empRounding's un-deleted row.
      await tryDelete("org_settings (clear updated_by)", () =>
        pool.query(`update org_settings set updated_by_employee_id = null where updated_by_employee_id = any($1::uuid[])`, [employeeIds])
      );
      await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    }
    if (breakProfileId) await tryDelete("break_profiles", () => pool.query(`delete from break_profiles where id = $1`, [breakProfileId]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
