// Configurable work-start, work-end, AND break rounding (Basic Data >
// Breaks > a break profile's "Work start rounding" / "Work end rounding" /
// "Break rounding" sections — three independent settings, see
// breakProfiles.ts). Work-start rounding is applied only at the moment an
// employee's workday genuinely starts (idle -> work); work-end rounding
// only when they explicitly finish it (Finish Work); break rounding at
// both ends of a break (Start Break and End Break) whenever the break
// isn't already snapped to a scheduled fixed-break item. None of the three
// is ever applied to an activity change, an automatically-resumed
// activity, or a manual Inputs correction. server/src/routes/mobileTime.ts
// is the only caller of any of them, each on exactly its own transition.
//
// All arithmetic here happens in the greenhouse's local wall-clock reading
// (via timezone.ts's zonedWallTimeParts/zonedWallTimeToUtc), not in raw UTC
// or in elapsed real time since local midnight — "round to the nearest
// 5-minute mark" is a statement about clock digits (7:10, 7:15, ...), and
// must produce the same clock digits regardless of whether the calendar day
// it falls on happens to be 23, 24, or 25 real hours long (a DST
// transition). Converting the resulting wall-clock reading back to a UTC
// instant is delegated entirely to zonedWallTimeToUtc, which already
// handles that correctly via its own convergence loop — this module never
// reasons about UTC offsets itself.
import { zonedWallTimeParts, zonedWallTimeToUtc, APP_TIMEZONE } from "./timezone";

export const ROUNDING_DIRECTIONS = ["clockwise", "counter_clockwise"] as const;
export type RoundingDirection = (typeof ROUNDING_DIRECTIONS)[number];

export function isRoundingDirection(v: unknown): v is RoundingDirection {
  return typeof v === "string" && (ROUNDING_DIRECTIONS as readonly string[]).includes(v);
}

export const MIN_ROUNDING_INTERVAL_MINUTES = 1;
export const MAX_ROUNDING_INTERVAL_MINUTES = 60;

export function isValidRoundingIntervalMinutes(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_ROUNDING_INTERVAL_MINUTES &&
    v <= MAX_ROUNDING_INTERVAL_MINUTES
  );
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Rounds `instant` to the nearest `intervalMinutes` wall-clock boundary in
// `tz`, in the given direction. An instant already exactly on a boundary
// (to the millisecond) is returned unchanged — "exactly on the boundary"
// requires zero seconds/milliseconds too, not just a minute value that's a
// multiple of the interval: 7:10:30 is not "exactly 7:10" even though 10 is
// a multiple of 5.
//
// Crossing midnight is handled by carrying a day delta into the calendar
// date passed to zonedWallTimeToUtc, in either direction — clockwise can
// roll into the next calendar day (e.g. 23:58 with a 5-minute interval ->
// 00:00 the next day), counter-clockwise can roll into the previous one
// (e.g. 00:02 -> 23:55 the day before). This is the correct, literal
// reading of "round to the nearest boundary" and is deliberately not
// special-cased away — a real work-start tap in the first few minutes
// after local midnight is rare but not impossible, and the alternative
// (clamping to the same calendar day) would silently produce a boundary
// that isn't actually nearest in the requested direction.
export function roundToInterval(
  instant: Date,
  intervalMinutes: number,
  direction: RoundingDirection,
  tz: string = APP_TIMEZONE
): Date {
  if (!isValidRoundingIntervalMinutes(intervalMinutes)) {
    throw new Error(`intervalMinutes must be an integer between ${MIN_ROUNDING_INTERVAL_MINUTES} and ${MAX_ROUNDING_INTERVAL_MINUTES}`);
  }

  const parts = zonedWallTimeParts(instant, tz);
  // The millisecond-of-second component is timezone-shift invariant (every
  // modern IANA zone offsets by a whole number of minutes), so it's safe to
  // read directly off the UTC instant rather than needing Intl to supply it
  // (Intl.DateTimeFormat has no millisecond part).
  const ms = instant.getUTCMilliseconds();
  const wallMsOfDay = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 + ms;
  const intervalMs = intervalMinutes * 60 * 1000;
  const remainder = wallMsOfDay % intervalMs;

  if (remainder === 0) return instant;

  const roundedMsOfDayRaw = direction === "clockwise" ? wallMsOfDay - remainder + intervalMs : wallMsOfDay - remainder;

  let dayDelta = 0;
  let roundedMsOfDay = roundedMsOfDayRaw;
  while (roundedMsOfDay >= MS_PER_DAY) {
    roundedMsOfDay -= MS_PER_DAY;
    dayDelta += 1;
  }
  while (roundedMsOfDay < 0) {
    roundedMsOfDay += MS_PER_DAY;
    dayDelta -= 1;
  }

  // roundedMsOfDay is always an exact multiple of 60000: wallMsOfDay -
  // remainder is (by definition of %) an exact multiple of intervalMs, and
  // intervalMs is itself an exact multiple of 60000 since intervalMinutes
  // is a whole number >= 1 — so the result always lands precisely on a
  // whole minute with zero seconds, matching every example in the spec
  // (7:11 -> 7:15, never 7:15:00.001 or similar).
  const roundedSeconds = roundedMsOfDay / 1000;
  const rH = Math.floor(roundedSeconds / 3600);
  const rM = Math.floor((roundedSeconds % 3600) / 60);
  const rS = roundedSeconds % 60;

  // Applying dayDelta via a UTC-arithmetic Date and reading its UTC y/m/d
  // back out is just calendar-date bookkeeping (no timezone conversion
  // happening here) — the same "shift by whole days in UTC-arithmetic
  // space, never through a timezone" pattern timezone.ts's own
  // addDaysToDateStr and getDayBoundsUtc already use.
  const shiftedDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayDelta));

  return zonedWallTimeToUtc(
    shiftedDate.getUTCFullYear(),
    shiftedDate.getUTCMonth() + 1,
    shiftedDate.getUTCDate(),
    rH,
    rM,
    rS,
    tz
  );
}

// Named per call site for readability — both are the exact same rounding
// math (roundToInterval above is direction-agnostic: "round forward/
// backward to the nearest boundary" means the same thing whether the
// instant being rounded is a work start or a work end), so neither
// duplicates any logic, just gives mobileTime.ts's two call sites their own
// self-documenting name.
export function roundWorkStart(
  instant: Date,
  intervalMinutes: number,
  direction: RoundingDirection,
  tz: string = APP_TIMEZONE
): Date {
  return roundToInterval(instant, intervalMinutes, direction, tz);
}

export function roundWorkEnd(
  instant: Date,
  intervalMinutes: number,
  direction: RoundingDirection,
  tz: string = APP_TIMEZONE
): Date {
  return roundToInterval(instant, intervalMinutes, direction, tz);
}

// Same math again, named for its own call sites — server/src/routes/
// mobileTime.ts's POST /time-entries/break/start and POST /time-entries/
// break/end both use this one wrapper (a single break-rounding setting
// governs both ends of a break, unlike work-start/work-end which are two
// independent settings for two different routes).
export function roundBreak(
  instant: Date,
  intervalMinutes: number,
  direction: RoundingDirection,
  tz: string = APP_TIMEZONE
): Date {
  return roundToInterval(instant, intervalMinutes, direction, tz);
}

// A work-start tap made offline can be replayed by the phone's own offline
// queue (web/src/lib/offlineQueue.ts) long after it actually happened — the
// client always sends its own clock's reading of the moment the employee
// tapped (`clientStartedAt`), captured before the request is even
// attempted, so a delayed sync still rounds against the real tap time
// instead of whenever the sync happened to land (server/src/routes/
// mobileTime.ts's POST /time-entries/work is the only caller). A Finish
// Work tap is the same idea for the opposite end of the day —
// `clientEndedAt`, captured client-side before the request is attempted
// (WorkSessionContext.tsx's confirmEndDay) and preserved across a retry
// with the same idempotencyKey, even though end-day deliberately never
// goes through the generic offline queue itself (see that route's own
// comment for why). Either way, this client-reported value is untrusted
// input feeding a paid-time calculation, so it's bounded rather than
// accepted as-is: a small forward-skew tolerance covers ordinary clock
// drift between the phone and the server, while the backward bound is
// generous enough to cover a genuinely offline shift (this mobile app is
// documented elsewhere, see mobileTime.ts's fixed-break rounding, as not
// meant to survive an extended fully-offline shift beyond that) without
// accepting an obviously broken clock (e.g. an unset-clock epoch date).
// Missing, unparseable, or out-of-bounds values all fall back to `now` —
// the same value used everywhere else in that file when no client
// timestamp exists at all.
export const MAX_CLIENT_CLOCK_SKEW_FUTURE_MS = 5 * 60 * 1000;
export const MAX_OFFLINE_REPLAY_DELAY_MS = 24 * 60 * 60 * 1000;

export function resolveOriginalTimestamp(clientTimestamp: unknown, now: Date): Date {
  if (typeof clientTimestamp !== "string") return now;
  const parsed = new Date(clientTimestamp);
  if (isNaN(parsed.getTime())) return now;
  const delta = now.getTime() - parsed.getTime();
  if (delta < -MAX_CLIENT_CLOCK_SKEW_FUTURE_MS || delta > MAX_OFFLINE_REPLAY_DELAY_MS) return now;
  return parsed;
}

// Named per call site, same reasoning as roundWorkStart/roundWorkEnd above
// — both are the exact same bounding logic.
export function resolveOriginalStartedAt(clientStartedAt: unknown, now: Date): Date {
  return resolveOriginalTimestamp(clientStartedAt, now);
}

export function resolveOriginalEndedAt(clientEndedAt: unknown, now: Date): Date {
  return resolveOriginalTimestamp(clientEndedAt, now);
}
