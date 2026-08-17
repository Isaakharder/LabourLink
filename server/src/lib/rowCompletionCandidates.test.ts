// Tests getUnresolvedRunsForRow directly against the real database — the
// root-cause fix for the Marcelino Besa "Needs review" / "No pending work
// found" bug: a break-split single visit was miscounted as two ambiguous
// runs because the old row-scoped, work-only query could never include the
// bridging break entry (breaks always have greenhouse_row_id = null). Same
// convention as dashboardBlockProgress.test.ts (disposable QA fixtures, no
// HTTP layer, since this is a lib function not a route).
//
// Run with: npm run test:row-completion-candidates
import "dotenv/config";
import { pool } from "../db";
import { getUnresolvedRunsForRow } from "./rowCompletionCandidates";
import { zonedWallTimeToUtc } from "./timezone";

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
const DATE = "2019-06-20"; // QA-only past date, never collides with real data

async function main() {
  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const rowIds: string[] = [];
  const timeEntryIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Row Candidates ${label} ${RUN_ID}`, `qa-row-candidates-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertActivity(label: string, densitySource: "plants" | "stems" | null): Promise<string> {
      const { rows } = await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, $2) returning id`, [
        `QA Row Candidates ${label} ${RUN_ID}`,
        densitySource,
      ]);
      activityIds.push(rows[0].id);
      return rows[0].id;
    }

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [
        `QA Row Candidates Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [
        landId,
        `QA Row Candidates Phase ${RUN_ID}`,
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
      densityType: "plants" | "stems",
      densityCountPerRow: number
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 20, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 20, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7) returning id`,
        [employeeId, activityId, startedAt, endedAt, rowId, densityType, densityCountPerRow]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertBreak(employeeId: string, startHour: number, startMinute: number, endHour: number, endMinute: number): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 20, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 20, endHour, endMinute, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual') returning id`,
        [employeeId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }

    async function confirmCompletion(rowId: string, densityType: "plants" | "stems", quantityPerRow: number, confirmedBy: string, segmentIds: string[]): Promise<void> {
      const { rows } = await pool.query(
        `insert into row_completions (greenhouse_row_id, density_type, quantity_per_row, confirmed_by_employee_id) values ($1, $2, $3, $4) returning id`,
        [rowId, densityType, quantityPerRow, confirmedBy]
      );
      for (const segId of segmentIds) {
        await pool.query(`insert into row_completion_segments (time_entry_id, row_completion_id) values ($1, $2)`, [segId, rows[0].id]);
      }
    }

    const activity = await insertActivity("Activity", "stems");
    const emp1 = await insertEmployee("Emp1");
    const emp2 = await insertEmployee("Emp2");

    // -----------------------------------------------------------------
    // 1) One unambiguous run split into multiple segments with NO break in
    //    between (bit-identical boundary) — must combine into exactly one
    //    candidate, not two.
    // -----------------------------------------------------------------
    const rowA = await insertRow(1);
    {
      const e1 = await insertWork(emp1, activity, rowA, 8, 0, 9, 0, "stems", 500);
      const e2 = await insertWork(emp1, activity, rowA, 9, 0, 10, 0, "stems", 500);

      const candidates = await getUnresolvedRunsForRow(rowA, "stems");
      check(
        candidates.length === 1 && candidates[0].segmentIds.length === 2 && candidates[0].durationSeconds === 7200,
        "1) two bit-contiguous segments (no break) combine into exactly one candidate run",
        { candidates, e1, e2 }
      );
    }

    // -----------------------------------------------------------------
    // 2) A break-split visit — the exact reported bug. Two work segments
    //    bridged by a break must auto-combine into ONE candidate, not be
    //    miscounted as two separate (spuriously ambiguous) ones.
    // -----------------------------------------------------------------
    const rowB = await insertRow(2);
    {
      const e1 = await insertWork(emp1, activity, rowB, 11, 0, 12, 0, "stems", 400);
      await insertBreak(emp1, 12, 0, 12, 15);
      const e2 = await insertWork(emp1, activity, rowB, 12, 15, 13, 0, "stems", 400);

      const candidates = await getUnresolvedRunsForRow(rowB, "stems");
      check(
        candidates.length === 1 && candidates[0].segmentIds.length === 2 && candidates[0].segmentIds.includes(e1) && candidates[0].segmentIds.includes(e2),
        "2) a break-split visit to the same row auto-combines into one candidate — the reported bug",
        candidates
      );
      check(candidates[0]?.durationSeconds === 6300, "2) combined duration is the sum of BOTH work segments (1h + 45min = 6300s), not counting the break", candidates[0]);
    }

    // -----------------------------------------------------------------
    // 3) Genuinely ambiguous: two different employees visiting the same
    //    row on the same day, with no bridging between them — must remain
    //    two separate candidates, never auto-combined.
    // -----------------------------------------------------------------
    const rowC = await insertRow(3);
    {
      await insertWork(emp1, activity, rowC, 8, 0, 9, 0, "stems", 300);
      await insertWork(emp2, activity, rowC, 10, 0, 11, 0, "stems", 300);

      const candidates = await getUnresolvedRunsForRow(rowC, "stems");
      check(candidates.length === 2, "3) two different employees' visits to the same row remain genuinely ambiguous (2 candidates)", candidates);
      check(
        new Set(candidates.map((c) => c.employeeId)).size === 2,
        "3) the two candidates are correctly attributed to two different employees, not merged",
        candidates.map((c) => c.employeeId)
      );
    }

    // -----------------------------------------------------------------
    // 4) Already-resolved work must not show up as a candidate at all —
    //    the badge must be able to disappear once genuinely resolved.
    // -----------------------------------------------------------------
    const rowD = await insertRow(4);
    {
      const e1 = await insertWork(emp1, activity, rowD, 8, 0, 9, 0, "stems", 600);
      await confirmCompletion(rowD, "stems", 600, emp1, [e1]);

      const candidates = await getUnresolvedRunsForRow(rowD, "stems");
      check(candidates.length === 0, "4) already-resolved work (confirmed row_completions) never appears as a pending candidate", candidates);
    }

    // -----------------------------------------------------------------
    // 7) Duplicate row numbers never cause the wrong physical row to be
    //    reviewed — a soft-deleted row sharing the same row_number as an
    //    active one must never leak its historical entries into the
    //    active row's candidate list.
    // -----------------------------------------------------------------
    {
      const sharedRowNumber = 50;
      const { rows: deletedRowRows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation, deleted_at)
         values ($1, $2, 0, 100, 2, 20, 'horizontal', now()) returning id`,
        [phaseId, sharedRowNumber]
      );
      const deletedRowId = deletedRowRows[0].id;
      rowIds.push(deletedRowId);
      const activeRowId = await insertRow(sharedRowNumber);

      // Historical work against the now-deleted row (its row record is
      // gone, but the time_entries referencing its old UUID remain, per
      // this app's soft-delete convention).
      await insertWork(emp1, activity, deletedRowId, 8, 0, 9, 0, "stems", 700);
      // Genuinely new, unrelated work against the active row sharing the
      // same row_number.
      const activeEntry = await insertWork(emp2, activity, activeRowId, 8, 0, 9, 0, "stems", 700);

      const candidates = await getUnresolvedRunsForRow(activeRowId, "stems");
      check(
        candidates.length === 1 && candidates[0].segmentIds[0] === activeEntry && candidates[0].employeeId === emp2,
        "7) querying the active row by its own UUID never picks up the deleted duplicate row_number's historical entries",
        candidates
      );
    }

    // -----------------------------------------------------------------
    // 8) Changing an activity's density_source after the fact must not
    //    orphan or falsely re-flag an existing completion — the completion
    //    and its entries keep their own frozen density_type forever,
    //    independent of the activity's current, live config.
    // -----------------------------------------------------------------
    const rowF = await insertRow(6);
    {
      const changeableActivity = await insertActivity("Changeable", "plants");
      const e1 = await insertWork(emp1, changeableActivity, rowF, 8, 0, 9, 0, "plants", 250);
      await confirmCompletion(rowF, "plants", 250, emp1, [e1]);

      // Simulate an admin later changing this activity's density_source.
      await pool.query(`update activities set density_source = 'stems' where id = $1`, [changeableActivity]);

      const candidatesOldType = await getUnresolvedRunsForRow(rowF, "plants");
      check(candidatesOldType.length === 0, "8) the old (frozen) density type still correctly recognizes the completion as resolved after the activity's density_source changes", candidatesOldType);

      const candidatesNewType = await getUnresolvedRunsForRow(rowF, "stems");
      check(candidatesNewType.length === 0, "8) the new density type finds no false candidates either — nothing was orphaned or wrongly flagged", candidatesNewType);
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
      await tryDelete("row_completion_segments/row_completions", () => pool.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]));
    }
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (activityIds.length) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [activityIds]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
