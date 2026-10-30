// Pure logic for computeEmploymentStatuses — no database needed. The end is
// the End Different Date when entered, otherwise the Work Permit Expiry Date
// (same priority as the timeline bar). See employmentPeriods.test.ts
// (routes) for the real-HTTP+DB coverage.
//
// Run with: npm run test:employment-periods-logic
import { addDaysToDateStr } from "./timezone";
import { computeEmploymentStatuses, FINISHING_SOON_WINDOW_DAYS, STARTING_SOON_WINDOW_DAYS } from "./employmentPeriods";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const TODAY = "2026-06-15";
const d = (n: number) => addDaysToDateStr(TODAY, n);

function statuses(startDate: string, workPermitExpiryDate: string | null, endDifferentDate: string | null) {
  return computeEmploymentStatuses({ startDate, workPermitExpiryDate, endDifferentDate }, TODAY);
}
function eq(actual: unknown, expected: unknown, label: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, { actual, expected });
}

eq(statuses(d(-30), null, null), ["current"], "started, no ending dates: current");
eq(statuses(d(30), null, null), ["future"], "starts well in the future: future");
eq(statuses(d(STARTING_SOON_WINDOW_DAYS), null, null), ["future", "startingSoon"], "starts exactly at the starting-soon window: starting soon");
eq(statuses(d(STARTING_SOON_WINDOW_DAYS + 1), null, null), ["future"], "one day past the window: not starting soon");

eq(statuses(d(-30), d(60), null), ["current"], "permit far in the future: current");
eq(statuses(d(-30), d(FINISHING_SOON_WINDOW_DAYS), null), ["current", "finishingSoon"], "permit expiring within the window: finishing soon");
eq(statuses(d(-30), d(FINISHING_SOON_WINDOW_DAYS + 1), null), ["current"], "permit just outside the window: not finishing soon");
eq(statuses(d(-30), TODAY, null), ["current", "finishingSoon"], "permit expiring today: still current");
eq(statuses(d(-30), d(-1), null), ["permitExpired"], "permit expired, no End Different Date: Permit expired");

eq(statuses(d(-30), d(-10), d(5)), ["current", "finishingSoon"], "End Different Date wins over an expired permit");
eq(statuses(d(-30), d(90), d(-1)), ["completed"], "End Different Date in the past: completed, even with a future permit");
eq(statuses(d(-30), d(90), TODAY), ["current", "finishingSoon", "completed"], "End Different Date today: last day worked");
eq(statuses(d(-30), null, d(40)), ["current"], "End Different Date far ahead: current");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
