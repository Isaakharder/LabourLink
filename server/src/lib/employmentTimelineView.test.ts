// Pure logic for the Employment Timeline redesign's inclusion/labeling
// rules — no database needed. See employmentPeriods.test.ts (routes) for
// the real-HTTP+DB coverage that the GET /api/employment-periods endpoint
// actually applies these functions and excludes deactivated employees.
//
// Run with: npm run test:employment-timeline-view
import { addDaysToDateStr } from "./timezone";
import { computeTimelineBar, resolveEmployeeTimeline, TimelineEmployeeInput, TimelinePeriodInput } from "./employmentTimelineView";

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

const TODAY = "2026-06-15";

function period(overrides: Partial<TimelinePeriodInput> = {}): TimelinePeriodInput {
  return {
    id: "p1",
    startDate: addDaysToDateStr(TODAY, -365),
    expectedFinishDate: null,
    actualFinishDate: null,
    employmentType: "Permanent",
    workGroup: "Greenhouse",
    workGroupOtherDescription: null,
    notes: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function employee(overrides: Partial<TimelineEmployeeInput> = {}): TimelineEmployeeInput {
  return { id: "e1", isActive: true, startDate: addDaysToDateStr(TODAY, -365), workPermitExpiryDate: null, ...overrides };
}

// 1) Active permanent, no expected finish, no permit — Ongoing, extends to today.
{
  const bar = computeTimelineBar(period(), null, TODAY);
  check(bar.label === "ongoing" && bar.effectiveEndDate === TODAY, "1) active permanent with no end/expiry is 'ongoing', ending today", bar);
}

// 2) Active temporary with a future expected finish — Employed, ends at that date.
{
  const finish = addDaysToDateStr(TODAY, 30);
  const bar = computeTimelineBar(period({ employmentType: "Temporary", expectedFinishDate: finish }), null, TODAY);
  check(bar.label === "employed" && bar.effectiveEndDate === finish, "2) a future expected finish is 'employed', ending at that date", bar);
}

// 3) Future work-permit expiry with no expected finish — also "employed",
//    ending at the permit expiry (permit expiry counts as an applicable
//    "expiry" exactly like an expected finish would).
{
  const expiry = addDaysToDateStr(TODAY, 60);
  const bar = computeTimelineBar(period(), expiry, TODAY);
  check(bar.label === "employed" && bar.effectiveEndDate === expiry, "3) a future permit expiry with no expected finish still bounds the bar", bar);
}

// 4) Expected finish already passed, no actual finish recorded, employee
//    still active — "expiredStillWorking", extended to today (the explicit
//    "still working" choice is is_active remaining true).
{
  const bar = computeTimelineBar(period({ expectedFinishDate: addDaysToDateStr(TODAY, -10) }), null, TODAY);
  check(bar.label === "expiredStillWorking" && bar.effectiveEndDate === TODAY, "4) an overdue expected finish with no actual finish is 'expiredStillWorking'", bar);
}

// 5) Work permit already expired, no expected finish — same
//    "expiredStillWorking" outcome via the permit path.
{
  const bar = computeTimelineBar(period(), addDaysToDateStr(TODAY, -1), TODAY);
  check(bar.label === "expiredStillWorking" && bar.effectiveEndDate === TODAY, "5) an already-expired work permit alone triggers 'expiredStillWorking'", bar);
}

// 6) Confirmed actual finish is absolute — always "completed", even though
//    the expected finish also passed and even though (hypothetically) a
//    permit is still valid. Never re-extended.
{
  const bar = computeTimelineBar(
    period({ expectedFinishDate: addDaysToDateStr(TODAY, -40), actualFinishDate: addDaysToDateStr(TODAY, -35) }),
    addDaysToDateStr(TODAY, 400),
    TODAY
  );
  check(bar.label === "completed" && bar.effectiveEndDate === addDaysToDateStr(TODAY, -35), "6) a confirmed actual finish is absolute — 'completed', never overridden", bar);
}

// 7) Earlier-of-the-two precedence: expected finish and permit expiry both
//    set and disagree — the earlier one caps the bar, whichever it is.
{
  const earlierPermit = computeTimelineBar(period({ expectedFinishDate: addDaysToDateStr(TODAY, 90) }), addDaysToDateStr(TODAY, 30), TODAY);
  check(earlierPermit.label === "employed" && earlierPermit.effectiveEndDate === addDaysToDateStr(TODAY, 30), "7a) an earlier permit expiry caps a later expected finish", earlierPermit);

  const earlierExpected = computeTimelineBar(period({ expectedFinishDate: addDaysToDateStr(TODAY, 30) }), addDaysToDateStr(TODAY, 90), TODAY);
  check(earlierExpected.label === "employed" && earlierExpected.effectiveEndDate === addDaysToDateStr(TODAY, 30), "7b) an earlier expected finish caps a later permit expiry", earlierExpected);
}

// -- resolveEmployeeTimeline (inclusion + synthesis) ----------------------

// 8) Deactivated employee is excluded outright, regardless of their periods.
{
  const r = resolveEmployeeTimeline(employee({ isActive: false }), [period({ expectedFinishDate: addDaysToDateStr(TODAY, 30) })], TODAY);
  check(r.included === false && r.periods.length === 0, "8) a deactivated employee is excluded entirely, no exceptions", r);
}

// 9) Active employee with a real period — included, using the real period.
{
  const r = resolveEmployeeTimeline(employee(), [period()], TODAY);
  check(r.included === true && r.hasUsableDates === true && r.periods.length === 1 && r.periods[0].synthesized === false, "9) an active employee with a real period is included using that period", r);
}

// 10) Active employee, zero employment_periods rows, but a usable
//     employees.start_date — synthesize one virtual "ongoing" period from
//     it rather than showing a blank row.
{
  const start = addDaysToDateStr(TODAY, -100);
  const r = resolveEmployeeTimeline(employee({ startDate: start }), [], TODAY);
  check(
    r.included === true && r.hasUsableDates === true && r.periods.length === 1 && r.periods[0].synthesized === true && r.periods[0].startDate === start && r.periods[0].timelineLabel === "ongoing",
    "10) zero periods but a real start_date synthesizes one ongoing virtual period",
    r
  );
}

// 11) Active employee, zero employment_periods rows, AND no start_date —
//     nothing to draw a bar from; included but flagged as having no usable
//     dates (a "flagged row", not silently dropped, and not lumped in with
//     "expired"/"deactivated").
{
  const r = resolveEmployeeTimeline(employee({ startDate: null }), [], TODAY);
  check(r.included === true && r.hasUsableDates === false && r.periods.length === 0, "11) no start_date and no periods is included but flagged as having no usable dates", r);
}

// 12) Multiple periods (rehire history): an old, closed period keeps
//     reading as 'completed' regardless of the employee's current is_active
//     or a much-later permit expiry — only the un-finished period is
//     affected by permit-expiry capping.
{
  const oldClosed = period({ id: "old", startDate: "2018-01-01", actualFinishDate: "2018-06-30" });
  const currentOpen = period({ id: "current", startDate: "2026-01-01" });
  const r = resolveEmployeeTimeline(employee({ workPermitExpiryDate: addDaysToDateStr(TODAY, -5) }), [oldClosed, currentOpen], TODAY);
  const old = r.periods.find((p) => p.id === "old")!;
  const current = r.periods.find((p) => p.id === "current")!;
  check(old.timelineLabel === "completed" && old.timelineEffectiveEndDate === "2018-06-30", "12a) an old closed period stays 'completed' unaffected by a later expired permit", old);
  check(current.timelineLabel === "expiredStillWorking" && current.timelineEffectiveEndDate === TODAY, "12b) the current open period is capped by the expired permit", current);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
