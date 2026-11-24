import { describe, expect, it } from "vitest";
import {
  ActivityReportData,
  REPORT_METRIC_CHOICES,
  normalizeReportMetric,
  normalizeReportMetrics,
  pivotCellValue,
  reportMetricUnavailableReason,
} from "./reportTypes";
import { buildActivityPivotGrid } from "./reportPivot";

const stemsJob = { productivityMetric: "density" as const, quantityUnits: ["stems"] };
const plantsJob = { productivityMetric: "density" as const, quantityUnits: ["plants"] };
const scaleJob = { productivityMetric: "scale_kg" as const, quantityUnits: ["stems"] };

describe("the six Job Report choices", () => {
  it("are exactly Rows, Total Hours, Paid Hours, Stems/Hr, Kg/Hr, Plants/Hr", () => {
    expect(REPORT_METRIC_CHOICES).toEqual(["rows", "totalHours", "paidHours", "stemsPerHour", "kgPerHour", "plantsPerHour"]);
  });

  it("map every older saved key onto its closest choice, or drop it", () => {
    expect(normalizeReportMetric("workTime", stemsJob)).toBe("totalHours");
    expect(normalizeReportMetric("activityHours", stemsJob)).toBe("totalHours");
    expect(normalizeReportMetric("employeePaidTime", stemsJob)).toBe("paidHours");
    expect(normalizeReportMetric("paidTime", stemsJob)).toBe("paidHours");
    expect(normalizeReportMetric("averageSpeed", stemsJob)).toBe("stemsPerHour");
    expect(normalizeReportMetric("averageSpeed", plantsJob)).toBe("plantsPerHour");
    expect(normalizeReportMetric("rows", stemsJob)).toBe("rows");
    for (const dropped of ["breakTime", "rowsCompleted", "quantityWorked", "nonsense", ""]) {
      expect(normalizeReportMetric(dropped, stemsJob)).toBeNull();
    }
    // A rate saved under the other unit is shown under the Job's own unit;
    // on a Job whose rows mix stems and plants it is not shown at all.
    expect(normalizeReportMetric("stemsPerHour", plantsJob)).toBe("plantsPerHour");
    expect(normalizeReportMetric("plantsPerHour", stemsJob)).toBe("stemsPerHour");
    const mixedJob = { productivityMetric: "density" as const, quantityUnits: ["plants", "stems"] };
    expect(normalizeReportMetric("averageSpeed", mixedJob)).toBeNull();
    expect(normalizeReportMetric("stemsPerHour", mixedJob)).toBeNull();
    // Kg/Hr stays (dashes, with a note saying why) so the choice isn't lost.
    expect(normalizeReportMetric("kgPerHour", stemsJob)).toBe("kgPerHour");
    // Duplicates collapse (workTime and activityHours were the same figure).
    expect(normalizeReportMetrics(["workTime", "activityHours", "averageSpeed", "breakTime"], stemsJob)).toEqual(["totalHours", "stemsPerHour"]);
  });

  it("disable what doesn't apply to the Job", () => {
    expect(reportMetricUnavailableReason("kgPerHour", stemsJob)).toMatch(/LabourLink Scale/);
    expect(reportMetricUnavailableReason("kgPerHour", scaleJob)).toBeNull();
    expect(reportMetricUnavailableReason("plantsPerHour", stemsJob)).toMatch(/no plants count/);
    expect(reportMetricUnavailableReason("stemsPerHour", plantsJob)).toMatch(/no stems count/);
    expect(reportMetricUnavailableReason("stemsPerHour", { productivityMetric: "density", quantityUnits: ["plants", "stems"] })).toMatch(/mix/);
    // Unit not known yet (a Job with no density source, before its report runs).
    expect(reportMetricUnavailableReason("stemsPerHour", { productivityMetric: "scale_kg" })).toBeNull();
    for (const always of ["rows", "totalHours", "paidHours"] as const) expect(reportMetricUnavailableReason(always, stemsJob)).toBeNull();
  });

  it("format hours as H:MM, Paid Hours from the whole-day payroll figure, rates as one decimal", () => {
    const src = { workSeconds: 3 * 3600 + 1800, breakSeconds: 1800, paidBreakSeconds: 0, rowsTouched: 5, quantityWorked: 2000, rowsCompleted: 3, averageSpeed: 571.43, employeePaidSeconds: 4 * 3600 };
    expect(pivotCellValue("rows", src, "stems/hour")).toBe("5");
    expect(pivotCellValue("totalHours", src, "stems/hour")).toBe("3:30");
    expect(pivotCellValue("paidHours", src, "stems/hour")).toBe("4:00");
    expect(pivotCellValue("stemsPerHour", src, "stems/hour")).toBe("571.4");
    expect(pivotCellValue("stemsPerHour", { ...src, averageSpeed: null }, "stems/hour")).toBe("—");
  });
});

function data(): ActivityReportData {
  const z = { breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, rowsTouched: 1, quantityWorked: null, rowsCompleted: 0, averageSpeed: null, employeePaidSeconds: 3600 };
  return {
    activity: { id: "a", name: "Picking", normalSpeedPerHour: null, speedUnit: null, ...scaleJob },
    rows: [
      { employeeId: "a", employeeName: "Ann", date: "2026-11-24", startedAt: "", endedAt: "", workSeconds: 3600, ...z },
      { employeeId: "b", employeeName: "Bob", date: "2026-11-24", startedAt: "", endedAt: "", workSeconds: 3 * 3600, ...z },
    ],
    employeeTotals: [
      { employeeId: "a", employeeName: "Ann", workSeconds: 3600, ...z },
      { employeeId: "b", employeeName: "Bob", workSeconds: 3 * 3600, ...z },
    ],
    dateTotals: [{ date: "2026-11-24", workSeconds: 4 * 3600, ...z }],
    totals: { workSeconds: 4 * 3600, ...z },
    // Ann 200 kg in 1 h (200 kg/h), Bob 300 kg in 3 h (100 kg/h).
    scaleProductivity: {
      reportingFrom: "2026-11-24",
      byEmployeeDay: [
        { employeeId: "a", date: "2026-11-24", netGrams: 200000, matchedSeconds: 3600, bins: 1, kgPerHour: 200 },
        { employeeId: "b", date: "2026-11-24", netGrams: 300000, matchedSeconds: 10800, bins: 2, kgPerHour: 100 },
      ],
      byEmployee: [
        { employeeId: "a", employeeName: "Ann", openBins: 0, netGrams: 200000, matchedSeconds: 3600, bins: 1, kgPerHour: 200 },
        { employeeId: "b", employeeName: "Bob", openBins: 0, netGrams: 300000, matchedSeconds: 10800, bins: 2, kgPerHour: 100 },
      ],
      byDate: [{ date: "2026-11-24", netGrams: 500000, matchedSeconds: 14400, bins: 3, kgPerHour: 125 }],
      totals: { netGrams: 500000, matchedSeconds: 14400, bins: 3, kgPerHour: 125 },
    },
  };
}

describe("Kg/Hr in the pivot grid", () => {
  it("uses the server's weighted totals (500 kg / 4 h = 125.0), never the mean of employee rates (150)", () => {
    const grid = buildActivityPivotGrid(data(), { start: "2026-11-24", end: "2026-11-25" }, "kgPerHour", ["kgPerHour"]);
    expect(grid.employees.map((e) => e.cells)).toEqual([
      ["200.0", "—"],
      ["100.0", "—"],
    ]);
    expect(grid.columnTotals).toEqual(["125.0", "—"]);
    expect(grid.weeklyTotalColumnTotals).toEqual(["125.0"]);
    // Sort by Kg/Hr when it's the only rate on screen.
    expect(grid.employees.map((e) => e.speedValue)).toEqual([200, 100]);
    expect(grid.hasSpeedMetric).toBe(true);
  });

  it("daily cells and summary columns are independent", () => {
    const grid = buildActivityPivotGrid(data(), { start: "2026-11-24", end: "2026-11-24" }, "rows", ["totalHours", "paidHours", "kgPerHour"]);
    expect(grid.employees[0].cells).toEqual(["1"]);
    expect(grid.employees[0].weeklyTotals).toEqual(["1:00", "1:00", "200.0"]);
    expect(grid.weeklyTotalColumns!.map((c) => c.label)).toEqual(["Total Hours", "Paid Hours", "Kg/Hr"]);
  });

  it("without a Kg/Hr column, employees with bins but no time in range are not added", () => {
    const d = data();
    d.scaleProductivity!.byEmployee.push({ employeeId: "c", employeeName: "Cy", openBins: 0, netGrams: 100000, matchedSeconds: 3600, bins: 1, kgPerHour: 100 });
    expect(buildActivityPivotGrid(d, { start: "2026-11-24", end: "2026-11-24" }, "rows", ["totalHours"]).employees).toHaveLength(2);
    const withKg = buildActivityPivotGrid(d, { start: "2026-11-24", end: "2026-11-24" }, "rows", ["totalHours", "kgPerHour"]);
    expect(withKg.employees.map((e) => [e.employeeName, ...e.cells, ...e.weeklyTotals!])).toContainEqual(["Cy", "—", "—", "100.0"]);
  });
});
