// Covers the client-side preview shown in AddBreakModal instead of the old
// blocking conflict error — purely informational, mirrors
// planBreakInsertion's own classification (server/src/lib/manualTimeEntries.ts).
import { describe, expect, it } from "vitest";
import { describeBreakSplitEffect } from "./breakSplitPreview";

const GENERAL = {
  activityName: "General",
  startedAt: "2026-08-10T11:00:00.000Z", // 7:00 AM in America/Toronto (UTC-4 in August)
  endedAt: "2026-08-10T21:00:00.000Z", // 5:00 PM
};

describe("describeBreakSplitEffect", () => {
  it("describes a split when the break falls entirely inside one activity — Dave's exact scenario", () => {
    const msg = describeBreakSplitEffect(
      [GENERAL],
      "2026-08-10T16:00:00.000Z", // 12:00 PM
      "2026-08-10T17:00:00.000Z" // 1:00 PM
    );
    expect(msg).toBe("This will split General around the 12:00 PM–1:00 PM break.");
  });

  it("describes a trim when the break touches only the end of an activity", () => {
    const msg = describeBreakSplitEffect([GENERAL], "2026-08-10T20:30:00.000Z", "2026-08-10T21:00:00.000Z");
    expect(msg).toMatch(/trim General to end at/);
  });

  it("describes a trim when the break touches only the start of an activity", () => {
    const msg = describeBreakSplitEffect([GENERAL], "2026-08-10T11:00:00.000Z", "2026-08-10T11:30:00.000Z");
    expect(msg).toMatch(/trim General to start at/);
  });

  it("describes removal when the break fully covers a short activity", () => {
    const shortActivity = { activityName: "Quick Task", startedAt: "2026-08-10T16:00:00.000Z", endedAt: "2026-08-10T16:10:00.000Z" };
    const msg = describeBreakSplitEffect([shortActivity], "2026-08-10T15:45:00.000Z", "2026-08-10T16:15:00.000Z");
    expect(msg).toMatch(/remove Quick Task/);
  });

  it("returns null when the break doesn't overlap any run", () => {
    const msg = describeBreakSplitEffect([GENERAL], "2026-08-11T16:00:00.000Z", "2026-08-11T17:00:00.000Z");
    expect(msg).toBeNull();
  });

  it("returns null for an incomplete or invalid range", () => {
    expect(describeBreakSplitEffect([GENERAL], "", "")).toBeNull();
    expect(describeBreakSplitEffect([GENERAL], "2026-08-10T17:00:00.000Z", "2026-08-10T16:00:00.000Z")).toBeNull();
  });

  it("returns null for an in-progress (open-ended) activity — the server still rejects that case outright", () => {
    const openRun = { activityName: "General", startedAt: "2026-08-10T11:00:00.000Z", endedAt: null };
    const msg = describeBreakSplitEffect([openRun], "2026-08-10T16:00:00.000Z", "2026-08-10T17:00:00.000Z");
    expect(msg).toBeNull();
  });

  it("describes multiple affected activities generically when the break spans more than one", () => {
    const runA = { activityName: "A", startedAt: "2026-08-10T11:00:00.000Z", endedAt: "2026-08-10T13:30:00.000Z" };
    const runB = { activityName: "B", startedAt: "2026-08-10T13:30:00.000Z", endedAt: "2026-08-10T14:30:00.000Z" };
    const msg = describeBreakSplitEffect([runA, runB], "2026-08-10T13:00:00.000Z", "2026-08-10T14:00:00.000Z");
    expect(msg).toMatch(/2 existing activities/);
  });
});
