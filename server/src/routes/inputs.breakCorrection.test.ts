// Reproduces and locks in the fix for the reported bug: correcting a
// break's start/end time rejected outright ("Corrected break overlaps a
// work entry") whenever the corrected range reached past the single
// immediately-adjacent work entry into a second one — Byron Escober's real
// Aug 25 2026 case (a break at 3:14:50-3:15:00 PM, corrected start of
// 3:00 PM, which needed the PRECEDING entry trimmed by 7 seconds AND the
// one before THAT entirely soft-deleted). PATCH /breaks/:id now reuses
// planBreakInsertion (server/src/lib/manualTimeEntries.ts) — the exact
// same trim/split/delete classification Add Break already uses — against
// the break's own corrected range, excluding the break's own row from its
// own overlap check.
//
// Byron's own real employee record is never touched here — this file
// reproduces the SAME relative shape (work ending a few seconds after the
// corrected break's new start, then a fully-covered work entry, then a
// following entry touching the break's end exactly) using disposable QA
// fixtures only.
//
// Same real-HTTP-against-real-database convention as
// inputs.addBreakSplit.test.ts.
//
// Run with: npm run test:break-correction
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
const DATE_BEGIN = "2018-03-01"; // work overlaps the BEGINNING of the corrected break
const DATE_END = "2018-03-02"; // work overlaps the END of the corrected break
const DATE_SPLIT = "2018-03-03"; // corrected break sits inside one work entry
const DATE_FULL_COVER = "2018-03-04"; // work entry completely covered
const DATE_MULTI = "2018-03-05"; // multiple work entries touched atomically
const DATE_BREAK_CONFLICT = "2018-03-06"; // another break overlaps -> reject, no merge
const DATE_BOUNDARY = "2018-03-07"; // exact boundary contact -> untouched
const DATE_ROLLBACK = "2018-03-08"; // rejected plan leaves everything untouched
const DATE_CONCURRENCY = "2018-03-09"; // two concurrent corrections, same employee
const DATE_BYRON = "2018-03-10"; // Byron's real reported shape, isolated fixture
const DATE_NO_ROUND = "2018-03-11"; // exact admin-entered times, no rounding, Corrected not Rounded

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
  const activityIds: string[] = [];
  const timeEntryIds: string[] = [];
  let emp!: { id: string };

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    const admin = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`Break Correction Admin ${RUN_ID}`, `qa-break-corr-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(admin.id);
    const adminToken = signSession({ id: admin.id, firstName: admin.first_name, lastName: admin.last_name, securityRole: "Administrator", teamRole: "Team Member" });

    emp = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [`Break Correction Target ${RUN_ID}`, `qa-break-corr-target-${RUN_ID}@test.local`, await roleId("Employee"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(emp.id);

    const winding = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Winding & Pruning ${RUN_ID}`])
    ).rows[0];
    activityIds.push(winding.id);
    const picking = (
      await pool.query(`insert into activities (name, is_active) values ($1, true) returning id`, [`QA Picking ${RUN_ID}`])
    ).rows[0];
    activityIds.push(picking.id);

    async function insertWork(date: string, activityId: string, sh: number, sm: number, ss: number, eh: number, em: number, es: number, opts: { device?: string | null; actualStart?: boolean; actualEnd?: boolean } = {}): Promise<string> {
      const [y, mo, d] = date.split("-").map(Number);
      const startedAt = zonedWallTimeToUtc(y, mo, d, sh, sm, ss);
      const endedAt = zonedWallTimeToUtc(y, mo, d, eh, em, es);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                    actual_started_at, actual_ended_at)
         values ($1, $2, 'work', $3, gen_random_uuid(), $4, $5, 'manual', $6, $7) returning id`,
        [emp.id, opts.device ?? null, activityId, startedAt, endedAt, opts.actualStart ? startedAt : null, opts.actualEnd ? endedAt : null]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function insertBreak(date: string, sh: number, sm: number, ss: number, eh: number, em: number, es: number): Promise<string> {
      const [y, mo, d] = date.split("-").map(Number);
      const startedAt = zonedWallTimeToUtc(y, mo, d, sh, sm, ss);
      const endedAt = zonedWallTimeToUtc(y, mo, d, eh, em, es);
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, idempotency_key, started_at, ended_at, source, is_paid)
         values ($1, null, 'break', gen_random_uuid(), $2, $3, 'manual', false) returning id`,
        [emp.id, startedAt, endedAt]
      );
      timeEntryIds.push(rows[0].id);
      return rows[0].id;
    }
    async function entry(id: string) {
      const { rows } = await pool.query(
        `select entry_type, started_at, ended_at, deleted_at, actual_started_at, actual_ended_at, activity_id, device_id
         from time_entries where id = $1`,
        [id]
      );
      return rows[0];
    }

    // =====================================================================
    // 1) BEGINNING TRIM — work overlaps the start of the corrected break.
    // =====================================================================
    const w1 = await insertWork(DATE_BEGIN, winding.id, 9, 0, 0, 10, 0, 0);
    const b1 = await insertBreak(DATE_BEGIN, 10, 15, 0, 10, 30, 0);
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b1}`, { token: adminToken, body: { startTime: zonedWallTimeToUtc(2018, 3, 1, 10, 0, 0).toISOString() } });
      check(res.status === 200, "1) beginning-trim correction succeeds", res.body);
      const w1After = await entry(w1);
      check(new Date(w1After.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 1, 10, 0, 0).getTime(), "1b) work entry's end trimmed to the new break start", w1After);
      check(w1After.actual_ended_at === null, "1c) trimmed work entry's stale actual_ended_at cleared", w1After);
    }

    // =====================================================================
    // 2) ENDING TRIM — work overlaps the end of the corrected break.
    // =====================================================================
    const b2 = await insertBreak(DATE_END, 10, 0, 0, 10, 15, 0);
    const w2 = await insertWork(DATE_END, winding.id, 10, 20, 0, 11, 0, 0);
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b2}`, { token: adminToken, body: { endTime: zonedWallTimeToUtc(2018, 3, 2, 10, 30, 0).toISOString() } });
      check(res.status === 200, "2) ending-trim correction succeeds", res.body);
      const w2After = await entry(w2);
      check(new Date(w2After.started_at).getTime() === zonedWallTimeToUtc(2018, 3, 2, 10, 30, 0).getTime(), "2b) work entry's start moved to the new break end", w2After);
      check(w2After.actual_started_at === null, "2c) trimmed work entry's stale actual_started_at cleared", w2After);
    }

    // =====================================================================
    // 3) SPLIT — corrected break sits entirely inside one work entry.
    // =====================================================================
    const w3 = await insertWork(DATE_SPLIT, winding.id, 9, 0, 0, 12, 0, 0, { device: null });
    const b3 = await insertBreak(DATE_SPLIT, 15, 0, 0, 15, 5, 0); // starts detached; will be moved inside w3
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b3}`, {
        token: adminToken,
        body: {
          startTime: zonedWallTimeToUtc(2018, 3, 3, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 3, 3, 10, 15, 0).toISOString(),
        },
      });
      check(res.status === 200, "3) split correction succeeds", res.body);
      const w3After = await entry(w3);
      check(new Date(w3After.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 3, 10, 0, 0).getTime(), "3b) original entry trimmed to end at the break's new start", w3After);
      const { rows: continuationRows } = await pool.query(
        `select id, started_at, ended_at, activity_id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and started_at = $2 order by started_at`,
        [emp.id, zonedWallTimeToUtc(2018, 3, 3, 10, 15, 0)]
      );
      check(continuationRows.length === 1, "3c) exactly one continuation entry created", continuationRows);
      if (continuationRows[0]) {
        timeEntryIds.push(continuationRows[0].id);
        check(continuationRows[0].activity_id === winding.id, "3d) continuation preserves the original activity", continuationRows[0]);
        check(new Date(continuationRows[0].ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 3, 12, 0, 0).getTime(), "3e) continuation ends at the original entry's own end", continuationRows[0]);
      }
    }

    // =====================================================================
    // 4) FULLY COVERED — work entry completely inside the corrected break.
    // =====================================================================
    const w4 = await insertWork(DATE_FULL_COVER, winding.id, 10, 5, 0, 10, 10, 0);
    const b4 = await insertBreak(DATE_FULL_COVER, 15, 0, 0, 15, 5, 0);
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b4}`, {
        token: adminToken,
        body: {
          startTime: zonedWallTimeToUtc(2018, 3, 4, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 3, 4, 10, 15, 0).toISOString(),
        },
      });
      check(res.status === 200, "4) fully-covered correction succeeds", res.body);
      const w4After = await entry(w4);
      check(w4After.deleted_at !== null, "4b) fully-covered work entry is soft-deleted", w4After);
      const delRows = await pool.query(`select id from time_entry_deletions where $1 = any(affected_time_entry_ids)`, [w4]);
      check(delRows.rows.length === 1, "4c) a deletion audit row exists for it", delRows.rows);
    }

    // =====================================================================
    // 5) MULTIPLE WORK ENTRIES touched atomically — beginning-trim on one,
    //    full deletion of a second, all in a single correction.
    // =====================================================================
    const w5a = await insertWork(DATE_MULTI, winding.id, 9, 0, 0, 10, 5, 0); // reaches into the break's new start
    const w5b = await insertWork(DATE_MULTI, picking.id, 10, 5, 0, 10, 10, 0); // fully inside the break's new range
    const b5 = await insertBreak(DATE_MULTI, 12, 0, 0, 12, 5, 0);
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b5}`, {
        token: adminToken,
        body: {
          startTime: zonedWallTimeToUtc(2018, 3, 5, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 3, 5, 10, 15, 0).toISOString(),
        },
      });
      check(res.status === 200, "5) multi-entry correction succeeds", res.body);
      const w5aAfter = await entry(w5a);
      const w5bAfter = await entry(w5b);
      check(new Date(w5aAfter.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 5, 10, 0, 0).getTime(), "5b) first entry trimmed", w5aAfter);
      check(w5bAfter.deleted_at !== null, "5c) second entry (fully covered) soft-deleted", w5bAfter);
    }

    // =====================================================================
    // 6) ANOTHER BREAK CONFLICT — reject, never silently merge.
    // =====================================================================
    const otherBreak = await insertBreak(DATE_BREAK_CONFLICT, 11, 0, 0, 11, 10, 0);
    const b6 = await insertBreak(DATE_BREAK_CONFLICT, 15, 0, 0, 15, 5, 0);
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b6}`, {
        token: adminToken,
        body: {
          startTime: zonedWallTimeToUtc(2018, 3, 6, 10, 55, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 3, 6, 11, 5, 0).toISOString(),
        },
      });
      check(res.status === 409, "6) overlapping another break is rejected (409)", res.body);
      check(/break/i.test(res.body?.error ?? ""), "6b) rejection message mentions the conflicting break, not a generic error", res.body);
      const otherAfter = await entry(otherBreak);
      check(
        new Date(otherAfter.started_at).getTime() === zonedWallTimeToUtc(2018, 3, 6, 11, 0, 0).getTime() &&
          new Date(otherAfter.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 6, 11, 10, 0).getTime(),
        "6c) the other break was never merged/altered",
        otherAfter
      );
    }

    // =====================================================================
    // 7) EXACT BOUNDARY CONTACT — touching, not overlapping, stays untouched.
    // =====================================================================
    const w7 = await insertWork(DATE_BOUNDARY, winding.id, 10, 15, 0, 11, 0, 0); // starts exactly at the new break end
    const b7 = await insertBreak(DATE_BOUNDARY, 15, 0, 0, 15, 5, 0);
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b7}`, {
        token: adminToken,
        body: {
          startTime: zonedWallTimeToUtc(2018, 3, 7, 10, 0, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 3, 7, 10, 15, 0).toISOString(),
        },
      });
      check(res.status === 200, "7) correction touching (not overlapping) an entry succeeds", res.body);
      const w7After = await entry(w7);
      check(
        new Date(w7After.started_at).getTime() === zonedWallTimeToUtc(2018, 3, 7, 10, 15, 0).getTime(),
        "7b) the touching entry's own boundary is completely unchanged",
        w7After
      );
    }

    // =====================================================================
    // 8) ROLLBACK / ATOMICITY — a plan that's partly resolvable and partly
    //    blocked (another break overlap) is rejected as a WHOLE; the
    //    otherwise-trimmable entry is left completely untouched.
    // =====================================================================
    const w8 = await insertWork(DATE_ROLLBACK, winding.id, 9, 0, 0, 10, 0, 0); // would be trimmed if the plan applied
    const conflictBreak8 = await insertBreak(DATE_ROLLBACK, 10, 20, 0, 10, 30, 0); // sits inside the corrected range
    const b8 = await insertBreak(DATE_ROLLBACK, 15, 0, 0, 15, 5, 0);
    {
      const res = await call("PATCH", `/api/inputs/breaks/${b8}`, {
        token: adminToken,
        body: {
          startTime: zonedWallTimeToUtc(2018, 3, 8, 9, 50, 0).toISOString(),
          endTime: zonedWallTimeToUtc(2018, 3, 8, 10, 40, 0).toISOString(),
        },
      });
      check(res.status === 409, "8) a plan with any blocked entry is rejected entirely", res.body);
      const w8After = await entry(w8);
      const b8After = await entry(b8);
      check(new Date(w8After.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 8, 10, 0, 0).getTime(), "8b) the otherwise-trimmable entry was left completely untouched (full rollback)", w8After);
      check(new Date(b8After.started_at).getTime() === zonedWallTimeToUtc(2018, 3, 8, 15, 0, 0).getTime(), "8c) the break being corrected itself reverted to its original time", b8After);
      const historyCount = await pool.query(`select count(*)::int c from time_entry_corrections where time_entry_id = any($1::uuid[])`, [[w8, b8]]);
      check(historyCount.rows[0].c === 0, "8d) no correction audit rows were written for the rejected attempt", historyCount.rows[0]);
    }

    // =====================================================================
    // 9) CONCURRENCY — two correction requests fired at once for the same
    //    break must never both apply / never corrupt data; the advisory
    //    employee lock serializes them.
    // =====================================================================
    const w9 = await insertWork(DATE_CONCURRENCY, winding.id, 9, 0, 0, 10, 0, 0);
    const b9 = await insertBreak(DATE_CONCURRENCY, 15, 0, 0, 15, 5, 0);
    {
      // Two IDENTICAL requests — the same double-click/two-tabs scenario
      // the advisory lock exists for. The advisory lock serializes them;
      // whichever runs second sees the first's already-committed result
      // (w9 already trimmed to 9:50, no longer overlapping [9:50,10:05)),
      // so its own plan finds nothing left to touch and simply re-applies
      // the same (already-current) break boundary — a harmless no-op, not
      // a duplicate trim or a second audit row.
      const target = { startTime: zonedWallTimeToUtc(2018, 3, 9, 9, 50, 0).toISOString(), endTime: zonedWallTimeToUtc(2018, 3, 9, 10, 5, 0).toISOString() };
      const [r1, r2] = await Promise.all([
        call("PATCH", `/api/inputs/breaks/${b9}`, { token: adminToken, body: target }),
        call("PATCH", `/api/inputs/breaks/${b9}`, { token: adminToken, body: target }),
      ]);
      check(r1.status === 200 && r2.status === 200, "9) two identical concurrent corrections both succeed (serialized, not raced)", { r1: r1.status, r2: r2.status });
      const w9After = await entry(w9);
      const b9After = await entry(b9);
      check(new Date(w9After.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 9, 9, 50, 0).getTime(), "9b) work entry trimmed to exactly the target boundary once, not corrupted by the race", w9After);
      check(
        new Date(b9After.started_at).getTime() === zonedWallTimeToUtc(2018, 3, 9, 9, 50, 0).getTime() &&
          new Date(b9After.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 9, 10, 5, 0).getTime(),
        "9c) break lands at exactly the target boundary",
        b9After
      );
      // Exactly one real trim was recorded — the second (redundant) call's
      // plan found nothing left to change, so it never wrote a duplicate.
      const auditCount = await pool.query(`select count(*)::int c from time_entry_corrections where time_entry_id = $1`, [w9]);
      check(auditCount.rows[0].c === 1, "9d) exactly one audit row for the work entry, no duplicate from the redundant second request", auditCount.rows[0]);
    }

    // =====================================================================
    // 10) NO AUTOMATIC ROUNDING — exact administrator-entered times,
    //     actual_* cleared, Corrected not Rounded.
    // =====================================================================
    const b10 = await insertBreak(DATE_NO_ROUND, 14, 0, 0, 14, 5, 0);
    // Simulate this break having previously shown "Rounded" evidence.
    await pool.query(`update time_entries set actual_started_at = $1, actual_ended_at = $2 where id = $3`, [
      zonedWallTimeToUtc(2018, 3, 11, 13, 59, 40),
      zonedWallTimeToUtc(2018, 3, 11, 14, 5, 20),
      b10,
    ]);
    {
      const oddStart = zonedWallTimeToUtc(2018, 3, 11, 14, 0, 37); // deliberately not on any rounding interval
      const res = await call("PATCH", `/api/inputs/breaks/${b10}`, { token: adminToken, body: { startTime: oddStart.toISOString() } });
      check(res.status === 200, "10) an exact, non-round-interval correction is accepted verbatim", res.body);
      const b10After = await entry(b10);
      check(new Date(b10After.started_at).getTime() === oddStart.getTime(), "10b) stored exactly as entered — no rounding applied", b10After);
      check(b10After.actual_started_at === null, "10c) stale actual_started_at cleared (shows Corrected, not Rounded)", b10After);
    }

    // =====================================================================
    // 11) BYRON'S REPORTED SCENARIO — isolated fixture reproducing the same
    //     relative shape: work ending 7s after the corrected break's new
    //     start (needs a 7s trim), then a fully-covered work entry, then a
    //     following entry touching the break's new end exactly.
    // =====================================================================
    const wByronFar = await insertWork(DATE_BYRON, winding.id, 12, 48, 48, 13, 0, 7); // 17:48:48-19:00:07 equivalent, trimmed by 7s
    const wByronCovered = await insertWork(DATE_BYRON, winding.id, 13, 0, 7, 13, 14, 51); // fully covered by the corrected break
    const bByron = await insertBreak(DATE_BYRON, 13, 14, 51, 13, 15, 0); // the break being corrected: currently 3:14:50.856-3:15:00 PM equivalent
    const wByronFollowing = await insertWork(DATE_BYRON, winding.id, 13, 15, 0, 14, 20, 24); // touches the break's end exactly — must stay untouched
    {
      const dailyBefore = await call("GET", `/api/inputs/daily?employeeId=${emp.id}&date=${DATE_BYRON}`, { token: adminToken });
      const workedBefore = dailyBefore.body?.totals?.workedSeconds;

      const newStart = zonedWallTimeToUtc(2018, 3, 10, 13, 0, 0); // corrected break start: 3:00 PM equivalent
      const res = await call("PATCH", `/api/inputs/breaks/${bByron}`, { token: adminToken, body: { startTime: newStart.toISOString() } });
      check(res.status === 200, "11) Byron's exact reported correction now succeeds instead of rejecting", res.body);

      const bByronAfter = await entry(bByron);
      check(new Date(bByronAfter.started_at).getTime() === newStart.getTime(), "11b) break displays the corrected start", bByronAfter);
      check(new Date(bByronAfter.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 10, 13, 15, 0).getTime(), "11c) break's untouched end is still 3:15 PM equivalent", bByronAfter);

      const wFarAfter = await entry(wByronFar);
      check(new Date(wFarAfter.ended_at).getTime() === newStart.getTime(), "11d) the further-back entry is trimmed to end at the new break start", wFarAfter);

      const wCoveredAfter = await entry(wByronCovered);
      check(wCoveredAfter.deleted_at !== null, "11e) the entry fully covered by the corrected break is soft-deleted", wCoveredAfter);

      const wFollowingAfter = await entry(wByronFollowing);
      check(
        new Date(wFollowingAfter.started_at).getTime() === zonedWallTimeToUtc(2018, 3, 10, 13, 15, 0).getTime(),
        "11f) the following entry (exact boundary touch) is completely unaffected",
        wFollowingAfter
      );

      const dailyAfter = await call("GET", `/api/inputs/daily?employeeId=${emp.id}&date=${DATE_BYRON}`, { token: adminToken });
      const workedAfter = dailyAfter.body?.totals?.workedSeconds;
      // The corrected break's own span grew from 9s to 15 minutes (900s) —
      // an 891s (14m51s) larger unpaid-break deduction — which is exactly
      // what should come out of worked time, no more and no less.
      check(workedBefore - workedAfter === 891, "11g) worked total decreases by exactly the break's own growth (14m51s here)", { workedBefore, workedAfter });

      const breakAfterTotals = dailyAfter.body?.totals?.unpaidBreakSeconds;
      check(breakAfterTotals >= 900, "11h) break total increased to reflect the corrected (larger) break span", breakAfterTotals);

      // Audit rows correctly identify both the break's own correction and
      // the affected work entry's correction.
      const breakAudit = await pool.query(`select field_name from time_entry_corrections where time_entry_id = $1`, [bByron]);
      check(breakAudit.rows.some((r) => r.field_name === "started_at"), "11i) the break's own started_at correction is audited", breakAudit.rows);
      const workAudit = await pool.query(`select field_name from time_entry_corrections where time_entry_id = $1`, [wByronFar]);
      check(workAudit.rows.some((r) => r.field_name === "ended_at"), "11j) the affected work entry's ended_at correction is audited", workAudit.rows);
    }

    // Preview endpoint — same plan, never applied.
    {
      const wP = await insertWork(DATE_BYRON, picking.id, 20, 0, 0, 21, 12, 0);
      const bP = await insertBreak(DATE_BYRON, 21, 30, 0, 21, 35, 0);
      // Moving the break's start earlier, back into wP's own end (21:12),
      // is what makes this an ending-trim on wP — leaving endTime alone.
      const res = await call("POST", `/api/inputs/breaks/${bP}/correction-preview`, {
        token: adminToken,
        body: { startTime: zonedWallTimeToUtc(2018, 3, 10, 21, 4, 0).toISOString() },
      });
      check(res.status === 200, "12) preview endpoint succeeds", res.body);
      check(Array.isArray(res.body?.messages) && res.body.messages.length === 1, "12b) preview describes exactly one affected entry", res.body);
      check(/shorten/i.test(res.body?.messages?.[0] ?? "") && /QA Picking/.test(res.body?.messages?.[0] ?? ""), "12c) preview message names the activity and describes shortening it", res.body?.messages);
      check(res.body?.workedMinutesRemoved === 8, "12d) preview reports the correct worked-minutes-removed (8 minutes)", res.body);
      const wPAfter = await entry(wP);
      check(new Date(wPAfter.ended_at).getTime() === zonedWallTimeToUtc(2018, 3, 10, 21, 12, 0).getTime(), "12e) preview never actually applies anything — entry unchanged", wPAfter);
    }
  } finally {
    for (const id of timeEntryIds) {
      await pool.query(`delete from time_entry_corrections where time_entry_id = $1`, [id]).catch(() => {});
      await pool.query(`delete from time_entry_deletions where $1 = any(affected_time_entry_ids)`, [id]).catch(() => {});
    }
    for (const id of timeEntryIds) {
      await pool.query(`delete from time_entries where id = $1`, [id]).catch(() => {});
    }
    // Catch-all in case any continuation/split row wasn't individually
    // tracked above — scoped strictly to this run's own QA employee.
    await pool.query(`delete from time_entry_corrections where employee_id = $1`, [emp?.id]).catch(() => {});
    await pool.query(`delete from time_entry_deletions where employee_id = $1`, [emp?.id]).catch(() => {});
    await pool.query(`delete from time_entries where employee_id = $1`, [emp?.id]).catch(() => {});
    for (const id of activityIds) await pool.query(`delete from activities where id = $1`, [id]).catch(() => {});
    for (const id of employeeIds) await pool.query(`delete from employees where id = $1`, [id]).catch(() => {});
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
