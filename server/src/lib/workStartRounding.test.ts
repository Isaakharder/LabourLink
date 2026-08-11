import {
  roundWorkStart,
  isValidRoundingIntervalMinutes,
  isRoundingDirection,
  resolveOriginalStartedAt,
  MAX_CLIENT_CLOCK_SKEW_FUTURE_MS,
  MAX_OFFLINE_REPLAY_DELAY_MS,
} from "./workStartRounding";
import { zonedWallTimeToUtc } from "./timezone";

let pass = 0;
let fail = 0;

function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

// August 11 2026 — ordinary EDT (UTC-4) day in America/Toronto, no DST
// transition involved. Used for every non-DST example below so the
// clockwise/counter-clockwise math is isolated from timezone-conversion
// concerns (those get their own dedicated DST tests further down).
function toronto(h: number, m: number, s = 0): Date {
  return zonedWallTimeToUtc(2026, 8, 11, h, m, s, "America/Toronto");
}

// ---------------------------------------------------------------------------
// Spec examples, verbatim (5-minute interval)
// ---------------------------------------------------------------------------

check(
  roundWorkStart(toronto(7, 10), 5, "clockwise", "America/Toronto").getTime() === toronto(7, 10).getTime(),
  "clockwise 5min: 7:10 -> 7:10 (exact boundary unchanged)"
);
check(
  roundWorkStart(toronto(7, 11), 5, "clockwise", "America/Toronto").getTime() === toronto(7, 15).getTime(),
  "clockwise 5min: 7:11 -> 7:15"
);
check(
  roundWorkStart(toronto(7, 14), 5, "clockwise", "America/Toronto").getTime() === toronto(7, 15).getTime(),
  "clockwise 5min: 7:14 -> 7:15"
);

check(
  roundWorkStart(toronto(7, 10), 5, "counter_clockwise", "America/Toronto").getTime() === toronto(7, 10).getTime(),
  "counter-clockwise 5min: 7:10 -> 7:10 (exact boundary unchanged)"
);
check(
  roundWorkStart(toronto(7, 11), 5, "counter_clockwise", "America/Toronto").getTime() === toronto(7, 10).getTime(),
  "counter-clockwise 5min: 7:11 -> 7:10"
);
check(
  roundWorkStart(toronto(7, 14), 5, "counter_clockwise", "America/Toronto").getTime() === toronto(7, 10).getTime(),
  "counter-clockwise 5min: 7:14 -> 7:10"
);

// ---------------------------------------------------------------------------
// Sub-minute precision: a minute value that's a multiple of the interval is
// NOT itself "exact" if there are leftover seconds.
// ---------------------------------------------------------------------------

check(
  roundWorkStart(toronto(7, 10, 30), 5, "clockwise", "America/Toronto").getTime() === toronto(7, 15).getTime(),
  "clockwise 5min: 7:10:30 (not exact despite :10 being a multiple of 5) -> 7:15"
);
check(
  roundWorkStart(toronto(7, 10, 30), 5, "counter_clockwise", "America/Toronto").getTime() === toronto(7, 10).getTime(),
  "counter-clockwise 5min: 7:10:30 -> 7:10 (rounds back to the boundary it's past)"
);

// ---------------------------------------------------------------------------
// Arbitrary interval (7 minutes — doesn't evenly divide an hour)
// ---------------------------------------------------------------------------

check(
  roundWorkStart(toronto(7, 0), 7, "clockwise", "America/Toronto").getTime() === toronto(7, 0).getTime(),
  "clockwise 7min: 7:00 -> 7:00 (exact)"
);
check(
  roundWorkStart(toronto(7, 1), 7, "clockwise", "America/Toronto").getTime() === toronto(7, 7).getTime(),
  "clockwise 7min: 7:01 -> 7:07"
);
check(
  roundWorkStart(toronto(7, 8), 7, "clockwise", "America/Toronto").getTime() === toronto(7, 14).getTime(),
  "clockwise 7min: 7:08 -> 7:14"
);
check(
  roundWorkStart(toronto(7, 13), 7, "counter_clockwise", "America/Toronto").getTime() === toronto(7, 7).getTime(),
  "counter-clockwise 7min: 7:13 -> 7:07"
);

// interval = 1 minute: only an exact whole minute (0 seconds) is unchanged.
check(
  roundWorkStart(toronto(7, 11, 0), 1, "clockwise", "America/Toronto").getTime() === toronto(7, 11).getTime(),
  "clockwise 1min: 7:11:00 -> 7:11 (exact)"
);
check(
  roundWorkStart(toronto(7, 11, 1), 1, "clockwise", "America/Toronto").getTime() === toronto(7, 12).getTime(),
  "clockwise 1min: 7:11:01 -> 7:12"
);
check(
  roundWorkStart(toronto(7, 11, 1), 1, "counter_clockwise", "America/Toronto").getTime() === toronto(7, 11).getTime(),
  "counter-clockwise 1min: 7:11:01 -> 7:11"
);

// interval = 60 minutes: hour boundaries only.
check(
  roundWorkStart(toronto(7, 0), 60, "clockwise", "America/Toronto").getTime() === toronto(7, 0).getTime(),
  "clockwise 60min: 7:00 -> 7:00 (exact)"
);
check(
  roundWorkStart(toronto(7, 30), 60, "clockwise", "America/Toronto").getTime() === toronto(8, 0).getTime(),
  "clockwise 60min: 7:30 -> 8:00"
);
check(
  roundWorkStart(toronto(7, 30), 60, "counter_clockwise", "America/Toronto").getTime() === toronto(7, 0).getTime(),
  "counter-clockwise 60min: 7:30 -> 7:00"
);

// ---------------------------------------------------------------------------
// Hour rollover
// ---------------------------------------------------------------------------

check(
  roundWorkStart(toronto(7, 58), 5, "clockwise", "America/Toronto").getTime() === toronto(8, 0).getTime(),
  "clockwise 5min hour rollover: 7:58 -> 8:00"
);
check(
  roundWorkStart(toronto(8, 2), 5, "counter_clockwise", "America/Toronto").getTime() === toronto(8, 0).getTime(),
  "counter-clockwise 5min hour rollover: 8:02 -> 8:00"
);

// ---------------------------------------------------------------------------
// Midnight rollover — crosses into the adjacent calendar date in either
// direction.
// ---------------------------------------------------------------------------

check(
  roundWorkStart(toronto(23, 58), 5, "clockwise", "America/Toronto").getTime() ===
    zonedWallTimeToUtc(2026, 8, 12, 0, 0, 0, "America/Toronto").getTime(),
  "clockwise 5min midnight rollover: Aug 11 23:58 -> Aug 12 00:00"
);
// Counter-clockwise can never roll backward into the previous calendar day:
// 00:00 is always itself a valid boundary for any interval (every interval
// evenly divides the start of a day), so the "previous boundary" from any
// time shortly after local midnight is always still 00:00 that same day —
// unlike clockwise, which genuinely can roll forward into the next day
// (tested above via 23:58 -> next day 00:00).
check(
  roundWorkStart(toronto(0, 2), 5, "counter_clockwise", "America/Toronto").getTime() === toronto(0, 0).getTime(),
  "counter-clockwise 5min near midnight: Aug 11 00:02 -> Aug 11 00:00 (never crosses backward into the prior day)"
);
check(
  roundWorkStart(toronto(0, 0), 5, "clockwise", "America/Toronto").getTime() === toronto(0, 0).getTime(),
  "clockwise 5min: exact midnight unchanged"
);
check(
  roundWorkStart(toronto(0, 0), 5, "counter_clockwise", "America/Toronto").getTime() === toronto(0, 0).getTime(),
  "counter-clockwise 5min: exact midnight unchanged"
);

// ---------------------------------------------------------------------------
// Daylight saving boundaries — 2026-03-08 is America/Toronto's spring-
// forward (2:00am -> 3:00am EST->EDT) and 2026-11-01 is its fall-back
// (2:00am EDT -> 1:00am EST). A 7am work-start tap is nowhere near either
// transition's wall-clock hour, so the correctness being tested here is
// that rounding on a transition DAY still produces the right UTC instant
// for the (already-transitioned) offset in effect at that hour — i.e. that
// roundWorkStart correctly delegates to zonedWallTimeToUtc's own
// convergence loop rather than assuming a fixed offset. Cross-checked
// against that same trusted primitive instead of a hardcoded string, same
// pattern as dailyCutoff.test.ts's own DST cross-checks.
// ---------------------------------------------------------------------------

check(
  roundWorkStart(
    zonedWallTimeToUtc(2026, 3, 8, 7, 11, 0, "America/Toronto"),
    5,
    "clockwise",
    "America/Toronto"
  ).getTime() === zonedWallTimeToUtc(2026, 3, 8, 7, 15, 0, "America/Toronto").getTime(),
  "spring-forward day: clockwise 5min 7:11 -> 7:15 in the correct (post-transition EDT) offset"
);
check(
  roundWorkStart(
    zonedWallTimeToUtc(2026, 11, 1, 7, 14, 0, "America/Toronto"),
    5,
    "counter_clockwise",
    "America/Toronto"
  ).getTime() === zonedWallTimeToUtc(2026, 11, 1, 7, 10, 0, "America/Toronto").getTime(),
  "fall-back day: counter-clockwise 5min 7:14 -> 7:10 in the correct (post-transition EST) offset"
);
// The transition itself: local 2:30am on spring-forward day doesn't exist
// (clocks jump 2:00 -> 3:00) — zonedWallTimeToUtc's own convergence loop is
// what resolves this, not roundWorkStart; this just confirms rounding math
// through that boundary doesn't throw or silently produce a nonsense
// instant on the one input that could plausibly break it (an interval that
// lands the rounded result inside the skipped hour).
check(
  !isNaN(
    roundWorkStart(
      zonedWallTimeToUtc(2026, 3, 8, 1, 58, 0, "America/Toronto"),
      5,
      "clockwise",
      "America/Toronto"
    ).getTime()
  ),
  "spring-forward transition hour: rounding through the skipped 2am-3am window still produces a valid instant"
);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

check(isValidRoundingIntervalMinutes(1), "interval 1 is valid (lower bound)");
check(isValidRoundingIntervalMinutes(60), "interval 60 is valid (upper bound)");
check(isValidRoundingIntervalMinutes(30), "interval 30 is valid");
check(!isValidRoundingIntervalMinutes(0), "interval 0 is invalid (below lower bound)");
check(!isValidRoundingIntervalMinutes(61), "interval 61 is invalid (above upper bound)");
check(!isValidRoundingIntervalMinutes(5.5), "interval 5.5 is invalid (not an integer)");
check(!isValidRoundingIntervalMinutes("5"), "interval '5' (string) is invalid");
check(!isValidRoundingIntervalMinutes(null), "interval null is invalid");

check(isRoundingDirection("clockwise"), "'clockwise' is a valid direction");
check(isRoundingDirection("counter_clockwise"), "'counter_clockwise' is a valid direction");
check(!isRoundingDirection("backward"), "'backward' is not a valid direction");
check(!isRoundingDirection(""), "empty string is not a valid direction");

let threw = false;
try {
  roundWorkStart(toronto(7, 11), 0, "clockwise", "America/Toronto");
} catch {
  threw = true;
}
check(threw, "roundWorkStart throws for an out-of-range interval rather than silently misbehaving");

// ---------------------------------------------------------------------------
// resolveOriginalStartedAt — the offline-sync clamping used to trust (or
// fall back from) a phone-reported clientStartedAt.
// ---------------------------------------------------------------------------

{
  const now = new Date("2026-08-11T15:00:00.000Z");

  check(
    resolveOriginalStartedAt(undefined, now).getTime() === now.getTime(),
    "resolveOriginalStartedAt: missing clientStartedAt falls back to now"
  );
  check(
    resolveOriginalStartedAt(12345, now).getTime() === now.getTime(),
    "resolveOriginalStartedAt: non-string clientStartedAt falls back to now"
  );
  check(
    resolveOriginalStartedAt("not a date", now).getTime() === now.getTime(),
    "resolveOriginalStartedAt: unparseable clientStartedAt falls back to now"
  );

  // A plausible same-request tap a few seconds before "now" — the ordinary
  // online case — is trusted as-is.
  const fiveSecondsAgo = new Date(now.getTime() - 5000);
  check(
    resolveOriginalStartedAt(fiveSecondsAgo.toISOString(), now).getTime() === fiveSecondsAgo.getTime(),
    "resolveOriginalStartedAt: a recent, plausible timestamp is trusted as-is"
  );

  // A genuinely offline-delayed sync — hours old, well within the generous
  // backward bound — is trusted, not clamped to now.
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  check(
    resolveOriginalStartedAt(sixHoursAgo.toISOString(), now).getTime() === sixHoursAgo.getTime(),
    "resolveOriginalStartedAt: a 6-hour-old offline tap is trusted, not clamped to sync time"
  );

  // Exactly at the backward bound is still trusted; one millisecond further
  // back falls back to now.
  const atBackwardBound = new Date(now.getTime() - MAX_OFFLINE_REPLAY_DELAY_MS);
  check(
    resolveOriginalStartedAt(atBackwardBound.toISOString(), now).getTime() === atBackwardBound.getTime(),
    "resolveOriginalStartedAt: exactly at the backward bound is trusted"
  );
  const pastBackwardBound = new Date(now.getTime() - MAX_OFFLINE_REPLAY_DELAY_MS - 1);
  check(
    resolveOriginalStartedAt(pastBackwardBound.toISOString(), now).getTime() === now.getTime(),
    "resolveOriginalStartedAt: one ms past the backward bound falls back to now"
  );

  // Small forward skew (phone clock slightly ahead of the server) is
  // tolerated; a large forward skew is not.
  const withinForwardSkew = new Date(now.getTime() + MAX_CLIENT_CLOCK_SKEW_FUTURE_MS);
  check(
    resolveOriginalStartedAt(withinForwardSkew.toISOString(), now).getTime() === withinForwardSkew.getTime(),
    "resolveOriginalStartedAt: exactly at the forward skew bound is trusted"
  );
  const pastForwardSkew = new Date(now.getTime() + MAX_CLIENT_CLOCK_SKEW_FUTURE_MS + 1);
  check(
    resolveOriginalStartedAt(pastForwardSkew.toISOString(), now).getTime() === now.getTime(),
    "resolveOriginalStartedAt: one ms past the forward skew bound falls back to now"
  );

  // An obviously broken clock (unset-clock epoch date) is far outside the
  // backward bound and falls back to now rather than recording a bogus
  // 1970 timestamp.
  check(
    resolveOriginalStartedAt(new Date(0).toISOString(), now).getTime() === now.getTime(),
    "resolveOriginalStartedAt: an epoch-zero clientStartedAt (broken clock) falls back to now"
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
