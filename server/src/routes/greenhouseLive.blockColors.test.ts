// Covers the greenhouse live map's Employee Block colour-coding data
// contract: GET /api/greenhouse/live and GET /api/greenhouse/display/
// :displayKey/state both report each row's own blockId (keyed by the exact
// physical greenhouse_row_id, never phase+row_number — duplicate row
// numbers can exist across different physical rows/phases), a per-land
// block summary (name/employee/colour/progress) fetched in one extra query
// rather than per-block, land-scoped isolation, TV-route employee-name
// redaction, and that the map's completedRows/totalRows numbers agree with
// the Dashboard's own authoritative row_completions-based block progress
// (dashboardBlockProgress.ts).
//
// Same real-HTTP-against-real-database convention as
// mobileTime.densityResume.test.ts — no mocking.
//
// Run with: npm run test:greenhouse-live-block-colors
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { getBlockProgressForEmployees } from "../lib/dashboardBlockProgress";
import greenhouseLiveRouter from "./greenhouseLive";
import greenhouseDisplaysRouter from "./greenhouseDisplays";

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
  app.use("/api/greenhouse", greenhouseLiveRouter);
  app.use("/api/greenhouse/displays", greenhouseDisplaysRouter);
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

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const blockIds: string[] = [];
  const rowIds: string[] = [];
  const landIds: string[] = [];
  const phaseIds: string[] = [];
  const displayIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    const admin = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`GLBC Admin ${RUN_ID}`, `qa-glbc-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(admin.id);
    const adminToken = signSession({ id: admin.id, firstName: "QA", lastName: admin.last_name, securityRole: "Administrator", teamRole: "Team Member" });

    const worker = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('Lester', $1, $2, $3, $4, $5, true) returning id`,
        [`GLBC Worker ${RUN_ID}`, `qa-glbc-worker-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(worker.id);

    async function insertLand(name: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active) values ($1, 200, 200, true) returning id`,
        [name]
      );
      landIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertPhase(landId: string, name: string, xFt: number, yFt: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, x_feet_from_west, y_feet_from_north, is_active, sort_order)
         values ($1, $2, 60, 60, $3, $4, true, 1) returning id`,
        [landId, name, xFt, yFt]
      );
      phaseIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertRow(phaseId: string, n: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, 0, 4, 20, 'horizontal') returning id`,
        [phaseId, n]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBlock(name: string, employeeId: string | null, colorKey: string, linkedRowIds: string[]): Promise<string> {
      const { rows } = await pool.query(
        `insert into employee_blocks (name, employee_id, color_key) values ($1, $2, $3) returning id`,
        [name, employeeId, colorKey]
      );
      const blockId = rows[0].id;
      blockIds.push(blockId);
      for (const rowId of linkedRowIds) {
        await pool.query(`insert into employee_block_rows (block_id, greenhouse_row_id) values ($1, $2)`, [blockId, rowId]);
      }
      return blockId;
    }

    // -----------------------------------------------------------------
    // Setup: one land with TWO phases (so the block's rows are
    // "disconnected sections"), plus a SECOND, unrelated land — same
    // row_number (301) reused across three different physical rows, to
    // prove blockId is keyed by the real greenhouse_row_id, never
    // phase+row_number.
    // -----------------------------------------------------------------
    const land = await insertLand(`QA GLBC Land ${RUN_ID}`);
    const phaseNorth = await insertPhase(land, `QA GLBC Phase North ${RUN_ID}`, 0, 0);
    const phaseSouth = await insertPhase(land, `QA GLBC Phase South ${RUN_ID}`, 0, 100);
    const otherLand = await insertLand(`QA GLBC Other Land ${RUN_ID}`);
    const otherPhase = await insertPhase(otherLand, `QA GLBC Other Phase ${RUN_ID}`, 0, 0);

    const rowNorth301 = await insertRow(phaseNorth, 301); // block's row, section 1
    const rowSouth301 = await insertRow(phaseSouth, 301); // block's row, section 2 (disconnected, same row_number!)
    const rowUnassigned = await insertRow(phaseNorth, 302); // never linked to any block
    const rowOtherLand301 = await insertRow(otherPhase, 301); // same row_number again, different land entirely, unrelated

    const block = await insertBlock(`QA GLBC Block ${RUN_ID}`, worker.id, "dustyPurple", [rowNorth301, rowSouth301]);

    // -----------------------------------------------------------------
    // 5, 6, 8, 9) GET /live: every linked row (across BOTH disconnected
    //    phases) reports the SAME blockId, keyed by the real row id — the
    //    unassigned row and the same-row-number row in a different land
    //    are both unaffected.
    // -----------------------------------------------------------------
    {
      const res = await call("GET", `/api/greenhouse/live?landId=${land}`, { token: adminToken });
      check(res.status === 200, "GET /live succeeds", res.body);

      const allRows: any[] = res.body.land.phases.flatMap((p: any) => p.rows);
      const rn = (id: string) => allRows.find((r: any) => r.id === id);

      check(rn(rowNorth301)?.blockId === block, "5/8) the physical row in the north section reports the correct blockId", rn(rowNorth301));
      check(rn(rowSouth301)?.blockId === block, "9) the disconnected south-section row reports the SAME blockId (same colour)", rn(rowSouth301));
      check(rn(rowUnassigned)?.blockId === null, "6) an unlinked row's blockId is null (stays default blue/neutral)", rn(rowUnassigned));

      // 12) Land-scoped isolation: the other land's row (same row_number,
      // totally unrelated) never appears in this land's response at all.
      check(!allRows.some((r: any) => r.id === rowOtherLand301), "12) a different land's row never appears in this land's payload", allRows.length);

      // 10) The block summary carries the correct name/employee/colour.
      const blockSummary = res.body.blocks.find((b: any) => b.id === block);
      check(
        blockSummary?.name === `QA GLBC Block ${RUN_ID}` &&
          blockSummary?.employeeFirstName === "Lester" &&
          blockSummary?.colorKey === "dustyPurple" &&
          blockSummary?.totalRows === 2,
        "10) the block summary reports the correct name, employee, colour, and total row count",
        blockSummary
      );

      // Efficiency: exactly one blocks entry for this land (not one row
      // per request) even though the block links 2 rows across 2 phases.
      check(res.body.blocks.length === 1, "the land's blocks array is per-block, not per-row (efficient payload)", res.body.blocks);
    }

    // -----------------------------------------------------------------
    // 12 continued) The OTHER land's own /live response must never show
    //    this block at all (no rows of its there).
    // -----------------------------------------------------------------
    {
      const res = await call("GET", `/api/greenhouse/live?landId=${otherLand}`, { token: adminToken });
      check(res.body.blocks.length === 0, "12) an unrelated land's payload has no blocks at all", res.body.blocks);
      const rows: any[] = res.body.land.phases.flatMap((p: any) => p.rows);
      check(rows.find((r: any) => r.id === rowOtherLand301)?.blockId === null, "the other land's same-numbered row has no block link of its own", rows);
    }

    // -----------------------------------------------------------------
    // 11) Dashboard/map progress agreement: confirm a real completed row
    //    is counted the same way by both getBlockProgressForEmployees
    //    (Dashboard's own authoritative function) and the map's
    //    blocks[].completedRows for the same block.
    // -----------------------------------------------------------------
    {
      await pool.query(
        `insert into row_completions (greenhouse_row_id, density_type, quantity_per_row, confirmed_by_employee_id) values ($1, 'stems', 300, $2)`,
        [rowNorth301, admin.id]
      );

      const mapRes = await call("GET", `/api/greenhouse/live?landId=${land}`, { token: adminToken });
      const mapBlock = mapRes.body.blocks.find((b: any) => b.id === block);
      check(mapBlock?.completedRows === 1 && mapBlock?.totalRows === 2, "11) the map shows 1/2 rows completed after confirming one", mapBlock);

      const dashboardProgress = await getBlockProgressForEmployees([worker.id], "stems");
      const dashboardEntry = dashboardProgress.get(worker.id);
      check(
        dashboardEntry?.completedRows === mapBlock?.completedRows && dashboardEntry?.totalRows === mapBlock?.totalRows,
        "11) the Dashboard's own authoritative block-progress function agrees exactly with the map's numbers",
        { dashboardEntry, mapBlock }
      );
    }

    // -----------------------------------------------------------------
    // TV route: same blockId/blocks contract, plus employee name
    // redaction (a display token is a bearer credential — full names are
    // cut down to "First L." server-side, same as every row-level
    // employee already is).
    // -----------------------------------------------------------------
    {
      const displayRes = await call("POST", "/api/greenhouse/displays", {
        token: adminToken,
        body: { name: `QA GLBC Display ${RUN_ID}`, landId: land },
      });
      check(displayRes.status === 201, "creating a TV display succeeds", displayRes.body);
      displayIds.push(displayRes.body.display.id);
      const tvToken = displayRes.body.token;

      const tvRes = await call("GET", `/api/greenhouse/display/${tvToken}/state`);
      check(tvRes.status === 200, "TV state endpoint succeeds with the display token", tvRes.body);

      const tvRows: any[] = tvRes.body.land.phases.flatMap((p: any) => p.rows);
      check(tvRows.find((r: any) => r.id === rowNorth301)?.blockId === block, "TV route also reports the correct blockId per row", tvRows.find((r: any) => r.id === rowNorth301));

      const tvBlock = tvRes.body.blocks.find((b: any) => b.id === block);
      check(
        tvBlock?.employeeFirstName === "Lester" && /^.\.$/.test(tvBlock?.employeeLastName ?? ""),
        "14) the TV route redacts the block's employee last name to an initial, same as row-level employees",
        tvBlock
      );
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (displayIds.length) await tryDelete("greenhouse_displays", () => pool.query(`delete from greenhouse_displays where id = any($1::uuid[])`, [displayIds]));
    if (rowIds.length) await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    if (blockIds.length) await tryDelete("employee_blocks", () => pool.query(`delete from employee_blocks where id = any($1::uuid[])`, [blockIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseIds.length) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = any($1::uuid[])`, [phaseIds]));
    if (landIds.length) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = any($1::uuid[])`, [landIds]));
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
