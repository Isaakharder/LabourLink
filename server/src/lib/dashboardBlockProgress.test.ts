// Tests getBlockProgressForEmployees directly against the real database —
// same convention as breakReconciliation.test.ts (disposable QA fixtures,
// no HTTP layer, since this is a lib function not a route).
//
// Run with: npm run test:dashboard-block-progress
import "dotenv/config";
import { pool } from "../db";
import { getBlockProgressForEmployees } from "./dashboardBlockProgress";

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
  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const blockIds: string[] = [];
  const rowIds: string[] = [];
  const densityIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Block Progress ${label} ${RUN_ID}`, `qa-block-progress-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 500, 100) returning id`, [
        `QA Block Progress Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 500, 100) returning id`, [
        landId,
        `QA Block Progress Phase ${RUN_ID}`,
      ])
    ).rows[0].id;

    async function insertRow(rowNumber: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
         values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, rowNumber, rowNumber * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBlock(name: string, employeeId: string, linkedRowIds: string[]): Promise<string> {
      const { rows } = await pool.query(
        `insert into employee_blocks (name, employee_id, color_key) values ($1, $2, 'slate') returning id`,
        [name, employeeId]
      );
      const blockId = rows[0].id;
      blockIds.push(blockId);
      for (const rowId of linkedRowIds) {
        await pool.query(`insert into employee_block_rows (block_id, greenhouse_row_id) values ($1, $2)`, [blockId, rowId]);
      }
      return blockId;
    }

    async function insertDensity(type: "plants" | "stems", countPerRow: number, linkedRowIds: string[]): Promise<void> {
      const { rows } = await pool.query(
        `insert into plant_densities (name, type, count_per_row) values ($1, $2, $3) returning id`,
        [`QA Block Progress Density ${type} ${RUN_ID}-${densityIds.length}`, type, countPerRow]
      );
      densityIds.push(rows[0].id);
      for (const rowId of linkedRowIds) {
        await pool.query(`insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, $3)`, [
          rows[0].id,
          rowId,
          type,
        ]);
      }
    }

    async function insertCompletion(rowId: string, densityType: "plants" | "stems", quantityPerRow: number, confirmedBy: string): Promise<void> {
      await pool.query(
        `insert into row_completions (greenhouse_row_id, density_type, quantity_per_row, confirmed_by_employee_id) values ($1, $2, $3, $4)`,
        [rowId, densityType, quantityPerRow, confirmedBy]
      );
    }

    // -----------------------------------------------------------------
    // A) An employee with no block at all is absent from the result map —
    //    distinct from "block present but empty."
    // -----------------------------------------------------------------
    const empNoBlock = await insertEmployee("No Block");
    {
      const result = await getBlockProgressForEmployees([empNoBlock], "stems");
      check(!result.has(empNoBlock), "A) an employee with no block is absent from the result map", [...result.keys()]);
    }

    // -----------------------------------------------------------------
    // B) An employee with two blocks: the most-recently-updated one wins.
    // -----------------------------------------------------------------
    const empTwoBlocks = await insertEmployee("Two Blocks");
    {
      const olderBlockId = await insertBlock(`QA Older Block ${RUN_ID}`, empTwoBlocks, []);
      // Ensure a real updated_at gap regardless of clock resolution.
      await pool.query(`update employee_blocks set updated_at = now() - interval '1 hour' where id = $1`, [olderBlockId]);
      const newerRow = await insertRow(1);
      const newerBlockId = await insertBlock(`QA Newer Block ${RUN_ID}`, empTwoBlocks, [newerRow]);

      const result = await getBlockProgressForEmployees([empTwoBlocks], "stems");
      const progress = result.get(empTwoBlocks);
      check(progress?.blockId === newerBlockId, "B) the most-recently-updated block wins when an employee has more than one", progress);
    }

    // -----------------------------------------------------------------
    // C) A block with zero linked rows: totalRows = 0, not confused with
    //    "no block assigned."
    // -----------------------------------------------------------------
    const empEmptyBlock = await insertEmployee("Empty Block");
    {
      await insertBlock(`QA Empty Block ${RUN_ID}`, empEmptyBlock, []);
      const result = await getBlockProgressForEmployees([empEmptyBlock], "stems");
      const progress = result.get(empEmptyBlock);
      check(
        progress !== undefined && progress.totalRows === 0 && progress.completedRows === 0 && progress.rowsMissingDensity === 0,
        "C) a block with zero linked rows reports totalRows = 0 (present in the map, unlike no-block-at-all)",
        progress
      );
    }

    // -----------------------------------------------------------------
    // D) A fully-complete block: completedRows === totalRows, remainingStems = 0.
    // -----------------------------------------------------------------
    const empComplete = await insertEmployee("Complete Block");
    {
      const r1 = await insertRow(2);
      const r2 = await insertRow(3);
      await insertDensity("stems", 500, [r1, r2]);
      await insertCompletion(r1, "stems", 500, empComplete);
      await insertCompletion(r2, "stems", 500, empComplete);
      await insertBlock(`QA Complete Block ${RUN_ID}`, empComplete, [r1, r2]);

      const result = await getBlockProgressForEmployees([empComplete], "stems");
      const progress = result.get(empComplete);
      check(
        progress?.totalRows === 2 && progress?.completedRows === 2 && progress?.remainingStems === 0,
        "D) a fully-complete block has completedRows === totalRows and remainingStems = 0",
        progress
      );
    }

    // -----------------------------------------------------------------
    // E) Deduplication: total/completed rows are DISTINCT greenhouse_row_id
    //    counts even if a row somehow has more than one row_completions
    //    record (schema allows it — no uniqueness constraint).
    // -----------------------------------------------------------------
    const empDedup = await insertEmployee("Dedup");
    {
      const r1 = await insertRow(4);
      await insertDensity("stems", 400, [r1]);
      await insertCompletion(r1, "stems", 400, empDedup);
      await insertCompletion(r1, "stems", 400, empDedup); // a second completion on the SAME row
      await insertBlock(`QA Dedup Block ${RUN_ID}`, empDedup, [r1]);

      const result = await getBlockProgressForEmployees([empDedup], "stems");
      const progress = result.get(empDedup);
      check(
        progress?.totalRows === 1 && progress?.completedRows === 1,
        "E) totalRows/completedRows are deduplicated per physical row, not per completion record",
        progress
      );
    }

    // -----------------------------------------------------------------
    // F) Partial progress reduces remaining stems correctly: one completed
    //    row (500 stems) + one not-yet-completed row (500 stems) -> 500
    //    remaining, not the full block's 1000.
    // -----------------------------------------------------------------
    const empPartial = await insertEmployee("Partial");
    {
      const done = await insertRow(5);
      const pending = await insertRow(6);
      await insertDensity("stems", 500, [done, pending]);
      await insertCompletion(done, "stems", 500, empPartial);
      await insertBlock(`QA Partial Block ${RUN_ID}`, empPartial, [done, pending]);

      const result = await getBlockProgressForEmployees([empPartial], "stems");
      const progress = result.get(empPartial);
      check(
        progress?.totalRows === 2 && progress?.completedRows === 1 && progress?.remainingStems === 500,
        "F) a partially-completed block's remaining stems only counts the not-yet-completed row(s)",
        progress
      );
    }

    // -----------------------------------------------------------------
    // G) A not-yet-completed row with no density link is flagged missing,
    //    not silently treated as 0 remaining stems.
    // -----------------------------------------------------------------
    const empMissing = await insertEmployee("Missing Density");
    {
      const withDensity = await insertRow(7);
      const withoutDensity = await insertRow(8);
      await insertDensity("stems", 300, [withDensity]); // withoutDensity deliberately left unlinked
      await insertBlock(`QA Missing Density Block ${RUN_ID}`, empMissing, [withDensity, withoutDensity]);

      const result = await getBlockProgressForEmployees([empMissing], "stems");
      const progress = result.get(empMissing);
      check(
        progress?.remainingStems === null && progress?.rowsMissingDensity === 1,
        "G) a not-yet-completed row missing a density link makes remainingStems null and flags rowsMissingDensity",
        progress
      );
    }

    // -----------------------------------------------------------------
    // H) Mixed densityType employees must be batched separately — calling
    //    with the WRONG densityType for an employee silently produces
    //    different (wrong) numbers, proving the caller-side partitioning
    //    in dashboard.ts (one call per distinct densityType) is load-bearing.
    // -----------------------------------------------------------------
    const empPlants = await insertEmployee("Plants Employee");
    const empStems = await insertEmployee("Stems Employee");
    {
      const plantsRow = await insertRow(9);
      const stemsRow = await insertRow(10);
      await insertDensity("plants", 600, [plantsRow]);
      await insertDensity("stems", 700, [stemsRow]);
      await insertBlock(`QA Plants Block ${RUN_ID}`, empPlants, [plantsRow]);
      await insertBlock(`QA Stems Block ${RUN_ID}`, empStems, [stemsRow]);

      // Correct usage: one call per employee's own density type.
      const plantsResult = await getBlockProgressForEmployees([empPlants], "plants");
      const stemsResult = await getBlockProgressForEmployees([empStems], "stems");
      check(
        plantsResult.get(empPlants)?.remainingStems === 600 && stemsResult.get(empStems)?.remainingStems === 700,
        "H) each employee's block progress is correct when batched by their own density type",
        { plants: plantsResult.get(empPlants), stems: stemsResult.get(empStems) }
      );

      // Demonstrates why: sharing one density_type across mixed employees
      // gives the WRONG remainingStems for whichever one doesn't match.
      const mismatched = await getBlockProgressForEmployees([empPlants, empStems], "stems");
      check(
        mismatched.get(empPlants)?.rowsMissingDensity === 1 && mismatched.get(empPlants)?.remainingStems === null,
        "H) calling with a single shared densityType wrongly flags the mismatched employee's row as missing density (the bug correct batching avoids)",
        mismatched.get(empPlants)
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

    if (rowIds.length) {
      await tryDelete("row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
      await tryDelete("plant_density_rows", () => pool.query(`delete from plant_density_rows where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
      await tryDelete("employee_block_rows", () => pool.query(`delete from employee_block_rows where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    }
    if (densityIds.length) await tryDelete("plant_densities", () => pool.query(`delete from plant_densities where id = any($1::uuid[])`, [densityIds]));
    if (blockIds.length) await tryDelete("employee_blocks", () => pool.query(`delete from employee_blocks where id = any($1::uuid[])`, [blockIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
