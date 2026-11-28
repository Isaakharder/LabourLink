// Auto breaks (employees.auto_breaks_enabled) and the auto-breaks worker
// tick (scheduledBreaks.runAutoBreakTick), plus the "no historical
// rewriting" rules: occurrence snapshots, prospective settings changes, and
// Inputs reads writing nothing.
//
// Each scenario replays a day three days ago through the phone sync path,
// then runs worker ticks with a simulated "now" on that day.
//
// Run with: npm run test:auto-breaks
import "dotenv/config";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { addDaysToDateStr, calendarDateInAppTimezone } from "./timezone";
import { ensureOccurrences, runAutoBreakTick } from "./scheduledBreaks";
import { reconcileMidnightCutoff } from "./midnightCutoff";
import { signSession } from "../middleware/auth";
import { computeWorkdayTotals } from "./workdayTotals";
import { getPayrollReportData } from "./reportQueries";
import {
  activities,
  adminToken,
  at,
  check,
  createEmployee,
  createProfile,
  describe,
  direct,
  inputs,
  live,
  makeEvents,
  overlaps,
  paidHours,
  rows,
  sameInstant,
  sendEvents,
  startServer,
  summary,
  sync,
  FULL_BREAKS,
} from "./testSupport/scheduledBreakFixtures";

async function main() {
  const server = await startServer();
  const { A, B } = await activities();
  const admin = await adminToken();
  const D = addDaysToDateStr(calendarDateInAppTimezone(new Date()), -3);
  const t = (hhmm: string) => at(D, hhmm);
  const tick = (hhmm = "17:00") => runAutoBreakTick(new Date(t(hhmm)), 60 * 1000);
  const breaks = async (e: { id: string }) => live(await rows(e as never)).filter((r) => r.entry_type === "break");
  const occ = async (e: { id: string }) =>
    (await pool.query(`select status, auto_enabled, last_check_reason, scheduled_start from break_occurrences where employee_id = $1 and scheduled_date = $2 order by scheduled_start`, [e.id, D])).rows;
  const FULL_DAY: [string, string, string?][] = [["work_start", t("06:58"), A], ["end_day", t("16:33")]];
  // Every occurrence of the day, with its review state.
  const occFull = async (e: { id: string }) =>
    (
      await pool.query(
        `select id, name, status, last_check_reason, scheduled_start, auto_before_entry_id, auto_after_entry_id, reversal,
                review_reason, review_detail, review_confirmed_at
         from break_occurrences where employee_id = $1 and scheduled_date = $2 order by scheduled_start`,
        [e.id, D]
      )
    ).rows;
  // The Breaks to review list as Inputs shows it, for one employee.
  const reviewList = async (e: { id: string }) => {
    const r = await inputs(server, admin.token, "GET", "/break-reviews");
    return ((r.body?.occurrences ?? []) as any[]).filter((o) => o.employeeId === e.id);
  };
  // Every receipt still exists, and none points at a removed entry.
  const receiptsIntact = async (e: { id: string }, expected: number) => {
    const { rows: rc } = await pool.query(
      `select count(*)::int as n,
              count(*) filter (where m.time_entry_id is not null and te.id is null)::int as dangling
       from mobile_time_events m left join time_entries te on te.id = m.time_entry_id where m.employee_id = $1`,
      [e.id]
    );
    return rc[0].n === expected && rc[0].dangling === 0;
  };

  try {
    // 1) Default off: worked through every break, nothing is added.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      const { rows: def } = await pool.query(`select auto_breaks_enabled from employees where id = $1`, [e.id]);
      check(def[0].auto_breaks_enabled === false, "1: Auto breaks defaults to off", def[0]);
      await sync(server, e, FULL_DAY);
      await tick();
      check((await breaks(e)).length === 0, "1: no break added while off", await breaks(e));
      const o = await occ(e);
      check(o.length === 3 && o.every((x) => x.auto_enabled === false), "1: occurrences recorded with Auto breaks off", o);
    }

    // 2) On, worked through the whole day: every scheduled break is added.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, FULL_DAY);
      await tick();
      const b = await breaks(e);
      check(
        b.length === 3 && sameInstant(b[0].started_at, t("10:00")) && sameInstant(b[1].started_at, t("12:00")) && sameInstant(b[1].ended_at, t("13:00")) && sameInstant(b[2].ended_at, t("15:15")),
        "2: the three scheduled breaks are added",
        describe(await rows(e))
      );
      check(b.every((x) => x.source === "auto" && x.is_paid === false), "2: marked automatic and unpaid", b);
      const rs = await rows(e);
      check(overlaps(rs).length === 0, "2: no overlap", overlaps(rs));
      check(paidHours(rs, D) === 8, "2: paid 07:00-16:30 minus 1.5 h = 8 h", paidHours(rs, D));
      // A second tick, and two concurrent ticks, add nothing more.
      await Promise.all([tick(), tick()]);
      check((await breaks(e)).length === 3, "2: repeated / concurrent ticks add nothing", describe(await rows(e)));
      // Payroll report agrees with the day's totals.
      const payroll = await getPayrollReportData(D, D, { employeeIds: [e.id] });
      const prow = payroll.rows.find((r) => r.employeeId === e.id);
      check(!!prow && prow.workSeconds === 8 * 3600, "2: Payroll report shows the same 8 h", prow);
    }

    // 3) Each occurrence on its own: tapping the morning break doesn't stop
    //    lunch or the afternoon break being added.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("10:02")], ["break_end", t("10:13")], ["end_day", t("16:33")]]);
      await tick();
      const b = await breaks(e);
      check(b.length === 3, "3: one tapped + two automatic breaks", describe(await rows(e)));
      check(b[0].source === "manual" && b[1].source === "auto" && b[2].source === "auto", "3: the tapped one stays the employee's", b.map((x) => x.source));
    }

    // 4) Starts at 12:20: lunch skipped entirely, nothing deducted 12:20-13:00.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("12:20"), A], ["end_day", t("16:33")]]);
      await tick();
      const b = await breaks(e);
      check(b.length === 1 && sameInstant(b[0].started_at, t("15:00")), "4: only the afternoon break is added", describe(await rows(e)));
      check(paidHours(await rows(e), D) === 3.75, "4: paid 12:30-16:30 minus 15 min", paidHours(await rows(e), D));
      const o = await occ(e);
      check(o[1].last_check_reason === "started_after_window_start", "4: lunch skipped because work started after 12:00", o[1]);
      const rv = await reviewList(e);
      check(rv.length === 1 && rv[0].reason === "started_after_window_start" && rv[0].recordedBreak === null && /work started at 12:30 PM/.test(rv[0].message), "4: shown in Breaks to review, with no break record", rv);
    }

    // 5) Finishes at 12:20: no automatic lunch.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A], ["end_day", t("12:20")]]);
      await tick();
      const b = await breaks(e);
      check(b.length === 1 && sameInstant(b[0].started_at, t("10:00")), "5: only the morning break", describe(await rows(e)));
      check((await occ(e))[1].last_check_reason === "ended_before_window_end", "5: lunch skipped, work ended before 13:00", await occ(e));
      check((await reviewList(e)).some((r) => r.reason === "ended_before_window_end" && /work ended at 12:20 PM/.test(r.message)), "5: shown in Breaks to review", await reviewList(e));
      check(!(await reviewList(e)).some((r) => /Afternoon/.test(r.message)), "5: a break with no work at all isn't listed", await reviewList(e));
    }

    // 6) Starts exactly at 12:00 (11:50 rounded up) and works through.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("11:50"), A], ["end_day", t("14:33")]]);
      await tick();
      const rs = await rows(e);
      const b = await breaks(e);
      check(b.length === 1 && sameInstant(b[0].started_at, t("12:00")) && sameInstant(b[0].ended_at, t("13:00")), "6: lunch added", describe(rs));
      const w = live(rs).filter((r) => r.entry_type === "work");
      check(w.length === 1 && sameInstant(w[0].started_at, t("13:00")) && sameInstant(w[0].ended_at, t("14:30")), "6: work starts 13:00, nothing before", describe(rs));
      check(overlaps(rs).length === 0 && rs.every((r) => !r.deleted_at), "6: no overlap, nothing soft-deleted", describe(rs));
    }

    // 7) A gap inside the window (left 12:20, back 12:35): never a full break.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A], ["end_day", t("12:20")], ["work_start", t("12:35"), A], ["end_day", t("16:33")]]);
      await tick();
      const lunch = (await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00")));
      check(lunch.length === 0, "7: no lunch across the gap", describe(await rows(e)));
      check((await occ(e))[1].last_check_reason === "gap_in_work", "7: reason recorded", await occ(e));
      check((await reviewList(e)).some((r) => r.reason === "gap_in_work" && /no work is recorded from 12:20 PM to 12:45 PM/.test(r.message)), "7: shown in Breaks to review", await reviewList(e));
    }

    // 8) Several job switches during lunch: removed for good, boundaries kept.
    let switchEmp: Awaited<ReturnType<typeof createEmployee>> | null = null;
    let switchEvents: unknown[] = [];
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      switchEvents = makeEvents(e, [["work_start", t("10:58"), A], ["activity_switch", t("12:10"), B], ["activity_switch", t("12:30"), A], ["activity_switch", t("12:50"), B], ["end_day", t("14:33")]]);
      await sendEvents(server, e, switchEvents);
      await tick();
      const rs = await rows(e);
      check(rs.every((r) => !r.deleted_at), "8: discarded segments deleted, not soft-deleted", describe(rs));
      check(overlaps(rs).length === 0, "8: no overlap", overlaps(rs));
      const w = live(rs).filter((r) => r.entry_type === "work");
      check(
        w.length === 2 && w[0].activity_id === A && sameInstant(w[0].ended_at, t("12:00")) && w[1].activity_id === B && sameInstant(w[1].started_at, t("13:00")),
        "8: A ends 12:00, B (the job at 12:50) continues from 13:00",
        describe(rs)
      );
      switchEmp = e;
    }

    // 9) Sync receipts survive the removal: a full replay is all duplicates
    //    and changes nothing.
    if (switchEmp) {
      const before = describe(await rows(switchEmp));
      const replay = await sendEvents(server, switchEmp, switchEvents);
      check(replay.results.every((r) => r.status === "duplicate"), "9: replay = duplicates", replay.results);
      check(describe(await rows(switchEmp)) === before, "9: replay changes nothing", describe(await rows(switchEmp)));
      const { rows: rc } = await pool.query(`select count(*)::int as n, count(time_entry_id)::int as linked from mobile_time_events where employee_id = $1`, [switchEmp.id]);
      check(rc[0].n === 5 && rc[0].linked < 5, "9: every receipt kept; removed segments' pointers cleared", rc[0]);
    }

    // 10) A supervisor-entered entry in the window: never overwritten.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A], ["end_day", t("12:10")]]);
      await pool.query(
        `insert into time_entries (employee_id, entry_type, activity_id, started_at, ended_at, idempotency_key, created_by_employee_id, creation_reason)
         values ($1, 'work', $2, $3, $4, $5, $6, 'QA supervisor entry')`,
        [e.id, A, t("12:10"), t("16:30"), randomUUID(), admin.id]
      );
      await tick();
      const lunch = (await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00")));
      check(lunch.length === 0, "10: no automatic lunch over a supervisor's entry", describe(await rows(e)));
      check((await occ(e))[1].last_check_reason === "protected_record", "10: reason recorded", await occ(e));
      const rv = (await reviewList(e)).find((r) => r.reason === "protected_record");
      check(!!rv && /entered by a supervisor/.test(rv.message), "10: shown in Breaks to review with the reason", await reviewList(e));
    }

    // 11) An existing break in the window (e.g. entered in Inputs): left alone.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, FULL_DAY);
      await pool.query(
        `insert into time_entries (employee_id, entry_type, started_at, ended_at, idempotency_key, is_paid, created_by_employee_id, creation_reason)
         values ($1, 'break', $2, $3, $4, false, $5, 'QA supervisor entry')`,
        [e.id, t("12:30"), t("12:40"), randomUUID(), admin.id]
      );
      await tick();
      const lunch = (await breaks(e)).filter((x) => +x.started_at >= +new Date(t("12:00")) && +x.started_at < +new Date(t("13:00")));
      check(lunch.length === 1 && sameInstant(lunch[0].started_at, t("12:30")), "11: only the existing break, no full lunch on top", describe(await rows(e)));
    }

    // 12) A segment linked to a bin completion, or corrected by a supervisor:
    //     never removed; that lunch is skipped.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A], ["activity_switch", t("12:20"), B], ["activity_switch", t("12:40"), A], ["end_day", t("16:33")]]);
      const seg = live(await rows(e)).find((r) => r.activity_id === B)!;
      const carrier = (await pool.query(`insert into carriers (name) values ($1) returning id`, [`QA SB Bin ${randomUUID()}`])).rows[0].id;
      const cc = (await pool.query(`insert into carrier_completions (carrier_id, confirmed_by_employee_id) values ($1, $2) returning id`, [carrier, admin.id])).rows[0].id;
      await pool.query(`insert into carrier_completion_segments (time_entry_id, carrier_completion_id) values ($1, $2)`, [seg.id, cc]);
      await tick();
      const rs = await rows(e);
      check(rs.some((r) => r.id === seg.id && !r.deleted_at && sameInstant(r.started_at, t("12:20"))), "12: the completion-linked segment is untouched", describe(rs));
      check((await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00"))).length === 0, "12: lunch skipped", describe(rs));
      const rv = (await reviewList(e)).find((r) => r.reason === "protected_record");
      check(!!rv && /12:20 PM–12:40 PM is linked to a bin completion/.test(rv.message), "12: shown in Breaks to review: linked to a bin completion", await reviewList(e));
    }

    // 13) Supervisor deleted an automatic break: it never comes back.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, FULL_DAY);
      await tick();
      const lunch = (await breaks(e)).find((x) => sameInstant(x.started_at, t("12:00")))!;
      const del = await inputs(server, admin.token, "POST", `/breaks/${lunch.id}/delete`, {});
      check(del.status === 200, "13: supervisor deletes the automatic lunch", del);
      await tick();
      await tick("23:00");
      check((await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00"))).length === 0, "13: it is not re-added", describe(await rows(e)));
      // A late employee tap for that same lunch doesn't silently restore the
      // scheduled break either: it is an ordinary break at the real times.
      await direct(server, e, "/time-entries/break/start", { clientStartedAt: t("12:10") });
      const again = (await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00")));
      check(again.length === 0, "13: the deleted scheduled lunch doesn't reappear from a late tap", describe(await rows(e)));
      check((await reviewList(e)).some((r) => r.reason === "tap_after_supervisor_removed" && /a supervisor had deleted Lunch/.test(r.message)), "13: the late tap is shown in Breaks to review", await reviewList(e));
    }

    // 14) Forgot Break, phone offline: open work covering the window is
    //     enough (no later phone event needed). The phone then syncs "left at
    //     12:20": the automatic lunch is undone exactly and the day decided
    //     again; the morning break stays. A retry of that batch changes
    //     nothing.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("13:02");
      let rs = await rows(e);
      const b = await breaks(e);
      check(b.length === 2 && sameInstant(b[0].started_at, t("10:00")) && sameInstant(b[1].started_at, t("12:00")) && sameInstant(b[1].ended_at, t("13:00")), "14: morning and lunch added while work is still open", describe(rs));
      check(overlaps(rs).length === 0 && live(rs).filter((r) => r.ended_at === null).length === 1, "14: no overlap, one open entry", describe(rs));
      const lunchOcc = (await occFull(e))[1];
      check(lunchOcc.status === "auto_added" && lunchOcc.auto_after_entry_id !== null && lunchOcc.auto_before_entry_id !== null, "14: the split is recorded so it can be undone", lunchOcc);
      check((await reviewList(e)).length === 0, "14: nothing to review", await reviewList(e));

      const late = makeEvents(e, [["end_day", t("12:20")]]);
      const res = await sendEvents(server, e, late);
      check(res.results.every((r) => r.status === "accepted"), "14: the delayed Finish Work is accepted", res.results);
      rs = await rows(e);
      const work = live(rs).filter((r) => r.entry_type === "work");
      check(
        (await breaks(e)).length === 1 && work.length === 2 && sameInstant(work[0].ended_at, t("10:00")) && sameInstant(work[1].started_at, t("10:15")) && sameInstant(work[1].ended_at, t("12:20")),
        "14: lunch removed; worked 07:00-10:00, 10:15-12:20",
        describe(rs)
      );
      check(rs.every((r) => !r.deleted_at) && overlaps(rs).length === 0, "14: nothing soft-deleted, no overlap", describe(rs));
      check(await receiptsIntact(e, 2), "14: sync receipts kept, none dangling");
      const o = (await occFull(e))[1];
      check(o.status !== "auto_added" && o.last_check_reason === "ended_before_window_end" && o.reversal?.event === "end_day", "14: lunch decided again: work ended before 13:00", o);
      const rv = await reviewList(e);
      check(
        rv.length === 1 && rv[0].reason === "ended_before_window_end" && /removed when the phone's delayed Finish Work at 12:20 PM synced/.test(rv[0].message),
        "14: shown in Breaks to review, saying the automatic lunch was removed",
        rv
      );
      const before = describe(await rows(e));
      const retry = await sendEvents(server, e, late);
      check(retry.results.every((r) => r.status === "duplicate") && describe(await rows(e)) === before, "14: a retry of the batch is a duplicate and changes nothing", retry.results);
      await tick("17:00");
      check(describe(await rows(e)) === before, "14: a later tick changes nothing", describe(await rows(e)));
    }

    // 15) Tap arriving after the automatic break (offline phone): reconciled,
    //     never a second break; a stale End Break opens no work.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A], ["activity_switch", t("13:30"), B], ["end_day", t("16:33")]]);
      await tick();
      check((await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00"))).length === 1, "15: lunch added automatically", describe(await rows(e)));
      const before = live(await rows(e)).length;
      await direct(server, e, "/time-entries/break/start", { clientStartedAt: t("12:10") });
      await direct(server, e, "/time-entries/break/end", { clientEndedAt: t("12:50") });
      const rs = await rows(e);
      const lunch = live(rs).filter((x) => x.entry_type === "break" && sameInstant(x.started_at, t("12:00")));
      check(lunch.length === 1 && live(rs).length === before, "15: still one lunch, nothing added", describe(rs));
      check(lunch[0].source === "manual" && sameInstant(lunch[0].actual_started_at, t("12:10")) && sameInstant(lunch[0].actual_ended_at, t("12:50")), "15: the break now records the employee's taps", lunch[0]);
      check(live(rs).every((r) => r.ended_at !== null), "15: no work reopened by the stale End Break", describe(rs));
      const o = await occ(e);
      check(o[1].status === "tapped", "15: occurrence marked as tapped", o[1]);
    }

    // 16) Turned on mid-day: only windows starting after that apply.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true, autoFrom: t("12:30") });
      await sync(server, e, FULL_DAY);
      await tick();
      const b = await breaks(e);
      check(b.length === 1 && sameInstant(b[0].started_at, t("15:00")), "16: only the afternoon break (lunch started before it was turned on)", describe(await rows(e)));
    }

    // 17) Turned on now: never backfills earlier days.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true, autoFrom: new Date().toISOString() });
      await sync(server, e, FULL_DAY);
      await tick();
      await runAutoBreakTick(new Date(), 60 * 1000);
      check((await breaks(e)).length === 0, "17: no break added on an earlier day", describe(await rows(e)));
    }

    // 18) Snapshots: a profile edit after a window started can't change it;
    //     a schedule edited before any snapshot isn't applied backwards.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("12:10")]]);
      await pool.query(`update break_profile_items set end_time = '13:30', updated_at = now() where id = $1`, [p.itemIds[1]]);
      await sync(server, e, [["break_end", t("12:50")], ["end_day", t("16:33")]]);
      const lunch = (await breaks(e)).find((x) => sameInstant(x.started_at, t("12:00")));
      check(!!lunch && sameInstant(lunch.ended_at, t("13:00")), "18: the started lunch keeps its frozen 13:00 end", describe(await rows(e)));

      const p2 = await createProfile();
      await pool.query(`update break_profile_items set updated_at = now() where break_profile_id = $1`, [p2.id]);
      const e2 = await createEmployee(p2.id);
      await sync(server, e2, [["work_start", t("06:58"), A], ["break_start", t("12:10")], ["break_end", t("12:50")], ["end_day", t("16:33")]]);
      const b2 = await breaks(e2);
      check(b2.length === 1 && sameInstant(b2[0].started_at, t("12:10")) && b2[0].break_occurrence_id === null, "18: schedule edited after the day: real tap times, not today's schedule", describe(await rows(e2)));
    }

    // 19) Opening Inputs for any day writes nothing.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, FULL_DAY);
      const count = async () =>
        (
          await pool.query(
            `select (select count(*) from time_entries where employee_id = $1)::int as te,
                    (select count(*) from break_occurrences where employee_id = $1)::int as bo,
                    (select coalesce(max(greatest(started_at, coalesce(ended_at, started_at))), 'epoch') from time_entries where employee_id = $1) as latest`,
            [e.id]
          )
        ).rows[0];
      const before = await count();
      const r1 = await inputs(server, admin.token, "GET", `/daily?employeeId=${e.id}&date=${D}`);
      const r2 = await inputs(server, admin.token, "GET", `/daily?employeeId=${e.id}&date=${calendarDateInAppTimezone(new Date())}`);
      check(r1.status === 200 && r2.status === 200, "19: Inputs daily loads", { a: r1.status, b: r2.status });
      check(JSON.stringify(await count()) === JSON.stringify(before), "19: no rows created or changed by reading Inputs", { before, after: await count() });
    }

    // 20) Paid scheduled breaks: added, and not deducted from pay.
    {
      const p = await createProfile(FULL_BREAKS.map((i) => ({ ...i, isPaid: true })));
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, FULL_DAY);
      await tick();
      const b = await breaks(e);
      check(b.length === 3 && b.every((x) => x.is_paid === true), "20: paid breaks added as paid", b.map((x) => x.is_paid));
      check(paidHours(await rows(e), D) === 9.5, "20: paid 07:00-16:30 = 9.5 h", paidHours(await rows(e), D));
    }

    // 21) No profile: Auto breaks on does nothing.
    {
      const e = await createEmployee(null, { autoBreaks: true });
      await sync(server, e, FULL_DAY);
      await tick();
      check((await breaks(e)).length === 0 && (await occ(e)).length === 0, "21: no profile, no breaks", describe(await rows(e)));
    }

    // 22) Pending occurrences older than yesterday expire, never added.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      const old = addDaysToDateStr(D, -3);
      await sync(server, e, [["work_start", at(old, "06:58"), A], ["end_day", at(old, "16:33")]]);
      await ensureOccurrences(pool, e.id, old, new Date(at(old, "17:00")));
      await tick();
      const { rows: o } = await pool.query(`select status from break_occurrences where employee_id = $1 and scheduled_date = $2`, [e.id, old]);
      check(o.length === 3 && o.every((x) => x.status === "expired"), "22: expired after the recovery window", o);
      check((await breaks(e)).length === 0, "22: nothing added late", describe(await rows(e)));
      const { rows: rv } = await pool.query(`select review_reason from break_occurrences where employee_id = $1 and scheduled_date = $2`, [e.id, old]);
      check(rv.length === 3 && rv.every((x) => x.review_reason === "recovery_window_passed"), "22: each worked-through break is flagged for review", rv);
    }

    // 23) Toronto DST: windows keep their wall-clock times on both transition days.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      for (const [day, lunchUtc] of [["2026-03-08", "2026-03-08T16:00:00.000Z"], ["2026-11-01", "2026-11-01T17:00:00.000Z"], ["2026-03-07", "2026-03-07T17:00:00.000Z"]]) {
        await ensureOccurrences(pool, e.id, day, new Date(`${day}T23:00:00Z`));
        const { rows: r } = await pool.query(
          `select scheduled_start, scheduled_end from break_occurrences where employee_id = $1 and scheduled_date = $2 and break_profile_item_id = $3`,
          [e.id, day, p.itemIds[1]]
        );
        check(r[0] && new Date(r[0].scheduled_start).toISOString() === lunchUtc && +r[0].scheduled_end - +r[0].scheduled_start === 3600000, `23: ${day} lunch at 12:00 Toronto`, r[0]);
      }
    }

    // 24) Payroll: an unpaid break outside the work span is deducted only on
    //     or after the payroll_settings date; earlier days keep the old rule.
    {
      const entries = [
        { entryType: "break" as const, startedAt: new Date(t("12:00")), endedAt: new Date(t("12:30")), isPaid: false },
        { entryType: "work" as const, startedAt: new Date(t("12:30")), endedAt: new Date(t("16:30")), isPaid: null },
        { entryType: "break" as const, startedAt: new Date(t("15:00")), endedAt: new Date(t("15:15")), isPaid: false },
        { entryType: "break" as const, startedAt: new Date(t("15:10")), endedAt: new Date(t("15:20")), isPaid: false },
      ];
      const oldRule = computeWorkdayTotals(entries, new Date(), { unpaidBreakSpanClipFrom: addDaysToDateStr(D, 1) });
      const newRule = computeWorkdayTotals(entries, new Date(), { unpaidBreakSpanClipFrom: D });
      check(oldRule.workedSeconds === (4 * 3600 - 30 * 60 - 20 * 60), "24: before the date: whole break deducted (old rule)", oldRule);
      check(newRule.workedSeconds === (4 * 3600 - 20 * 60), "24: from the date: only the in-span part, overlaps once", newRule);
      const { rows: ps } = await pool.query(`select to_char(unpaid_break_span_clip_from, 'YYYY-MM-DD') as d from payroll_settings`);
      check(!!ps[0]?.d && ps[0].d <= calendarDateInAppTimezone(new Date()), "24: migration set the date to the day it ran", ps[0]);
    }

    // 25) Forgot Break and Finish Work: lunch is added while the shift is
    //     still open and stays after the midnight cut-off closes it. A
    //     Finish Work from that phone arriving after the cut-off can't undo
    //     it (the shift is closed): flagged, and the phone's sync goes on.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("13:02");
      check((await breaks(e)).some((x) => sameInstant(x.started_at, t("12:00"))), "25: lunch added with the shift open", describe(await rows(e)));
      await reconcileMidnightCutoff(e.id);
      await tick("23:30");
      const rs = await rows(e);
      check(live(rs).every((r) => r.ended_at !== null) && (await breaks(e)).length === 3, "25: cut-off closed the shift; all three breaks stay", describe(rs));
      const res = await sync(server, e, [["end_day", t("12:40")], ["work_start", at(addDaysToDateStr(D, 1), "06:58"), A]]);
      check(res.results.every((r) => r.status === "accepted"), "25: the delayed events are accepted; sync doesn't stall", res.results);
      check((await breaks(e)).some((x) => sameInstant(x.started_at, t("12:00"))), "25: lunch kept", describe(await rows(e)));
      const rv = (await reviewList(e)).find((r) => r.reason === "late_event_conflict" && /Lunch/.test(r.message));
      check(!!rv && /Finish Work at 12:40 PM synced after Lunch .* had already been closed/.test(rv.message), "25: the conflict is shown in Breaks to review", await reviewList(e));
    }

    // 26) Breaks added while the phone was offline, then its taps arrive in
    //     separate batches: the tapped lunch takes the occurrence over (the
    //     full 12:00-13:00), the other two are added again, one break per
    //     window, 8 h paid, nothing to review.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("17:00");
      check((await breaks(e)).length === 3, "26: three breaks added while offline", describe(await rows(e)));
      await sync(server, e, [["break_start", t("12:10")]]);
      await sync(server, e, [["break_end", t("12:50")]]);
      await sync(server, e, [["end_day", t("16:33")]]);
      await tick("17:05");
      const rs = await rows(e);
      const b = await breaks(e);
      check(b.length === 3 && b[1].source === "manual" && sameInstant(b[1].started_at, t("12:00")) && sameInstant(b[1].ended_at, t("13:00")), "26: lunch is the employee's tap, full window", describe(rs));
      check(b[0].source === "auto" && b[2].source === "auto", "26: morning and afternoon added again", b.map((x) => x.source));
      check(overlaps(rs).length === 0 && rs.every((r) => !r.deleted_at), "26: no overlap, nothing soft-deleted", describe(rs));
      check(paidHours(rs, D) === 8, "26: paid 8 h", paidHours(rs, D));
      const o = await occFull(e);
      check(o[0].status === "auto_added" && o[1].status === "tapped" && o[2].status === "auto_added", "26: statuses", o.map((x) => x.status));
      check((await reviewList(e)).length === 0, "26: nothing to review", await reviewList(e));
      check(await receiptsIntact(e, 4), "26: receipts intact");
    }

    // 27) A job change during lunch arrives late and nothing after it: lunch
    //     waits (undoing it later would need the deleted segments), shown in
    //     Breaks to review. The phone's Finish Work, in a later sync, adds it:
    //     A ends 12:00, B continues from 13:00.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("13:02");
      await sync(server, e, [["activity_switch", t("12:30"), B]]);
      let rs = await rows(e);
      check(!(await breaks(e)).some((x) => sameInstant(x.started_at, t("12:00"))), "27: lunch undone by the late job change", describe(rs));
      const w = live(rs).filter((r) => r.entry_type === "work");
      check(w.some((r) => r.activity_id === A && sameInstant(r.ended_at, t("12:30"))) && w.some((r) => r.activity_id === B && sameInstant(r.started_at, t("12:30")) && r.ended_at === null), "27: A until 12:30, B from 12:30", describe(rs));
      let rv = await reviewList(e);
      check(rv.some((r) => r.reason === "waiting_for_shift_end" && /not added yet/.test(r.message)), "27: waiting, shown in Breaks to review", rv);
      await sync(server, e, [["end_day", t("16:33")]]);
      await tick("17:00");
      rs = await rows(e);
      const lunch = (await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00")));
      check(lunch.length === 1 && lunch[0].source === "auto", "27: lunch added once the shift ended", describe(rs));
      const w2 = live(rs).filter((r) => r.entry_type === "work");
      check(w2.some((r) => r.activity_id === A && sameInstant(r.ended_at, t("12:00"))) && w2.some((r) => r.activity_id === B && sameInstant(r.started_at, t("13:00"))), "27: A ends 12:00, B resumes 13:00", describe(rs));
      check(overlaps(rs).length === 0 && rs.every((r) => !r.deleted_at), "27: no overlap, nothing soft-deleted", describe(rs));
      rv = await reviewList(e);
      check(!rv.some((r) => r.reason === "waiting_for_shift_end"), "27: no longer listed", rv);
    }

    // 28) A late job change before the window: lunch is undone and added
    //     again, now resuming the job the employee really had (B).
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("10:58"), A]]);
      await tick("13:02");
      await sync(server, e, [["activity_switch", t("11:30"), B]]);
      const rs = await rows(e);
      const lunch = (await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00")));
      const w = live(rs).filter((r) => r.entry_type === "work");
      check(lunch.length === 1 && w.length === 3 && w[2].activity_id === B && sameInstant(w[2].started_at, t("13:00")) && w[2].ended_at === null, "28: lunch again, B resumes at 13:00", describe(rs));
      check(sameInstant(w[0].ended_at, t("11:30")) && w[1].activity_id === B && sameInstant(w[1].started_at, t("11:30")) && sameInstant(w[1].ended_at, t("12:00")), "28: A until 11:30, B 11:30-12:00", describe(rs));
      check(overlaps(rs).length === 0 && (await reviewList(e)).length === 0, "28: no overlap, nothing to review", describe(rs));
    }

    // 29) A supervisor edited the day after the automatic lunch: a delayed
    //     Finish Work or job change can't undo it. The event is rejected as a
    //     conflict (the phone's sync carries on), the day stays exactly as
    //     recorded (the corrected entry keeps its job and stays open), and
    //     the conflict is flagged.
    for (const kind of ["end_day", "activity_switch"] as const) {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("13:02");
      const lunchOcc = (await occFull(e))[1];
      await pool.query(
        `insert into time_entry_corrections (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, $3, 'started_at', $4, $4, 'QA supervisor check')`,
        [lunchOcc.auto_after_entry_id, e.id, admin.id, t("13:00")]
      );
      const dayBefore = describe(await rows(e));
      const res = await sync(server, e, kind === "end_day" ? [["end_day", t("12:40")]] : [["activity_switch", t("12:30"), B]]);
      check(res.results.length === 1 && res.results[0].status === "permanent_conflict", `29 ${kind}: rejected as a conflict, sync carries on`, res.results);
      const more = await sync(server, e, [["activity_switch", t("14:00"), B]]);
      check(more.results[0]?.status === "accepted", `29 ${kind}: the phone's next event applies`, more.results);
      const rs = await rows(e);
      const corrected = rs.find((r) => r.id === lunchOcc.auto_after_entry_id)!;
      check(corrected.activity_id === A && sameInstant(corrected.started_at, t("13:00")) && sameInstant(corrected.ended_at, t("14:00")), `29 ${kind}: the corrected entry keeps its job and times`, describe(rs));
      check(dayBefore.startsWith(describe(rs).split(", work 13:00:00")[0]), `29 ${kind}: nothing before it changed`, { dayBefore, after: describe(rs) });
      check((await breaks(e)).some((x) => sameInstant(x.started_at, t("12:00")) && x.source === "auto"), `29 ${kind}: lunch kept`, describe(rs));
      check(live(rs).every((r) => r.ended_at === null || +r.ended_at > +r.started_at), `29 ${kind}: no entry ends before it starts`, describe(rs));
      const rv = await reviewList(e);
      check(rv.some((r) => r.reason === "late_event_conflict" && /supervisor has edited/.test(r.message)), `29 ${kind}: conflict shown in Breaks to review`, rv);
    }

    // 33) A stale Finish Work from an earlier day (another phone, or an old
    //     queue) never undoes or flags today's automatic break.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("10:20");
      const before = describe(await rows(e));
      check((await breaks(e)).length === 1, "33: morning added, shift open", before);
      await sync(server, e, [["end_day", at(addDaysToDateStr(D, -1), "17:00")]]);
      check((await occFull(e))[0].status === "auto_added", "33: today's morning break untouched", await occFull(e));
      // (The stale Finish Work itself still closes today's open entry 1 s
      // after its start: the existing work-end rounding fallback, unchanged
      // by this PR and reported separately.)
      check(describe(await rows(e)).startsWith("work 07:00:00-10:00:00, break 10:00:00-10:15:00, work 10:15:00-"), "33: today's break and the work around it unchanged", describe(await rows(e)));
      check(!(await reviewList(e)).some((r) => r.reason === "late_event_conflict"), "33: nothing flagged", await reviewList(e));
    }

    // 30) Confirming a review: needs Inputs access, a reason and the
    //     confirmation; records who and why; changes no time entry; and Auto
    //     breaks stops checking it (the supervisor's decision stands even if
    //     the shift later ends normally).
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("13:02");
      await sync(server, e, [["activity_switch", t("12:30"), B]]);
      const item = (await reviewList(e)).find((r) => r.reason === "waiting_for_shift_end");
      check(!!item, "30: a waiting lunch to review", await reviewList(e));
      const snapshot = async () =>
        JSON.stringify((await rows(e)).map((r) => [r.id, r.entry_type, r.started_at, r.ended_at, r.is_paid, r.deleted_at]));
      const before = await snapshot();
      const empRole = (await pool.query(`select id from employees where id = $1`, [e.id])).rows[0].id;
      const employeeToken = signSession({ id: empRole, firstName: "QA", lastName: "Emp", securityRole: "Employee", teamRole: "Team Member" });
      const denied = await inputs(server, employeeToken, "POST", `/break-occurrences/${item.occurrenceId}/review`, { confirmed: true, reason: "Looks fine" });
      check(denied.status === 403, "30: an employee can't confirm", denied);
      const listDenied = await inputs(server, employeeToken, "GET", "/break-reviews");
      check(listDenied.status === 403, "30: an employee can't list reviews", listDenied.status);
      const noReason = await inputs(server, admin.token, "POST", `/break-occurrences/${item.occurrenceId}/review`, { confirmed: true, reason: "" });
      const noConfirm = await inputs(server, admin.token, "POST", `/break-occurrences/${item.occurrenceId}/review`, { reason: "Checked with the employee" });
      check(noReason.status === 422 && noConfirm.status === 422, "30: a reason and the confirmation are required", [noReason.status, noConfirm.status]);
      const ok = await inputs(server, admin.token, "POST", `/break-occurrences/${item.occurrenceId}/review`, { confirmed: true, reason: "Checked with the employee: no lunch" });
      check(ok.status === 200, "30: confirmed", ok);
      check((await snapshot()) === before, "30: confirming changed no time entry", { before, after: await snapshot() });
      const again = await inputs(server, admin.token, "POST", `/break-occurrences/${item.occurrenceId}/review`, { confirmed: true, reason: "Again" });
      check(again.status === 409, "30: can't confirm twice", again.status);
      const { rows: o } = await pool.query(`select status, review_confirmed_by_employee_id, review_confirm_note from break_occurrences where id = $1`, [item.occurrenceId]);
      check(o[0].status === "expired" && o[0].review_confirmed_by_employee_id === admin.id && o[0].review_confirm_note === "Checked with the employee: no lunch", "30: who and why recorded", o[0]);
      check(!(await reviewList(e)).some((r) => r.occurrenceId === item.occurrenceId), "30: no longer listed", await reviewList(e));
      await sync(server, e, [["end_day", t("16:33")]]);
      await tick("17:00");
      check(!(await breaks(e)).some((x) => sameInstant(x.started_at, t("12:00"))), "30: Auto breaks doesn't add it after the confirmation", describe(await rows(e)));
    }

    // 31) A delayed batch and a worker tick at the same moment: one
    //     consistent day (no lunch for someone who left at 12:20, no overlap,
    //     nothing left half-done).
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick("13:02");
      await Promise.all([sync(server, e, [["end_day", t("12:20")]]), tick("13:03"), tick("13:03")]);
      await tick("13:30");
      const rs = await rows(e);
      check(!(await breaks(e)).some((x) => sameInstant(x.started_at, t("12:00"))), "31: no lunch", describe(rs));
      check(overlaps(rs).length === 0 && live(rs).every((r) => r.ended_at !== null), "31: no overlap, shift closed", describe(rs));
      check((await occFull(e)).every((x) => x.status !== "reversed"), "31: nothing left undecided", (await occFull(e)).map((x) => x.status));
    }

    // 32) Today/yesterday recovery limit: an automatic lunch a week ago is
    //     still undone exactly when that phone's delayed Finish Work arrives.
    {
      const W = addDaysToDateStr(D, -4);
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", at(W, "06:58"), A]]);
      await runAutoBreakTick(new Date(at(W, "13:02")), 60 * 1000);
      check((await breaks(e)).some((x) => sameInstant(x.started_at, at(W, "12:00"))), "32: lunch added that day", describe(await rows(e)));
      await sync(server, e, [["end_day", at(W, "12:20")]]);
      const rs = await rows(e);
      check(!(await breaks(e)).some((x) => sameInstant(x.started_at, at(W, "12:00"))), "32: undone days later", describe(rs));
      check(live(rs).filter((r) => r.entry_type === "work").some((r) => sameInstant(r.ended_at, at(W, "12:20"))), "32: work ends 12:20", describe(rs));
      const { rows: o } = await pool.query(`select status, review_reason from break_occurrences where employee_id = $1 and scheduled_date = $2 order by scheduled_start`, [e.id, W]);
      check(o[1].status === "expired" && o[1].review_reason === "ended_before_window_end", "32: decided and flagged", o);
    }
  } finally {
    server.close();
  }
  const failed = summary("auto breaks");
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
