// Integration test for GET /api/inputs/daily's per-run
// minimumDurationMinutes / isBelowMinimumDuration — the Inputs → Activity
// details "below minimum" highlight. Judged per displayed run against the
// UNROUNDED worked seconds (break interruptions excluded), strictly less
// than the activity's current minimum; never for an open run; breaks and
// deleted entries never appear as runs at all. Visual guidance only —
// durationSeconds stays the same rounded value it always was. Same real-database harness as inputs.workingTotals.test.ts:
// far-past QA dates, fixtures always removed.
//
// Run with: npm run test:inputs-below-minimum-duration
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { zonedWallTimeToUtc } from "../lib/timezone";
import inputsRouter from "./inputs";

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
const EMAIL_PATTERN = `qa-below-min-%-${RUN_ID}@test.local`;
const DAY = "2018-04-11";
// Wall-clock time on DAY in the organization's timezone, to the millisecond.
const at = (h: number, m: number, s = 0, ms = 0) => new Date(zonedWallTimeToUtc(2018, 4, 11, h, m, s).getTime() + ms).toISOString();

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/inputs", inputsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const activityIds: string[] = [];
  const carrierIds: string[] = [];
  let activityGroupId: string | undefined;
  let landId: string | undefined;
  let phaseId: string | undefined;
  let rowId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    async function createEmployee(label: string, role = "Employee") {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`${label} ${RUN_ID}`, `qa-below-min-${label.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0] as { id: string; first_name: string; last_name: string };
    }
    async function createActivity(name: string, minimumMinutes: number) {
      const id: string = (
        await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, $2) returning id`, [
          `${name} ${RUN_ID}`,
          minimumMinutes,
        ])
      ).rows[0].id;
      activityIds.push(id);
      await pool.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [activityGroupId, id]);
      return id;
    }
    async function entry(
      employeeId: string,
      start: string,
      end: string | null,
      opts: { type?: "work" | "break"; activityId?: string; deleted?: boolean; rowId?: string; carrierId?: string } = {}
    ) {
      const type = opts.type ?? "work";
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source, is_paid,
                                   greenhouse_row_id, carrier_id, deleted_at, deleted_by_employee_id, deletion_reason)
         values ($1, null, $2, $3, gen_random_uuid(), $4, $5, 'manual', $6, $7, $8, $9, $10, $11) returning id`,
        [
          employeeId,
          type,
          type === "work" ? opts.activityId : null,
          start,
          end,
          type === "break" ? false : null,
          opts.rowId ?? null,
          opts.carrierId ?? null,
          opts.deleted ? new Date() : null,
          opts.deleted ? employeeId : null,
          opts.deleted ? "QA deleted" : null,
        ]
      );
      return rows[0].id as string;
    }

    const admin = await createEmployee("Admin", "Administrator");
    const adminToken = signSession({ id: admin.id, firstName: admin.first_name, lastName: admin.last_name, securityRole: "Administrator", teamRole: "Team Member" });

    activityGroupId = (await pool.query(`insert into activity_groups (name, is_active) values ($1, true) returning id`, [`QA BelowMin ${RUN_ID}`])).rows[0].id;
    const peppers = await createActivity("QA Picking Peppers", 3);
    const tomatoes = await createActivity("QA Picking Tomatoes", 10);
    const sorting = await createActivity("QA Sorting", 0);

    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [`QA BelowMin Land ${RUN_ID}`])).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`, [landId, `QA BelowMin Phase ${RUN_ID}`])
    ).rows[0].id;
    rowId = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, 1, 0, 0, 4, 50, 'vertical') returning id`,
        [phaseId]
      )
    ).rows[0].id;
    for (const name of ["Bin A", "Bin B"]) {
      carrierIds.push((await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [`QA ${name} ${RUN_ID}`])).rows[0].id);
    }

    const daily = async (employeeId: string) => {
      const r = await call("GET", `/api/inputs/daily?employeeId=${employeeId}&date=${DAY}`, adminToken);
      check(r.status === 200, `daily loads for ${employeeId}`, r);
      return r.body;
    };
    const runStarting = (body: any, startIso: string) => body?.runs?.find((r: any) => new Date(r.startedAt).toISOString() === startIso);

    // -----------------------------------------------------------------
    // 1) Boundaries, unrounded seconds, different activities' minimums,
    //    deleted entries and breaks.
    // -----------------------------------------------------------------
    const worker = await createEmployee("Worker");
    const shortId = await entry(worker.id, at(7, 0), at(7, 2, 59), { activityId: peppers }); // 2:59
    await entry(worker.id, at(7, 10), at(7, 13), { activityId: peppers }); // exactly 3:00
    await entry(worker.id, at(7, 20), at(7, 23, 30), { activityId: peppers }); // 3:30
    await entry(worker.id, at(7, 30), at(7, 32, 59, 600), { activityId: peppers }); // 2:59.6 — displays as 3:00
    await entry(worker.id, at(7, 40), at(7, 41), { activityId: peppers, deleted: true });
    await entry(worker.id, at(7, 50), at(7, 51), { type: "break" });
    await entry(worker.id, at(8, 0), at(8, 5), { activityId: tomatoes }); // 5:00 vs 10-minute minimum
    await entry(worker.id, at(8, 10), at(8, 15), { activityId: peppers }); // 5:00 vs 3-minute minimum
    await entry(worker.id, at(8, 20), at(8, 20, 10), { activityId: sorting }); // 0:10, no minimum
    // Split by a break: 1:30 + 1:00 worked = 2:30, though the run spans 6 minutes.
    await entry(worker.id, at(9, 0), at(9, 1, 30), { activityId: peppers });
    await entry(worker.id, at(9, 1, 30), at(9, 5), { type: "break" });
    await entry(worker.id, at(9, 5), at(9, 6), { activityId: peppers });

    const d1 = await daily(worker.id);
    const flag = (startIso: string) => runStarting(d1, startIso)?.isBelowMinimumDuration;
    check(flag(at(7, 0)) === true, "1) 2:59 against a 3-minute minimum is flagged", runStarting(d1, at(7, 0)));
    check(runStarting(d1, at(7, 0))?.minimumDurationMinutes === 3, "1) the run carries its activity's minimum (3)");
    check(flag(at(7, 10)) === false, "1) exactly 3:00 is not flagged");
    check(flag(at(7, 20)) === false, "1) 3:30 is not flagged");
    check(
      flag(at(7, 30)) === true && runStarting(d1, at(7, 30))?.durationSeconds === 180,
      "1) 2:59.6 is flagged from the unrounded seconds even though durationSeconds rounds it to 180",
      runStarting(d1, at(7, 30))
    );
    check(!runStarting(d1, at(7, 40)), "1) the deleted entry isn't a run at all");
    check(d1.breaks.length === 2 && d1.breaks.every((b: any) => !("isBelowMinimumDuration" in b)), "1) breaks carry no minimum flag", d1.breaks);
    check(flag(at(8, 0)) === true && runStarting(d1, at(8, 0))?.minimumDurationMinutes === 10, "1) 5:00 of a 10-minute-minimum activity is flagged");
    check(flag(at(8, 10)) === false, "1) 5:00 of the 3-minute-minimum activity is not");
    check(flag(at(8, 20)) === false && runStarting(d1, at(8, 20))?.minimumDurationMinutes === 0, "1) a 0-minimum activity is never flagged");
    const splitRun = runStarting(d1, at(9, 0));
    check(
      splitRun?.segmentIds.length === 2 && splitRun?.durationSeconds === 150 && splitRun?.isBelowMinimumDuration === true,
      "1) a break-split run is judged on its 2:30 worked, not the 6 minutes it spans",
      splitRun
    );
    check(d1.runs.length === 8, "1) eight runs shown (deleted entry and breaks excluded)", d1.runs.length);

    // -----------------------------------------------------------------
    // 2) Editing the short entry into compliance clears the flag on the
    //    next load; changing the activity's minimum applies on next load.
    // -----------------------------------------------------------------
    const preview = await call("POST", `/api/inputs/activity-runs/${shortId}/correction-preview`, adminToken, { endTime: at(7, 3) });
    check(preview.status === 200, "2) correction preview to 3:00 succeeds", preview);
    const applied = await call("PATCH", `/api/inputs/activity-runs/${shortId}/correction`, adminToken, {
      endTime: at(7, 3),
      fingerprint: preview.body?.fingerprint,
    });
    check(applied.status === 200, "2) correction applies", applied);
    const d2 = await daily(worker.id);
    check(runStarting(d2, at(7, 0))?.isBelowMinimumDuration === false, "2) the corrected 3:00 entry is no longer flagged", runStarting(d2, at(7, 0)));

    await pool.query(`update activities set minimum_duration_minutes = 4 where id = $1`, [peppers]);
    const d3 = await daily(worker.id);
    check(
      runStarting(d3, at(7, 20))?.isBelowMinimumDuration === true && runStarting(d3, at(7, 20))?.minimumDurationMinutes === 4,
      "2) raising the minimum to 4 flags the 3:30 entry on the next load",
      runStarting(d3, at(7, 20))
    );
    await pool.query(`update activities set minimum_duration_minutes = 3 where id = $1`, [peppers]);

    // -----------------------------------------------------------------
    // 3) Carrier change on the same row: the 0:08 segment is its own run
    //    and is flagged; the long one after it is not.
    // -----------------------------------------------------------------
    const binWorker = await createEmployee("Bin Worker");
    await entry(binWorker.id, at(10, 0), at(10, 0, 8), { activityId: peppers, rowId, carrierId: carrierIds[0] });
    await entry(binWorker.id, at(10, 0, 8), at(10, 15), { activityId: peppers, rowId, carrierId: carrierIds[1] });
    const d4 = await daily(binWorker.id);
    check(d4.runs.length === 2, "3) the carrier change produces two displayed runs", d4.runs);
    check(runStarting(d4, at(10, 0))?.isBelowMinimumDuration === true, "3) the 0:08 segment is flagged on its own");
    check(runStarting(d4, at(10, 0, 8))?.isBelowMinimumDuration === false, "3) the following long segment is not");

    // -----------------------------------------------------------------
    // 4) Open runs are never flagged; manual entries are judged the same.
    // -----------------------------------------------------------------
    const openWorker = await createEmployee("Open Worker");
    await entry(openWorker.id, at(11, 0), null, { activityId: peppers });
    const d5 = await daily(openWorker.id);
    check(d5.runs[0]?.isOpen === true && d5.runs[0]?.isBelowMinimumDuration === false, "4) an in-progress run is never flagged", d5.runs);

    const manualWorker = await createEmployee("Manual Worker");
    await pool.query(`insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`, [manualWorker.id, activityGroupId]);
    const added = await call("POST", "/api/inputs/activities", adminToken, {
      employeeId: manualWorker.id,
      date: DAY,
      activityId: peppers,
      startTime: at(12, 0),
      endTime: at(12, 2),
      reason: "Forgot phone",
    });
    check(added.status === 201, "4) a 2-minute manual entry is added through Inputs", added);
    const d6 = await daily(manualWorker.id);
    check(d6.runs[0]?.manualEntry && d6.runs[0]?.isBelowMinimumDuration === true, "4) the manual entry is flagged the same as a phone entry", d6.runs);
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const table of ["time_entry_corrections", "time_entry_deletions", "time_entries"]) {
        await client.query(`delete from ${table} where employee_id in (select id from employees where email like $1)`, [EMAIL_PATTERN]);
      }
      if (activityGroupId) {
        await client.query(`delete from employee_activity_group_assignments where activity_group_id = $1`, [activityGroupId]);
        await client.query(`delete from activity_group_activities where activity_group_id = $1`, [activityGroupId]);
      }
      await client.query(`delete from activities where id = any($1::uuid[])`, [activityIds]);
      if (activityGroupId) await client.query(`delete from activity_groups where id = $1`, [activityGroupId]);
      if (rowId) await client.query(`delete from greenhouse_rows where id = $1`, [rowId]);
      if (phaseId) await client.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      await client.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }
    const leftover = await pool.query(`select count(*) from employees where email like $1`, [EMAIL_PATTERN]);
    check(Number(leftover.rows[0].count) === 0, "all QA fixtures cleaned up");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
