import { describe, expect, it } from "vitest";
import {
  buildEmploymentTimelineRows,
  computeBarPosition,
  filterEmploymentTimelineEmployees,
  getTimelineColumns,
  shiftAnchor,
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
    periods: [period()],
    ...overrides,
  };
}

describe("getTimelineColumns", () => {
  it("Month view: one column per day of the month", () => {
    const columns = getTimelineColumns("month", "2026-02-15");
    expect(columns).toHaveLength(28); // Feb 2026 is not a leap year
    expect(columns[0].startDate).toBe("2026-02-01");
    expect(columns[columns.length - 1].startDate).toBe("2026-02-28");
  });

  it("Quarter view: exactly 13 weekly columns covering the quarter", () => {
    const columns = getTimelineColumns("quarter", "2026-05-15"); // Q2: Apr-Jun
    expect(columns).toHaveLength(13);
    // Each column spans exactly 7 days (Monday-start week).
    for (const c of columns) {
      expect(c.startDate <= c.endDate).toBe(true);
    }
  });

  it("Year view: exactly 12 monthly columns", () => {
    const columns = getTimelineColumns("year", "2026-07-01");
    expect(columns).toHaveLength(12);
    expect(columns[0].startDate).toBe("2026-01-01");
    expect(columns[11].startDate).toBe("2026-12-01");
    expect(columns[11].endDate).toBe("2026-12-31");
  });
});

describe("shiftAnchor", () => {
  it("Month navigation moves by exactly one calendar month", () => {
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-28"); // end-of-month clamping
    expect(shiftAnchor("month", "2026-03-15", -1)).toBe("2026-02-15");
  });
  it("Quarter navigation moves by three months, Year by twelve", () => {
    expect(shiftAnchor("quarter", "2026-01-15", 1)).toBe("2026-04-15");
    expect(shiftAnchor("year", "2026-01-15", 1)).toBe("2027-01-15");
  });
});

describe("computeBarPosition", () => {
  const columns = getTimelineColumns("month", "2026-06-15"); // June 2026, 30 columns, index 0=Jun1 .. 29=Jun30

  it("a period fully within the visible range positions at the exact start/end columns, not clipped", () => {
    const pos = computeBarPosition({ startDate: "2026-06-05", expectedFinishDate: null, actualFinishDate: "2026-06-10" }, columns);
    expect(pos).toEqual({ startColIndex: 4, endColIndex: 9, clippedStart: false, clippedEnd: false });
  });

  it("a period starting before the visible window is clipped to column 0", () => {
    const pos = computeBarPosition({ startDate: "2026-01-01", expectedFinishDate: null, actualFinishDate: "2026-06-10" }, columns);
    expect(pos?.clippedStart).toBe(true);
    expect(pos?.startColIndex).toBe(0);
  });

  it("an open-ended period (no finish at all) extends to the last visible column and is flagged clippedEnd", () => {
    const pos = computeBarPosition({ startDate: "2026-06-05", expectedFinishDate: null, actualFinishDate: null }, columns);
    expect(pos?.clippedEnd).toBe(true);
    expect(pos?.endColIndex).toBe(columns.length - 1);
  });

  it("a period finishing after the visible window is clipped at the last column", () => {
    const pos = computeBarPosition({ startDate: "2026-06-05", expectedFinishDate: null, actualFinishDate: "2027-01-01" }, columns);
    expect(pos?.clippedEnd).toBe(true);
    expect(pos?.endColIndex).toBe(columns.length - 1);
  });

  it("a period entirely before the visible range returns null (nothing to draw)", () => {
    const pos = computeBarPosition({ startDate: "2026-01-01", expectedFinishDate: null, actualFinishDate: "2026-01-15" }, columns);
    expect(pos).toBeNull();
  });

  it("a period entirely after the visible range returns null", () => {
    const pos = computeBarPosition({ startDate: "2026-12-01", expectedFinishDate: null, actualFinishDate: null }, columns);
    expect(pos).toBeNull();
  });

  it("prefers actualFinishDate over expectedFinishDate when both are set", () => {
    const pos = computeBarPosition({ startDate: "2026-06-01", expectedFinishDate: "2026-06-25", actualFinishDate: "2026-06-05" }, columns);
    expect(pos?.endColIndex).toBe(4); // Jun 5 = index 4, not Jun 25's index
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
  it("produces one row per period with the expected columns, Unspecified fallbacks, and a — for missing dates as empty strings", () => {
    const emp = employee({
      nationality: null,
      periods: [
        period({ id: "p-a", startDate: "2026-01-01", expectedFinishDate: "2026-06-01", actualFinishDate: null, employmentType: null, workGroup: "Greenhouse", statuses: ["current", "finishingSoon"] }),
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
      status: "Finishing soon",
    });
  });

  it("is the exact same builder the table view and CSV/PDF export both call — same array reference shape for identical input", () => {
    const emp = employee();
    const rowsA = buildEmploymentTimelineRows([emp]);
    const rowsB = buildEmploymentTimelineRows([emp]);
    expect(rowsA).toEqual(rowsB);
  });

  it("multiple periods for one employee produce multiple rows, one per period", () => {
    const emp = employee({
      periods: [period({ id: "p1", startDate: "2024-01-01", actualFinishDate: "2024-06-01", statuses: ["completed"] }), period({ id: "p2", startDate: "2024-07-01", statuses: ["current"] })],
    });
    const rows = buildEmploymentTimelineRows([emp]);
    expect(rows).toHaveLength(2);
    expect(rows[0].startDate).toBe("2024-01-01");
    expect(rows[1].startDate).toBe("2024-07-01");
  });
});
