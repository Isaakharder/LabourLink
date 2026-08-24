// Tests reconcileEmployeeBreaks after the Inputs employee-switch
// performance refactor: the new optional `knownEmployee` fast path (no
// query/transaction at all when the caller already knows there's nothing
// to reconcile), the combined break-profile+auto-add-items query, and that
// the actual split behavior/idempotency are unchanged from before the
// refactor. Runs against the real database with disposable QA fixtures,
// torn down in a finally block — same convention as
// inputs.manualEntries.test.ts.
//
// Run with: npm run test:break-reconciliation
import "dotenv/config";
import { pool } from "../db";
import { reconcileEmployeeBreaks } from "./breakReconciliation";
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
const TEST_DATE = "2019-06-03"; // past date, QA-only, never collides with real payroll data

async function main() {
  let target: { id: string } | undefined;
  let inactiveProfileEmployee: { id: string } | undefined;
  let breakProfile: { id: string } | undefined;
  let activity: { id: string } | undefined;
  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const employeeRoleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;

    breakProfile = (
      await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
        `QA Break Reconciliation Profile ${RUN_ID}`,
      ])
    ).rows[0];
    await pool.query(
      `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
       values ($1, 'QA Auto Break', '10:00:00', '10:15:00', false, true, 1)`,
      [breakProfile!.id]
    );

    activity = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [
        `QA Break Reconciliation Activity ${RUN_ID}`,
      ])
    ).rows[0];

    const targetRows = await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
       values ($1, $2, $3, $4, $5, $6, true, $7)
       returning id`,
      [
        "QA",
        `Break Recon Target ${RUN_ID}`,
        `qa-break-recon-target-${RUN_ID}@test.local`,
        employeeRoleId,
        teamRoleId,
        fakePinHash,
        breakProfile!.id,
      ]
    );
    target = targetRows.rows[0];

    // A work entry that fully covers the scheduled 10:00-10:15 window —
    // the exact shape reconciliation looks for to split.
    await pool.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
       values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')`,
      [
        target!.id,
        activity!.id,
        zonedWallTimeToUtc(2019, 6, 3, 9, 0, 0).toISOString(),
        zonedWallTimeToUtc(2019, 6, 3, 11, 0, 0).toISOString(),
      ]
    );

    // -----------------------------------------------------------------
    // Fast path: knownEmployee says there's nothing to do — no query, no
    // transaction, and (observably) nothing created, for an employee whose
    // real DB state actually WOULD have something to reconcile. Proves the
    // function trusts the passed-in info rather than re-checking it.
    // -----------------------------------------------------------------
    {
      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: true, breakProfileId: null });
      const { rows } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and entry_type = 'break'`,
        [target!.id]
      );
      check(
        Number(rows[0].count) === 0,
        "knownEmployee with breakProfileId=null skips reconciliation entirely, even though the employee's real row has one",
        rows[0]
      );

      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: false, breakProfileId: breakProfile!.id });
      const { rows: rows2 } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and entry_type = 'break'`,
        [target!.id]
      );
      check(
        Number(rows2[0].count) === 0,
        "knownEmployee with isActive=false skips reconciliation entirely",
        rows2[0]
      );
    }

    // -----------------------------------------------------------------
    // Real reconciliation, using the pre-fetched knownEmployee (the GET
    // /daily call shape) — the work entry must actually get split.
    // -----------------------------------------------------------------
    {
      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: true, breakProfileId: breakProfile!.id });

      const { rows } = await pool.query(
        `select entry_type, started_at, ended_at, source, is_paid
         from time_entries
         where employee_id = $1 and deleted_at is null
         order by started_at asc`,
        [target!.id]
      );
      check(rows.length === 3, "the covering work entry is split into exactly 3 rows (before/break/after)", rows);
      check(
        rows[0]?.entry_type === "work" &&
          rows[1]?.entry_type === "break" &&
          rows[1]?.source === "auto" &&
          rows[1]?.is_paid === false &&
          rows[2]?.entry_type === "work",
        "the split rows are work / auto unpaid break / work, in that order",
        rows
      );
    }

    // -----------------------------------------------------------------
    // Idempotency: reconciling the same employee/date again — whether via
    // the same knownEmployee shortcut or the no-argument fallback path
    // mobileTime.ts uses — must never double-add.
    // -----------------------------------------------------------------
    {
      await reconcileEmployeeBreaks(target!.id, TEST_DATE, { isActive: true, breakProfileId: breakProfile!.id });
      await reconcileEmployeeBreaks(target!.id, TEST_DATE); // no third arg — fetches employee info itself

      const { rows } = await pool.query(
        `select count(*) from time_entries where employee_id = $1 and deleted_at is null`,
        [target!.id]
      );
      check(
        Number(rows[0].count) === 3,
        "reconciling again (with or without a pre-fetched knownEmployee) never creates duplicate rows",
        rows[0]
      );
    }

    // -----------------------------------------------------------------
    // The no-argument fallback path also correctly finds "nothing to do"
    // on its own for an employee with no break profile at all, exactly
    // like before this refactor.
    // -----------------------------------------------------------------
    {
      const unassignedRows = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true)
         returning id`,
        [
          "QA",
          `Break Recon Unassigned ${RUN_ID}`,
          `qa-break-recon-unassigned-${RUN_ID}@test.local`,
          employeeRoleId,
          teamRoleId,
          fakePinHash,
        ]
      );
      inactiveProfileEmployee = unassignedRows.rows[0];
      await reconcileEmployeeBreaks(inactiveProfileEmployee!.id, TEST_DATE);
      const { rows } = await pool.query(`select count(*) from time_entries where employee_id = $1`, [
        inactiveProfileEmployee!.id,
      ]);
      check(
        Number(rows[0].count) === 0,
        "the no-argument fallback path correctly no-ops for an employee with no break profile"
      );
    }

    // -----------------------------------------------------------------
    // Multiple auto-add items on one profile, each with a DIFFERENT reason
    // to skip (or not) — proves the batched pre-checks (suppressed/already/
    // overlapping, each now one query covering every item instead of one
    // query per item) still discriminate correctly PER ITEM rather than
    // accidentally applying one item's verdict to all of them:
    //   Item A (08:00-08:15): nothing in the way — must be created.
    //   Item B (10:00-10:15): suppressed via break_schedule_exceptions —
    //     must NOT be created.
    //   Item C (14:00-14:15): a manually-added break (not tied to any
    //     break_profile_item_id) already overlaps its window — must NOT be
    //     created, and the manual break itself must be left untouched.
    // -----------------------------------------------------------------
    let multiItemEmployee: { id: string } | undefined;
    let multiItemProfile: { id: string } | undefined;
    try {
      multiItemProfile = (
        await pool.query(`insert into break_profiles (name, is_active) values ($1, true) returning id`, [
          `QA Break Reconciliation Multi-Item Profile ${RUN_ID}`,
        ])
      ).rows[0];
      const itemA = (
        await pool.query(
          `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
           values ($1, 'QA Item A', '08:00:00', '08:15:00', false, true, 1) returning id`,
          [multiItemProfile!.id]
        )
      ).rows[0].id;
      const itemB = (
        await pool.query(
          `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
           values ($1, 'QA Item B', '10:00:00', '10:15:00', false, true, 2) returning id`,
          [multiItemProfile!.id]
        )
      ).rows[0].id;
      const itemC = (
        await pool.query(
          `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, auto_add, sort_order)
           values ($1, 'QA Item C', '14:00:00', '14:15:00', false, true, 3) returning id`,
          [multiItemProfile!.id]
        )
      ).rows[0].id;

      const multiItemRows = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
         values ($1, $2, $3, $4, $5, $6, true, $7)
         returning id`,
        [
          "QA",
          `Break Recon Multi ${RUN_ID}`,
          `qa-break-recon-multi-${RUN_ID}@test.local`,
          employeeRoleId,
          teamRoleId,
          fakePinHash,
          multiItemProfile!.id,
        ]
      );
      multiItemEmployee = multiItemRows.rows[0];

      // One work entry covering the whole day — enough for item A (the only
      // one that should ever reach the "find a covering work entry" step;
      // B and C are both skipped by an earlier pre-check).
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual')`,
        [
          multiItemEmployee!.id,
          activity!.id,
          zonedWallTimeToUtc(2019, 6, 3, 7, 0, 0).toISOString(),
          zonedWallTimeToUtc(2019, 6, 3, 15, 0, 0).toISOString(),
        ]
      );
      // Item B's suppression.
      await pool.query(
        `insert into break_schedule_exceptions (employee_id, break_profile_item_id, scheduled_date, reason, created_by_employee_id)
         values ($1, $2, $3, 'QA test suppression', $1)`,
        [multiItemEmployee!.id, itemB, TEST_DATE]
      );
      // A manual break overlapping item C's window, unrelated to any
      // profile item.
      await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source)
         values ($1, null, 'break', null, gen_random_uuid(), $2, $3, 'manual')`,
        [
          multiItemEmployee!.id,
          zonedWallTimeToUtc(2019, 6, 3, 14, 5, 0).toISOString(),
          zonedWallTimeToUtc(2019, 6, 3, 14, 10, 0).toISOString(),
        ]
      );

      await reconcileEmployeeBreaks(multiItemEmployee!.id, TEST_DATE, { isActive: true, breakProfileId: multiItemProfile!.id });

      const { rows: breaksAfter } = await pool.query(
        `select break_profile_item_id, source, started_at, ended_at from time_entries
         where employee_id = $1 and entry_type = 'break' and deleted_at is null
         order by started_at asc`,
        [multiItemEmployee!.id]
      );
      check(
        breaksAfter.length === 2,
        "exactly 2 break rows exist after reconciliation: the pre-existing manual one (item C's window) and the new auto one (item A) — item B stayed suppressed",
        breaksAfter
      );
      check(
        breaksAfter.some((b) => b.break_profile_item_id === itemA && b.source === "auto"),
        "item A (nothing in the way) was auto-created",
        breaksAfter
      );
      check(
        !breaksAfter.some((b) => b.break_profile_item_id === itemB),
        "item B (suppressed via break_schedule_exceptions) was NOT created",
        breaksAfter
      );
      check(
        !breaksAfter.some((b) => b.break_profile_item_id === itemC),
        "item C (its window already overlapped by an unrelated manual break) was NOT created as its own auto row",
        breaksAfter
      );
      const manualBreak = breaksAfter.find((b) => b.break_profile_item_id === null);
      check(
        manualBreak !== undefined &&
          new Date(manualBreak.started_at).getTime() === zonedWallTimeToUtc(2019, 6, 3, 14, 5, 0).getTime() &&
          new Date(manualBreak.ended_at).getTime() === zonedWallTimeToUtc(2019, 6, 3, 14, 10, 0).getTime(),
        "the pre-existing manual break (item C's overlap) is completely untouched — same start/end as inserted",
        manualBreak
      );

      // The covering work entry was split around item A only — item C was
      // skipped by the overlapping pre-check before reconciliation ever
      // looked for a work entry to split around IT, so the pre-existing
      // manual break at 14:05-14:10 is never "carved out" of the work
      // entry the way an auto-add split would be; the day's work rows are
      // exactly the before/after halves of item A's own split:
      // 7:00-8:00 and 8:15-15:00 (the latter simply overlapping the
      // untouched manual break inside it, same as the fixture set up).
      const { rows: workAfter } = await pool.query(
        `select started_at, ended_at from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
         order by started_at asc`,
        [multiItemEmployee!.id]
      );
      check(workAfter.length === 2, "the covering work entry is split into exactly 2 rows around item A only — item C's window was never touched", workAfter);
    } finally {
      if (multiItemEmployee) {
        // break_schedule_exceptions references both the employee and the
        // profile item — must go first, or deleting either FK target below
        // fails.
        await pool
          .query(`delete from break_schedule_exceptions where employee_id = $1`, [multiItemEmployee.id])
          .catch((err) => console.error("cleanup step failed (multi-item exceptions):", err));
        await pool
          .query(`delete from time_entries where employee_id = $1`, [multiItemEmployee.id])
          .catch((err) => console.error("cleanup step failed (multi-item time_entries):", err));
        await pool
          .query(`delete from employees where id = $1`, [multiItemEmployee.id])
          .catch((err) => console.error("cleanup step failed (multi-item employee):", err));
      }
      if (multiItemProfile) {
        await pool
          .query(`delete from break_profile_items where break_profile_id = $1`, [multiItemProfile.id])
          .catch((err) => console.error("cleanup step failed (multi-item items):", err));
        await pool
          .query(`delete from break_profiles where id = $1`, [multiItemProfile.id])
          .catch((err) => console.error("cleanup step failed (multi-item profile):", err));
      }
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    await tryDelete("time_entries", () =>
      pool.query(`delete from time_entries where employee_id in (select id from employees where email like $1)`, [
        `qa-break-recon-%-${RUN_ID}@test.local`,
      ])
    );
    for (const employee of [target, inactiveProfileEmployee]) {
      if (employee) {
        await tryDelete("employees", () => pool.query("delete from employees where id = $1", [employee.id]));
      }
    }
    if (activity) {
      await tryDelete("activities", () => pool.query("delete from activities where id = $1", [activity!.id]));
    }
    if (breakProfile) {
      await tryDelete("break_profile_items", () =>
        pool.query("delete from break_profile_items where break_profile_id = $1", [breakProfile!.id])
      );
      await tryDelete("break_profiles", () => pool.query("delete from break_profiles where id = $1", [breakProfile!.id]));
    }
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
