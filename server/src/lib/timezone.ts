// Calendar-day boundaries and displayed times for the desktop Inputs page
// must use the greenhouse's local timezone, not whatever timezone the DB
// session or the server host happens to default to (Supabase's pooled
// connections default to UTC; a server could be hosted anywhere). Node ships
// full ICU by default, so this is done entirely with Intl — no new
// dependency, matching this project's deliberately minimal dependency list.

export const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Toronto";

// Reads the wall-clock date/time Intl renders `instant` as inside `tz`, and
// returns that same wall-clock reading reinterpreted as a UTC instant. This
// is a helper for the convergence loop below, not a real conversion.
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

// Converts a wall-clock time as observed in `tz` to the UTC instant it
// actually represents, via a short convergence loop rather than a single
// fixed-offset guess — a fixed guess is wrong on a DST transition day. Two
// iterations converge for any real IANA offset, since offsets don't change
// between the guess and the corrected instant except during the transition
// itself, and transitions never land on midnight in practice. Ambiguous
// (fall-back) or skipped (spring-forward) wall-clock times are an accepted,
// undocumented edge case here — they only matter for arbitrary correction
// times, and 2-3am corrections aren't a realistic scenario for this app.
export function zonedWallTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string = APP_TIMEZONE
): Date {
  const naiveGuessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naiveGuessMs;
  for (let i = 0; i < 2; i++) {
    guess += naiveGuessMs - wallClockAsUtcMs(new Date(guess), tz);
  }
  return new Date(guess);
}

// [start, end) UTC instants for the given YYYY-MM-DD calendar date as
// observed in APP_TIMEZONE. `end` is computed independently as the start of
// the *next* calendar date, not as start + 24h — a DST transition day is 23
// or 25 real hours, not 24.
export function getDayBoundsUtc(dateStr: string): { start: Date; end: Date } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = zonedWallTimeToUtc(y, m, d, 0, 0, 0);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  const end = zonedWallTimeToUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    0,
    0,
    0
  );
  return { start, end };
}

// The YYYY-MM-DD calendar date `instant` falls on, as observed in
// APP_TIMEZONE — used to confirm a correction's new end time stays on the
// same calendar day as the run it belongs to.
export function calendarDateInAppTimezone(instant: Date, tz: string = APP_TIMEZONE): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// "7:55:10 AM" style display of a UTC instant in APP_TIMEZONE.
export function formatTimeInAppTimezone(instant: Date, tz: string = APP_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(instant);
}
