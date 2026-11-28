// Scheduled (fixed) breaks tapped on the phone, through the offline sync
// path the Android app uses (POST /api/mobile/sync/events):
//   - a matching tap records the full scheduled window, whatever the tap
//     times (12:10 -> 12:50 records 12:00-13:00);
//   - work inside the window before the tap is removed for good (no
//     soft-deleted segment), the job active at the tap resumes at the
//     scheduled end with its row, bin and density snapshot;
//   - returning early never creates future work, and tapping again can't
//     create a second, overlapping break;
//   - a late arrival is never charged break time before they arrived;
//   - retries, duplicate batches and concurrent requests never duplicate.
//
// Before this change, cases 1, 2, 3 and 5 reproduced the production defects
// found on 2026-11-28 (75 work/break overlaps from a deleted job segment,
// 88 overlaps from early returns, and a late arrival losing an extra hour).
//
// Run with: npm run test:scheduled-breaks
import "dotenv/config";
import { pool } from "../db";
import { addDaysToDateStr, calendarDateInAppTimezone, zonedWallTimeToUtc } from "../lib/timezone";
import {
  activities,
  at,
  check,
  createEmployee,
  createProfile,
  describe,
  live,
  local,
  makeEvents,
  me,
  overlaps,
  paidHours,
  rows,
  sameInstant,
  sendEvents,
  startServer,
  summary,
  sync,
} from "../lib/testSupport/scheduledBreakFixtures";

async function main() {
  const server = await startServer();
  const { A, B } = await activities();
  const DAY = addDaysToDateStr(calendarDateInAppTimezone(new Date()), -3);
  const t = (hhmm: string) => at(DAY, hhmm);

  try {
    // 1) Job switch inside the window, then Start Break (the deleted-job defect).
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("10:58"), A], ["activity_switch", t("12:05"), B], ["break_start", t("12:10")], ["break_end", t("12:58")], ["end_day", t("16:33")]]);
      const rs = await rows(e);
      const l = live(rs);
      check(rs.every((r) => !r.deleted_at), "1: no soft-deleted segment is left behind", describe(rs));
      check(overlaps(rs).length === 0, "1: no work/break overlap", overlaps(rs));
      const brk = l.filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].started_at, t("12:00")) && sameInstant(brk[0].ended_at, t("13:00")), "1: one break 12:00-13:00", describe(rs));
      const jobA = l.find((r) => r.activity_id === A);
      check(!!jobA && sameInstant(jobA.ended_at, t("12:00")), "1: Job A ends 12:00", describe(rs));
      const jobB = l.filter((r) => r.activity_id === B);
      check(jobB.length === 1 && sameInstant(jobB[0].started_at, t("13:00")) && sameInstant(jobB[0].ended_at, t("16:30")), "1: Job B resumes at 13:00 (no 12:05-12:10 segment)", describe(rs));
      check(paidHours(rs, DAY) === 4.5, "1: paid 11:00-16:30 minus lunch = 4.5 h", paidHours(rs, DAY));
    }

    // 2) Early return, then Start Break again (the double-break defect).
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("12:00:30")], ["break_end", t("12:31")], ["break_start", t("12:31:30")], ["break_end", t("12:56")], ["end_day", t("16:33")]]);
      const rs = await rows(e);
      const brk = live(rs).filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].started_at, t("12:00")) && sameInstant(brk[0].ended_at, t("13:00")), "2: exactly one break 12:00-13:00", describe(rs));
      check(overlaps(rs).length === 0, "2: no overlapping records", overlaps(rs));
      check(rs.every((r) => !r.deleted_at), "2: nothing soft-deleted", describe(rs));
      const after = live(rs).filter((r) => r.entry_type === "work" && +r.started_at >= +new Date(t("12:00")));
      check(after.length === 1 && sameInstant(after[0].started_at, t("13:00")), "2: work resumes once, at 13:00", describe(rs));
    }

    // 3) Late arrival during lunch who then taps Start Break.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("12:20"), A], ["break_start", t("12:35")], ["break_end", t("12:59")], ["end_day", t("16:33")]]);
      const rs = await rows(e);
      const brk = live(rs).filter((r) => r.entry_type === "break");
      check(brk.length === 1 && +brk[0].started_at >= +new Date(t("12:30")), "3: the break never starts before the employee's (rounded) arrival", describe(rs));
      check(overlaps(rs).length === 0, "3: no overlap", overlaps(rs));
      check(rs.every((r) => !r.deleted_at), "3: nothing soft-deleted", describe(rs));
      check(paidHours(rs, DAY, DAY) === 3.5, "3: paid 13:00-16:30 = 3.5 h (no hour lost)", paidHours(rs, DAY, DAY));
    }

    // 4) Normal full day, tap times inside each window.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      const r = await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("10:01")], ["break_end", t("10:14")], ["break_start", t("12:10")], ["break_end", t("12:50")], ["break_start", t("15:01")], ["break_end", t("15:14")], ["end_day", t("16:33")]]);
      check(r.results.every((x) => x.status === "accepted"), "4: every event accepted", r.results);
      const rs = await rows(e);
      const brk = live(rs).filter((x) => x.entry_type === "break");
      check(
        brk.length === 3 &&
          sameInstant(brk[0].started_at, t("10:00")) && sameInstant(brk[0].ended_at, t("10:15")) &&
          sameInstant(brk[1].started_at, t("12:00")) && sameInstant(brk[1].ended_at, t("13:00")) &&
          sameInstant(brk[2].started_at, t("15:00")) && sameInstant(brk[2].ended_at, t("15:15")),
        "4: breaks recorded at their full scheduled times",
        describe(rs)
      );
      check(sameInstant(brk[1].actual_started_at, t("12:10")) && sameInstant(brk[1].actual_ended_at, t("12:50")), "4: the real tap times are kept", brk[1]);
      check(paidHours(rs, DAY) === 8, "4: paid 07:00-16:30 minus 1.5 h = 8 h", paidHours(rs, DAY));
      check(overlaps(rs).length === 0, "4: no overlap", overlaps(rs));
    }

    // 5) Several job switches inside the window before the tap.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("10:58"), A], ["activity_switch", t("12:05"), B], ["activity_switch", t("12:08"), A], ["activity_switch", t("12:09"), B], ["break_start", t("12:10")], ["break_end", t("12:58")], ["end_day", t("16:33")]]);
      const rs = await rows(e);
      check(rs.every((r) => !r.deleted_at), "5: discarded segments are removed, not soft-deleted", describe(rs));
      check(overlaps(rs).length === 0, "5: no overlap", overlaps(rs));
      const work = live(rs).filter((r) => r.entry_type === "work");
      check(work.length === 2 && sameInstant(work[0].ended_at, t("12:00")) && work[1].activity_id === B && sameInstant(work[1].started_at, t("13:00")), "5: A ends 12:00; the job at the tap (B) resumes 13:00", describe(rs));
    }

    // 6) Separate batches, retries, and a duplicate batch sent concurrently.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      const b1 = makeEvents(e, [["work_start", t("06:58"), A], ["break_start", t("12:10")]]);
      await sendEvents(server, e, b1);
      const b2 = makeEvents(e, [["break_end", t("12:50")], ["end_day", t("16:33")]]);
      const [x, y] = await Promise.all([sendEvents(server, e, b2), sendEvents(server, e, b2)]);
      const retry = await sendEvents(server, e, [...b1, ...b2]);
      check(retry.results.every((r) => r.status === "duplicate"), "6: a full replay is all duplicates", retry.results);
      check(x.results.length === 2 && y.results.length === 2, "6: both concurrent batches answered", { x: x.results, y: y.results });
      const rs = await rows(e);
      check(live(rs).filter((r) => r.entry_type === "break").length === 1, "6: one break only", describe(rs));
      check(live(rs).length === 3 && overlaps(rs).length === 0, "6: work / break / work, no overlap", describe(rs));
      const { rows: receipts } = await pool.query(`select count(*)::int as n from mobile_time_events where device_id = $1`, [e.deviceId]);
      check(receipts[0].n === 4, "6: one sync receipt per event", receipts[0]);
    }

    // 7) No profile: real tap times, no rounding, nothing snapped.
    {
      const e = await createEmployee(null);
      await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("12:02")], ["break_end", t("12:58")], ["end_day", t("16:33")]]);
      const rs = await rows(e);
      const brk = live(rs).filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].started_at, t("12:02")) && sameInstant(brk[0].ended_at, t("12:58")) && brk[0].break_occurrence_id === null, "7: tap times kept, no occurrence", describe(rs));
    }

    // 8) A tap outside every window is an ordinary break with its own times.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("13:10")], ["break_end", t("13:40")], ["end_day", t("16:33")]]);
      const rs = await rows(e);
      const brk = live(rs).filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].started_at, t("13:10")) && sameInstant(brk[0].ended_at, t("13:40")) && brk[0].break_occurrence_id === null, "8: ordinary break 13:10-13:40", describe(rs));
    }

    // 9) Finish Work during lunch ends the break at the tap.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("12:02")], ["end_day", t("12:20")]]);
      const rs = await rows(e);
      const brk = live(rs).filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].started_at, t("12:00")) && sameInstant(brk[0].ended_at, t("12:20")), "9: break 12:00-12:20, day ends", describe(rs));
      check(live(rs).every((r) => r.ended_at !== null), "9: nothing left open", describe(rs));
    }

    // 10) Early return, job change while still on lunch, finish before 13:00.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("06:58"), A], ["break_start", t("12:02")], ["break_end", t("12:30")], ["activity_switch", t("12:45"), B], ["end_day", t("12:50")]]);
      const rs = await rows(e);
      const l = live(rs);
      check(l.filter((r) => r.entry_type === "work" && +r.started_at >= +new Date(t("12:00"))).length === 0, "10: no work row inside or after the lunch (no 1-second row)", describe(rs));
      const brk = l.filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].ended_at, t("12:50")), "10: lunch ends when they finished", describe(rs));
      check(overlaps(rs).length === 0, "10: no overlap", overlaps(rs));
    }

    // 12) A segment inside the window already linked to a bin completion is
    //     never removed: the break starts after it.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      await sync(server, e, [["work_start", t("10:58"), A], ["activity_switch", t("12:03"), B], ["activity_switch", t("12:06"), A]]);
      const linked = live(await rows(e)).find((r) => r.activity_id === B)!;
      const admin = (await pool.query(`select id from employees where id <> $1 limit 1`, [e.id])).rows[0].id;
      const carrier = (await pool.query(`insert into carriers (name) values ($1) returning id`, [`QA SB Bin ${e.id}`])).rows[0].id;
      const cc = (await pool.query(`insert into carrier_completions (carrier_id, confirmed_by_employee_id) values ($1, $2) returning id`, [carrier, admin])).rows[0].id;
      await pool.query(`insert into carrier_completion_segments (time_entry_id, carrier_completion_id) values ($1, $2)`, [linked.id, cc]);
      await sync(server, e, [["break_start", t("12:10")], ["break_end", t("12:50")], ["end_day", t("16:33")]]);
      const rs = await rows(e);
      check(rs.some((r) => r.id === linked.id && !r.deleted_at && sameInstant(r.started_at, t("12:03")) && sameInstant(r.ended_at, t("12:06"))), "12: the completion-linked segment is untouched", describe(rs));
      const brk = live(rs).filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].started_at, t("12:06")) && sameInstant(brk[0].ended_at, t("13:00")), "12: the break starts after it, ends on schedule", describe(rs));
      check(overlaps(rs).length === 0, "12: no overlap", overlaps(rs));
    }

    // 13) A finished supervisor entry later in the window: the scheduled
    //     window can't be recorded without overwriting it, so the tap is an
    //     ordinary break at its real time and the supervisor's entry stays.
    {
      const p = await createProfile();
      const e = await createEmployee(p.id);
      const admin = (await pool.query(`select id from employees where id <> $1 limit 1`, [e.id])).rows[0].id;
      await sync(server, e, [["work_start", t("10:58"), A]]);
      await pool.query(
        `insert into time_entries (employee_id, entry_type, activity_id, started_at, ended_at, idempotency_key, created_by_employee_id, creation_reason)
         values ($1, 'work', $2, $3, $4, gen_random_uuid(), $5, 'QA supervisor entry')`,
        [e.id, B, t("12:30"), t("12:40"), admin]
      );
      await sync(server, e, [["break_start", t("12:10")]]);
      const rs = await rows(e);
      const brk = live(rs).filter((r) => r.entry_type === "break");
      check(brk.length === 1 && sameInstant(brk[0].started_at, t("12:10")) && brk[0].break_occurrence_id === null, "13: ordinary break at the tap", describe(rs));
      check(live(rs).some((r) => r.created_by_employee_id && sameInstant(r.started_at, t("12:30")) && sameInstant(r.ended_at, t("12:40"))), "13: the supervisor's entry is untouched", describe(rs));
    }

    // 11) Live: on lunch now, End Break early — the server keeps them on
    //     lunch until the scheduled end and /me says so; repeated taps are
    //     harmless; nothing is recorded in the future.
    {
      const now = new Date();
      const nowLocal = calendarDateInAppTimezone(now);
      const startMs = Math.floor(now.getTime() / 60000) * 60000 - 10 * 60000;
      const endMs = startMs + 60 * 60000;
      if (calendarDateInAppTimezone(new Date(startMs - 3 * 3600000)) === nowLocal && calendarDateInAppTimezone(new Date(endMs)) === nowLocal) {
        const hhmm = (ms: number) => local(new Date(ms));
        const p = await createProfile([{ start: hhmm(startMs), end: hhmm(endMs), name: "Lunch" }], false);
        const e = await createEmployee(p.id);
        const iso = (ms: number) => new Date(ms).toISOString();
        await sync(server, e, [["work_start", iso(startMs - 2 * 3600000), A], ["break_start", iso(startMs + 5 * 60000)], ["break_end", iso(now.getTime() - 1000)]]);
        let status = await me(server, e);
        check(status.status === "break", "11: still on lunch after an early End Break", status.status);
        check(status.scheduledBreak && sameInstant(status.scheduledBreak.endsAt, iso(endMs)) && status.scheduledBreak.resumeRequested === true, "11: /me reports the scheduled end and the pending resume", status.scheduledBreak);
        check(status.scheduledBreak?.resume?.activityId === A, "11: resumes the same job", status.scheduledBreak);
        await sync(server, e, [["break_start", iso(now.getTime() - 500)], ["break_end", iso(now.getTime())]]);
        const rs = await rows(e);
        check(live(rs).filter((r) => r.entry_type === "break").length === 1, "11: repeated taps add no break", describe(rs));
        check(live(rs).every((r) => +r.started_at <= Date.now()), "11: nothing starts in the future", describe(rs));
        status = await me(server, e);
        check(status.status === "break" && sameInstant(status.since, iso(startMs)), "11: the break timer keeps counting from the scheduled start", status);
      } else {
        console.log("11: skipped (window would cross local midnight)");
      }
    }
  } finally {
    server.close();
  }
  const failed = summary("scheduled breaks (sync path)");
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

void zonedWallTimeToUtc;
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
