// TV slide schedules (064_display_slide_schedules.sql): weekday windows,
// overnight windows, the 24-hour case, time zone and DST boundaries, the next
// boundary the TV re-checks at, and request validation. Pure — no database.
//   npm run test:display-schedule
import { isoWeekday, nextScheduleBoundary, parseSchedule, scheduleAllows, scheduleAllowsAt, SlideSchedule } from "./displaySchedule";
import { zonedWallTimeToUtc } from "./timezone";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const TZ = "America/Toronto";
const at = (y: number, mo: number, d: number, h: number, mi = 0) => zonedWallTimeToUtc(y, mo, d, h, mi, 0, TZ);
const weekdays: SlideSchedule = { enabled: true, days: [1, 2, 3, 4, 5], start: "06:00", end: "18:00" };
const overnight: SlideSchedule = { enabled: true, days: [5], start: "22:00", end: "06:00" }; // Fri night
const always: SlideSchedule = { enabled: false, days: [], start: "06:00", end: "18:00" };

// 2026-10-05 is a Monday; 2026-10-09 Friday; 2026-10-10 Saturday; 2026-10-11 Sunday.
check(isoWeekday("2026-10-05") === 1 && isoWeekday("2026-10-11") === 7, "ISO weekdays: Monday 1, Sunday 7");

// Always show ignores days and times.
check(scheduleAllows(always, 7, 3 * 60), "Always show: any day, any time");

// Mon–Fri 6:00 AM–6:00 PM: start inclusive, end exclusive, weekend off.
check(!scheduleAllows(weekdays, 1, 5 * 60 + 59), "weekday window: 5:59 AM Monday is before the start");
check(scheduleAllows(weekdays, 1, 6 * 60), "weekday window: 6:00 AM Monday starts it");
check(scheduleAllows(weekdays, 5, 17 * 60 + 59), "weekday window: 5:59 PM Friday is inside");
check(!scheduleAllows(weekdays, 5, 18 * 60), "weekday window: 6:00 PM Friday ends it");
check(!scheduleAllows(weekdays, 6, 12 * 60), "weekday window: Saturday noon is off");

// Overnight Fri 22:00 → Sat 06:00.
check(!scheduleAllows(overnight, 5, 21 * 60 + 59), "overnight: Friday 9:59 PM before the start");
check(scheduleAllows(overnight, 5, 23 * 60), "overnight: Friday 11 PM inside");
check(scheduleAllows(overnight, 6, 5 * 60 + 59), "overnight: Saturday 5:59 AM still inside (started Friday)");
check(!scheduleAllows(overnight, 6, 6 * 60), "overnight: Saturday 6:00 AM ends it");
check(!scheduleAllows(overnight, 6, 23 * 60), "overnight: Saturday night is not a chosen start day");
check(!scheduleAllows(overnight, 5, 2 * 60), "overnight: Friday 2 AM belongs to Thursday's (unchosen) night");

// Sunday night into Monday wraps the week (7 → 1).
const sundayNight: SlideSchedule = { enabled: true, days: [7], start: "20:00", end: "02:00" };
check(scheduleAllows(sundayNight, 1, 60), "overnight across the week: Monday 1 AM after a Sunday start");

// start = end is a full 24 hours from the start on each chosen day.
const allDayMon: SlideSchedule = { enabled: true, days: [1], start: "00:00", end: "00:00" };
check(scheduleAllows(allDayMon, 1, 0) && scheduleAllows(allDayMon, 1, 23 * 60 + 59) && !scheduleAllows(allDayMon, 2, 0), "00:00–00:00 is all of Monday only");
const day24: SlideSchedule = { enabled: true, days: [1], start: "06:00", end: "06:00" };
check(scheduleAllows(day24, 2, 5 * 60 + 59) && !scheduleAllows(day24, 2, 6 * 60) && !scheduleAllows(day24, 1, 5 * 60), "06:00–06:00 runs Monday 6 AM to Tuesday 6 AM");

// Real instants are read in the organization's time zone, not UTC.
// Friday 2026-10-09 23:30 Toronto = Saturday 03:30 UTC.
check(scheduleAllowsAt(overnight, at(2026, 10, 9, 23, 30), TZ), "time zone: Friday 11:30 PM Toronto is inside (although it is Saturday in UTC)");
// Monday 2026-10-05 05:30 Toronto = 09:30 UTC (inside 6–18 if read as UTC).
check(!scheduleAllowsAt(weekdays, at(2026, 10, 5, 5, 30), TZ), "time zone: Monday 5:30 AM Toronto is before the start (although 9:30 UTC)");
check(scheduleAllowsAt(weekdays, at(2026, 10, 5, 6, 0), TZ), "time zone: Monday 6:00 AM Toronto starts it");

// DST: 2026-11-01 (Sun) clocks fall back at 2 AM; 2026-03-08 (Sun) spring forward.
const sun = { enabled: true, days: [7], start: "01:00", end: "03:00" };
check(scheduleAllowsAt(sun, at(2026, 11, 1, 2, 30), TZ) && !scheduleAllowsAt(sun, at(2026, 11, 1, 3, 0), TZ), "DST fall back: wall-clock window still 1–3 AM");
check(scheduleAllowsAt(sun, at(2026, 3, 8, 1, 30), TZ) && !scheduleAllowsAt(sun, at(2026, 3, 8, 3, 30), TZ), "DST spring forward: wall-clock window still respected");

// Next boundary the TV re-checks at.
const monday7am = at(2026, 10, 5, 7);
check(nextScheduleBoundary([weekdays], monday7am, TZ)?.getTime() === at(2026, 10, 5, 18).getTime(), "next boundary: Monday 7 AM → 6 PM end", nextScheduleBoundary([weekdays], monday7am, TZ));
check(nextScheduleBoundary([weekdays], at(2026, 10, 5, 19), TZ)?.getTime() === at(2026, 10, 6, 6).getTime(), "next boundary: Monday 7 PM → Tuesday 6 AM start");
check(nextScheduleBoundary([overnight], at(2026, 10, 9, 23), TZ)?.getTime() === at(2026, 10, 10, 6).getTime(), "next boundary: overnight ends Saturday 6 AM");
check(nextScheduleBoundary([weekdays, overnight], at(2026, 10, 9, 19), TZ)?.getTime() === at(2026, 10, 9, 22).getTime(), "next boundary: earliest of several schedules");
check(nextScheduleBoundary([always], monday7am, TZ) === null, "next boundary: nothing scheduled → null");
check(nextScheduleBoundary([weekdays], at(2026, 10, 5, 6, 0), TZ)?.getTime() === at(2026, 10, 5, 18).getTime(), "next boundary: strictly after now");

// Validation.
check(typeof parseSchedule({ enabled: true, days: [], start: "06:00", end: "18:00" }, "X") === "string", "rejects a schedule with no days");
check(typeof parseSchedule({ enabled: true, days: [0], start: "06:00", end: "18:00" }, "X") === "string", "rejects day 0");
check(typeof parseSchedule({ enabled: true, days: [1], start: "6:00", end: "18:00" }, "X") === "string", "rejects H:MM");
check(typeof parseSchedule({ enabled: true, days: [1], start: "24:00", end: "18:00" }, "X") === "string", "rejects 24:00");
check(typeof parseSchedule({ days: [1], start: "06:00", end: "18:00" }, "X") === "string", "requires Always show / Use schedule");
const ok = parseSchedule({ enabled: false, days: [], start: "06:00", end: "18:00" }, "X");
check(typeof ok === "object" && ok.enabled === false, "Always show may have no days", ok);
const norm = parseSchedule({ enabled: true, days: [5, 1, 1, 3], start: "22:00", end: "06:00" }, "X");
check(typeof norm === "object" && norm.days.join() === "1,3,5", "days de-duplicated and sorted", norm);

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
