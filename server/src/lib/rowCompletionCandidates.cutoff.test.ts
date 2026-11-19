// relevantFrom (rowCompletionCandidates.ts): trimming a pair's history to the
// cycles that can reach the caller's date must give exactly the same
// candidates for those cycles as the full history does, including a visit
// rolled over at midnight across the cut, a long gap, and 1-day and
// 3-day windows.
import "dotenv/config";
import { pool } from "../db";
import { CandidateRun, cutDateForPair, getUnresolvedRunsForRows } from "./rowCompletionCandidates";
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

// Pure cut rule.
function pureCases() {
  // window 3: inclusiveDayCount > 3 is a cycle break.
  check(cutDateForPair(["2019-08-01", "2019-08-05", "2019-08-06"], "2019-08-06", 3) === "2019-08-05", "A) a gap wider than the window cuts there");
  check(cutDateForPair(["2019-08-01", "2019-08-04", "2019-08-06"], "2019-08-06", 3) === "2019-08-04", "A) a gap of exactly the window does not");
  check(cutDateForPair(["2019-08-01", "2019-08-03", "2019-08-05"], "2019-08-05", 3) === null, "A) one unbroken chain keeps everything");
  check(cutDateForPair(["2019-08-01", "2019-08-10"], "2019-08-01", 3) === null, "A) nothing before relevantFrom: nothing to cut");
  check(cutDateForPair(["2019-08-01", "2019-08-10"], "2019-08-20", 3) === null, "A) no visit from relevantFrom on: keep the whole history");
  // window 1 still never separates consecutive dates (a midnight rollover).
  check(cutDateForPair(["2019-08-04", "2019-08-05"], "2019-08-05", 1) === null, "A) 1-day window keeps the day before");
  check(cutDateForPair(["2019-08-02", "2019-08-05"], "2019-08-05", 1) === "2019-08-05", "A) 1-day window still cuts a real gap");
  check(cutDateForPair(["2019-07-01", "2019-08-05", "2019-08-20"], "2019-08-20", 30) === "2019-08-05", "A) 30-day window");
}

function shape(list: CandidateRun[]) {
  // Cycle numbers are relative, so compare which candidates share a cycle.
  const firstOfCycle = new Map<number, string>();
  for (const c of list) if (!firstOfCycle.has(c.cycleIndex)) firstOfCycle.set(c.cycleIndex, c.runId);
  return list.map((c) => ({ ...c, cycleIndex: firstOfCycle.get(c.cycleIndex) }));
}

async function main() {
  pureCases();

  const employeeIds: string[] = [];
  const timeEntryIds: string[] = [];
  const rowIds: string[] = [];
  let activityId: string | undefined;
  let landId: string | undefined;
  let phaseId: string | undefined;
  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    for (const label of ["one", "two"]) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, 'x', true) returning id`,
        [`Cutoff ${label} ${RUN_ID}`, `qa-cutoff-${label}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId]
      );
      employeeIds.push(rows[0].id);
    }
    const [e1, e2] = employeeIds;
    activityId = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [`QA Cutoff ${RUN_ID}`])).rows[0].id;
    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [`QA Cutoff ${RUN_ID}`])).rows[0].id;
    phaseId = (await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [landId, `QA Cutoff ${RUN_ID}`])).rows[0].id;
    for (const n of [1, 2]) {
      rowIds.push(
        (await pool.query(`insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`, [phaseId, n, n * 3])).rows[0].id
      );
    }
    const [r1, r2] = rowIds;

    async function work(emp: string, row: string, start: Date, end: Date, rolloverOf: string | null = null): Promise<string> {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    greenhouse_row_id, density_type, density_count_per_row, rollover_of_entry_id)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', 100, $6) returning id`,
        [emp, activityId, start, end, row, rolloverOf]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    const at = (d: number, h: number, m = 0) => zonedWallTimeToUtc(2019, 8, d, h, m, 0);

    // Row 1: an old ambiguous cycle (Aug 1 + Aug 2), a long gap, then a visit
    // rolled over at midnight (Aug 20 22:00 -> Aug 21 01:00) and a second
    // employee's visit on Aug 23, in the same cycle.
    await work(e1, r1, at(1, 8), at(1, 9));
    await work(e2, r1, at(2, 8), at(2, 9));
    const beforeMidnight = await work(e1, r1, at(20, 22), at(21, 0));
    const afterMidnight = await work(e1, r1, at(21, 0), at(21, 1), beforeMidnight);
    await work(e2, r1, at(23, 8), at(23, 9));
    // Row 2: Aug 19 and Aug 21 (3 dates inclusive: same cycle under a
    // 3-day window, separate cycles under a 1-day window).
    await work(e1, r2, at(19, 8), at(19, 9));
    await work(e1, r2, at(21, 8), at(21, 9));

    const pairs = [r1, r2].map((greenhouseRowId) => ({ greenhouseRowId, activityId: activityId!, densityType: "stems" as const }));
    for (const windowDays of [3, 1, 7]) {
      const full = await getUnresolvedRunsForRows(pairs, { windowDays });
      const cut = await getUnresolvedRunsForRows(pairs, { windowDays, relevantFrom: "2019-08-21" });
      for (const [i, p] of pairs.entries()) {
        const key = `${p.greenhouseRowId}:${p.activityId}:stems`;
        const f = full.get(key)!;
        const c = cut.get(key)!;
        // The cycles containing any visit from Aug 21 on (or the rolled-over
        // one that started Aug 20) must be identical.
        const reachingCycles = new Set(f.filter((x) => x.segmentIds.some((id) => id === afterMidnight) || x.date >= "2019-08-21").map((x) => x.cycleIndex));
        const expected = f.filter((x) => reachingCycles.has(x.cycleIndex));
        const keptReaching = shape(c).filter((x) => expected.some((e) => e.runId === x.runId));
        check(JSON.stringify(keptReaching) === JSON.stringify(shape(expected)), `B) window ${windowDays}, row ${i + 1}: same candidates and cycles from the cut on`, { expected: shape(expected), got: shape(c) });
        check(c.every((x) => f.some((e) => e.runId === x.runId)), `B) window ${windowDays}, row ${i + 1}: nothing that the full history lacks`);
      }
      const r1Cut = cut.get(`${r1}:${activityId}:stems`)!;
      const rolled = r1Cut.find((x) => x.segmentIds.includes(beforeMidnight));
      check(!!rolled && rolled.segmentIds.includes(afterMidnight) && rolled.date === "2019-08-20", `C) window ${windowDays}: the midnight rollover is still one visit`, rolled);
      check(!r1Cut.some((x) => x.date < "2019-08-20"), `C) window ${windowDays}: the old cycle before the long gap is not loaded`, r1Cut.map((x) => x.date));
    }
  } finally {
    const tryDelete = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.error("cleanup step failed:", err);
      }
    };
    if (timeEntryIds.length) {
      await tryDelete(() => pool.query(`update time_entries set rollover_of_entry_id = null where id = any($1::uuid[])`, [timeEntryIds]));
      await tryDelete(() => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    }
    if (rowIds.length) await tryDelete(() => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete(() => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete(() => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (activityId) await tryDelete(() => pool.query(`delete from activities where id = $1`, [activityId]));
    if (employeeIds.length) await tryDelete(() => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
