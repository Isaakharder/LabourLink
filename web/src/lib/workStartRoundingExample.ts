import { WorkStartRoundingDirection } from "./breakProfileTypes";

export interface RoundingExampleRow {
  inputLabel: string;
  outputLabel: string;
}

// "7:00 AM" / "7:05 AM" — minutes-since-midnight to a 12-hour clock label.
function formatClock(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  const period = h < 12 ? "AM" : "PM";
  return `${displayHour}:${String(m).padStart(2, "0")} ${period}`;
}

// Minute-level illustration of the same rounding rule
// server/src/lib/workStartRounding.ts implements authoritatively — used
// only to render the Break Profile editor's live example. Deliberately
// simpler than the server's version: no timezone/DST conversion (the
// example is always shown in plain clock digits, not tied to any real
// calendar date) and no sub-minute precision (a live example never needs to
// illustrate "7:10:30"). The server's implementation is what's actually
// authoritative for anything recorded.
function roundMinutes(totalMinutes: number, intervalMinutes: number, direction: WorkStartRoundingDirection): number {
  const remainder = totalMinutes % intervalMinutes;
  if (remainder === 0) return totalMinutes;
  return direction === "clockwise" ? totalMinutes - remainder + intervalMinutes : totalMinutes - remainder;
}

// Three rows — an exact boundary (unchanged), one minute past the lower
// boundary, and one minute before the upper boundary — anchored at an
// arbitrary, readable 7:00 AM reference hour. Matches the shape of the
// spec's own worked example (5-minute interval: 7:10 -> 7:10, 7:11 -> 7:15,
// 7:14 -> 7:15) for any interval from 1 to 60. An interval of 1 minute has
// no "in-between" — every whole minute is already a boundary — so that case
// is shown as a single always-unchanged row instead.
export function computeRoundingExample(
  intervalMinutes: number,
  direction: WorkStartRoundingDirection
): RoundingExampleRow[] {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) return [];

  const baseHourMinutes = 7 * 60; // 7:00 AM

  if (intervalMinutes === 1) {
    const t = baseHourMinutes + 11;
    return [{ inputLabel: formatClock(t), outputLabel: formatClock(t) }];
  }

  const exact = baseHourMinutes;
  const justPast = baseHourMinutes + 1;
  const justBefore = baseHourMinutes + intervalMinutes - 1;

  return [
    { inputLabel: formatClock(exact), outputLabel: formatClock(roundMinutes(exact, intervalMinutes, direction)) },
    {
      inputLabel: formatClock(justPast),
      outputLabel: formatClock(roundMinutes(justPast, intervalMinutes, direction)),
    },
    {
      inputLabel: formatClock(justBefore),
      outputLabel: formatClock(roundMinutes(justBefore, intervalMinutes, direction)),
    },
  ];
}
