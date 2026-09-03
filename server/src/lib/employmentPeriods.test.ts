// Pure logic for computePeriodStatuses — no database needed. See
// employmentPeriods.test.ts (routes) for the real-HTTP+DB coverage of
// overlap rejection, audit history, permissions, etc.
//
// Run with: npm run test:employment-periods-logic
import { addDaysToDateStr } from "./timezone";
import { computePeriodStatuses, FINISHING_SOON_WINDOW_DAYS, STARTING_SOON_WINDOW_DAYS } from "./employmentPeriods";

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

function statuses(startDate: string, expectedFinishDate: string | null, actualFinishDate: string | null) {
  return computePeriodStatuses({ startDate, expectedFinishDate, actualFinishDate }, TODAY);
}

// 1) Ongoing, open-ended: started in the past, no finish set at all.
check(
  JSON.stringify(statuses(addDaysToDateStr(TODAY, -30), null, null)) === JSON.stringify(["current"]),
  "1) an open-ended period that already started is exactly 'current'"
);

// 2) Future — starts after today, well outside the starting-soon window.
check(
  JSON.stringify(statuses(addDaysToDateStr(TODAY, 30), null, null)) === JSON.stringify(["future"]),
  "2) a period starting well in the future is exactly 'future'"
);

// 3) Starting-soon boundary — exactly STARTING_SOON_WINDOW_DAYS out is
//    included; one day beyond is not.
{
  const withinWindow = statuses(addDaysToDateStr(TODAY, STARTING_SOON_WINDOW_DAYS), null, null);
  check(withinWindow.includes("future") && withinWindow.includes("startingSoon"), "3) exactly at the starting-soon window boundary IS startingSoon", withinWindow);
  const beyondWindow = statuses(addDaysToDateStr(TODAY, STARTING_SOON_WINDOW_DAYS + 1), null, null);
  check(beyondWindow.includes("future") && !beyondWindow.includes("startingSoon"), "3b) one day beyond the starting-soon window is NOT startingSoon", beyondWindow);
}

// 4) Finishing-soon boundary — expected finish exactly at the window edge
//    vs. one day beyond, with no actual finish recorded.
{
  const withinWindow = statuses(addDaysToDateStr(TODAY, -10), addDaysToDateStr(TODAY, FINISHING_SOON_WINDOW_DAYS), null);
  check(withinWindow.includes("current") && withinWindow.includes("finishingSoon"), "4) exactly at the finishing-soon window boundary IS finishingSoon", withinWindow);
  const beyondWindow = statuses(addDaysToDateStr(TODAY, -10), addDaysToDateStr(TODAY, FINISHING_SOON_WINDOW_DAYS + 1), null);
  check(beyondWindow.includes("current") && !beyondWindow.includes("finishingSoon"), "4b) one day beyond the finishing-soon window is NOT finishingSoon", beyondWindow);
}

// 5) Overdue — expected finish already passed, no actual finish recorded.
{
  const s = statuses(addDaysToDateStr(TODAY, -60), addDaysToDateStr(TODAY, -1), null);
  check(s.includes("current") && s.includes("overdue"), "5) an expected finish that already passed with no actual finish IS overdue", s);
  check(!s.includes("finishingSoon"), "5b) an overdue period is not also flagged finishingSoon", s);
}

// 6) Completed — actual finish recorded in the past.
{
  const s = statuses(addDaysToDateStr(TODAY, -60), addDaysToDateStr(TODAY, -30), addDaysToDateStr(TODAY, -25));
  check(JSON.stringify(s) === JSON.stringify(["completed"]), "6) an actual finish in the past is exactly 'completed', not 'current'", s);
}

// 6b) Completed overrides overdue — actual finish recorded even though the
//     expected finish also already passed; overdue must NOT fire.
{
  const s = statuses(addDaysToDateStr(TODAY, -60), addDaysToDateStr(TODAY, -40), addDaysToDateStr(TODAY, -10));
  check(s.includes("completed") && !s.includes("overdue") && !s.includes("current"), "6c) recording an actual finish clears overdue/current even though the expected finish also passed", s);
}

// 7) Completed today (actual finish == today, inclusive) still reads as
//    completed, not current (today's date is the last day worked).
{
  const s = statuses(addDaysToDateStr(TODAY, -10), null, TODAY);
  check(s.includes("completed"), "7) an actual finish dated today is 'completed'", s);
}

// 8) A period completing exactly tomorrow is still 'current' today (finish
//    is inclusive — the employee is still working through that date).
{
  const s = statuses(addDaysToDateStr(TODAY, -10), null, addDaysToDateStr(TODAY, 1));
  check(JSON.stringify(s) === JSON.stringify(["current"]), "8) a period whose actual finish is tomorrow is still 'current' today", s);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
