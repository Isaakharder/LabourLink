// Week/month rollover for TV display periods — pure, no database.
// Run with: npm run test:display-periods
import { resolveMapPreset, resolveReportingPeriod, startOfWeekMonday } from "./displayPeriods";

let pass = 0;
let fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// 2026-10-12 is a Monday; 2026-10-18 a Sunday.
eq(startOfWeekMonday("2026-10-12"), "2026-10-12", "Monday is its own week start");
eq(startOfWeekMonday("2026-10-18"), "2026-10-12", "Sunday belongs to the week that started Monday");
eq(startOfWeekMonday("2026-11-01"), "2026-10-26", "week start crosses a month boundary");
eq(startOfWeekMonday("2027-01-01"), "2026-12-28", "week start crosses a year boundary");

eq(resolveReportingPeriod("this_week", true, "2026-10-12"), { dateStart: "2026-10-12", dateEnd: "2026-10-12", empty: false }, "Monday incl. today = just Monday");
eq(resolveReportingPeriod("this_week", false, "2026-10-12").empty, true, "Monday excl. today = no days yet (map only)");
eq(resolveReportingPeriod("this_week", false, "2026-10-14"), { dateStart: "2026-10-12", dateEnd: "2026-10-13", empty: false }, "Wednesday excl. today = Mon–Tue");
eq(resolveReportingPeriod("this_week", true, "2026-10-18"), { dateStart: "2026-10-12", dateEnd: "2026-10-18", empty: false }, "Sunday incl. today = full week");
eq(resolveReportingPeriod("last_week", true, "2026-10-12"), { dateStart: "2026-10-05", dateEnd: "2026-10-11", empty: false }, "last week from a Monday");
eq(resolveReportingPeriod("last_week", false, "2026-10-18"), { dateStart: "2026-10-05", dateEnd: "2026-10-11", empty: false }, "last week ignores Include today");
// Rollover: Sunday night -> Monday morning switches the whole period.
eq(resolveReportingPeriod("this_week", true, "2026-10-19").dateStart, "2026-10-19", "the week rolls over on Monday");

eq(resolveMapPreset("today", "2026-11-01"), { dateStart: "2026-11-01", dateEnd: "2026-11-01" }, "today (DST-change day in Toronto)");
eq(resolveMapPreset("yesterday", "2026-03-01"), { dateStart: "2026-02-28", dateEnd: "2026-02-28" }, "yesterday across February");
eq(resolveMapPreset("thisWeek", "2026-10-14"), { dateStart: "2026-10-12", dateEnd: "2026-10-18" }, "this week Mon–Sun");
eq(resolveMapPreset("lastWeek", "2026-10-12"), { dateStart: "2026-10-05", dateEnd: "2026-10-11" }, "last week");
eq(resolveMapPreset("last7", "2026-10-03"), { dateStart: "2026-09-27", dateEnd: "2026-10-03" }, "last 7 days across a month");
eq(resolveMapPreset("thisMonth", "2028-02-10"), { dateStart: "2028-02-01", dateEnd: "2028-02-29" }, "this month in a leap year");
eq(resolveMapPreset("lastMonth", "2027-01-15"), { dateStart: "2026-12-01", dateEnd: "2026-12-31" }, "last month across a year");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
