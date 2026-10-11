// When a TV slide may show (064_display_slide_schedules.sql). Pure apart from
// the time zone conversions, so the weekday, overnight and DST rules are
// testable with fixed instants.
//
// A schedule is a weekly window in the organization's time zone: it starts
// on each chosen ISO weekday (1 = Monday … 7 = Sunday) at `start` and ends at
// `end`. An end at or before the start runs past midnight into the next day
// (Fri 22:00–06:00 covers Friday 22:00 until Saturday 06:00); start = end is a
// full 24 hours. "Always show" (enabled = false) ignores days and times.
import { addDaysToDateStr, APP_TIMEZONE, zonedWallTimeParts, zonedWallTimeToUtc } from "./timezone";

export interface SlideSchedule {
  enabled: boolean;
  days: number[]; // ISO weekdays, ascending, unique
  start: string; // "HH:MM", 24-hour
  end: string; // "HH:MM", 24-hour
}

export const DEFAULT_SCHEDULE: SlideSchedule = { enabled: false, days: [1, 2, 3, 4, 5, 6, 7], start: "06:00", end: "18:00" };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD calendar date.
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function previousDay(isoDay: number): number {
  return isoDay === 1 ? 7 : isoDay - 1;
}

// Is the slide allowed at this local weekday and minute of the day?
export function scheduleAllows(s: SlideSchedule, isoDay: number, minuteOfDay: number): boolean {
  if (!s.enabled) return true;
  const start = minutesOf(s.start);
  const end = minutesOf(s.end);
  const days = new Set(s.days);
  if (start < end) return days.has(isoDay) && minuteOfDay >= start && minuteOfDay < end;
  // Runs past midnight (or a full 24 hours): today's window from `start`, or
  // the tail of a window that started yesterday.
  return (days.has(isoDay) && minuteOfDay >= start) || (days.has(previousDay(isoDay)) && minuteOfDay < end);
}

export function scheduleAllowsAt(s: SlideSchedule, instant: Date, tz: string = APP_TIMEZONE): boolean {
  if (!s.enabled) return true;
  const p = zonedWallTimeParts(instant, tz);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return scheduleAllows(s, isoWeekday(date), p.hour * 60 + p.minute);
}

// The next instant after `now` at which any of these schedules starts or
// ends, so the TV can re-check exactly then instead of waiting for its next
// poll. null when none of them is enabled.
export function nextScheduleBoundary(schedules: SlideSchedule[], now: Date, tz: string = APP_TIMEZONE): Date | null {
  const enabled = schedules.filter((s) => s.enabled && s.days.length > 0);
  if (enabled.length === 0) return null;
  const p = zonedWallTimeParts(now, tz);
  const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  let best: Date | null = null;
  for (let offset = 0; offset <= 8; offset++) {
    const date = addDaysToDateStr(today, offset);
    const [y, m, d] = date.split("-").map(Number);
    for (const s of enabled) {
      for (const t of [s.start, s.end]) {
        const [hh, mm] = t.split(":").map(Number);
        const at = zonedWallTimeToUtc(y, m, d, hh, mm, 0, tz);
        if (at > now && (!best || at < best)) best = at;
      }
    }
    if (best) return best; // boundaries on a later day are always later
  }
  return best;
}

// Validates a schedule from a request body. Returns the normalized schedule,
// or an error message.
export function parseSchedule(raw: unknown, label: string): SlideSchedule | string {
  if (!raw || typeof raw !== "object") return `${label}: schedule is invalid`;
  const r = raw as { enabled?: unknown; days?: unknown; start?: unknown; end?: unknown };
  if (typeof r.enabled !== "boolean") return `${label}: choose Always show or Use schedule`;
  if (!Array.isArray(r.days) || !r.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    return `${label}: schedule days must be weekdays 1 (Monday) to 7 (Sunday)`;
  }
  if (typeof r.start !== "string" || !HHMM.test(r.start) || typeof r.end !== "string" || !HHMM.test(r.end)) {
    return `${label}: schedule times must be HH:MM`;
  }
  const days = [...new Set(r.days as number[])].sort((a, b) => a - b);
  if (r.enabled && days.length === 0) return `${label}: choose at least one day for the schedule`;
  return { enabled: r.enabled, days, start: r.start, end: r.end };
}

// A row's schedule columns ("time" comes back as "HH:MM:SS").
export function scheduleFromRow(enabled: boolean, days: number[] | null, start: string, end: string): SlideSchedule {
  return { enabled, days: (days ?? []).map(Number).sort((a, b) => a - b), start: String(start).slice(0, 5), end: String(end).slice(0, 5) };
}
