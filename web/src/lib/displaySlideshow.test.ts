import { describe, expect, it } from "vitest";
import { buildSlideSequence, formatAge, indexAfterUpdate, isStale, msUntilScheduleCheck, reportingPeriodFor } from "./displaySlideshow";
import { formatDays, summarizeSchedule } from "./displaySchedule";
import { ActivitySlide } from "./greenhouseLiveTypes";

function slide(id: string, employees: number, seconds = 15): ActivitySlide {
  return {
    activityId: id,
    activityName: id,
    speedUnit: "stems/hour",
    target: 500,
    minimumActivityHours: 0,
    topN: null,
    slideSeconds: seconds,
    atTargetColor: "#15803d",
    belowTargetColor: "#dc2626",
    status: "ok",
    notice: null,
    employees: Array.from({ length: employees }, (_, i) => ({
      firstName: `E${i + 1}`,
      lastInitial: "X.",
      speed: 1000 - i,
      activityHours: 5,
      quantityCounted: 100,
    })),
    belowMinimumHours: 0,
    employeesWithoutSpeed: 0,
    computedAt: "2026-10-12T12:00:00Z",
  };
}

describe("buildSlideSequence", () => {
  it("is just the map when nothing is sent to the TV or nothing has work", () => {
    expect(buildSlideSequence([], 20)).toEqual([{ kind: "map", key: "map", seconds: 20 }]);
    expect(buildSlideSequence(null, 20)).toHaveLength(1);
  });

  it("puts the map first, then each activity with its own duration", () => {
    const seq = buildSlideSequence([slide("pruning", 3, 25), slide("picking", 2)], 20);
    expect(seq.map((s) => s.key)).toEqual(["map", "pruning", "picking"]);
    expect(seq.map((s) => s.seconds)).toEqual([20, 25, 15]);
  });

  it("keeps every employee on ONE slide per activity — no pagination", () => {
    const seq = buildSlideSequence([slide("picking", 60)], 20);
    expect(seq).toHaveLength(2);
    const only = seq[1];
    expect(only.kind === "activity" && only.slide.employees.length).toBe(60);
  });

  it("keeps a notice-only slide as one slide", () => {
    const empty = { ...slide("cleaning", 0), status: "no_speed" as const, notice: "No speed" };
    expect(buildSlideSequence([empty], 20)).toHaveLength(2);
  });
});

describe("indexAfterUpdate", () => {
  it("stays on the same slide after a data refresh, or falls back to the map", () => {
    const before = buildSlideSequence([slide("a", 3), slide("b", 3)], 20);
    const after = buildSlideSequence([slide("b", 3)], 20);
    expect(indexAfterUpdate(before[2], after)).toBe(1); // still on "b"
    expect(indexAfterUpdate(before[1], after)).toBe(0);
    expect(indexAfterUpdate(undefined, after)).toBe(0);
  });
});

describe("data age", () => {
  it("formats how old retained data is", () => {
    expect(formatAge(20_000)).toBe("less than a minute");
    expect(formatAge(6 * 60_000)).toBe("6 min");
    expect(formatAge(125 * 60_000)).toBe("2 h 5 min");
    expect(formatAge(120 * 60_000)).toBe("2 h");
  });

  it("marks data stale after two missed polls", () => {
    expect(isStale(null, 100_000, 10_000)).toBe(false);
    expect(isStale(0, 20_000, 10_000)).toBe(false);
    expect(isStale(0, 20_001, 10_000)).toBe(true);
  });
});

describe("reportingPeriodFor (mirror of the server rule)", () => {
  it("matches the server's week rules", () => {
    expect(reportingPeriodFor("this_week", true, "2026-10-12")).toEqual({ dateStart: "2026-10-12", dateEnd: "2026-10-12", empty: false });
    expect(reportingPeriodFor("this_week", false, "2026-10-12").empty).toBe(true);
    expect(reportingPeriodFor("this_week", false, "2026-10-14")).toEqual({ dateStart: "2026-10-12", dateEnd: "2026-10-13", empty: false });
    expect(reportingPeriodFor("last_week", false, "2026-10-18")).toEqual({ dateStart: "2026-10-05", dateEnd: "2026-10-11", empty: false });
    expect(reportingPeriodFor("this_week", true, "2026-10-19").dateStart).toBe("2026-10-19");
  });
});

describe("schedules on the TV", () => {
  it("leaves the map out when it isn't sent to the TV or its schedule is off", () => {
    expect(buildSlideSequence([slide("a", 3)], 20, false).map((i) => i.key)).toEqual(["a"]);
    expect(buildSlideSequence([], 20, false)).toEqual([]);
    expect(buildSlideSequence([slide("a", 3)], 20).map((i) => i.key)).toEqual(["map", "a"]);
  });

  it("re-checks just after the next boundary, only when sooner than the regular poll", () => {
    const now = Date.parse("2026-10-12T14:00:00Z");
    expect(msUntilScheduleCheck("2026-10-12T14:00:30Z", now, 60_000)).toBe(31_000);
    expect(msUntilScheduleCheck("2026-10-12T14:05:00Z", now, 60_000)).toBeNull();
    expect(msUntilScheduleCheck("2026-10-12T13:59:00Z", now, 60_000)).toBe(1_000);
    expect(msUntilScheduleCheck(null, now, 60_000)).toBeNull();
  });
});

describe("schedule summaries (Display → Setup cards)", () => {
  it("describes days and times plainly", () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(formatDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatDays([6, 7])).toBe("Sat–Sun");
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(summarizeSchedule({ enabled: false, days: [], start: "06:00", end: "18:00" })).toBe("Always shown");
    expect(summarizeSchedule({ enabled: true, days: [1, 2, 3, 4, 5], start: "06:00", end: "18:00" })).toBe("Mon–Fri · 6:00 AM–6:00 PM");
    expect(summarizeSchedule({ enabled: true, days: [5], start: "22:00", end: "06:00" })).toBe("Fri · 10:00 PM–6:00 AM (next day)");
    expect(summarizeSchedule({ enabled: true, days: [6, 7], start: "00:00", end: "00:00" })).toBe("Sat–Sun · all day");
    expect(summarizeSchedule({ enabled: true, days: [1], start: "12:00", end: "12:00" })).toBe("Mon · 24 h from 12:00 PM");
  });
});
