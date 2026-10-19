// @vitest-environment jsdom
//
// Covers the Reports "Sort employees" ordering: alphabetical stays the
// untouched default, "Speed: highest first" orders by the raw numeric
// Weekly Average Speed (never the formatted text), ties and missing speeds
// fall back to the existing alphabetical order, the DAY TOTAL row is never
// part of the sort, and CSV/PDF both follow the chosen order because they
// read the same sorted PivotGrid.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActivityPivotGrid, buildPayrollPivotGrid, PivotGrid } from "./reportPivot";
import { ActivityReportData, PayrollReportData, SavedReportDetail } from "./reportTypes";
import {
  DEFAULT_EMPLOYEE_SORT,
  effectiveEmployeeSort,
  getSessionEmployeeSort,
  gridSupportsSpeedSort,
  setSessionEmployeeSort,
  sortPivotEmployees,
} from "./reportEmployeeSort";

let lastAutoTableConfig: any = null;

vi.mock("jspdf", () => {
  class MockJsPDF {
    setFontSize() {}
    text() {}
    save() {}
  }
  return { default: MockJsPDF };
});

vi.mock("jspdf-autotable", () => ({
  default: (_doc: unknown, config: any) => {
    lastAutoTableConfig = config;
  },
}));

const RANGE = { start: "2026-08-17", end: "2026-08-17" };

function makeActivityData(
  employees: { name: string; speed: number | null }[],
  speedUnit: string | null = "stems/hour"
): ActivityReportData {
  return {
    activity: { id: "act-1", name: "Picking Peppers", normalSpeedPerHour: 900, speedUnit },
    rows: [],
    employeeTotals: employees.map((e) => ({
      employeeId: e.name.toLowerCase().replace(/\s+/g, "-"),
      employeeName: e.name,
      workSeconds: 3600,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      rowsTouched: 1,
      quantityWorked: e.speed,
      rowsCompleted: 1,
      averageSpeed: e.speed,
      employeePaidSeconds: 3600,
    })),
    dateTotals: [],
    totals: {
      workSeconds: 3600 * employees.length,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      quantityWorked: null,
      rowsCompleted: employees.length,
      rowsTouched: employees.length,
      averageSpeed: 500,
      employeePaidSeconds: 3600 * employees.length,
    },
  };
}

function activityGrid(employees: { name: string; speed: number | null }[], speedUnit: string | null = "stems/hour") {
  return buildActivityPivotGrid(makeActivityData(employees, speedUnit), RANGE, "workTime", ["activityHours", "averageSpeed"]);
}

const names = (grid: PivotGrid) => grid.employees.map((e) => e.employeeName);

afterEach(() => {
  setSessionEmployeeSort(DEFAULT_EMPLOYEE_SORT);
  lastAutoTableConfig = null;
});

describe("sortPivotEmployees", () => {
  const mixed = [
    { name: "Carlos", speed: 980 },
    { name: "Ana", speed: 1140.6 },
    { name: "Bea", speed: 1200 },
  ];

  it("defaults to alphabetical, leaving the existing order exactly as built", () => {
    expect(DEFAULT_EMPLOYEE_SORT).toBe("alphabetical");
    expect(getSessionEmployeeSort()).toBe("alphabetical");
    const grid = activityGrid(mixed);
    expect(sortPivotEmployees(grid, "alphabetical")).toBe(grid);
    expect(names(grid)).toEqual(["Ana", "Bea", "Carlos"]);
  });

  it("orders by Weekly Average Speed, highest first", () => {
    expect(names(sortPivotEmployees(activityGrid(mixed), "speedDesc"))).toEqual(["Bea", "Ana", "Carlos"]);
  });

  it("compares numeric speeds, not the formatted text", () => {
    // As text, "9.5 stems/hour" > "10.2 stems/hour" > "1,140.6 ..." — numerically it's the reverse.
    const grid = activityGrid([
      { name: "Ana", speed: 9.5 },
      { name: "Bea", speed: 10.2 },
      { name: "Carlos", speed: 1140.6 },
    ]);
    expect(grid.employees.map((e) => e.weeklyTotals?.[1])).toEqual(["9.5 stems/hour", "10.2 stems/hour", "1140.6 stems/hour"]);
    expect(names(sortPivotEmployees(grid, "speedDesc"))).toEqual(["Carlos", "Bea", "Ana"]);
  });

  it("breaks equal speeds alphabetically", () => {
    const grid = activityGrid([
      { name: "Diego", speed: 500 },
      { name: "Ana", speed: 500 },
      { name: "Carlos", speed: 700 },
      { name: "Bea", speed: 500 },
    ]);
    expect(names(sortPivotEmployees(grid, "speedDesc"))).toEqual(["Carlos", "Ana", "Bea", "Diego"]);
  });

  it("puts employees without a speed last, alphabetical among themselves", () => {
    const grid = activityGrid([
      { name: "Zoe", speed: null },
      { name: "Ana", speed: null },
      { name: "Mia", speed: 300 },
      { name: "Bea", speed: 800 },
    ]);
    expect(names(sortPivotEmployees(grid, "speedDesc"))).toEqual(["Bea", "Mia", "Ana", "Zoe"]);
  });

  it("treats zero as a real speed: below every positive speed, above every missing one", () => {
    const grid = activityGrid([
      { name: "Ana", speed: null },
      { name: "Bea", speed: 0 },
      { name: "Carlos", speed: 50 },
    ]);
    expect(names(sortPivotEmployees(grid, "speedDesc"))).toEqual(["Carlos", "Bea", "Ana"]);
  });

  it("treats a non-finite speed as missing rather than sorting on it", () => {
    const grid = activityGrid([
      { name: "Ana", speed: Number.NaN },
      { name: "Bea", speed: 10 },
    ]);
    expect(names(sortPivotEmployees(grid, "speedDesc"))).toEqual(["Bea", "Ana"]);
  });

  it("never touches the DAY TOTAL row or any cell value — only the row order", () => {
    const grid = activityGrid(mixed);
    const sorted = sortPivotEmployees(grid, "speedDesc");
    expect(sorted.columnTotals).toBe(grid.columnTotals);
    expect(sorted.weeklyTotalColumnTotals).toBe(grid.weeklyTotalColumnTotals);
    expect(sorted.employees).toHaveLength(grid.employees.length);
    for (const row of sorted.employees) {
      expect(row).toBe(grid.employees.find((e) => e.employeeId === row.employeeId));
    }
    // The input grid itself stays alphabetical.
    expect(names(grid)).toEqual(["Ana", "Bea", "Carlos"]);
  });

  it("re-sorts a newly built grid (different employees / date range)", () => {
    const first = sortPivotEmployees(activityGrid(mixed), "speedDesc");
    expect(names(first)).toEqual(["Bea", "Ana", "Carlos"]);
    const next = sortPivotEmployees(
      activityGrid([
        { name: "Ana", speed: 100 },
        { name: "Elena", speed: 2000 },
      ]),
      "speedDesc"
    );
    expect(names(next)).toEqual(["Elena", "Ana"]);
  });

  it.each([["stems/hour"], ["plants/hour"], ["kg/hour"], [null]])("works for activities measured in %s", (unit) => {
    const grid = activityGrid(
      [
        { name: "Ana", speed: 12 },
        { name: "Bea", speed: 40 },
      ],
      unit
    );
    expect(gridSupportsSpeedSort(grid)).toBe(true);
    expect(names(sortPivotEmployees(grid, "speedDesc"))).toEqual(["Bea", "Ana"]);
  });
});

describe("reports without a speed metric", () => {
  it("an activity with no speed unit and no calculated speeds disables speed sorting and stays alphabetical", () => {
    const grid = activityGrid(
      [
        { name: "Bea", speed: null },
        { name: "Ana", speed: null },
      ],
      null
    );
    expect(gridSupportsSpeedSort(grid)).toBe(false);
    expect(effectiveEmployeeSort("speedDesc", grid)).toBe("alphabetical");
    expect(sortPivotEmployees(grid, "speedDesc")).toBe(grid);
  });

  it("an activity with a speed unit but no speeds yet this range keeps the option and lists everyone alphabetically", () => {
    const grid = activityGrid([
      { name: "Bea", speed: null },
      { name: "Ana", speed: null },
    ]);
    expect(gridSupportsSpeedSort(grid)).toBe(true);
    expect(names(sortPivotEmployees(grid, "speedDesc"))).toEqual(["Ana", "Bea"]);
  });

  it("Payroll has no speed: the option is unavailable and the order is untouched", () => {
    const payroll: PayrollReportData = {
      rows: [],
      employeeTotals: [
        { employeeId: "b", employeeName: "Bea", workSeconds: 1, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 1, unpaidSeconds: 0, totalSeconds: 1 },
        { employeeId: "a", employeeName: "Ana", workSeconds: 2, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 2, unpaidSeconds: 0, totalSeconds: 2 },
      ],
      dateTotals: [],
      totals: { workSeconds: 3, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 3, unpaidSeconds: 0, totalSeconds: 3 },
      daysWorkedByEmployee: [],
      activityBreakdown: [],
      weeklyTotals: [],
    } as unknown as PayrollReportData;
    const grid = buildPayrollPivotGrid(payroll, RANGE, "workTime");
    expect(gridSupportsSpeedSort(grid)).toBe(false);
    expect(gridSupportsSpeedSort(null)).toBe(false);
    expect(sortPivotEmployees(grid, "speedDesc")).toBe(grid);
    expect(names(grid)).toEqual(["Ana", "Bea"]);
  });
});

describe("session selection", () => {
  it("remembers the chosen order for the rest of the session", () => {
    setSessionEmployeeSort("speedDesc");
    expect(getSessionEmployeeSort()).toBe("speedDesc");
  });
});

describe("exports follow the selected order with DAY TOTAL last", () => {
  const report: SavedReportDetail = {
    id: "report-1",
    name: "Picking Peppers",
    reportType: "activity",
    activity: { id: "act-1", name: "Picking Peppers" },
    configuration: {},
    employeeSelectionMode: "all",
    employeeIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const sorted = sortPivotEmployees(
    activityGrid([
      { name: "Ana", speed: null },
      { name: "Bea", speed: 10 },
      { name: "Carlos", speed: 1140.6 },
    ]),
    "speedDesc"
  );

  it("CSV", async () => {
    let text = "";
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blob.text().then((t) => (text = t));
      return "blob:mock";
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const { exportPivotCsv } = await import("./reportExport");
    exportPivotCsv(report, sorted, "Work time");
    await new Promise((r) => setTimeout(r, 0));
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;

    const firstCells = text.split("\r\n").slice(1).map((l) => l.split(",")[0]);
    expect(firstCells).toEqual(["Carlos", "Bea", "Ana", "DAY TOTAL"]);
  });

  it("PDF", async () => {
    const { exportPivotPdf } = await import("./reportExport");
    exportPivotPdf(report, RANGE, sorted, "Work time", "landscape", null);
    expect(lastAutoTableConfig.body.map((r: string[]) => r[0])).toEqual(["Carlos", "Bea", "Ana", "DAY TOTAL"]);
  });
});
