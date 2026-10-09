import { describe, expect, it } from "vitest";
import { buildSlideSequence, formatAge, indexAfterUpdate, isStale, reportingPeriodFor, ROWS_PER_PAGE } from "./displaySlideshow";
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
    expect(seq.map((s) => s.key)).toEqual(["map", "pruning:1", "picking:1"]);
    expect(seq.map((s) => s.seconds)).toEqual([20, 25, 15]);
  });

  it("paginates long rankings so every page stays readable", () => {
    const seq = buildSlideSequence([slide("picking", 23)], 20);
    expect(seq).toHaveLength(1 + 3);
    const pages = seq.filter((s) => s.kind === "activity");
    expect(pages.map((p) => (p.kind === "activity" ? [p.page, p.pageCount, p.employees.length, p.firstRank] : null))).toEqual([
      [1, 3, ROWS_PER_PAGE, 1],
      [2, 3, ROWS_PER_PAGE, 11],
      [3, 3, 3, 21],
    ]);
  });

  it("keeps a notice-only slide as one page", () => {
    const empty = { ...slide("cleaning", 0), status: "no_speed" as const, notice: "No speed" };
    const seq = buildSlideSequence([empty], 20);
    expect(seq).toHaveLength(2);
  });
});

describe("indexAfterUpdate", () => {
  it("stays on the same slide after a data refresh, or falls back to the map", () => {
    const before = buildSlideSequence([slide("a", 3), slide("b", 3)], 20);
    const after = buildSlideSequence([slide("b", 3)], 20);
    expect(indexAfterUpdate(before[2], after)).toBe(1);
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
