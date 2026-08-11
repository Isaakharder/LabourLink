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

// [start, end) UTC instants spanning every calendar date from dateStart
// through dateEnd inclusive, as observed in APP_TIMEZONE. dateStart ===
// dateEnd reduces to exactly getDayBoundsUtc(dateStart) — used by every
// greenhouse live-state query (single-date and date-range callers share the
// same bounds shape) so a range is never assembled as start + N*24h, which
// would be wrong across a DST transition the same way getDayBoundsUtc's own
// end-of-day math already avoids.
export function getRangeBoundsUtc(dateStart: string, dateEnd: string): { start: Date; end: Date } {
  return { start: getDayBoundsUtc(dateStart).start, end: getDayBoundsUtc(dateEnd).end };
}

// Inclusive day-count spanned by [dateStart, dateEnd] (1 for a single day) —
// plain calendar-date arithmetic, no timezone conversion needed since both
// ends are already Y/M/D strings. Used to enforce MAX_DATE_RANGE_DAYS on any
// endpoint accepting a caller-supplied greenhouse date range (see
// greenhouseLive.ts and greenhouseDisplays.ts) — a published TV display's
// range gets re-queried on every ~10s poll indefinitely, so an unbounded
// span isn't just a slow one-off request, it's a standing load.
export function inclusiveDayCount(dateStart: string, dateEnd: string): number {
  const [sy, sm, sd] = dateStart.split("-").map(Number);
  const [ey, em, ed] = dateEnd.split("-").map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  return Math.round((endMs - startMs) / 86400000) + 1;
}

// dateStr shifted by `days` (negative to go backward), as a YYYY-MM-DD
// string — plain calendar-date arithmetic like inclusiveDayCount above, no
// timezone conversion needed since it never leaves Y/M/D representation.
// Used to derive prior week boundaries from a known week start (mobileStats.ts).
export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate()
  ).padStart(2, "0")}`;
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

// The wall-clock date/time `instant` reads as inside `tz`, as plain numeric
// parts — the read half of the zonedWallTimeToUtc/wallClockAsUtcMs pair
// above, exposed for callers (workStartRounding.ts) that need to do
// arithmetic on the wall-clock reading itself (e.g. "round this to the
// nearest 5-minute mark") rather than just converting a known wall-clock
// time to UTC or reading back a calendar date/formatted string.
export function zonedWallTimeParts(
  instant: Date,
  tz: string = APP_TIMEZONE
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
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
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// Splits a Postgres `time` column value ("HH:MM:SS", as returned by pg) into
// its numeric parts. Shared by break_profile_items consumers —
// breakReconciliation.ts (auto-add) and mobileTime.ts (fixed-break
// rounding) — that both need to combine a scheduled time-of-day with a
// calendar date via zonedWallTimeToUtc.
export function parseTimeParts(t: string): [number, number, number] {
  const [h, m, s] = t.split(":").map(Number);
  return [h, m, s || 0];
}
