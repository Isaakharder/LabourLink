// Pure-function tests for computeWorkdayTotals — no database, fast. Covers
// the reported bug (Reynaldo Dela Cruz, Aug 17 2026: corrected work start
// 6:45 AM, corrected work end 7:00 PM, one 1:00:00 unpaid lunch, Worked
// showed 11:13:52 instead of 11:15:00 because a ~68s untracked transition
// gap between two activities was silently excluded) and every requirement
// from that fix: transition gaps don't reduce Worked, paid breaks don't
// reduce Worked, overlapping unpaid breaks aren't double-subtracted, and
// the still-open-day path.
//
// Run with: npm run test:workday-totals
import { computeWorkdayTotals, groupByEmployeeDay, WorkdayBoundaryEntry } from "./workdayTotals";

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

// 2026-08-17 in America/Toronto (EDT, UTC-4) — plain UTC instants standing
// in for "already corrected/rounded, whatever they currently are" values;
// this function never cares about provenance, only the current stored
// timestamps.
function t(hh: number, mm: number, ss = 0): Date {
  return new Date(Date.UTC(2026, 7, 17, hh + 4, mm, ss));
}

function work(startedAt: Date, endedAt: Date | null): WorkdayBoundaryEntry {
  return { entryType: "work", startedAt, endedAt, isPaid: null };
}
function brk(startedAt: Date, endedAt: Date | null, isPaid: boolean | null): WorkdayBoundaryEntry {
  return { entryType: "break", startedAt, endedAt, isPaid };
}

function main() {
  // -----------------------------------------------------------------
  // 1) The exact reported scenario: 6:45 AM - 7:00 PM minus a one-hour
  //    unpaid lunch = 11:15:00, even with a transition gap elsewhere in
  //    the day that isn't covered by any break.
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [
      work(t(6, 45), t(17, 30)), // first activity block, ending 5:30 PM
      // 68-second UNTRACKED transition gap (5:30:00-5:31:08 PM) — no break
      // entry covers it, same shape as the real Reynaldo Aug 17 gap.
      work(t(17, 31, 8), t(18, 0)),
      brk(t(12, 0), t(13, 0), false), // 1-hour unpaid lunch
      work(t(18, 0), t(19, 0)),
    ];
    const totals = computeWorkdayTotals(entries);
    check(totals.workStartTime?.getTime() === t(6, 45).getTime(), "1) workStartTime is the earliest work entry's own started_at", totals.workStartTime);
    check(totals.workEndTime?.getTime() === t(19, 0).getTime(), "1) workEndTime is the latest entry's own ended_at", totals.workEndTime);
    check(totals.workedSeconds === 11 * 3600 + 15 * 60, `1) Worked = 11:15:00 (${totals.workedSeconds}s), matching (7:00 PM - 6:45 AM) - 1:00:00 unpaid lunch`, totals);
    check(totals.unpaidBreakSeconds === 3600, "1) unpaid break total is exactly the one recorded hour", totals.unpaidBreakSeconds);
  }

  // -----------------------------------------------------------------
  // 2) Transition gaps alone (no breaks at all) never reduce Worked — the
  //    employee remained clocked into the workday while switching
  //    activities.
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [
      work(t(8, 0), t(9, 0)),
      // 5-minute gap, no break recorded.
      work(t(9, 5), t(10, 0)),
      // 30-second gap, no break recorded.
      work(t(10, 0, 30), t(11, 0)),
    ];
    const totals = computeWorkdayTotals(entries);
    check(totals.workedSeconds === 3 * 3600, `2) Worked = the full 8:00-11:00 span (${totals.workedSeconds}s = 3h), transition gaps not subtracted`, totals);
  }

  // -----------------------------------------------------------------
  // 3) A paid break does not reduce Worked — it's implicitly still part
  //    of the span the employee is compensated for.
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [work(t(8, 0), t(9, 0)), brk(t(9, 0), t(9, 15), true), work(t(9, 15), t(12, 0))];
    const totals = computeWorkdayTotals(entries);
    const fullSpanSeconds = (t(12, 0).getTime() - t(8, 0).getTime()) / 1000;
    check(totals.workedSeconds === fullSpanSeconds, `3) Worked equals the FULL 8:00-12:00 span (${totals.workedSeconds}s) — the paid 15-min break never subtracted`, totals);
    check(totals.paidBreakSeconds === 900, "3) paid break total is still recorded (informational), just not deducted", totals.paidBreakSeconds);
  }

  // -----------------------------------------------------------------
  // 4) Multiple/overlapping unpaid breaks are not double-subtracted — a
  //    duplicate/glitch data shape (the same class of bug the Aug 17
  //    investigation itself started from: two overlapping activity
  //    entries) must never double-count the overlap against Worked.
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [
      work(t(8, 0), t(17, 0)),
      brk(t(12, 0), t(13, 0), false), // 12:00-1:00
      brk(t(12, 30), t(12, 45), false), // fully inside the first break — pure duplicate
      brk(t(12, 45), t(13, 15), false), // overlaps the tail of the first break by 15 min
    ];
    const totals = computeWorkdayTotals(entries);
    // Union of [12:00-13:00] and [12:45-13:15] = [12:00-13:15] = 75 minutes.
    check(totals.unpaidBreakSeconds === 75 * 60, `4) overlapping unpaid breaks are merged (union), not naively summed (${totals.unpaidBreakSeconds}s, expected 4500s = 75min, naive sum would be 5400s = 90min)`, totals);
    const fullSpanSeconds = (t(17, 0).getTime() - t(8, 0).getTime()) / 1000;
    check(totals.workedSeconds === fullSpanSeconds - 75 * 60, "4) Worked subtracts the deduplicated union once, not the naive (larger, double-counted) sum", totals);
  }

  // -----------------------------------------------------------------
  // 5) An unclassified/legacy break (is_paid null) is bucketed as unpaid,
  //    same convention as inputs.ts's own breakMeta — and still
  //    deduplicated the same way as an explicitly-unpaid break.
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [work(t(8, 0), t(9, 0)), brk(t(9, 0), t(9, 15), null), work(t(9, 15), t(10, 0))];
    const totals = computeWorkdayTotals(entries);
    check(totals.workedSeconds === 3600 + 2700, "5) an is_paid=null break is treated as unpaid (subtracted), not silently folded into Worked like a paid one", totals);
  }

  // -----------------------------------------------------------------
  // 5b) Break totals must still be correct even with NO work entry at all
  //     that day (e.g. an admin recorded a break before its surrounding
  //     work entries exist yet) — Worked is genuinely 0 (nothing to
  //     measure a span against), but paidBreakSeconds/unpaidBreakSeconds
  //     must not also collapse to 0 just because there's no work anchor.
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [brk(t(12, 0), t(12, 30), false), brk(t(15, 0), t(15, 15), true)];
    const totals = computeWorkdayTotals(entries);
    check(totals.workStartTime === null, "5b) workStartTime is null with no work entries", totals.workStartTime);
    check(totals.workedSeconds === 0, "5b) Worked is 0 — there's no work-anchored span to measure", totals.workedSeconds);
    check(totals.unpaidBreakSeconds === 30 * 60, "5b) the unpaid break's own 30 minutes is still correctly totaled", totals.unpaidBreakSeconds);
    check(totals.paidBreakSeconds === 15 * 60, "5b) the paid break's own 15 minutes is still correctly totaled", totals.paidBreakSeconds);
  }

  // -----------------------------------------------------------------
  // 6) Still-open day: the last entry has no end time. workEndTime is
  //    null, and Worked is computed against the supplied `now` (injected
  //    for a deterministic test — every real caller uses the real clock).
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [work(t(8, 0), t(9, 0)), work(t(9, 0), null)];
    const now = t(9, 30);
    const totals = computeWorkdayTotals(entries, now);
    check(totals.workEndTime === null, "6) workEndTime is null while the day is still open", totals.workEndTime);
    check(totals.workedSeconds === 90 * 60, "6) Worked so far uses `now` as the effective end (8:00-9:30 = 90 min)", totals.workedSeconds);
  }

  // -----------------------------------------------------------------
  // 7) The day can end mid-break (no work entry follows a completed
  //    break) — workEndTime is the break's own end, not the preceding
  //    work entry's, and the trailing break time itself is correctly
  //    excluded from Worked (it's unpaid).
  // -----------------------------------------------------------------
  {
    const entries: WorkdayBoundaryEntry[] = [work(t(8, 0), t(16, 0)), brk(t(16, 0), t(16, 30), false)];
    const totals = computeWorkdayTotals(entries);
    check(totals.workEndTime?.getTime() === t(16, 30).getTime(), "7) workEndTime is the trailing break's own end when nothing follows it", totals.workEndTime);
    check(totals.workedSeconds === 8 * 3600, "7) Worked is exactly the work portion (8:00-16:00); the trailing unpaid break is excluded", totals.workedSeconds);
  }

  // -----------------------------------------------------------------
  // 8) No work entries at all — every figure is a clean zero/null, never
  //    a crash or NaN.
  // -----------------------------------------------------------------
  {
    const totals = computeWorkdayTotals([]);
    check(totals.workStartTime === null && totals.workEndTime === null && totals.workedSeconds === 0, "8) an empty day produces all-zero/null totals", totals);
  }

  // -----------------------------------------------------------------
  // groupByEmployeeDay — the grouping helper Payroll uses to bucket raw
  // entries before calling computeWorkdayTotals per employee-day.
  // -----------------------------------------------------------------
  {
    const entries = [
      { employeeId: "emp-1", startedAt: t(8, 0) },
      { employeeId: "emp-1", startedAt: t(9, 0) },
      { employeeId: "emp-2", startedAt: t(8, 0) },
    ];
    const groups = groupByEmployeeDay(entries);
    check(groups.size === 2, "groupByEmployeeDay produces one group per distinct employee+calendar-date", [...groups.keys()]);
    check(groups.get("emp-1:2026-08-17")?.length === 2, "groupByEmployeeDay keeps both of emp-1's entries in the same group", groups.get("emp-1:2026-08-17"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
