// Tests getCarrierCompletionAttribution directly against the real database
// — mirrors the two-rule selection logic getActivityDensityAttribution
// already has coverage for, adapted to carriers. Same convention as
// dashboardBlockProgress.test.ts / breakReconciliation.test.ts.
//
// Run with: npm run test:carrier-completion-attribution
import "dotenv/config";
import { pool } from "../db";
import { getCarrierCompletionAttribution } from "./carrierCompletionAttribution";
import { zonedWallTimeToUtc, getRangeBoundsUtc } from "./timezone";

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
const DATE = "2019-06-10"; // QA-only past date, never collides with real data

async function main() {
  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const carrierIds: string[] = [];
  const timeEntryIds: string[] = [];
  const completionIds: string[] = [];
  let activityId!: string;
  let otherActivityId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    async function insertEmployee(label: string): Promise<string> {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Carrier Attr ${label} ${RUN_ID}`, `qa-carrier-attr-${label.toLowerCase()}-${RUN_ID}@test.local`, employeeRoleId, teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id;
    }

    activityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Carrier Attr Activity ${RUN_ID}`])
    ).rows[0].id;
    otherActivityId = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Carrier Attr Other Activity ${RUN_ID}`])
    ).rows[0].id;

    async function insertCarrier(label: string): Promise<string> {
      const { rows } = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [
        `QA Carrier Attr ${label} ${RUN_ID}`,
      ]);
      carrierIds.push(rows[0].id);
      return rows[0].id;
    }

    async function insertWork(
      employeeId: string,
      actId: string,
      carrierId: string,
      startHour: number,
      endHour: number | null,
      opts: { deleted?: boolean } = {}
    ): Promise<string> {
      const startedAt = zonedWallTimeToUtc(2019, 6, 10, startHour, 0, 0);
      const endedAt = endHour !== null ? zonedWallTimeToUtc(2019, 6, 10, endHour, 0, 0) : null;
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, carrier_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, $3, gen_random_uuid(), $4, $5, 'manual')
         returning id`,
        [employeeId, actId, carrierId, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      if (opts.deleted) {
        await pool.query(
          `update time_entries set deleted_at = now(), deleted_by_employee_id = $2, deletion_reason = 'QA test' where id = $1`,
          [rows[0].id, employeeId]
        );
      }
      return rows[0].id;
    }

    async function insertCompletion(carrierId: string, confirmedBy: string, segmentIds: string[]): Promise<string> {
      const { rows } = await pool.query(
        `insert into carrier_completions (carrier_id, confirmed_by_employee_id) values ($1, $2) returning id`,
        [carrierId, confirmedBy]
      );
      const completionId = rows[0].id;
      completionIds.push(completionId);
      for (const segId of segmentIds) {
        await pool.query(`insert into carrier_completion_segments (time_entry_id, carrier_completion_id) values ($1, $2)`, [segId, completionId]);
      }
      return completionId;
    }

    const { start: rangeStart, end: rangeEnd } = getRangeBoundsUtc(DATE, DATE);

    // -----------------------------------------------------------------
    // A) Single-employee/single-activity/in-range confirmed completion
    //    counts exactly once toward that employee's totals.
    // -----------------------------------------------------------------
    const empA = await insertEmployee("A");
    {
      const carrier = await insertCarrier("A");
      const entry = await insertWork(empA, activityId, carrier, 8, 9); // 1 hour = 3600s
      await insertCompletion(carrier, empA, [entry]);

      const attribution = await getCarrierCompletionAttribution(activityId, rangeStart, rangeEnd);
      const totals = attribution.byEmployee.get(empA);
      check(
        totals?.quantity === 1 && totals?.completions === 1 && totals?.durationSeconds === 3600,
        "A) a confirmed single-employee/activity/in-range completion counts exactly once",
        totals
      );
    }

    // -----------------------------------------------------------------
    // B) A completion whose segments span more than one employee is
    //    excluded entirely, for every employee it touches.
    // -----------------------------------------------------------------
    const empB1 = await insertEmployee("B1");
    const empB2 = await insertEmployee("B2");
    {
      const carrier = await insertCarrier("B");
      const e1 = await insertWork(empB1, activityId, carrier, 10, 11);
      const e2 = await insertWork(empB2, activityId, carrier, 11, 12);
      await insertCompletion(carrier, empB1, [e1, e2]);

      const attribution = await getCarrierCompletionAttribution(activityId, rangeStart, rangeEnd);
      check(
        !attribution.byEmployee.has(empB1) && !attribution.byEmployee.has(empB2),
        "B) a completion spanning more than one employee is excluded entirely, not split or guessed",
        { b1: attribution.byEmployee.get(empB1), b2: attribution.byEmployee.get(empB2) }
      );
    }

    // -----------------------------------------------------------------
    // C) A confirmed completion outside the queried range is excluded.
    // -----------------------------------------------------------------
    const empC = await insertEmployee("C");
    {
      const carrier = await insertCarrier("C");
      // A different calendar day, outside [rangeStart, rangeEnd).
      const startedAt = zonedWallTimeToUtc(2019, 6, 11, 8, 0, 0);
      const endedAt = zonedWallTimeToUtc(2019, 6, 11, 9, 0, 0);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, carrier_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, $3, gen_random_uuid(), $4, $5, 'manual') returning id`,
        [empC, activityId, carrier, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      await insertCompletion(carrier, empC, [rows[0].id]);

      const attribution = await getCarrierCompletionAttribution(activityId, rangeStart, rangeEnd);
      check(!attribution.byEmployee.has(empC), "C) a confirmed completion outside the queried range is excluded", attribution.byEmployee.get(empC));
    }

    // -----------------------------------------------------------------
    // D) A not-yet-completed run is auto-counted when it's the sole
    //    candidate for its carrier.
    // -----------------------------------------------------------------
    const empD = await insertEmployee("D");
    {
      const carrier = await insertCarrier("D");
      await insertWork(empD, activityId, carrier, 13, 14); // completed, never confirmed

      const attribution = await getCarrierCompletionAttribution(activityId, rangeStart, rangeEnd);
      const totals = attribution.byEmployee.get(empD);
      check(
        totals?.quantity === 1 && totals?.completions === 0 && totals?.durationSeconds === 3600,
        "D) a sole not-yet-completed run auto-counts its quantity (1) but not as a 'completion'",
        totals
      );
    }

    // -----------------------------------------------------------------
    // E) Two-or-more unresolved candidates for the same carrier are
    //    ambiguous and excluded entirely.
    // -----------------------------------------------------------------
    const empE1 = await insertEmployee("E1");
    const empE2 = await insertEmployee("E2");
    {
      const carrier = await insertCarrier("E");
      await insertWork(empE1, activityId, carrier, 14, 15);
      await insertWork(empE2, activityId, carrier, 15, 16);

      const attribution = await getCarrierCompletionAttribution(activityId, rangeStart, rangeEnd);
      check(
        !attribution.byEmployee.has(empE1) && !attribution.byEmployee.has(empE2),
        "E) two unresolved candidates for the same carrier are ambiguous and both excluded",
        { e1: attribution.byEmployee.get(empE1), e2: attribution.byEmployee.get(empE2) }
      );
    }

    // -----------------------------------------------------------------
    // F) A deleted work entry never contributes, confirmed or unresolved.
    // -----------------------------------------------------------------
    const empF = await insertEmployee("F");
    {
      const carrier = await insertCarrier("F");
      const entry = await insertWork(empF, activityId, carrier, 16, 17, { deleted: true });
      await insertCompletion(carrier, empF, [entry]);

      const attribution = await getCarrierCompletionAttribution(activityId, rangeStart, rangeEnd);
      check(!attribution.byEmployee.has(empF), "F) a deleted work entry's completion never contributes", attribution.byEmployee.get(empF));
    }

    // -----------------------------------------------------------------
    // G) A completion belonging to a DIFFERENT activity than queried is
    //    excluded from this activity's attribution.
    // -----------------------------------------------------------------
    const empG = await insertEmployee("G");
    {
      const carrier = await insertCarrier("G");
      const entry = await insertWork(empG, otherActivityId, carrier, 17, 18);
      await insertCompletion(carrier, empG, [entry]);

      const attribution = await getCarrierCompletionAttribution(activityId, rangeStart, rangeEnd);
      check(!attribution.byEmployee.has(empG), "G) a completion for a different activity is excluded from this activity's attribution", attribution.byEmployee.get(empG));
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (completionIds.length) {
      await tryDelete("carrier_completion_segments", () =>
        pool.query(`delete from carrier_completion_segments where carrier_completion_id = any($1::uuid[])`, [completionIds])
      );
      await tryDelete("carrier_completions", () => pool.query(`delete from carrier_completions where id = any($1::uuid[])`, [completionIds]));
    }
    if (timeEntryIds.length) await tryDelete("time_entries", () => pool.query(`delete from time_entries where id = any($1::uuid[])`, [timeEntryIds]));
    if (carrierIds.length) await tryDelete("carriers", () => pool.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]));
    if (activityId) await tryDelete("activities", () => pool.query(`delete from activities where id = any($1::uuid[])`, [[activityId, otherActivityId]]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
