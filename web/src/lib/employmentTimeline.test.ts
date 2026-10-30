import { describe, expect, it } from "vitest";
import {
  addDaysStr,
  buildEmploymentTimelineRows,
  buildTimelineScale,
  computeBarPosition,
  computeFitAllPxPerDay,
  computeFittedRange,
  computeVacationPosition,
  daysBetweenDateStrs,
  EMPLOYMENT_TIMELINE_COLUMNS,
  employmentTimelineRowCells,
  filterEmploymentTimelineEmployees,
  MAX_PX_PER_DAY,
  MIN_MONTH_LABEL_PX,
  percentInRange,
  pinnedYearLabel,
  rangeDayCount,
  TimelineRange,
} from "./employmentTimeline";
import { EMPTY_FILTER_STATE, EmploymentTimelineEmployee } from "./employmentPeriodTypes";

function emp(overrides: Partial<EmploymentTimelineEmployee> = {}): EmploymentTimelineEmployee {
  return {
    id: "e1",
    firstName: "Alice",
    lastName: "Smith",
    nationality: "Guatemalan",
    jobGroup: null,
    employeeGroup: { id: "g-gh", name: "Greenhouse Guys" },
    isActive: true,
    employmentStartDate: "2026-01-05",
    workPermitExpiryDate: "2026-09-30",
    endDifferentDate: null,
    vacationStartDate: null,
    vacationEndDate: null,
    workPermit: null,
    employmentType: "Seasonal",
    workGroup: "Greenhouse",
    hasUsableDates: true,
    timelineEndDate: "2026-09-30",
    timelineEndSource: "workPermitExpiry",
    timelineLabel: "employed",
    statuses: ["current"],
    ...overrides,
  };
}

const TODAY = "2026-10-30";

describe("date math", () => {
  it("counts calendar days, and a range's day slots include both ends", () => {
    expect(daysBetweenDateStrs("2026-01-01", "2026-01-31")).toBe(30);
    expect(rangeDayCount({ start: "2026-01-01", end: "2026-01-31" })).toBe(31);
    expect(addDaysStr("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysStr("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("a date's position is the left edge of its day", () => {
    const r = { start: "2026-01-01", end: "2026-01-10" }; // 10 slots
    expect(percentInRange("2026-01-01", r)).toBe(0);
    expect(percentInRange("2026-01-06", r)).toBe(50);
    expect(percentInRange("2026-01-11", r)).toBe(100); // day after the end = right edge
    expect(percentInRange("2025-12-01", r)).toBe(0);
    expect(percentInRange("2027-01-01", r)).toBe(100);
  });
});

describe("bar position: start, end priority, ongoing", () => {
  const r: TimelineRange = { start: "2026-01-01", end: "2026-12-31" }; // 365 slots
  const pct = (d: string) => percentInRange(d, r);

  it("starts on the Employment Start Date and ends after the permit expiry's day when there's no End Different Date", () => {
    const pos = computeBarPosition(emp(), r)!;
    expect(pos.leftPercent).toBe(pct("2026-01-05"));
    expect(pos.leftPercent + pos.widthPercent).toBeCloseTo(pct("2026-10-01"), 10); // through Sep 30 inclusive
  });

  it("ends on the End Different Date when one is entered (server already chose it as timelineEndDate)", () => {
    const pos = computeBarPosition(emp({ endDifferentDate: "2026-06-30", timelineEndDate: "2026-06-30", timelineEndSource: "endDifferentDate" }), r)!;
    expect(pos.leftPercent + pos.widthPercent).toBeCloseTo(pct("2026-07-01"), 10); // exactly on the Jul 1 gridline
  });

  it("an ongoing bar (no ending dates) runs to the right edge", () => {
    const pos = computeBarPosition(emp({ workPermitExpiryDate: null, timelineEndDate: null, timelineEndSource: null, timelineLabel: "ongoing" }), r)!;
    expect(pos.leftPercent + pos.widthPercent).toBe(100);
  });

  it("flags a start before the visible range and draws it from the edge", () => {
    const pos = computeBarPosition(emp({ employmentStartDate: "2025-06-01" }), r)!;
    expect(pos.clippedStart).toBe(true);
    expect(pos.leftPercent).toBe(0);
    expect(computeBarPosition(emp(), r)!.clippedStart).toBe(false);
  });

  it("a bar entirely outside the visible range isn't drawn (no edge sliver)", () => {
    expect(computeBarPosition(emp({ employmentStartDate: "2024-01-01", timelineEndDate: "2025-12-31" }), r)!.inRange).toBe(false);
    expect(computeBarPosition(emp({ employmentStartDate: "2027-01-01", timelineEndDate: null }), r)!.inRange).toBe(false);
    expect(computeBarPosition(emp({ employmentStartDate: "2024-01-01", timelineEndDate: "2026-01-01" }), r)!.inRange).toBe(true);
    expect(computeBarPosition(emp(), r)!.inRange).toBe(true);
  });

  it("no Employment Start Date: nothing to draw", () => {
    expect(computeBarPosition(emp({ hasUsableDates: false, employmentStartDate: null }), r)).toBeNull();
  });
});

describe("computeFittedRange", () => {
  it("spans the earliest start to the latest end, at least through today", () => {
    expect(computeFittedRange([emp(), emp({ id: "e2", employmentStartDate: "2025-03-01", timelineEndDate: "2027-02-04" })], TODAY)).toEqual({
      start: "2025-03-01",
      end: "2027-02-04",
    });
    expect(computeFittedRange([emp()], TODAY)).toEqual({ start: "2026-01-05", end: TODAY });
  });

  it("uses the saved 'Timeline starts' cutoff for the left edge only, ignores undated rows, null when nothing is datable", () => {
    expect(computeFittedRange([emp()], TODAY, "2026-03-01")).toEqual({ start: "2026-03-01", end: TODAY });
    expect(computeFittedRange([emp({ hasUsableDates: false, employmentStartDate: null })], TODAY)).toBeNull();
  });

  it("fit-all density divides the track width across the range", () => {
    expect(computeFitAllPxPerDay(100, 1000)).toBe(10);
    expect(computeFitAllPxPerDay(0, 1000)).toBe(MAX_PX_PER_DAY);
  });
});

describe("date scale: month and year labels", () => {
  // Every gridline position must equal the exact calendar-day offset of
  // its month start — independent of DST or leap years.
  function expectExactBoundaries(range: TimelineRange) {
    const scale = buildTimelineScale(range, 5);
    for (const seg of scale.months.filter((s) => s.isBoundary)) {
      expect(seg.key.endsWith("-01")).toBe(true);
      expect(seg.leftPercent).toBeCloseTo((daysBetweenDateStrs(range.start, seg.key) / rangeDayCount(range)) * 100, 10);
    }
    return scale;
  }

  it("labels every month Jan..Dec with the year above, across a year boundary", () => {
    const range = { start: "2025-11-01", end: "2026-02-28" };
    const scale = expectExactBoundaries(range);
    expect(scale.months.map((s) => [s.key, s.label, s.showLabel])).toEqual([
      ["2025-11-01", "Nov", true],
      ["2025-12-01", "Dec", true],
      ["2026-01-01", "Jan", true],
      ["2026-02-01", "Feb", true],
    ]);
    expect(scale.years.map((s) => [s.label, s.isBoundary, s.showLabel])).toEqual([
      ["2025", false, true],
      ["2026", true, true],
    ]);
    // The year boundary sits exactly on the January gridline.
    expect(scale.years[1].leftPercent).toBe(scale.months[2].leftPercent);
  });

  it("is exact through a leap February (2028-02-29) — March starts 60 days after Jan 1", () => {
    const range = { start: "2028-01-01", end: "2028-04-30" };
    const scale = expectExactBoundaries(range);
    const march = scale.months.find((s) => s.key === "2028-03-01")!;
    expect(march.leftPercent).toBeCloseTo((60 / 121) * 100, 10);
    const feb = scale.months.find((s) => s.key === "2028-02-01")!;
    expect(feb.widthPercent).toBeCloseTo((29 / 121) * 100, 10);
  });

  it("is exact across both Toronto DST changes (2026-03-08 and 2026-11-01): whole-day slots, no hour drift", () => {
    const range = { start: "2026-02-01", end: "2026-12-31" };
    const scale = expectExactBoundaries(range);
    const slot = 100 / rangeDayCount(range);
    // March (31 days, contains the spring-forward day) and November (30
    // days, contains the fall-back day) are exactly 31 and 30 slots wide.
    expect(scale.months.find((s) => s.key === "2026-03-01")!.widthPercent).toBeCloseTo(31 * slot, 10);
    expect(scale.months.find((s) => s.key === "2026-11-01")!.widthPercent).toBeCloseTo(30 * slot, 10);
    // A bar starting on each DST day starts exactly one whole slot after the day before.
    for (const day of ["2026-03-08", "2026-11-01"]) {
      const before = computeBarPosition(emp({ employmentStartDate: addDaysStr(day, -1) }), range)!.leftPercent;
      const on = computeBarPosition(emp({ employmentStartDate: day }), range)!.leftPercent;
      expect(on - before).toBeCloseTo(slot, 10);
    }
    // A bar ending Oct 31 meets the Nov 1 gridline exactly.
    const pos = computeBarPosition(emp({ employmentStartDate: "2026-02-01", timelineEndDate: "2026-10-31" }), range)!;
    expect(pos.leftPercent + pos.widthPercent).toBeCloseTo(scale.months.find((s) => s.key === "2026-11-01")!.leftPercent, 10);
  });

  it("thins month labels when zoomed out so they never overlap, keeping every gridline and January", () => {
    const range = { start: "2020-01-01", end: "2026-12-31" };
    for (const pxPerDay of [0.3, 0.6, 1, 2, 5]) {
      const scale = buildTimelineScale(range, pxPerDay);
      expect(scale.months.filter((s) => s.isBoundary)).toHaveLength(84); // a gridline for every month
      const labeled = scale.months.filter((s) => s.showLabel);
      const totalPx = rangeDayCount(range) * pxPerDay;
      for (let i = 1; i < labeled.length; i++) {
        expect(((labeled[i].leftPercent - labeled[i - 1].leftPercent) / 100) * totalPx).toBeGreaterThanOrEqual(MIN_MONTH_LABEL_PX - 3);
      }
      if (scale.monthLabelStep > 0) expect(labeled.filter((s) => s.label === "Jan")).toHaveLength(7);
    }
    expect(buildTimelineScale(range, 0.6).monthLabelStep).toBe(2);
    expect(buildTimelineScale(range, 5).monthLabelStep).toBe(1);
  });

  it("labels years every year at normal zoom and hides a too-narrow partial first year", () => {
    const scale = buildTimelineScale({ start: "2025-12-20", end: "2028-06-30" }, 1);
    expect(scale.years.map((s) => [s.label, s.showLabel])).toEqual([
      ["2025", false], // 12 days ≈ 12px: no room
      ["2026", true],
      ["2027", true],
      ["2028", true],
    ]);
  });

  it("follows a custom From/To mid-month range: partial first month labeled only when there's room", () => {
    const scale = buildTimelineScale({ start: "2026-05-17", end: "2026-08-20" }, 6);
    expect(scale.months[0]).toMatchObject({ key: "2026-05-17", label: "May", isBoundary: false, leftPercent: 0, showLabel: true });
    const tight = buildTimelineScale({ start: "2026-05-29", end: "2026-08-20" }, 6);
    expect(tight.months[0]).toMatchObject({ label: "May", showLabel: false });
  });

  it("adds week marks, then day marks, at close zoom", () => {
    const r = { start: "2026-03-02", end: "2026-03-31" };
    expect(buildTimelineScale(r, 5).minor).toBeNull();
    const weeks = buildTimelineScale(r, 10).minor!;
    expect(weeks.granularity).toBe("week");
    expect(weeks.marks.map((m) => m.key)).toEqual(["2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30"]);
    const days = buildTimelineScale(r, MAX_PX_PER_DAY).minor!;
    expect(days.granularity).toBe("day");
    expect(days.marks).toHaveLength(30);
  });
});

describe("filters and numbering", () => {
  const people = [
    emp({ id: "a", firstName: "Alice" }),
    emp({ id: "b", firstName: "Bob", nationality: "Mexican", employeeGroup: null, workGroup: null, employmentType: null, statuses: ["permitExpired"] }),
    emp({ id: "c", firstName: "Carla", employeeGroup: { id: "g-loc", name: "Locals" }, statuses: ["current", "finishingSoon"] }),
  ];
  const ids = (list: EmploymentTimelineEmployee[]) => list.map((e) => e.id);

  it("no filters keeps everyone in the server's order", () => {
    expect(ids(filterEmploymentTimelineEmployees(people, EMPTY_FILTER_STATE))).toEqual(["a", "b", "c"]);
  });

  it.each([
    ["employee", { employeeIds: ["c"] }, ["c"]],
    ["nationality", { nationalities: ["Mexican"] }, ["b"]],
    ["employee group", { employeeGroupIds: ["g-gh"] }, ["a"]],
    ["employee group Ungrouped", { employeeGroupIds: ["Ungrouped"] }, ["b"]],
    ["employment type Unspecified", { employmentTypes: ["Unspecified"] }, ["b"]],
    ["work group", { workGroups: ["Greenhouse"] }, ["a", "c"]],
    ["status", { statuses: ["finishingSoon" as const] }, ["c"]],
    ["two categories (AND)", { nationalities: ["Guatemalan"], employeeGroupIds: ["g-loc"] }, ["c"]],
  ])("%s filter", (_label, f, expected) => {
    expect(ids(filterEmploymentTimelineEmployees(people, { ...EMPTY_FILTER_STATE, ...f }))).toEqual(expected);
  });

  it("rows are numbered 1..n in displayed order, and renumber from 1 after filtering", () => {
    expect(buildEmploymentTimelineRows(people).map((r) => [r.number, r.employeeName])).toEqual([
      [1, "Alice Smith"],
      [2, "Bob Smith"],
      [3, "Carla Smith"],
    ]);
    const filtered = filterEmploymentTimelineEmployees(people, { ...EMPTY_FILTER_STATE, workGroups: ["Greenhouse"] });
    expect(buildEmploymentTimelineRows(filtered).map((r) => [r.number, r.employeeName])).toEqual([
      [1, "Alice Smith"],
      [2, "Carla Smith"],
    ]);
  });
});

describe("table/CSV/PDF/Print rows", () => {
  it("use the new date names and the bar's end priority, one row per employee", () => {
    expect(EMPLOYMENT_TIMELINE_COLUMNS).toEqual([
      "#",
      "Employee",
      "Nationality",
      "Employee Group",
      "Employment Type",
      "Work Group",
      "Employment Start Date",
      "Work Permit Expiry Date",
      "End Different Date",
      "Start Vacation",
      "End Vacation",
      "Timeline ends",
      "Status",
    ]);
    const rows = buildEmploymentTimelineRows([
      emp(),
      emp({ id: "x", endDifferentDate: "2026-06-30", timelineEndDate: "2026-06-30", timelineEndSource: "endDifferentDate" }),
      emp({ id: "y", workPermitExpiryDate: null, timelineEndDate: null, timelineEndSource: null, timelineLabel: "ongoing" }),
      emp({ id: "z", hasUsableDates: false, employmentStartDate: null, timelineEndDate: null, timelineLabel: null }),
    ]);
    expect(employmentTimelineRowCells(rows[0])).toEqual([
      "1",
      "Alice Smith",
      "Guatemalan",
      "Greenhouse Guys",
      "Seasonal",
      "Greenhouse",
      "2026-01-05",
      "2026-09-30",
      "",
      "",
      "",
      "2026-09-30 (Work Permit Expiry Date)",
      "Employed",
    ]);
    expect(rows[1].timelineEnds).toBe("2026-06-30 (End Different Date)");
    expect(rows[1].workPermitExpiryDate).toBe("2026-09-30");
    expect(rows[2].timelineEnds).toBe("Ongoing");
    expect(rows[3]).toMatchObject({ number: 4, startDate: "", status: "No Employment Start Date recorded" });
    const allText = rows.flatMap(employmentTimelineRowCells).join(" ");
    expect(allText).not.toMatch(/Expected finish|Actual finish|Expired — still working/i);
  });
});

describe("pinned year while scrolled", () => {
  const range = { start: "2024-01-01", end: "2026-12-31" };
  it("pins the year of the first visible day once its own label has scrolled away", () => {
    // 10px/day: 2025-07-01 is day 547 -> 5470px.
    expect(pinnedYearLabel(range, 10, 0)).toBeNull();
    expect(pinnedYearLabel(range, 10, 5470)).toBe("2025");
    expect(pinnedYearLabel(range, 10, 3660)).toBeNull(); // exactly on 2025-01-01: its own label is in view
  });
  it("hides just before the next year's label arrives (no overlap)", () => {
    const beforeJan1 = daysBetweenDateStrs(range.start, "2026-01-01") * 10 - 20; // 20px before
    expect(pinnedYearLabel(range, 10, beforeJan1)).toBeNull();
  });
});

describe("vacation overlay", () => {
  const vac = (s: string, e: string, extra: Partial<EmploymentTimelineEmployee> = {}) =>
    emp({ employmentStartDate: "2025-01-06", workPermitExpiryDate: "2027-12-31", timelineEndDate: "2027-12-31", vacationStartDate: s, vacationEndDate: e, ...extra });
  const slotPct = (range: TimelineRange) => 100 / rangeDayCount(range);

  it("starts on Start Vacation's day and ends after End Vacation's day, in the bar's day slots", () => {
    const range = { start: "2026-01-01", end: "2026-12-31" };
    const v = computeVacationPosition(vac("2026-07-01", "2026-07-14"), range)!;
    expect(v.leftPercent).toBeCloseTo(percentInRange("2026-07-01", range), 10);
    expect(v.leftPercent + v.widthPercent).toBeCloseTo(percentInRange("2026-07-15", range), 10);
    expect(v.widthPercent).toBeCloseTo(14 * slotPct(range), 10);
    expect(v.monthLines).toEqual([]);
  });

  it("across a month and a year boundary: the month lines inside it sit exactly on the timeline's month gridlines", () => {
    const range = { start: "2026-10-01", end: "2027-03-31" };
    const v = computeVacationPosition(vac("2026-12-20", "2027-01-10"), range)!;
    const scale = buildTimelineScale(range, 5);
    const jan1 = scale.months.find((s) => s.key === "2027-01-01")!;
    expect(v.monthLines.map((l) => l.key)).toEqual(["2027-01-01"]);
    expect(v.leftPercent + (v.monthLines[0].leftPercentOfSegment / 100) * v.widthPercent).toBeCloseTo(jan1.leftPercent, 10);
    expect(v.widthPercent).toBeCloseTo(22 * slotPct(range), 10);
  });

  it("is exact across both Toronto DST days (2026-03-08 spring forward, 2026-11-01 fall back) and a leap day", () => {
    const range = { start: "2026-01-01", end: "2028-12-31" };
    const spring = computeVacationPosition(vac("2026-03-07", "2026-03-09"), range)!;
    const fall = computeVacationPosition(vac("2026-10-31", "2026-11-02"), range)!;
    const leap = computeVacationPosition(vac("2028-02-28", "2028-03-01", { workPermitExpiryDate: "2028-12-31", timelineEndDate: "2028-12-31" }), range)!;
    for (const v of [spring, fall, leap]) expect(v.widthPercent).toBeCloseTo(3 * slotPct(range), 10); // 3 whole days each
    expect(fall.monthLines.map((l) => l.key)).toEqual(["2026-11-01"]);
    expect(fall.leftPercent + (fall.monthLines[0].leftPercentOfSegment / 100) * fall.widthPercent).toBeCloseTo(percentInRange("2026-11-01", range), 10);
    expect(leap.monthLines.map((l) => l.key)).toEqual(["2028-03-01"]);
  });

  it("is clipped to the visible range and to the bar; nothing when outside or absent", () => {
    const range = { start: "2026-07-05", end: "2026-07-31" };
    const clipped = computeVacationPosition(vac("2026-07-01", "2026-07-14"), range)!;
    expect(clipped.leftPercent).toBe(0);
    expect(clipped.widthPercent).toBeCloseTo(10 * slotPct(range), 10);
    expect(computeVacationPosition(vac("2026-06-01", "2026-06-10"), range)).toBeNull();
    expect(computeVacationPosition(emp(), range)).toBeNull();
    // Never past the bar's end (e.g. a later-shortened permit) or before its start.
    const bar = { start: "2026-01-01", end: "2026-12-31" };
    const short = computeVacationPosition(vac("2026-07-01", "2026-07-14", { timelineEndDate: "2026-07-10" }), bar)!;
    expect(short.leftPercent + short.widthPercent).toBeCloseTo(percentInRange("2026-07-11", bar), 10);
  });

  it("an ongoing bar keeps a future vacation", () => {
    const range = { start: "2026-01-01", end: "2031-12-31" };
    const v = computeVacationPosition(vac("2031-07-01", "2031-07-21", { workPermitExpiryDate: null, timelineEndDate: null, timelineLabel: "ongoing" }), range)!;
    expect(v.widthPercent).toBeCloseTo(21 * slotPct(range), 10);
  });

  it("Table/CSV/PDF/Print rows carry the same vacation dates", () => {
    const [row] = buildEmploymentTimelineRows([vac("2026-07-01", "2026-07-14")]);
    const cells = employmentTimelineRowCells(row);
    expect(cells[EMPLOYMENT_TIMELINE_COLUMNS.indexOf("Start Vacation")]).toBe("2026-07-01");
    expect(cells[EMPLOYMENT_TIMELINE_COLUMNS.indexOf("End Vacation")]).toBe("2026-07-14");
  });
});
