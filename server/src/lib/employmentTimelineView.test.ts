// Employment Timeline bar rule (employmentTimelineView.ts): the bar starts on
// the Employment Start Date and ends on End Different Date when entered,
// otherwise on the Work Permit Expiry Date, otherwise it's ongoing.
//
// Run with: npm run test:employment-timeline-view
import { computeTimelineBar, resolveEmployeeTimeline, TIMELINE_BAR_LABEL_TEXT } from "./employmentTimelineView";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}
function eq(actual: unknown, expected: unknown, label: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, { actual, expected });
}

const TODAY = "2026-10-30";

// Permit expiry ends the bar when there's no End Different Date.
eq(
  computeTimelineBar({ workPermitExpiryDate: "2027-02-04", endDifferentDate: null }, TODAY),
  { endDate: "2027-02-04", endSource: "workPermitExpiry", label: "employed" },
  "a future permit expiry ends the bar there (Employed)"
);
eq(
  computeTimelineBar({ workPermitExpiryDate: "2026-09-01", endDifferentDate: null }, TODAY),
  { endDate: "2026-09-01", endSource: "workPermitExpiry", label: "permitExpired" },
  "a past permit expiry still ends the bar on the expiry (Permit expired), not today"
);
eq(
  computeTimelineBar({ workPermitExpiryDate: TODAY, endDifferentDate: null }, TODAY),
  { endDate: TODAY, endSource: "workPermitExpiry", label: "employed" },
  "a permit expiring today is still Employed today"
);

// End Different Date overrides the permit expiry, earlier or later.
eq(
  computeTimelineBar({ workPermitExpiryDate: "2027-02-04", endDifferentDate: "2026-12-15" }, TODAY),
  { endDate: "2026-12-15", endSource: "endDifferentDate", label: "employed" },
  "End Different Date before the permit expiry ends the bar there"
);
eq(
  computeTimelineBar({ workPermitExpiryDate: "2026-09-01", endDifferentDate: "2026-11-20" }, TODAY),
  { endDate: "2026-11-20", endSource: "endDifferentDate", label: "employed" },
  "End Different Date after an expired permit ends the bar on the End Different Date"
);
eq(
  computeTimelineBar({ workPermitExpiryDate: "2027-02-04", endDifferentDate: "2026-10-01" }, TODAY),
  { endDate: "2026-10-01", endSource: "endDifferentDate", label: "completed" },
  "a past End Different Date is Finished"
);
eq(
  computeTimelineBar({ workPermitExpiryDate: null, endDifferentDate: TODAY }, TODAY),
  { endDate: TODAY, endSource: "endDifferentDate", label: "completed" },
  "End Different Date today (last day worked) is Finished"
);

// Neither ending date: ongoing.
eq(
  computeTimelineBar({ workPermitExpiryDate: null, endDifferentDate: null }, TODAY),
  { endDate: null, endSource: null, label: "ongoing" },
  "no ending dates gives an ongoing bar"
);

// Inclusion.
eq(resolveEmployeeTimeline({ isActive: false, startDate: "2026-01-01", workPermitExpiryDate: null, endDifferentDate: null }, TODAY), { included: false, hasUsableDates: false, bar: null }, "deactivated employees are excluded");
eq(
  resolveEmployeeTimeline({ isActive: true, startDate: null, workPermitExpiryDate: "2027-01-01", endDifferentDate: null }, TODAY),
  { included: true, hasUsableDates: false, bar: null },
  "an active employee with no Employment Start Date is included but has nothing to draw"
);
eq(
  resolveEmployeeTimeline({ isActive: true, startDate: "2026-04-15", workPermitExpiryDate: "2027-02-04", endDifferentDate: null }, TODAY).bar,
  { endDate: "2027-02-04", endSource: "workPermitExpiry", label: "employed" },
  "an active dated employee gets a bar"
);
eq(Object.values(TIMELINE_BAR_LABEL_TEXT), ["Finished", "Ongoing", "Employed", "Permit expired"], "label wording");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
