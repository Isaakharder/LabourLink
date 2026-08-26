// Pure unit tests (no database) for workPermits.ts's date/severity math —
// calendar-month subtraction, notification-window computation, the
// server-side 6-month default, and the four severity bands. See
// workPermits.routes.test.ts for the real-HTTP/real-DB coverage (weekly
// recurrence, renew/cancel, permissions, audit history, DB constraints).
//
// Run with: npm run test:work-permits
import {
  computeNotificationWindowStart,
  computeSeverity,
  daysBetweenDateStrs,
  isValidWorkPermitLeadDays,
  isValidWorkPermitLeadMonths,
  resolveNotifyLead,
  subtractCalendarMonths,
} from "./workPermits";

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

// -----------------------------------------------------------------------
// 1) subtractCalendarMonths — real calendar months, not fixed 30-day chunks
// -----------------------------------------------------------------------
check(subtractCalendarMonths("2027-02-25", 1) === "2027-01-25", "1) 1 month before Feb 25 is Jan 25 (the brief's own example)");
check(subtractCalendarMonths("2027-02-25", 6) === "2026-08-25", "1b) 6 months before Feb 25 2027 is Aug 25 2026");
check(subtractCalendarMonths("2027-03-31", 1) === "2027-02-28", "2) end-of-month clamping: 1 month before Mar 31 is Feb 28 (2027 is not a leap year)");
check(subtractCalendarMonths("2028-03-31", 1) === "2028-02-29", "2b) end-of-month clamping respects a real leap year (2028)");
check(subtractCalendarMonths("2027-01-15", 1) === "2026-12-15", "3) crossing a calendar-year boundary");
check(subtractCalendarMonths("2027-01-15", 12) === "2026-01-15", "3b) 12 months before is exactly one year earlier");

// -----------------------------------------------------------------------
// 2) daysBetweenDateStrs — plain calendar-day differences
// -----------------------------------------------------------------------
check(daysBetweenDateStrs("2027-02-01", "2027-02-25") === 24, "4) 24 days between Feb 1 and Feb 25");
check(daysBetweenDateStrs("2027-02-25", "2027-02-25") === 0, "4b) same date is 0 days");
check(daysBetweenDateStrs("2027-02-25", "2027-02-01") === -24, "4c) negative when `to` is earlier than `from` (expired case)");
check(daysBetweenDateStrs("2027-12-25", "2028-01-05") === 11, "4d) crosses a year boundary correctly");

// -----------------------------------------------------------------------
// 3) computeNotificationWindowStart — month preset vs custom days
// -----------------------------------------------------------------------
check(
  computeNotificationWindowStart("2027-02-25", { months: 6, days: null }) === "2026-08-25",
  "5) a 6-month preset window opens on the calendar-month date"
);
check(
  computeNotificationWindowStart("2027-02-25", { months: null, days: 45 }) === "2027-01-11",
  "5b) a 45-custom-day window opens 45 plain days earlier"
);

// -----------------------------------------------------------------------
// 4) resolveNotifyLead — the server-side 6-month default
// -----------------------------------------------------------------------
{
  const r = resolveNotifyLead(undefined, undefined);
  check(r.months === 6 && r.days === null, "6) no lead supplied at all defaults to 6 months", r);
}
{
  const r = resolveNotifyLead(3, undefined);
  check(r.months === 3 && r.days === null, "6b) an explicit valid month preset is honored, not defaulted", r);
}
{
  const r = resolveNotifyLead(undefined, 45);
  check(r.months === null && r.days === 45, "6c) an explicit custom day count is honored, not defaulted", r);
}
{
  // Custom days takes precedence if (invalidly) both were somehow passed —
  // real callers already enforce mutual exclusivity before this point, but
  // this function itself must still resolve to exactly one, never both.
  const r = resolveNotifyLead(3, 45);
  check(r.months === null && r.days === 45, "6d) days wins if both are somehow present — result is still exactly one, never both", r);
}
{
  const r = resolveNotifyLead(7, undefined); // 7 is not a valid preset
  check(r.months === 6 && r.days === null, "6e) an invalid month value falls back to the 6-month default, not silently accepted", r);
}

check(isValidWorkPermitLeadMonths(6) === true, "7) 6 is a valid month preset");
check(isValidWorkPermitLeadMonths(4) === false, "7b) 4 is not a valid month preset");
check(isValidWorkPermitLeadDays(45) === true, "7c) 45 is a valid custom day count");
check(isValidWorkPermitLeadDays(0) === false, "7d) 0 days is rejected (not positive)");
check(isValidWorkPermitLeadDays(-5) === false, "7e) a negative day count is rejected");
check(isValidWorkPermitLeadDays(3651) === false, "7f) an absurdly large day count (>3650) is rejected");
check(isValidWorkPermitLeadDays(1.5) === false, "7g) a non-integer day count is rejected");

// -----------------------------------------------------------------------
// 5) computeSeverity — the four bands and their exact boundaries
// -----------------------------------------------------------------------
check(computeSeverity(91) === "amber", "8) 91 days remaining is amber (more than 90)");
check(computeSeverity(90) === "orange", "8b) exactly 90 days remaining is orange (the 30-90 band includes 90)");
check(computeSeverity(30) === "orange", "8c) exactly 30 days remaining is orange (the 30-90 band includes 30)");
check(computeSeverity(29) === "red", "8d) 29 days remaining is red (less than 30)");
check(computeSeverity(0) === "red", "8e) expiring today (0 days remaining) is red, not yet 'expired'");
check(computeSeverity(-1) === "expired", "8f) -1 days remaining (1 day overdue) is 'expired'");
check(computeSeverity(-30) === "expired", "8g) well past expiry is still 'expired'");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
