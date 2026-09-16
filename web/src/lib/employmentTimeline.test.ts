import { describe, expect, it } from "vitest";
import {
  buildEmploymentTimelineRows,
  buildTimelineHeaderMarks,
  chooseHeaderGranularity,
  computeBarPosition,
  computeFitAllPxPerDay,
  computeFittedRange,
  daysBetweenDateStrs,
  filterEmploymentTimelineEmployees,
  MAX_PX_PER_DAY,
  percentInRange,
} from "./employmentTimeline";
import { EmploymentTimelineEmployee, EmploymentTimelineFilterState, EMPTY_FILTER_STATE } from "./employmentPeriodTypes";

function period(overrides: Partial<EmploymentTimelineEmployee["periods"][number]> = {}): EmploymentTimelineEmployee["periods"][number] {
  return {
    id: "p1",
    employeeId: "e1",
    startDate: "2026-01-01",
    expectedFinishDate: null,
    actualFinishDate: null,
    employmentType: null,
    workGroup: null,
    workGroupOtherDescription: null,
    notes: null,
    statuses: ["current"],
    timelineEffectiveEndDate: "2026-06-15",
    timelineLabel: "ongoing",
    synthesized: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function employee(overrides: Partial<EmploymentTimelineEmployee> = {}): EmploymentTimelineEmployee {
  return {
    id: "e1",
    firstName: "Alice",
    lastName: "Smith",
    nationality: null,
    jobGroup: null,
    isActive: true,
    workPermit: null,
    hasUsableDates: true,
    periods: [period()],
    ...overrides,
  };
}

describe("daysBetweenDateStrs", () => {
  it("counts calendar days, positive when `to` is later", () => {
    expect(daysBetweenDateStrs("2027-02-01", "2027-02-25")).toBe(24);
    expect(daysBetweenDateStrs("2027-02-25", "2027-02-01")).toBe(-24);
    expect(daysBetweenDateStrs("2026-01-01", "2026-01-01")).toBe(0);
  });
});

describe("computeFittedRange", () => {
  const TODAY = "2026-06-15";

  it("spans from the earliest period start to the latest timelineEffectiveEndDate", () => {
    const a = employee({ id: "a", periods: [period({ startDate: "2020-01-01", timelineEffectiveEndDate: "2021-01-01", timelineLabel: "completed" })] });
    const b = employee({ id: "b", periods: [period({ startDate: "2023-05-01", timelineEffectiveEndDate: "2027-01-01", timelineLabel: "employed" })] });
    const range = computeFittedRange([a, b], TODAY);
    expect(range).toEqual({ start: "2020-01-01", end: "2027-01-01" });
  });

  it("includes today when every included period's effective end is already in the past", () => {
    const a = employee({ periods: [period({ startDate: "2020-01-01", timelineEffectiveEndDate: "2020-06-01", timelineLabel: "completed" })] });
    const range = computeFittedRange([a], TODAY);
    expect(range).toEqual({ start: "2020-01-01", end: TODAY });
  });

  it("skips employees flagged hasUsableDates:false entirely — they don't affect the range", () => {
    const dated = employee({ id: "dated", periods: [period({ startDate: "2024-01-01", timelineEffectiveEndDate: "2024-06-01", timelineLabel: "completed" })] });
    const flagged = employee({ id: "flagged", hasUsableDates: false, periods: [] });
    const range = computeFittedRange([dated, flagged], TODAY);
    expect(range).toEqual({ start: "2024-01-01", end: TODAY });
  });

  it("returns null when nothing datable is included at all", () => {
    const flagged = employee({ hasUsableDates: false, periods: [] });
    expect(computeFittedRange([flagged], TODAY)).toBeNull();
  });

  it("recalculates from whatever list it's given — simulating 'recalculate after filters'", () => {
    const a = employee({ id: "a", periods: [period({ startDate: "2020-01-01", timelineEffectiveEndDate: "2021-01-01", timelineLabel: "completed" })] });
    const b = employee({ id: "b", periods: [period({ startDate: "2023-01-01", timelineEffectiveEndDate: "2024-01-01", timelineLabel: "completed" })] });
    expect(computeFittedRange([a, b], TODAY)).toEqual({ start: "2020-01-01", end: TODAY });
    // Once "a" is filtered out client-side, the range recomputed over the
    // remaining list narrows accordingly.
    expect(computeFittedRange([b], TODAY)).toEqual({ start: "2023-01-01", end: TODAY });
  });

  it("a saved displayStartOverride replaces the true earliest start on the left edge only", () => {
    const a = employee({ periods: [period({ startDate: "2018-01-01", timelineEffectiveEndDate: "2020-01-01", timelineLabel: "completed" })] });
    const range = computeFittedRange([a], TODAY, "2022-01-01");
    expect(range).toEqual({ start: "2022-01-01", end: TODAY });
  });

  it("the right edge is never affected by displayStartOverride", () => {
    const a = employee({ periods: [period({ startDate: "2018-01-01", timelineEffectiveEndDate: "2030-01-01", timelineLabel: "employed" })] });
    const range = computeFittedRange([a], TODAY, "2022-01-01");
    expect(range?.end).toBe("2030-01-01");
  });

  it("a null/omitted displayStartOverride falls back to the true earliest start, unchanged", () => {
    const a = employee({ periods: [period({ startDate: "2018-01-01", timelineEffectiveEndDate: "2020-01-01", timelineLabel: "completed" })] });
    expect(computeFittedRange([a], TODAY, null)).toEqual({ start: "2018-01-01", end: TODAY });
    expect(computeFittedRange([a], TODAY)).toEqual({ start: "2018-01-01", end: TODAY });
  });

  it("recalculates the fit-all range inside the configured display start after filters narrow the employee set", () => {
    const a = employee({ id: "a", periods: [period({ startDate: "2019-01-01", timelineEffectiveEndDate: "2019-06-01", timelineLabel: "completed" })] });
    const b = employee({ id: "b", periods: [period({ startDate: "2023-01-01", timelineEffectiveEndDate: "2024-01-01", timelineLabel: "completed" })] });
    // Saved cutoff is later than "a"'s real start — "a" alone would clip;
    // filtering it out entirely still keeps the same configured left edge.
    expect(computeFittedRange([a, b], TODAY, "2022-01-01")).toEqual({ start: "2022-01-01", end: TODAY });
    expect(computeFittedRange([b], TODAY, "2022-01-01")).toEqual({ start: "2022-01-01", end: TODAY });
  });
});

describe("percentInRange / computeBarPosition", () => {
  const range = { start: "2026-01-01", end: "2026-12-31" };

  it("start of range is 0%, end of range is 100%", () => {
    expect(percentInRange("2026-01-01", range)).toBe(0);
    expect(percentInRange("2026-12-31", range)).toBe(100);
  });

  it("clamps a date outside the range instead of going negative or past 100", () => {
    expect(percentInRange("2025-01-01", range)).toBe(0);
    expect(percentInRange("2027-01-01", range)).toBe(100);
  });

  it("a completed period positions between its start and its actual (recorded) end, not extended", () => {
    const p = period({ startDate: "2026-02-01", timelineEffectiveEndDate: "2026-03-01", timelineLabel: "completed" });
    const pos = computeBarPosition(p, range);
    expect(pos.leftPercent).toBeCloseTo(percentInRange("2026-02-01", range), 5);
    expect(pos.leftPercent + pos.widthPercent).toBeCloseTo(percentInRange("2026-03-01", range), 5);
  });

  it("an 'ongoing' period is drawn all the way to the range's right edge (100%), not clipped at its own effectiveEndDate", () => {
    const p = period({ startDate: "2026-02-01", timelineEffectiveEndDate: "2026-06-15", timelineLabel: "ongoing" });
    const pos = computeBarPosition(p, range);
    expect(pos.leftPercent + pos.widthPercent).toBeCloseTo(100, 5);
  });

  it("an 'expiredStillWorking' period is also drawn to the range's right edge", () => {
    const p = period({ startDate: "2026-02-01", timelineEffectiveEndDate: "2026-06-15", timelineLabel: "expiredStillWorking" });
    const pos = computeBarPosition(p, range);
    expect(pos.leftPercent + pos.widthPercent).toBeCloseTo(100, 5);
  });

  it("an 'employed' period (future finish/expiry) ends exactly at its own effectiveEndDate, not the range edge", () => {
    const p = period({ startDate: "2026-02-01", timelineEffectiveEndDate: "2026-08-01", timelineLabel: "employed" });
    const pos = computeBarPosition(p, range);
    expect(pos.leftPercent + pos.widthPercent).toBeCloseTo(percentInRange("2026-08-01", range), 5);
  });

  it("flags clippedStart when the period's real start is before the displayed range's left edge", () => {
    const p = period({ startDate: "2025-06-01", timelineEffectiveEndDate: "2026-06-15", timelineLabel: "ongoing" });
    const pos = computeBarPosition(p, range); // range starts 2026-01-01, period started 2025-06-01
    expect(pos.clippedStart).toBe(true);
    expect(pos.leftPercent).toBe(0); // drawn from the display boundary, not the true (earlier) start
  });

  it("does not flag clippedStart when the period starts at or after the range's left edge", () => {
    const atEdge = computeBarPosition(period({ startDate: "2026-01-01", timelineLabel: "ongoing" }), range);
    const afterEdge = computeBarPosition(period({ startDate: "2026-02-01", timelineLabel: "ongoing" }), range);
    expect(atEdge.clippedStart).toBe(false);
    expect(afterEdge.clippedStart).toBe(false);
  });
});

describe("computeFitAllPxPerDay", () => {
  it("divides the container width evenly across the whole range", () => {
    expect(computeFitAllPxPerDay(100, 1000)).toBe(10);
  });

  it("falls back to MAX_PX_PER_DAY for a degenerate (zero) range or container", () => {
    expect(computeFitAllPxPerDay(0, 1000)).toBe(MAX_PX_PER_DAY);
    expect(computeFitAllPxPerDay(100, 0)).toBe(MAX_PX_PER_DAY);
  });
});

describe("chooseHeaderGranularity", () => {
  it("picks the finest granularity whose marks are still comfortably spaced apart", () => {
    expect(chooseHeaderGranularity(100)).toBe("day"); // 100px/day — plenty of room for daily marks
    expect(chooseHeaderGranularity(10)).toBe("week"); // 70px/week
    expect(chooseHeaderGranularity(3)).toBe("month"); // ~90px/month
    expect(chooseHeaderGranularity(1)).toBe("quarter"); // ~91px/quarter
    expect(chooseHeaderGranularity(0.05)).toBe("year"); // even a year is < 64px — coarsest available still used
  });
});

describe("buildTimelineHeaderMarks", () => {
  it("month granularity: one mark per calendar month crossed, inclusive of both ends", () => {
    const marks = buildTimelineHeaderMarks({ start: "2026-01-15", end: "2026-04-05" }, 3);
    expect(marks.map((m) => m.key)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  it("month granularity labels a year boundary (and the very first mark) with the year, other months with just the abbreviation", () => {
    const marks = buildTimelineHeaderMarks({ start: "2025-11-01", end: "2026-02-01" }, 3);
    expect(marks.map((m) => m.label)).toEqual(["Nov 2025", "Dec", "Jan 2026", "Feb"]);
  });

  it("positions each mark by percentage within the range", () => {
    const marks = buildTimelineHeaderMarks({ start: "2026-01-01", end: "2026-12-31" }, 3);
    expect(marks[0].leftPercent).toBe(0);
    expect(marks[marks.length - 1].leftPercent).toBeGreaterThan(90);
  });

  it("year granularity: one mark per year crossed, when zoomed far out over a multi-year range", () => {
    const marks = buildTimelineHeaderMarks({ start: "2020-06-01", end: "2026-03-01" }, 0.05);
    expect(marks.map((m) => m.label)).toEqual(["2020", "2021", "2022", "2023", "2024", "2025", "2026"]);
  });

  it("quarter granularity: one mark per quarter, year shown at Q1 and the first mark", () => {
    const marks = buildTimelineHeaderMarks({ start: "2025-11-01", end: "2026-08-01" }, 1);
    expect(marks.map((m) => m.label)).toEqual(["Q4 2025", "Q1 2026", "Q2", "Q3"]);
  });

  it("week granularity: one mark per Monday-start week, when moderately zoomed in", () => {
    const marks = buildTimelineHeaderMarks({ start: "2026-01-05", end: "2026-01-26" }, 10);
    expect(marks.map((m) => m.key)).toEqual(["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"]);
  });

  it("day granularity: one mark per day, when zoomed in close", () => {
    const marks = buildTimelineHeaderMarks({ start: "2026-01-01", end: "2026-01-05" }, 100);
    expect(marks.map((m) => m.key)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  });
});

describe("filterEmploymentTimelineEmployees", () => {
  const alice = employee({
    id: "alice",
    firstName: "Alice",
    nationality: "Guatemalan",
    periods: [period({ id: "alice-1", workGroup: "Greenhouse", employmentType: "Seasonal", statuses: ["current"] })],
  });
  const bob = employee({
    id: "bob",
    firstName: "Bob",
    nationality: "Guatemalan",
    periods: [period({ id: "bob-1", workGroup: "Warehouse", employmentType: "Permanent", statuses: ["current"] })],
  });
  const carla = employee({
    id: "carla",
    firstName: "Carla",
    nationality: "Filipino",
    periods: [period({ id: "carla-1", workGroup: "Greenhouse", employmentType: "Seasonal", statuses: ["current"] })],
  });
  const dave = employee({
    id: "dave",
    firstName: "Dave",
    nationality: null,
    periods: [period({ id: "dave-1", workGroup: null, employmentType: null, statuses: ["current"] })],
  });
  const all = [alice, bob, carla, dave];

  it("no filters (EMPTY_FILTER_STATE) returns everyone", () => {
    expect(filterEmploymentTimelineEmployees(all, EMPTY_FILTER_STATE).map((e) => e.id)).toEqual(["alice", "bob", "carla", "dave"]);
  });

  it("combined filters: Guatemalan + Greenhouse + Seasonal returns only the exact match (Alice), not Bob (wrong Work Group) or Carla (wrong nationality)", () => {
    const filters: EmploymentTimelineFilterState = { ...EMPTY_FILTER_STATE, nationalities: ["Guatemalan"], workGroups: ["Greenhouse"], employmentTypes: ["Seasonal"] };
    expect(filterEmploymentTimelineEmployees(all, filters).map((e) => e.id)).toEqual(["alice"]);
  });

  it("OR within a category: two Work Group values returns employees matching either", () => {
    const filters: EmploymentTimelineFilterState = { ...EMPTY_FILTER_STATE, workGroups: ["Greenhouse", "Warehouse"] };
    expect(filterEmploymentTimelineEmployees(all, filters).map((e) => e.id).sort()).toEqual(["alice", "bob", "carla"]);
  });

  it("the literal 'Unspecified' value matches an employee/period with no classification", () => {
    const filters: EmploymentTimelineFilterState = { ...EMPTY_FILTER_STATE, workGroups: ["Unspecified"] };
    expect(filterEmploymentTimelineEmployees(all, filters).map((e) => e.id)).toEqual(["dave"]);
  });

  it("a qualifying employee keeps ALL of their periods, not just the matching one", () => {
    const multi = employee({
      id: "multi",
      nationality: "Thai",
      periods: [
        period({ id: "multi-old", workGroup: "Outdoor", employmentType: "Temporary", statuses: ["completed"] }),
        period({ id: "multi-new", workGroup: "Greenhouse", employmentType: "Seasonal", statuses: ["current"] }),
      ],
    });
    const filters: EmploymentTimelineFilterState = { ...EMPTY_FILTER_STATE, workGroups: ["Greenhouse"] };
    const result = filterEmploymentTimelineEmployees([multi], filters);
    expect(result).toHaveLength(1);
    expect(result[0].periods.map((p) => p.id)).toEqual(["multi-old", "multi-new"]);
  });

  it("employeeIds filter restricts to the selected employees regardless of other filters", () => {
    const filters: EmploymentTimelineFilterState = { ...EMPTY_FILTER_STATE, employeeIds: ["bob", "dave"] };
    expect(filterEmploymentTimelineEmployees(all, filters).map((e) => e.id).sort()).toEqual(["bob", "dave"]);
  });

  it("status filter uses the period's own computed statuses", () => {
    const overdueEmp = employee({ id: "overdue-emp", periods: [period({ id: "od-1", statuses: ["current", "overdue"] })] });
    const filters: EmploymentTimelineFilterState = { ...EMPTY_FILTER_STATE, statuses: ["overdue"] };
    expect(filterEmploymentTimelineEmployees([overdueEmp, alice], filters).map((e) => e.id)).toEqual(["overdue-emp"]);
  });
});

describe("buildEmploymentTimelineRows — table/export parity", () => {
  it("produces one row per period with the expected columns, Unspecified fallbacks, and the shared timelineLabel text as Status", () => {
    const emp = employee({
      nationality: null,
      periods: [
        period({
          id: "p-a",
          startDate: "2026-01-01",
          expectedFinishDate: "2026-06-01",
          actualFinishDate: null,
          employmentType: null,
          workGroup: "Greenhouse",
          timelineLabel: "employed",
        }),
      ],
    });
    const rows = buildEmploymentTimelineRows([emp]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      employeeName: "Alice Smith",
      nationality: "Unspecified",
      workGroup: "Greenhouse",
      employmentType: "Unspecified",
      startDate: "2026-01-01",
      expectedFinishDate: "2026-06-01",
      actualFinishDate: "",
      status: "Employed",
    });
  });

  it("uses the exact 'Expired — still working' / 'Ongoing' text for those timeline labels", () => {
    const expired = employee({ id: "e1", periods: [period({ timelineLabel: "expiredStillWorking" })] });
    const ongoing = employee({ id: "e2", periods: [period({ timelineLabel: "ongoing" })] });
    const rows = buildEmploymentTimelineRows([expired, ongoing]);
    expect(rows[0].status).toBe("Expired — still working");
    expect(rows[1].status).toBe("Ongoing");
  });

  it("an employee with no usable dates gets exactly one flagged placeholder row, not zero rows", () => {
    const flagged = employee({ hasUsableDates: false, periods: [] });
    const rows = buildEmploymentTimelineRows([flagged]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("No employment dates recorded");
    expect(rows[0].employeeName).toBe("Alice Smith");
  });

  it("is the exact same builder the table view and CSV/PDF export both call — same array reference shape for identical input", () => {
    const emp = employee();
    const rowsA = buildEmploymentTimelineRows([emp]);
    const rowsB = buildEmploymentTimelineRows([emp]);
    expect(rowsA).toEqual(rowsB);
  });

  it("multiple periods for one employee produce multiple rows, one per period", () => {
    const emp = employee({
      periods: [
        period({ id: "p1", startDate: "2024-01-01", actualFinishDate: "2024-06-01", timelineLabel: "completed" }),
        period({ id: "p2", startDate: "2024-07-01", timelineLabel: "ongoing" }),
      ],
    });
    const rows = buildEmploymentTimelineRows([emp]);
    expect(rows).toHaveLength(2);
    expect(rows[0].startDate).toBe("2024-01-01");
    expect(rows[1].startDate).toBe("2024-07-01");
  });
});
