// Covers loadGreenhouseRowOptions (used by GET /api/mobile/greenhouse-rows,
// which the mobile RowPickerSheet's Activity -> Phase -> Row flow fetches
// and caches) — confirms an inactive land, an inactive phase, and a
// soft-deleted row are all excluded from what the mobile app ever sees,
// while everything active/non-deleted is included. This is the server-side
// half of "deleted/inactive lands, phases and rows excluded"; the client
// (RowPickerSheet) simply renders whatever this function returns, so
// correctness here is what the requirement actually depends on.
//
// Run with: npm run test:greenhouse-row-options
import "dotenv/config";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { loadGreenhouseRowOptions } from "./activitySelection";

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
  const landIds: string[] = [];
  const phaseIds: string[] = [];
  const rowIds: string[] = [];

  try {
    async function makeLand(label: string, isActive: boolean): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active) values ($1, 300, 100, $2) returning id`,
        [`QA GRO Land ${label} ${RUN_ID}`, isActive]
      );
      landIds.push(rows[0].id);
      return rows[0].id;
    }
    async function makePhase(landId: string, label: string, isActive: boolean, sortOrder: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, is_active, sort_order) values ($1, $2, 300, 100, $3, $4) returning id`,
        [landId, `QA GRO Phase ${label} ${RUN_ID}`, isActive, sortOrder]
      );
      phaseIds.push(rows[0].id);
      return rows[0].id;
    }
    async function makeRow(phaseId: string, rowNumber: number, deleted: boolean): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation, deleted_at)
         values ($1, $2, 0, $2 * 3, 2, 20, 'horizontal', $3) returning id`,
        [phaseId, rowNumber, deleted ? new Date() : null]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }

    const activeLand = await makeLand("Active", true);
    const inactiveLand = await makeLand("Inactive", false);

    const activePhaseOnActiveLand = await makePhase(activeLand, "ActiveOnActive", true, 1);
    const inactivePhaseOnActiveLand = await makePhase(activeLand, "InactiveOnActive", false, 2);
    const activePhaseOnInactiveLand = await makePhase(inactiveLand, "ActiveOnInactive", true, 1);

    const visibleRow = await makeRow(activePhaseOnActiveLand, 9001, false);
    const deletedRow = await makeRow(activePhaseOnActiveLand, 9002, true);
    await makeRow(inactivePhaseOnActiveLand, 9003, false);
    await makeRow(activePhaseOnInactiveLand, 9004, false);

    const options = await loadGreenhouseRowOptions(pool);
    const returnedLandIds = new Set(options.map((l) => l.id));
    const returnedPhaseIds = new Set(options.flatMap((l) => l.phases.map((p) => p.id)));
    const returnedRowIds = new Set(options.flatMap((l) => l.phases.flatMap((p) => p.rows.map((r) => r.id))));

    check(returnedLandIds.has(activeLand), "1) an active land is included", activeLand);
    check(!returnedLandIds.has(inactiveLand), "2) an inactive land is excluded entirely (its own active phase never surfaces)", inactiveLand);
    check(returnedPhaseIds.has(activePhaseOnActiveLand), "3) an active phase on an active land is included", activePhaseOnActiveLand);
    check(!returnedPhaseIds.has(inactivePhaseOnActiveLand), "4) an inactive phase is excluded even on an active land", inactivePhaseOnActiveLand);
    check(!returnedPhaseIds.has(activePhaseOnInactiveLand), "5) an active phase is still excluded when its land is inactive", activePhaseOnInactiveLand);
    check(returnedRowIds.has(visibleRow), "6) a non-deleted row on an active phase/land is included", visibleRow);
    check(!returnedRowIds.has(deletedRow), "7) a soft-deleted row is excluded even on an active phase/land", deletedRow);
  } finally {
    for (const id of rowIds) await pool.query(`delete from greenhouse_rows where id = $1`, [id]).catch(() => {});
    for (const id of phaseIds) await pool.query(`delete from greenhouse_phases where id = $1`, [id]).catch(() => {});
    for (const id of landIds) await pool.query(`delete from greenhouse_lands where id = $1`, [id]).catch(() => {});
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
