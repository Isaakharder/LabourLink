// Pure-function tests for the client-side offline midnight-rollover
// display fold — America/Toronto DST dates deliberately mirror
// server/src/lib/midnightRollover.test.ts's own known-good boundary values
// exactly, so the two can never quietly drift apart on what "the next
// local midnight" means.
import { describe, expect, it } from "vitest";
import {
  calendarDateInTimezone,
  foldLocalMidnightRollover,
  msUntilNextLocalMidnight,
  FALLBACK_APP_TIMEZONE,
} from "./localMidnightRollover";
import { MeResponse } from "../context/WorkSessionContext";

const TZ = "America/Toronto";

function workMe(startedAt: string, overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    employee: { id: "emp-1", firstName: "Ana", lastName: "Rios", preferredLanguage: null, securityRole: "Employee" },
    status: "work",
    currentActivity: {
      id: "activity-1",
      name: "Picking Peppers",
      startedAt,
      accumulatedWorkedSecondsBeforeCurrentEntry: 120,
      minimumDurationMinutes: 5,
      row: { id: "row-1", label: "Phase 1 · Row 13" },
      carrier: { id: "carrier-1", name: "Bin 57" },
    },
    since: null,
    previousActivity: null,
    recentJobs: [],
    appTimezone: TZ,
    ...overrides,
  };
}

function breakMe(since: string, overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    employee: { id: "emp-1", firstName: "Ana", lastName: "Rios", preferredLanguage: null, securityRole: "Employee" },
    status: "break",
    currentActivity: null,
    since,
    previousActivity: { id: "activity-1", name: "Picking Peppers", accumulatedWorkedSeconds: 3600 },
    recentJobs: [],
    appTimezone: TZ,
    ...overrides,
  };
}

describe("foldLocalMidnightRollover", () => {
  it("same calendar day — returns the exact same object reference, no fold", () => {
    const me = workMe("2026-08-05T14:00:00.000Z");
    const now = new Date("2026-08-05T20:00:00.000Z"); // same UTC day, same local (EDT) day
    const result = foldLocalMidnightRollover(me, now, TZ);
    expect(result).toBe(me);
  });

  it("crosses exactly one local midnight — folds to the boundary, preserves activity/row/carrier/density, resets accumulated", () => {
    const me = workMe("2026-08-05T14:00:00.000Z"); // Aug 5, afternoon EDT
    const now = new Date("2026-08-06T18:00:00.000Z"); // Aug 6, afternoon EDT
    const result = foldLocalMidnightRollover(me, now, TZ);
    expect(result).not.toBe(me);
    // Matches server midnightRollover.test.ts's own known-good value for
    // this exact date pair.
    expect(result.currentActivity!.startedAt).toBe("2026-08-06T04:00:00.000Z");
    expect(result.currentActivity!.accumulatedWorkedSecondsBeforeCurrentEntry).toBe(0);
    expect(result.currentActivity!.id).toBe("activity-1");
    expect(result.currentActivity!.name).toBe("Picking Peppers");
    expect(result.currentActivity!.row).toEqual({ id: "row-1", label: "Phase 1 · Row 13" });
    expect(result.currentActivity!.carrier).toEqual({ id: "carrier-1", name: "Bin 57" });
  });

  it("crosses several missed midnights (phone off for days) — lands on TODAY's boundary, not an intermediate one", () => {
    const me = workMe("2026-08-03T14:00:00.000Z"); // 3 days before `now`
    const now = new Date("2026-08-06T12:00:00.000Z");
    const result = foldLocalMidnightRollover(me, now, TZ);
    expect(result.currentActivity!.startedAt).toBe("2026-08-06T04:00:00.000Z");
    expect(calendarDateInTimezone(new Date(result.currentActivity!.startedAt), TZ)).toBe(
      calendarDateInTimezone(now, TZ)
    );
  });

  it("break spanning midnight — since folds the same way, work fields untouched", () => {
    const me = breakMe("2026-08-05T22:00:00.000Z"); // late evening EDT, Aug 5
    const now = new Date("2026-08-06T13:00:00.000Z");
    const result = foldLocalMidnightRollover(me, now, TZ);
    expect(result.since).toBe("2026-08-06T04:00:00.000Z");
    expect(result.status).toBe("break");
    expect(result.previousActivity).toEqual(me.previousActivity);
  });

  it("spring-forward boundary matches the server's own known-good value", () => {
    const me = workMe("2026-03-07T14:00:00.000Z"); // day before spring-forward, EST
    const now = new Date("2026-03-08T14:00:00.000Z");
    const result = foldLocalMidnightRollover(me, now, TZ);
    expect(result.currentActivity!.startedAt).toBe("2026-03-08T05:00:00.000Z");
  });

  it("fall-back boundary matches the server's own known-good value", () => {
    const me = workMe("2026-10-31T14:00:00.000Z");
    const now = new Date("2026-11-01T14:00:00.000Z");
    const result = foldLocalMidnightRollover(me, now, TZ);
    expect(result.currentActivity!.startedAt).toBe("2026-11-01T04:00:00.000Z");
  });

  it("is idempotent — folding an already-folded result again is a no-op", () => {
    const me = workMe("2026-08-05T14:00:00.000Z");
    const now = new Date("2026-08-06T18:00:00.000Z");
    const once = foldLocalMidnightRollover(me, now, TZ);
    const twice = foldLocalMidnightRollover(once, now, TZ);
    expect(twice).toBe(once);
  });

  it("idle status is returned unchanged", () => {
    const me: MeResponse = {
      employee: { id: "emp-1", firstName: "Ana", lastName: "Rios", preferredLanguage: null, securityRole: "Employee" },
      status: "idle",
      currentActivity: null,
      since: null,
      previousActivity: null,
      recentJobs: [],
      appTimezone: TZ,
    };
    const result = foldLocalMidnightRollover(me, new Date("2026-08-06T18:00:00.000Z"), TZ);
    expect(result).toBe(me);
  });

  it("falls back to the default org timezone when none is known yet (never-online cold start)", () => {
    const me = workMe("2026-08-05T14:00:00.000Z", { appTimezone: undefined });
    const now = new Date("2026-08-06T18:00:00.000Z");
    const result = foldLocalMidnightRollover(me, now); // no timezone arg — uses the default
    expect(FALLBACK_APP_TIMEZONE).toBe(TZ);
    expect(result.currentActivity!.startedAt).toBe("2026-08-06T04:00:00.000Z");
  });
});

describe("msUntilNextLocalMidnight", () => {
  it("computes the exact delay to the next local-midnight boundary", () => {
    const now = new Date("2026-08-05T20:00:00.000Z"); // 4:00 PM EDT
    const delay = msUntilNextLocalMidnight(now, TZ);
    // Next boundary is 2026-08-06T04:00:00.000Z (matches the server's own
    // known-good value for this date) — 8 hours away.
    expect(delay).toBe(8 * 60 * 60 * 1000);
  });

  it("is never negative and never absurdly large (always within ~one day plus a DST hour)", () => {
    const now = new Date("2026-03-08T04:00:01.000Z"); // 1 second after a boundary
    const delay = msUntilNextLocalMidnight(now, TZ);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThan(26 * 60 * 60 * 1000);
  });

  it("is safe to pass straight into setTimeout (well under its ~24.8-day max)", () => {
    const delay = msUntilNextLocalMidnight(new Date(), TZ);
    expect(delay).toBeLessThan(2147483647);
  });
});
