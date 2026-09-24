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

    // Same as insertWork, but lets a cycle-partitioning test place a segment
    // on a specific calendar day instead of the fixed 2019-06-20 every other
    // scenario in this file uses — insertWork itself is left untouched so
    // every existing call site above stays unaffected.
    async function insertWorkOnDate(
      employeeId: string,
      activityId: string,
      rowId: string,
      month: number,
      day: number,
      startHour: number,
      startMinute: number,
      endHour: number,
      endMinute: number,
      densityType: "plants" | "stems",
      densityCountPerRow: number
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, month, day, startHour, startMinute, 0);
      const endedAt = zonedWallTimeToUtc(2019, month, day, endHour, endMinute, 0);
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

    async function confirmCompletion(rowId: string, activityId: string, densityType: "plants" | "stems", quantityPerRow: number, confirmedBy: string, segmentIds: string[]): Promise<void> {
      const { rows } = await pool.query(
        `insert into row_completions (greenhouse_row_id, activity_id, density_type, quantity_per_row, confirmed_by_employee_id) values ($1, $2, $3, $4, $5) returning id`,
        [rowId, activityId, densityType, quantityPerRow, confirmedBy]
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

      const candidates = await getUnresolvedRunsForRow(rowA, activity, "stems");
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

      const candidates = await getUnresolvedRunsForRow(rowB, activity, "stems");
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

      const candidates = await getUnresolvedRunsForRow(rowC, activity, "stems");
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
      await confirmCompletion(rowD, activity, "stems", 600, emp1, [e1]);

      const candidates = await getUnresolvedRunsForRow(rowD, activity, "stems");
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

      const candidates = await getUnresolvedRunsForRow(activeRowId, activity, "stems");
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
      await confirmCompletion(rowF, changeableActivity, "plants", 250, emp1, [e1]);

      // Simulate an admin later changing this activity's density_source.
      await pool.query(`update activities set density_source = 'stems' where id = $1`, [changeableActivity]);

      const candidatesOldType = await getUnresolvedRunsForRow(rowF, changeableActivity, "plants");
      check(candidatesOldType.length === 0, "8) the old (frozen) density type still correctly recognizes the completion as resolved after the activity's density_source changes", candidatesOldType);

      const candidatesNewType = await getUnresolvedRunsForRow(rowF, changeableActivity, "stems");
      check(candidatesNewType.length === 0, "8) the new density type finds no false candidates either — nothing was orphaned or wrongly flagged", candidatesNewType);
    }

    // -----------------------------------------------------------------
    // 9-11) Activity scoping — the real row-82 scenario (Picking Peppers /
    //    Winding & Pruning, same physical row, same 'stems' density type):
    //    two entirely independent activities must never be grouped into one
    //    ambiguity check, never appear in each other's candidate list, and
    //    resolving one must never affect the other. Winding & Pruning also
    //    genuinely revisits the row twice (no bridging) — that ambiguity
    //    must still trigger review, on its own, regardless of Picking
    //    Peppers' presence on the same row+type.
    // -----------------------------------------------------------------
    const pickingActivity = await insertActivity("Picking Peppers", "stems");
    const windingActivity = await insertActivity("Winding and Pruning", "stems");
    const rowG = await insertRow(82);
    {
      const pickingEntry = await insertWork(emp1, pickingActivity, rowG, 8, 0, 9, 0, "stems", 636);
      const windingEntry1 = await insertWork(emp2, windingActivity, rowG, 8, 0, 9, 0, "stems", 636);
      const windingEntry2 = await insertWork(emp2, windingActivity, rowG, 10, 0, 11, 0, "stems", 636);

      // 9) Picking Peppers' own review group is unambiguous (exactly one
      //    candidate) DESPITE Winding & Pruning also touching this row+type
      //    twice — the two activities never share an ambiguity check.
      const pickingCandidates = await getUnresolvedRunsForRow(rowG, pickingActivity, "stems");
      check(
        pickingCandidates.length === 1 &&
          pickingCandidates[0].segmentIds.length === 1 &&
          pickingCandidates[0].segmentIds[0] === pickingEntry,
        "9) Picking Peppers has exactly one unambiguous candidate, unaffected by Winding & Pruning's own visits to the same row+type",
        pickingCandidates
      );

      // 10) Winding & Pruning's own genuine multi-visit ambiguity (same
      //     activity, two separate unbridged visits) still triggers review —
      //     and its candidate list is exactly its own two segments, never
      //     Picking Peppers' entry.
      const windingCandidates = await getUnresolvedRunsForRow(rowG, windingActivity, "stems");
      check(
        windingCandidates.length === 2,
        "10) Winding & Pruning's genuine two-visit ambiguity (same activity) still triggers review",
        windingCandidates
      );
      const windingSegmentIds = new Set(windingCandidates.flatMap((c) => c.segmentIds));
      check(
        windingSegmentIds.has(windingEntry1) && windingSegmentIds.has(windingEntry2) && !windingSegmentIds.has(pickingEntry),
        "The modal never displays another activity's candidates — Winding & Pruning's group contains only its own two segments, never Reynaldo-style Picking Peppers entry",
        [...windingSegmentIds]
      );
      check(
        windingCandidates.every((c) => c.activityId === windingActivity),
        "10) every Winding & Pruning candidate is correctly attributed to Winding & Pruning, never Picking Peppers",
        windingCandidates.map((c) => c.activityId)
      );

      // 11) Resolving Picking Peppers' completion must leave Winding &
      //     Pruning's own still-genuinely-ambiguous group completely
      //     untouched.
      await confirmCompletion(rowG, pickingActivity, "stems", 636, emp1, [pickingEntry]);

      const pickingAfter = await getUnresolvedRunsForRow(rowG, pickingActivity, "stems");
      check(pickingAfter.length === 0, "11) Picking Peppers is now resolved (no pending candidates)", pickingAfter);

      const windingAfter = await getUnresolvedRunsForRow(rowG, windingActivity, "stems");
      check(
        windingAfter.length === 2 &&
          new Set(windingAfter.flatMap((c) => c.segmentIds)).has(windingEntry1) &&
          new Set(windingAfter.flatMap((c) => c.segmentIds)).has(windingEntry2),
        "11) Winding & Pruning's own ambiguity is completely untouched by resolving Picking Peppers' unrelated completion",
        windingAfter
      );
    }
    // -----------------------------------------------------------------
    // 12) Row-work cycle partitioning (Row 194) — the same row+activity is
    //     no longer one lifetime ambiguity group. A new cycle starts once
    //     more than 7 calendar days have elapsed since the preceding
    //     segment: Sept 3 is its own cycle (alone, unambiguous); the two
    //     Sept 10 segments (same day — no bridging needed to co-belong)
    //     form a second cycle together (genuinely ambiguous, 2 candidates);
    //     Sept 23 is a third cycle, alone again. None of the three cycles
    //     may ever be combined with, or trigger review from, another.
    // -----------------------------------------------------------------
    const rowH = await insertRow(194);
    {
      const sept3 = await insertWorkOnDate(emp1, activity, rowH, 9, 3, 8, 0, 9, 0, "stems", 500);
      const sept10a = await insertWorkOnDate(emp1, activity, rowH, 9, 10, 8, 0, 9, 0, "stems", 500);
      const sept10b = await insertWorkOnDate(emp2, activity, rowH, 9, 10, 10, 0, 11, 0, "stems", 500);
      const sept23 = await insertWorkOnDate(emp1, activity, rowH, 9, 23, 8, 0, 9, 0, "stems", 500);

      const candidates = await getUnresolvedRunsForRow(rowH, activity, "stems");
      check(candidates.length === 4, "12) all four segments remain individually pending candidates (nothing wrongly auto-merged)", candidates);

      const byFirstSegmentId = new Map(candidates.map((c) => [c.segmentIds[0], c]));
      const cSept3 = byFirstSegmentId.get(sept3);
      const cSept10a = byFirstSegmentId.get(sept10a);
      const cSept10b = byFirstSegmentId.get(sept10b);
      const cSept23 = byFirstSegmentId.get(sept23);
      check(!!cSept3 && !!cSept10a && !!cSept10b && !!cSept23, "12) every inserted segment surfaces as its own candidate", candidates);

      check(
        cSept3!.cycleIndex !== cSept10a!.cycleIndex,
        "12) Sept 3 is a separate cycle from Sept 10 — more than 7 calendar days elapsed",
        { cSept3, cSept10a }
      );
      check(
        cSept10a!.cycleIndex === cSept10b!.cycleIndex,
        "12) both Sept 10 segments (same day) belong to the same cycle",
        { cSept10a, cSept10b }
      );
      check(
        cSept10a!.cycleIndex !== cSept23!.cycleIndex,
        "12) Sept 23 is a separate cycle from Sept 10 — more than 7 calendar days elapsed",
        { cSept10a, cSept23 }
      );
      check(
        cSept3!.cycleIndex !== cSept23!.cycleIndex,
        "12) Sept 3 and Sept 23 are also different cycles from each other, not just both different from Sept 10",
        { cSept3, cSept23 }
      );

      // Only the Sept 10 pair is genuinely ambiguous (same cycle, 2
      // candidates, no bridging) — Sept 3 and Sept 23 must each stay a
      // lone, unambiguous candidate in their own cycle, never pulled into
      // review just because SOME candidate exists somewhere else in time
      // for this row+activity+type.
      const sameCycleAsSept10 = candidates.filter((c) => c.cycleIndex === cSept10a!.cycleIndex);
      check(sameCycleAsSept10.length === 2, "12) exactly two candidates share the Sept 10 cycle", sameCycleAsSept10);

      const sameCycleAsSept3 = candidates.filter((c) => c.cycleIndex === cSept3!.cycleIndex);
      check(sameCycleAsSept3.length === 1, "12) Sept 3's cycle has exactly one candidate (unambiguous on its own)", sameCycleAsSept3);

      const sameCycleAsSept23 = candidates.filter((c) => c.cycleIndex === cSept23!.cycleIndex);
      check(sameCycleAsSept23.length === 1, "12) Sept 23's cycle has exactly one candidate (unambiguous on its own)", sameCycleAsSept23);
    }

    // -----------------------------------------------------------------
    // 13) Boundary: exactly 6 calendar dates apart must remain one cycle —
    //     the cutoff is "at least 7 calendar dates after", so 6 is still
    //     inside the same cycle no matter the time of day either segment
    //     falls on.
    // -----------------------------------------------------------------
    const rowSixApart = await insertRow(195);
    {
      const first = await insertWorkOnDate(emp1, activity, rowSixApart, 9, 3, 20, 0, 21, 0, "stems", 500);
      const sixDatesLater = await insertWorkOnDate(emp2, activity, rowSixApart, 9, 9, 6, 0, 7, 0, "stems", 500);

      const candidates = await getUnresolvedRunsForRow(rowSixApart, activity, "stems");
      const byFirstSegmentId = new Map(candidates.map((c) => [c.segmentIds[0], c]));
      const cFirst = byFirstSegmentId.get(first);
      const cSixDatesLater = byFirstSegmentId.get(sixDatesLater);
      check(
        !!cFirst && !!cSixDatesLater && cFirst.cycleIndex === cSixDatesLater.cycleIndex,
        "13) segments exactly six calendar dates apart remain in the same cycle",
        { cFirst, cSixDatesLater }
      );
    }

    // -----------------------------------------------------------------
    // 14) Boundary: exactly 7 calendar dates apart must start a new cycle
    //     regardless of time-of-day — tested both with the later visit
    //     EARLIER in the day than the first (so raw elapsed hours is well
    //     under 7*24) and LATER in the day (so raw elapsed hours is over
    //     7*24). Both must split into a new cycle: the rule is "the next
    //     segment's work date is at least 7 calendar days after the
    //     preceding segment's work date", never a raw hour count.
    // -----------------------------------------------------------------
    const rowSevenApartEarlier = await insertRow(196);
    {
      // First visit late in the day (20:00); the visit exactly seven dates
      // later is EARLY in the day (6:00) — under an hours-based check this
      // gap is only ~5 days 10 hours of raw elapsed time, well short of
      // 168 hours, yet the calendar-date rule must still start a new cycle.
      const first = await insertWorkOnDate(emp1, activity, rowSevenApartEarlier, 9, 3, 20, 0, 21, 0, "stems", 500);
      const sevenDatesLaterEarlier = await insertWorkOnDate(emp2, activity, rowSevenApartEarlier, 9, 10, 6, 0, 7, 0, "stems", 500);

      const candidates = await getUnresolvedRunsForRow(rowSevenApartEarlier, activity, "stems");
      const byFirstSegmentId = new Map(candidates.map((c) => [c.segmentIds[0], c]));
      const cFirst = byFirstSegmentId.get(first);
      const cSevenDatesLaterEarlier = byFirstSegmentId.get(sevenDatesLaterEarlier);
      check(
        !!cFirst && !!cSevenDatesLaterEarlier && cFirst.cycleIndex !== cSevenDatesLaterEarlier.cycleIndex,
        "14) exactly seven calendar dates apart starts a new cycle when the later visit falls EARLIER in the day (raw elapsed hours well under 168)",
        { cFirst, cSevenDatesLaterEarlier }
      );
    }
    const rowSevenApartLater = await insertRow(197);
    {
      // First visit early in the day (6:00); the visit exactly seven dates
      // later is LATE in the day (20:00) — raw elapsed time here is over
      // 168 hours, the opposite time-of-day direction from the case above.
      // Both must agree: new cycle either way.
      const first = await insertWorkOnDate(emp1, activity, rowSevenApartLater, 9, 3, 6, 0, 7, 0, "stems", 500);
      const sevenDatesLaterLater = await insertWorkOnDate(emp2, activity, rowSevenApartLater, 9, 10, 20, 0, 21, 0, "stems", 500);

      const candidates = await getUnresolvedRunsForRow(rowSevenApartLater, activity, "stems");
      const byFirstSegmentId = new Map(candidates.map((c) => [c.segmentIds[0], c]));
      const cFirst = byFirstSegmentId.get(first);
      const cSevenDatesLaterLater = byFirstSegmentId.get(sevenDatesLaterLater);
      check(
        !!cFirst && !!cSevenDatesLaterLater && cFirst.cycleIndex !== cSevenDatesLaterLater.cycleIndex,
        "14) exactly seven calendar dates apart starts a new cycle when the later visit falls LATER in the day (raw elapsed hours well over 168)",
        { cFirst, cSevenDatesLaterLater }
      );
    }

    // -----------------------------------------------------------------
    // 15) DST: the cycle boundary is genuine APP_TIMEZONE (America/Toronto)
    //     calendar-date arithmetic, not a fixed elapsed-hours count, so it
    //     must stay correct across a DST transition. 2019-03-06 ->
    //     2019-03-13 is exactly 7 calendar dates apart in Toronto, but
    //     spans the March 10, 2019 "spring forward" (2am -> 3am) — a
    //     same-wall-clock-time week here is a real 167 hours, not 168. An
    //     elapsed-hours implementation checking "duration >= 168h" would
    //     wrongly keep these in one cycle; the calendar-date rule must
    //     still correctly start a new cycle, proving the boundary is
    //     driven by local calendar dates, immune to the DST shift.
    // -----------------------------------------------------------------
    const rowDstSpringForward = await insertRow(198);
    {
      const beforeDst = await insertWorkOnDate(emp1, activity, rowDstSpringForward, 3, 6, 8, 0, 9, 0, "stems", 500);
      const afterDst = await insertWorkOnDate(emp2, activity, rowDstSpringForward, 3, 13, 8, 0, 9, 0, "stems", 500);

      const candidates = await getUnresolvedRunsForRow(rowDstSpringForward, activity, "stems");
      const byFirstSegmentId = new Map(candidates.map((c) => [c.segmentIds[0], c]));
      const cBeforeDst = byFirstSegmentId.get(beforeDst);
      const cAfterDst = byFirstSegmentId.get(afterDst);
      check(!!cBeforeDst && !!cAfterDst, "15) both DST-fixture segments surface as their own candidates", { cBeforeDst, cAfterDst });

      const rawElapsedHours = (new Date(cAfterDst!.startedAt).getTime() - new Date(cBeforeDst!.startedAt).getTime()) / 3600000;
      check(
        // The real elapsed gap here is 167 hours (a DST spring-forward week
        // is 23 hours short of a normal 168), well under a raw "168 hours"
        // cutoff — confirming this test actually exercises the DST edge
        // case an hours-based implementation would get wrong, not a
        // coincidentally-passing 169+ hour gap.
        rawElapsedHours < 168,
        "15) the DST week between these two fixtures is genuinely under 168 raw hours (sanity-checks the test itself)",
        { rawElapsedHours }
      );
      check(
        cBeforeDst!.cycleIndex !== cAfterDst!.cycleIndex,
        "15) a 7-calendar-date gap spanning a DST spring-forward transition still correctly starts a new cycle",
        { cBeforeDst, cAfterDst }
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
