// Client mirror of server/src/lib/timezone.ts — this app has no shared
// package between server/ and web/ (confirmed: no workspaces, root
// package.json is just an npm --prefix + concurrently wrapper), so small
// duplication like this already happens elsewhere (e.g. validation
// regexes). Uses Intl with a timeZone option, same as the server side — no
// new dependency.

export const APP_TIMEZONE = import.meta.env.VITE_APP_TIMEZONE || "America/Toronto";

function wallClockAsUtcMs(instant: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
}

// Converts a wall-clock time as observed in APP_TIMEZONE to the UTC instant
// it actually represents, via a short convergence loop (correct across DST
// transitions; a single fixed-offset guess is not). See the server-side
// twin of this function for the full rationale.
function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const naiveGuessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naiveGuessMs;
  for (let i = 0; i < 2; i++) {
    guess += naiveGuessMs - wallClockAsUtcMs(new Date(guess), APP_TIMEZONE);
  }
  return new Date(guess);
}

// Today's calendar date (YYYY-MM-DD) as observed in APP_TIMEZONE — not the
// browser's local timezone, which may differ from the greenhouse's.
export function todayInAppTimezone(): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Adds `deltaDays` calendar days to a YYYY-MM-DD date string using pure UTC
// arithmetic on the date's own numbers — never round-trips through a
// locally-parsed Date, which is the classic source of an accidental
// off-by-one when the browser's local timezone differs from APP_TIMEZONE.
export function addCalendarDays(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(
    next.getUTCDate()
  ).padStart(2, "0")}`;
}

// Every YYYY-MM-DD date from `startStr` through `endStr` inclusive — the
// Reports pivot table's date columns. Bounded by the caller (a saved
// report's date range), not unbounded — a full calendar year is ~365
// entries, not a concern for a single array build.
export function enumerateDates(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  let cursor = startStr;
  while (cursor <= endStr) {
    dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

// Monday of the calendar week containing `dateStr` — pure UTC Y/M/D
// arithmetic via addCalendarDays, same approach as every other helper here
// (never round-trips through a locally-parsed Date). Week start is Monday,
// not Sunday — getUTCDay() is 0=Sun..6=Sat, so the Monday offset is
// (day + 6) % 7 days back (Sunday, day 0, is 6 days after the preceding
// Monday; Monday itself, day 1, is 0 days back).
export function startOfWeekMonday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const offset = (day + 6) % 7;
  return addCalendarDays(dateStr, -offset);
}

// "YYYY-MM-01" for the month containing `dateStr`.
export function startOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

// The last real calendar day of the month containing `dateStr` — computed
// by asking for day 0 of the *next* month (JS/UTC date arithmetic rolls
// that back to the last day of the current one), not a hardcoded 28-31
// lookup table.
export function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${String(
    last.getUTCDate()
  ).padStart(2, "0")}`;
}

// "Saturday, August 1, 2026" — the date string is a plain calendar date, not
// an instant, so this formats it directly rather than going through any
// timezone conversion (there's no "instant" to convert; a calendar date
// means the same day everywhere).
export function formatDateLong(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

// "7:55:10 AM" display of an ISO instant in APP_TIMEZONE.
export function formatTimeInAppTimezone(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

// "HH:MM:SS" (24-hour) rendering of an ISO instant in APP_TIMEZONE — the
// value format <input type="time" step="1"> expects/produces.
export function toTimeInputValue(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIMEZONE,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(iso))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

// Combines a YYYY-MM-DD date with a HH:MM:SS time-of-day (as produced by
// <input type="time" step="1">) into the UTC ISO instant that wall-clock
// reading represents in APP_TIMEZONE — used to build the correction
// endpoint's endTime payload.
export function combineDateAndTimeToUtcIso(dateStr: string, timeStr: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi, s] = timeStr.split(":").map(Number);
  return zonedWallTimeToUtc(y, mo, d, h, mi, s ?? 0).toISOString();
}

// "H:MM:SS" duration display (e.g. "0:15:09", "1:02:03") — hours not
// zero-padded, matching the Inputs page's requested fixed-width format.
export function formatDurationHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
