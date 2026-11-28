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
      check((await occ(e))[1].last_check_reason !== null, "7: reason recorded", await occ(e));
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
      check((await occ(e))[1].last_check_reason === "supervisor_or_linked_record", "10: reason recorded", await occ(e));
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
    }

    // 14) Evidence: open work covering the window isn't enough until the
    //     phone's later activity has synced (an offline phone may still hold
    //     "finished at 12:20").
    {
      const p = await createProfile();
      const e = await createEmployee(p.id, { autoBreaks: true });
      await sync(server, e, [["work_start", t("06:58"), A]]);
      await tick();
      check((await breaks(e)).length === 0, "14: nothing added while the end is unknown", describe(await rows(e)));
      check((await occ(e))[1].last_check_reason === "awaiting_later_activity", "14: waiting for later activity", await occ(e));
      // The phone comes back with the truth: they left at 12:20.
      await sync(server, e, [["end_day", t("12:20")]]);
      await tick();
      check((await breaks(e)).filter((x) => sameInstant(x.started_at, t("12:00"))).length === 0, "14: no lunch for someone who left at 12:20", describe(await rows(e)));
      check((await breaks(e)).filter((x) => sameInstant(x.started_at, t("10:00"))).length === 1, "14: the morning break is added once the end is known", describe(await rows(e)));
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
