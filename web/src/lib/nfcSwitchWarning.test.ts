import { describe, expect, it } from "vitest";
import { checkSwitchWarning, CurrentWorkContext } from "./nfcSwitchWarning";

const NOW = new Date("2026-08-12T12:00:00.000Z");

function ctx(overrides: Partial<CurrentWorkContext> = {}): CurrentWorkContext {
  return {
    status: "work",
    currentActivity: {
      id: "activity-1",
      startedAt: NOW.toISOString(),
      accumulatedWorkedSecondsBeforeCurrentEntry: 0,
      minimumDurationMinutes: 15,
      row: { id: "row-1" },
      carrier: null,
    },
    recentJobs: [],
    ...overrides,
  };
}

describe("checkSwitchWarning", () => {
  it("returns null when idle (nothing being interrupted)", () => {
    expect(checkSwitchWarning(ctx({ status: "idle", currentActivity: null }), "activity-2", "row-2", null, NOW)).toBeNull();
  });

  it("returns null when on break", () => {
    expect(checkSwitchWarning(ctx({ status: "break" }), "activity-2", "row-2", null, NOW)).toBeNull();
  });

  it("returns null when re-selecting exactly what's already running", () => {
    expect(checkSwitchWarning(ctx(), "activity-1", "row-1", null, NOW)).toBeNull();
  });

  it("returns null for a normal switch with no matching recent job and enough elapsed time", () => {
    const c = ctx({
      currentActivity: {
        id: "activity-1",
        startedAt: new Date(NOW.getTime() - 20 * 60000).toISOString(),
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: 15,
        row: { id: "row-1" },
        carrier: null,
      },
    });
    expect(checkSwitchWarning(c, "activity-1", "row-2", null, NOW)).toBeNull();
  });

  it("flags sameRow when the target matches the most recently completed job", () => {
    const c = ctx({
      recentJobs: [{ activityId: "activity-1", row: { id: "row-2" }, carrier: null }],
    });
    expect(checkSwitchWarning(c, "activity-1", "row-2", null, NOW)).toEqual({ kind: "sameRow" });
  });

  it("does not flag sameRow when only the activity matches but not the row", () => {
    const c = ctx({
      recentJobs: [{ activityId: "activity-1", row: { id: "row-99" }, carrier: null }],
    });
    const result = checkSwitchWarning(c, "activity-1", "row-2", null, NOW);
    expect(result?.kind).not.toBe("sameRow");
  });

  it("only checks the most recent job (index 0), not older ones", () => {
    const c = ctx({
      recentJobs: [
        { activityId: "activity-1", row: { id: "row-99" }, carrier: null },
        { activityId: "activity-1", row: { id: "row-2" }, carrier: null },
      ],
    });
    const result = checkSwitchWarning(c, "activity-1", "row-2", null, NOW);
    expect(result?.kind).not.toBe("sameRow");
  });

  it("flags minimumDuration when elapsed is under the current activity's minimum", () => {
    // Just started, 0 elapsed, 15-minute minimum.
    const result = checkSwitchWarning(ctx(), "activity-1", "row-2", null, NOW);
    expect(result).toEqual({ kind: "minimumDuration", elapsedSeconds: 0, minimumMinutes: 15 });
  });

  it("does not warn at exactly the minimum boundary", () => {
    const c = ctx({
      currentActivity: {
        id: "activity-1",
        startedAt: new Date(NOW.getTime() - 15 * 60000).toISOString(), // exactly 15 minutes ago
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: 15,
        row: { id: "row-1" },
        carrier: null,
      },
    });
    expect(checkSwitchWarning(c, "activity-1", "row-2", null, NOW)).toBeNull();
  });

  it("warns one second before the minimum boundary", () => {
    const c = ctx({
      currentActivity: {
        id: "activity-1",
        startedAt: new Date(NOW.getTime() - (15 * 60000 - 1000)).toISOString(), // 14:59 ago
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: 15,
        row: { id: "row-1" },
        carrier: null,
      },
    });
    const result = checkSwitchWarning(c, "activity-1", "row-2", null, NOW);
    expect(result).toEqual({ kind: "minimumDuration", elapsedSeconds: 899, minimumMinutes: 15 });
  });

  it("includes accumulatedWorkedSecondsBeforeCurrentEntry (break-interrupted chain) in elapsed", () => {
    const c = ctx({
      currentActivity: {
        id: "activity-1",
        startedAt: NOW.toISOString(), // just resumed, 0 seconds on this entry
        accumulatedWorkedSecondsBeforeCurrentEntry: 20 * 60, // but 20 minutes before the break
        minimumDurationMinutes: 15,
        row: { id: "row-1" },
        carrier: null,
      },
    });
    expect(checkSwitchWarning(c, "activity-1", "row-2", null, NOW)).toBeNull();
  });

  it("never warns when the current activity's minimum is 0", () => {
    const c = ctx({
      currentActivity: {
        id: "activity-1",
        startedAt: NOW.toISOString(),
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: 0,
        row: { id: "row-1" },
        carrier: null,
      },
    });
    expect(checkSwitchWarning(c, "activity-1", "row-2", null, NOW)).toBeNull();
  });

  it("prioritizes sameRow over minimumDuration when both conditions are true", () => {
    const c = ctx({
      recentJobs: [{ activityId: "activity-1", row: { id: "row-2" }, carrier: null }],
      // currentActivity started NOW, so elapsed is 0 — well under the
      // 15-minute minimum too, but sameRow must win.
    });
    expect(checkSwitchWarning(c, "activity-1", "row-2", null, NOW)).toEqual({ kind: "sameRow" });
  });

  it("works the same way for a carrier ('bin') target", () => {
    const c = ctx({
      currentActivity: {
        id: "activity-1",
        startedAt: NOW.toISOString(),
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: 15,
        row: null,
        carrier: { id: "carrier-1" },
      },
      recentJobs: [{ activityId: "activity-1", row: null, carrier: { id: "carrier-2" } }],
    });
    expect(checkSwitchWarning(c, "activity-1", null, "carrier-2", NOW)).toEqual({ kind: "sameRow" });
  });
});
