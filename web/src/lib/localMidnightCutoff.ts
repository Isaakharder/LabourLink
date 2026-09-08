// Client-side mirror of the server's midnight-cutoff boundary math
// (server/src/lib/timezone.ts's zonedWallTimeToUtc/getDayBoundsUtc,
// server/src/lib/midnightCutoff.ts's computeMidnightCutoffBoundary) — pure
// Intl.DateTimeFormat arithmetic, no server dependency, so it works fully
// offline.
//
// This is DISPLAY-ONLY: it never writes to the local event log
// (localEventStore.ts) and never sends anything to the server. The one and
// only place a real cutoff is ever recorded is still the server's
// reconcileMidnightCutoff, run the moment this device's next
// /api/mobile/me request lands (see WorkSessionContext.tsx's loadMe). All
// this does is predict what that reconciliation will show, so the on-screen
// status is already correct in the meantime: once local midnight has
// passed relative to the currently-displayed segment's own start, the
// employee must be shown idle immediately, not still "working" with a
// timer quietly ticking past 24h — a shift may never cross local midnight,
// and the UI must never suggest otherwise while offline. See the real
// incident (Marcelino Besa, 2026-08-31; 5 employees found stuck 57-105
// hours, 2026-09 investigation) this whole feature traces back to: an
// offline device that never got to tell the server a shift crossed
// midnight must not let that shift silently keep counting.
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

// Milliseconds from `now` until the next local-midnight boundary in `tz` —
// used to schedule an exact setTimeout for the cutoff transition (see
// WorkSessionContext.tsx), rather than relying solely on a periodic poll.
// Always positive and comfortably under setTimeout's ~24.8-day max delay
// (at most ~24h + a DST hour), so it's always safe to pass straight
// through with no clamping.
export function msUntilNextLocalMidnight(now: Date, tz: string): number {
  const todayLocal = calendarDateInTimezone(now, tz);
  const boundary = nextLocalMidnightUtc(todayLocal, tz);
  return Math.max(0, boundary.getTime() - now.getTime());
}

// Whether `startedAtIso`'s own local calendar date is before `now`'s —
// i.e. whatever segment started on that date should already have been cut
// off at its first local midnight, per the "a shift may never cross local
// midnight" rule. A multi-day-old startedAt (a phone left off for days)
// still simply returns true here — there is no hop count to cap: the
// employee is idle either way, regardless of how many midnights were
// actually crossed.
function hasCrossedLocalMidnight(startedAtIso: string, now: Date, tz: string): boolean {
  return calendarDateInTimezone(new Date(startedAtIso), tz) < calendarDateInTimezone(now, tz);
}

// Pure display transform, applied on top of whatever MeResponse is
// currently known — a fresh server response, a locally-restored snapshot,
// or a folded pending-event chain. Idempotent and cheap: a `me` already
// anchored to today's calendar date (or already idle) is returned as the
// exact same object reference, so a caller re-running this on every tick
// can skip a re-render whenever nothing actually crossed a boundary.
//
// Mirrors applyLocalEventToMe's own "end_day" case exactly (same idle
// shape) — a midnight cutoff is, from the display's point of view,
// indistinguishable from the employee having pressed Finish Work at
// exactly that instant.
export function applyLocalMidnightCutoff(me: MeResponse, now: Date, timezone: string = FALLBACK_APP_TIMEZONE): MeResponse {
  if (me.status === "work" && me.currentActivity && hasCrossedLocalMidnight(me.currentActivity.startedAt, now, timezone)) {
    return { ...me, status: "idle", currentActivity: null, since: null, previousActivity: null };
  }

  if (me.status === "break" && me.since && hasCrossedLocalMidnight(me.since, now, timezone)) {
    return { ...me, status: "idle", currentActivity: null, since: null, previousActivity: null };
  }

  return me;
}
