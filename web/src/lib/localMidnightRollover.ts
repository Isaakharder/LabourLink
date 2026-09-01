// Client-side mirror of the server's midnight-rollover boundary math
// (server/src/lib/timezone.ts's zonedWallTimeToUtc/getDayBoundsUtc,
// server/src/lib/midnightRollover.ts's computeRolloverBoundary) — pure
// Intl.DateTimeFormat arithmetic, no server dependency, so it works fully
// offline.
//
// This is DISPLAY-ONLY: it never writes to the local event log
// (localEventStore.ts) and never sends anything to the server. The one and
// only place a real rollover row is ever created is still the server's
// reconcileMidnightRollover, run the moment this device's next
// /api/mobile/me request lands (see WorkSessionContext.tsx's loadMe). All
// this does is predict what that reconciliation will show, so the on-screen
// timer/activity are already correct in the meantime — without it, a
// segment that started yesterday and is still open would just keep
// counting past 24h on screen, showing yesterday's raw start time, until
// the device happened to reconnect. See the real incident
// (Marcelino Besa, 2026-08-31) this whole feature traces back to: "local-
// first Finish Work" alone doesn't cover a shift that's still genuinely
// open across a midnight the device never got to tell the server about.
import { MeResponse } from "../context/WorkSessionContext";

// Matches server/src/lib/timezone.ts's own APP_TIMEZONE default — used only
// when this device has never received a real /me response at all (a
// first-ever launch, offline, before pairing ever reached the server), the
// one case appTimezone genuinely isn't known yet.
export const FALLBACK_APP_TIMEZONE = "America/Toronto";

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

// Same two-iteration DST-convergence approach as the server's own
// zonedWallTimeToUtc — see that function's comment for why two iterations
// always converge for a real IANA offset.
function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, tz: string): Date {
  const naiveGuessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naiveGuessMs;
  for (let i = 0; i < 2; i++) {
    guess += naiveGuessMs - wallClockAsUtcMs(new Date(guess), tz);
  }
  return new Date(guess);
}

// The YYYY-MM-DD calendar date `instant` falls on, as observed in `tz` —
// same shape as server/src/lib/timezone.ts's calendarDateInAppTimezone.
export function calendarDateInTimezone(instant: Date, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextLocalMidnightUtc(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  return zonedWallTimeToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0, 0, tz);
}

// Mirrors server/src/lib/midnightRollover.ts's MAX_ROLLOVER_HOPS_PER_CALL —
// several genuinely missed days (a phone left off for a while) reconstruct
// correctly in one call; this is purely a defensive cap, never reached in
// ordinary use.
const MAX_LOCAL_ROLLOVER_HOPS = 30;

// Walks startedAtIso forward one local midnight at a time until it lands on
// today's calendar date (in tz) or the hop cap is reached. Returns the
// SAME string, untouched, when nothing needs to change (the common case —
// still today).
function foldForward(startedAtIso: string, now: Date, tz: string): string {
  const todayLocal = calendarDateInTimezone(now, tz);
  let cursor = startedAtIso;
  for (let hops = 0; hops < MAX_LOCAL_ROLLOVER_HOPS; hops++) {
    const cursorLocalDate = calendarDateInTimezone(new Date(cursor), tz);
    if (cursorLocalDate >= todayLocal) break;
    cursor = nextLocalMidnightUtc(cursorLocalDate, tz).toISOString();
  }
  return cursor;
}

// Pure display transform, applied on top of whatever MeResponse is
// currently known — a fresh server response, a locally-restored snapshot,
// or a folded pending-event chain. Idempotent and cheap: a `me` already
// anchored to today's calendar date is returned as the exact same object
// reference, so a caller re-running this on every tick can skip a
// re-render whenever nothing actually crossed a boundary.
//
// Only startedAt/since and the now-irrelevant accumulated-before-this-
// entry counter are touched — activity id/name/row/carrier/density are
// carried over completely untouched, per "today's timer starts from zero
// while preserving activity, row, carrier and density."
export function foldLocalMidnightRollover(me: MeResponse, now: Date, timezone: string = FALLBACK_APP_TIMEZONE): MeResponse {
  if (me.status === "work" && me.currentActivity) {
    const folded = foldForward(me.currentActivity.startedAt, now, timezone);
    if (folded !== me.currentActivity.startedAt) {
      return {
        ...me,
        currentActivity: {
          ...me.currentActivity,
          startedAt: folded,
          // A calendar-day boundary is always a fresh start for "worked so
          // far today" — there is no earlier-today segment the instant a
          // new day begins. The precise same-day chain accumulation the
          // server computes (accumulateChainSeconds) reconciles in on the
          // next real sync/loadMe(), same as every other local
          // approximation in this codebase (see applyLocalEventToMe).
          accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        },
      };
    }
  }

  if (me.status === "break" && me.since) {
    const folded = foldForward(me.since, now, timezone);
    if (folded !== me.since) {
      return { ...me, since: folded };
    }
  }

  return me;
}
