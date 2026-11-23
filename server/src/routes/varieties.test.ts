// Basic Data -> Varieties API (routes/varieties.ts, 076_varieties.sql)
// through the real router: the variety catalogue, growing seasons (no
// overlaps, copy to a new season), plants planted per variety per season,
// bulk row assignment, calculated density from saved row lengths, the
// entered Plant Density figure kept separate, history by season, delete
// rules and permissions. Seasons use far-future dates and RUN_ID-suffixed
// names; everything created is removed at the end.
//
// Run with: npm run test:varieties
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { METRES_PER_FOOT, varietyForRowOnDate } from "../lib/varietyPlanting";
import varietiesRouter from "./varieties";

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
// Far-future, run-specific years so seasons never collide with other data.
const Y = 2200 + (RUN_ID % 500) * 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/varieties", varietiesRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ids = { employees: [] as string[], phases: [] as string[], rows: [] as string[], seasons: [] as string[], varieties: [] as string[], densities: [] as string[] };
  let landId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    async function employee(role: string, first: string) {
      const roleId = (await pool.query(`select id from security_roles where name = $1`, [role])).rows[0].id;
      const id = (
        await pool.query(`insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, $4) returning id`, [
          first,
          `VAR ${RUN_ID}`,
          roleId,
          teamRoleId,
        ])
      ).rows[0].id as string;
      ids.employees.push(id);
      return signSession({ id, firstName: first, lastName: `VAR ${RUN_ID}`, securityRole: role, teamRole: "Team Member" });
    }
    const admin = await employee("Administrator", "Ada");
    const manager = await employee("Manager", "Max");
    const worker = await employee("Employee", "Eve");

    async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: Json }> {
      const r = await fetch(`${BASE}/api/varieties${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { cookie: `labourlink_session=${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    }

    // ---- Fixtures: one land, two phases, rows of two lengths ----
    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 2000, 2000) returning id`, [`QA VAR ${RUN_ID}`])).rows[0]
      .id as string;
    async function phase(name: string) {
      const id = (
        await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 1000, 1000) returning id`, [landId, name])
      ).rows[0].id as string;
      ids.phases.push(id);
      return id;
    }
    const p1 = await phase(`QA VAR ${RUN_ID} Phase 1`);
    const p2 = await phase(`QA VAR ${RUN_ID} Phase 2`);
    async function row(phaseId: string, n: number, lengthFt: number) {
      const id = (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, $4, 'horizontal') returning id`,
          [phaseId, n, n * 3, lengthFt]
        )
      ).rows[0].id as string;
      ids.rows.push(id);
      return id;
    }
    const p1Rows: string[] = [];
    for (let n = 1; n <= 10; n++) p1Rows.push(await row(p1, n, 192));
    const shortRow = await row(p2, 501, 300);
    const longRow = await row(p2, 502, 330);

    // Existing Plant Density "Plants per row" on two Phase 1 rows (entered value).
    const densityId = (
      await pool.query(`insert into plant_densities (name, type, count_per_row) values ($1, 'plants', 318) returning id`, [`QA VAR ${RUN_ID} density`])
    ).rows[0].id as string;
    ids.densities.push(densityId);
    await pool.query(`insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, 'plants'), ($1, $3, 'plants')`, [
      densityId,
      p1Rows[0],
      p1Rows[1],
    ]);

    const timeEntriesBefore = Number((await pool.query(`select count(*) from time_entries`)).rows[0].count);
    const densityLinksBefore = Number((await pool.query(`select count(*) from plant_density_rows`)).rows[0].count);

    // ---- Permissions ----
    check((await call("GET", "/seasons", null)).status === 401, "signed out -> 401");
    check((await call("GET", "/seasons", worker)).status === 403, "Employee can't read -> 403");
    check((await call("GET", "/seasons", manager)).status === 200, "Manager can read");
    check((await call("POST", "/", manager, { name: "Nope" })).status === 403, "Manager can't add varieties -> 403");

    // ---- Seasons ----
    const s1 = await call("POST", "/seasons", admin, { name: `QA ${RUN_ID} ${Y}`, startsOn: `${Y}-01-05`, endsOn: `${Y}-11-30` });
    check(s1.status === 201 && s1.body.season?.startsOn === `${Y}-01-05`, "create a season", s1.body);
    const season1 = s1.body.season.id as string;
    ids.seasons.push(season1);
    const overlap = await call("POST", "/seasons", admin, { name: `QA ${RUN_ID} overlap`, startsOn: `${Y}-11-01`, endsOn: `${Y + 1}-03-01` });
    check(overlap.status === 409 && /overlap/.test(overlap.body.errors?.startsOn ?? ""), "overlapping season rejected", overlap.body);
    const openEnded = await call("POST", "/seasons", admin, { name: `QA ${RUN_ID} open`, startsOn: `${Y - 1}-01-01` });
    check(openEnded.status === 409, "an open-ended season that would run into a later one is rejected", openEnded.body);
    const badDates = await call("POST", "/seasons", admin, { name: `QA ${RUN_ID} bad`, startsOn: `${Y + 2}-05-01`, endsOn: `${Y + 2}-04-01` });
    check(badDates.status === 400 && !!badDates.body.errors?.endsOn, "end before start rejected", badDates.body);
    const dupName = await call("POST", "/seasons", admin, { name: ` qa ${RUN_ID} ${Y} `, startsOn: `${Y + 5}-01-01` });
    check(dupName.status === 409 && !!dupName.body.errors?.name, "duplicate season name (case/space-insensitive) rejected", dupName.body);

    // ---- Varieties ----
    const v1 = await call("POST", "/", admin, { name: `  Red Bell ${RUN_ID}  `, notes: "Blocky red", seasonId: season1, totalPlants: 3180 });
    check(v1.status === 201, "add a variety with plants planted for the season", v1.body);
    const red = v1.body.id as string;
    ids.varieties.push(red);
    const v2 = await call("POST", "/", admin, { name: `Yellow ${RUN_ID}` });
    const yellow = v2.body.id as string;
    ids.varieties.push(yellow);
    check((await call("POST", "/", admin, { name: `red bell ${RUN_ID}` })).status === 409, "duplicate variety name (case-insensitive) rejected");
    check((await call("POST", "/", admin, { name: "   " })).status === 400, "blank name rejected");
    check((await call("POST", "/", admin, { name: `X ${RUN_ID}`, seasonId: season1, totalPlants: 2.5 })).status === 400, "fractional plants rejected");
    check(
      (await pool.query(`select count(*) from varieties where name = $1`, [`X ${RUN_ID}`])).rows[0].count === "0",
      "a rejected plants value doesn't leave a half-created variety"
    );
    const renamed = await call("PATCH", `/${yellow}`, admin, { name: `Yellow Sun ${RUN_ID}`, notes: "  " });
    check(renamed.status === 200, "edit a variety", renamed.body);

    let list = await call("GET", `/?seasonId=${season1}`, manager);
    const redRow = list.body.varieties.find((v: Json) => v.id === red);
    check(redRow?.name === `Red Bell ${RUN_ID}` && redRow.totalPlants === 3180 && redRow.notes === "Blocky red", "name trimmed, plants planted recorded", redRow);
    check(list.body.varieties.find((v: Json) => v.id === yellow)?.notes === null, "blank notes stored as empty", list.body.varieties.find((v: Json) => v.id === yellow));

    // ---- Bulk row assignment ----
    const assign = await call("PUT", `/seasons/${season1}/rows`, admin, { rowIds: p1Rows, varietyId: red });
    check(assign.status === 200 && assign.body.rows.filter((r: Json) => r.varietyId === red).length === 10, "assign 10 consecutive rows at once", assign.status);
    check((await call("PUT", `/seasons/${season1}/rows`, manager, { rowIds: [p1Rows[0]], varietyId: yellow })).status === 403, "Manager can't assign rows");

    list = await call("GET", `/?seasonId=${season1}`, admin);
    let s = list.body.varieties.find((v: Json) => v.id === red).summary;
    const metres = 10 * 192 * METRES_PER_FOOT;
    check(s.rows === 10 && s.totalLengthM === Math.round(metres * 10) / 10, "summary: rows and total length in metres", s);
    check(s.plantsPerMetre === Math.round((3180 / metres) * 100) / 100, "summary: plants per metre calculated from plants planted and length", s);
    check(s.averageEstimatedPlantsPerRow === 318, "summary: estimated plants per row", s);
    check(s.rowsWithEnteredCount === 2 && s.enteredPlantsTotal === 636, "summary: the entered Plant Density figure is reported separately", s);

    // Reassign two of those rows to Yellow (a variety change within the season).
    await call("PUT", `/seasons/${season1}/rows`, admin, { rowIds: [p1Rows[8], p1Rows[9]], varietyId: yellow });
    list = await call("GET", `/?seasonId=${season1}`, admin);
    check(list.body.varieties.find((v: Json) => v.id === red).summary.rows === 8, "reassigning moves rows (one variety per row per season)");
    check(list.body.varieties.find((v: Json) => v.id === yellow).plantedThisSeason === true, "assigning rows records the variety as planted this season");

    // Per-row estimates: proportional to length, equal rows equal, adding up to the total.
    await call("PUT", `/seasons/${season1}/rows`, admin, { rowIds: [shortRow, longRow], varietyId: yellow });
    await call("PATCH", `/${yellow}`, admin, { seasonId: season1, totalPlants: 2000 });
    const yRows = await call("GET", `/${yellow}/rows?seasonId=${season1}`, admin);
    const est = yRows.body.rows.map((r: Json) => r.estimatedPlants);
    check(Math.abs(est.reduce((a: number, b: number) => a + b, 0) - 2000) <= 0.2, "per-row estimates add up to the plants planted (to rounding)", yRows.body.rows);
    const p1Est = yRows.body.rows.filter((r: Json) => r.rowNumber === 9 || r.rowNumber === 10).map((r: Json) => r.estimatedPlants);
    check(p1Est.length === 2 && p1Est[0] === p1Est[1], "rows of equal length get equal estimates", p1Est);
    const lengths = 2 * 192 + 300 + 330;
    check(yRows.body.rows.find((r: Json) => r.id === longRow).estimatedPlants === Math.round(((2000 * 330) / lengths) * 10) / 10, "estimate = plants x row length / total length", yRows.body.rows);
    const longEst = yRows.body.rows.find((r: Json) => r.id === longRow).estimatedPlants;
    const shortEst = yRows.body.rows.find((r: Json) => r.id === shortRow).estimatedPlants;
    check(longEst > shortEst && longEst > yRows.body.rows.find((r: Json) => r.id === p1Rows[8]).estimatedPlants, "longer rows get more plants", { longEst, shortEst });
    check(yRows.body.rows.find((r: Json) => r.id === p1Rows[0]) === undefined, "only this variety's rows are listed");
    const redRows = await call("GET", `/${red}/rows?seasonId=${season1}`, admin);
    const r0 = redRows.body.rows.find((r: Json) => r.id === p1Rows[0]);
    check(r0.enteredPlantsPerRow === 318 && r0.estimatedPlants === 397.5, "a row shows both its calculated estimate and its entered Plant Density value", r0);

    // Clearing plants planted keeps rows; density becomes unknown.
    await call("PATCH", `/${yellow}`, admin, { seasonId: season1, totalPlants: null });
    list = await call("GET", `/?seasonId=${season1}`, admin);
    s = list.body.varieties.find((v: Json) => v.id === yellow).summary;
    check(s.rows === 4 && s.plantsPerMetre === null && s.averageEstimatedPlantsPerRow === null, "no plants planted: rows and length shown, no calculated density", s);

    // Unassign.
    await call("PUT", `/seasons/${season1}/rows`, admin, { rowIds: [shortRow], varietyId: null });
    check((await call("GET", `/rows?seasonId=${season1}`, admin)).body.rows.find((r: Json) => r.id === shortRow).varietyId === null, "unassign a row");

    // Validation.
    check((await call("PUT", `/seasons/${season1}/rows`, admin, { rowIds: [], varietyId: red })).status === 400, "empty row list rejected");
    check(
      (await call("PUT", `/seasons/${season1}/rows`, admin, { rowIds: ["00000000-0000-0000-0000-000000000000"], varietyId: red })).status === 400,
      "unknown row rejected"
    );

    // ---- Next season: copy, then change a row, history stays ----
    const s2 = await call("POST", "/seasons", admin, {
      name: `QA ${RUN_ID} ${Y + 1}`,
      startsOn: `${Y + 1}-01-04`,
      endsOn: `${Y + 1}-11-30`,
      copyFromSeasonId: season1,
    });
    check(s2.status === 201, "create the next season copying the previous one", s2.body);
    const season2 = s2.body.season.id as string;
    ids.seasons.push(season2);
    const s2Red = (await call("GET", `/?seasonId=${season2}`, admin)).body.varieties.find((v: Json) => v.id === red);
    check(s2Red.totalPlants === 3180 && s2Red.summary.rows === 8, "copied season starts with the same plantings and rows", s2Red);

    await call("PUT", `/seasons/${season2}/rows`, admin, { rowIds: [p1Rows[0]], varietyId: yellow });
    check((await varietyForRowOnDate(pool, p1Rows[0], `${Y}-06-15`))?.varietyId === red, "a harvest in last season's row stays with last season's variety");
    check((await varietyForRowOnDate(pool, p1Rows[0], `${Y + 1}-06-15`))?.varietyId === yellow, "the same row this season gives this season's variety");
    check((await varietyForRowOnDate(pool, p1Rows[0], `${Y}-12-25`)) === null, "a date between seasons has no variety");
    check((await call("GET", `/?seasonId=${season1}`, admin)).body.varieties.find((v: Json) => v.id === red).summary.rows === 8, "changing next season never changes last season");

    // ---- A row deleted from the layout keeps its history ----
    await pool.query(`update greenhouse_rows set deleted_at = now() where id = $1`, [p1Rows[1]]);
    const afterDelete = (await call("GET", `/?seasonId=${season1}`, admin)).body.varieties.find((v: Json) => v.id === red).summary;
    check(afterDelete.rows === 7 && afterDelete.deletedRows === 1, "a deleted row stops counting but its assignment is kept", afterDelete);
    check((await varietyForRowOnDate(pool, p1Rows[1], `${Y}-06-15`))?.varietyId === red, "history for a deleted row is still answerable");
    await pool.query(`update greenhouse_rows set deleted_at = null where id = $1`, [p1Rows[1]]);

    // ---- Deactivate / delete rules ----
    check((await call("DELETE", `/${red}`, admin)).status === 409, "a planted variety can't be deleted");
    await call("PATCH", `/${red}`, admin, { isActive: false });
    check((await call("PUT", `/seasons/${season2}/rows`, admin, { rowIds: [p1Rows[2]], varietyId: red })).status === 409, "an inactive variety can't get new rows");
    check((await call("GET", `/?seasonId=${season1}`, admin)).body.varieties.find((v: Json) => v.id === red).summary.rows === 8, "deactivating keeps its rows and history");
    const v3 = await call("POST", "/", admin, { name: `Unused ${RUN_ID}` });
    check((await call("DELETE", `/${v3.body.id}`, admin)).status === 200, "a never-planted variety can be deleted");
    check((await call("DELETE", `/seasons/${season2}`, admin)).status === 409, "a season with assigned rows can't be deleted");
    const s3 = await call("POST", "/seasons", admin, { name: `QA ${RUN_ID} empty`, startsOn: `${Y + 3}-01-01`, endsOn: `${Y + 3}-02-01` });
    check((await call("DELETE", `/seasons/${s3.body.season.id}`, admin)).status === 200, "an empty season can be deleted");

    // Season edit can't create an overlap.
    const stretch = await call("PATCH", `/seasons/${season1}`, admin, { endsOn: `${Y + 1}-02-01` });
    check(stretch.status === 409, "editing a season into the next one is rejected", stretch.body);
    check((await call("PATCH", `/seasons/${season1}`, admin, { name: `QA ${RUN_ID} ${Y} renamed` })).status === 200, "rename a season");

    // ---- Nothing else touched ----
    check(Number((await pool.query(`select count(*) from time_entries`)).rows[0].count) === timeEntriesBefore, "time entries untouched");
    check(Number((await pool.query(`select count(*) from plant_density_rows`)).rows[0].count) === densityLinksBefore, "Plant Density links untouched");
  } finally {
    const tryDelete = async (q: string, p: unknown[]) => {
      try {
        await pool.query(q, p);
      } catch (err) {
        console.error("cleanup step failed:", q, err);
      }
    };
    await tryDelete(`delete from variety_row_assignments where season_id = any($1::uuid[]) or greenhouse_row_id = any($2::uuid[])`, [ids.seasons, ids.rows]);
    await tryDelete(`delete from variety_plantings where season_id = any($1::uuid[]) or variety_id = any($2::uuid[])`, [ids.seasons, ids.varieties]);
    await tryDelete(`delete from growing_seasons where id = any($1::uuid[]) or name like $2`, [ids.seasons, `QA ${RUN_ID}%`]);
    await tryDelete(`delete from varieties where id = any($1::uuid[]) or name like $2`, [ids.varieties, `% ${RUN_ID}`]);
    await tryDelete(`delete from plant_density_rows where density_id = any($1::uuid[])`, [ids.densities]);
    await tryDelete(`delete from plant_densities where id = any($1::uuid[])`, [ids.densities]);
    await tryDelete(`delete from greenhouse_rows where id = any($1::uuid[])`, [ids.rows]);
    await tryDelete(`delete from greenhouse_phases where id = any($1::uuid[])`, [ids.phases]);
    if (landId) await tryDelete(`delete from greenhouse_lands where id = $1`, [landId]);
    await tryDelete(`delete from employees where id = any($1::uuid[])`, [ids.employees]);
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
