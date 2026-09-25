// Tests the Activity Report "weekly totals" columns at the pivot-grid
// level: buildActivityPivotGrid's fourth argument (weeklyTotals, a list of
// ActivityMetric keys) drives an independent, ordered set of per-employee
// AND bottom-row combined totals — replacing the old fixed single Employee
// Total / toggleable Employee Paid Time columns with the report's own
// saved, arbitrary-length list (see reportTypes.ts's
// WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS/WEEKLY_TOTAL_METRIC_LABELS).
//
// Every activity-scoped key (e.g. "activityHours") reads from the SAME
// et.workSeconds/et.averageSpeed/etc. fields the daily metric/pivotCellValue
// already uses — a weekly total is simply that same metric's own
// whole-range value, never re-derived from the grid's own formatted daily
// cells. "employeePaidTime" is the one exception: whole-shift, every
// activity combined (et.employeePaidSeconds, itself computeWorkdayTotals-
// based — see reports.activityPaidTime.test.ts for that data's own
// correctness) — deliberately NOT the same number as the activity-scoped
// "paidTime" metric (workSeconds + paidBreakSeconds for just this one
// activity); test 6 below proves the two genuinely diverge on a
// multi-activity day.
import { describe, expect, it } from "vitest";
import { buildActivityPivotGrid } from "./reportPivot";
import { ActivityReportData } from "./reportTypes";

function emptyActivityTotals() {
  return {
    workSeconds: 0,
    breakSeconds: 0,
    paidBreakSeconds: 0,
    unpaidBreakSeconds: 0,
    rowsTouched: 0,
    quantityWorked: null,
    rowsCompleted: 0,
    averageSpeed: null,
    employeePaidSeconds: 0,
  };
}

describe("buildActivityPivotGrid — weekly totals columns", () => {
  it("1) one weekly total column — key/label on weeklyTotalColumns, formatted value per employee and combined bottom-row total", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        { employeeId: "e1", employeeName: "Alice", ...emptyActivityTotals(), workSeconds: 6.75 * 3600 }, // 6:45
        { employeeId: "e2", employeeName: "Bob", ...emptyActivityTotals(), workSeconds: 2 * 3600 }, // 2:00
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 8.75 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-10", end: "2026-08-11" }, "workTime", ["activityHours"]);
    expect(grid.weeklyTotalColumns).toEqual([{ key: "activityHours", label: "Weekly Activity Hours" }]);
    const alice = grid.employees.find((e) => e.employeeName === "Alice")!;
    const bob = grid.employees.find((e) => e.employeeName === "Bob")!;
    expect(alice.weeklyTotals).toEqual(["6:45"]);
    expect(bob.weeklyTotals).toEqual(["2:00"]);
    // Bottom row: combined total across the displayed employees, a total
    // (not an average) — 6:45 + 2:00 = 8:45.
    expect(grid.weeklyTotalColumnTotals).toEqual(["8:45"]);
  });

  it("2) multiple weekly total columns, in the exact order requested", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        { employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 5 * 3600, employeePaidSeconds: 5.5 * 3600 },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 5 * 3600, employeePaidSeconds: 5.5 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-12", end: "2026-08-12" }, "workTime", [
      "activityHours",
      "employeePaidTime",
    ]);
    expect(grid.weeklyTotalColumns).toEqual([
      { key: "activityHours", label: "Weekly Activity Hours" },
      { key: "employeePaidTime", label: "Employee Paid Time" },
    ]);
    expect(grid.employees[0].weeklyTotals).toEqual(["5:00", "5:30"]);
    expect(grid.weeklyTotalColumnTotals).toEqual(["5:00", "5:30"]);
  });

  it("3) employeePaidTime's whole-shift total already folds in paid breaks (computeWorkdayTotals never subtracts them) — employeePaidSeconds is the one number formatted, no separate break math here", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [{ employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), employeePaidSeconds: 5 * 3600 }],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), employeePaidSeconds: 5 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-12", end: "2026-08-12" }, "workTime", ["employeePaidTime"]);
    expect(grid.employees[0].weeklyTotals).toEqual(["5:00"]);
  });

  it("4) THE EXACT CASE: weekly totals shown while Average Speed is the daily metric — daily cells/nothing show speed, weekly totals independently show their own metrics", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: "plants/hour" },
      rows: [
        {
          employeeId: "e1",
          employeeName: "A",
          date: "2026-08-13",
          startedAt: "2026-08-13T12:00:00.000Z",
          endedAt: "2026-08-13T16:00:00.000Z",
          workSeconds: 4 * 3600,
          breakSeconds: 0,
          paidBreakSeconds: 0,
          unpaidBreakSeconds: 0,
          rowsTouched: 1,
          quantityWorked: 200,
          rowsCompleted: 1,
          averageSpeed: 50,
          employeePaidSeconds: 4.5 * 3600,
        },
      ],
      employeeTotals: [
        {
          employeeId: "e1",
          employeeName: "A",
          ...emptyActivityTotals(),
          workSeconds: 4 * 3600,
          averageSpeed: 50,
          employeePaidSeconds: 4.5 * 3600,
        },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 4 * 3600, averageSpeed: 50, employeePaidSeconds: 4.5 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-13", end: "2026-08-13" }, "averageSpeed", [
      "activityHours",
      "employeePaidTime",
    ]);
    // The daily cells are driven by "averageSpeed".
    expect(grid.employees[0].cells).toEqual(["50.0 plants/hour"]);
    // Weekly totals are completely independent of the daily metric — 4:00
    // activity hours and 4:30 whole-shift paid time, never a speed value.
    expect(grid.employees[0].weeklyTotals).toEqual(["4:00", "4:30"]);
  });

  it("5) GENUINELY DIFFERENT from the activity-scoped 'paidTime' metric on a multi-activity day — Employee Paid Time reflects the employee's WHOLE shift, not just this one activity's contribution", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        // This activity contributed only 2h of work + 0 paid breaks that
        // day, but the employee's WHOLE shift (this activity plus another
        // one, plus a paid break) was 5h — employeePaidSeconds must be the
        // full 5h, not the narrower activity-scoped 2h.
        {
          employeeId: "e1",
          employeeName: "Alice",
          ...emptyActivityTotals(),
          workSeconds: 2 * 3600,
          paidBreakSeconds: 0,
          employeePaidSeconds: 5 * 3600,
        },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 2 * 3600, paidBreakSeconds: 0, employeePaidSeconds: 5 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-14", end: "2026-08-14" }, "workTime", [
      "paidTime",
      "employeePaidTime",
    ]);
    // "paidTime" (activity-scoped: workSeconds + paidBreakSeconds for THIS
    // activity only) vs "employeePaidTime" (whole shift) — 2:00 vs 5:00.
    expect(grid.employees[0].weeklyTotals).toEqual(["2:00", "5:00"]);
  });

  it("6) a day with no row for an employee doesn't affect a weekly total — it's the range-wide employeeTotals value, not derived from the per-day cells", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [
        {
          employeeId: "e1",
          employeeName: "A",
          date: "2026-08-15",
          startedAt: "2026-08-15T12:00:00.000Z",
          endedAt: "2026-08-15T13:00:00.000Z",
          workSeconds: 3600,
          breakSeconds: 0,
          paidBreakSeconds: 0,
          unpaidBreakSeconds: 0,
          rowsTouched: 0,
          quantityWorked: null,
          rowsCompleted: 0,
          averageSpeed: null,
          employeePaidSeconds: 3600,
        },
      ],
      employeeTotals: [{ employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 3600, employeePaidSeconds: 3600 }],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 3600, employeePaidSeconds: 3600 },
    };
    // Range spans two days; the employee only has a row for the first.
    const grid = buildActivityPivotGrid(data, { start: "2026-08-15", end: "2026-08-16" }, "workTime", ["activityHours"]);
    expect(grid.employees[0].cells).toEqual(["1:00", "—"]);
    expect(grid.employees[0].weeklyTotals).toEqual(["1:00"]);
  });

  it("7) Payroll's buildPayrollPivotGrid is unaffected — no weeklyTotalColumns field at all, grandTotal still the single Employee Total value", async () => {
    const { buildPayrollPivotGrid } = await import("./reportPivot");
    const data = {
      rows: [],
      employeeTotals: [
        {
          employeeId: "e1",
          employeeName: "A",
          workSeconds: 3600,
          breakSeconds: 0,
          paidBreakSeconds: 0,
          unpaidBreakSeconds: 0,
          paidSeconds: 3600,
          totalSeconds: 3600,
        },
      ],
      dateTotals: [],
      daysWorkedByEmployee: [],
      activityBreakdown: [],
      weeklyTotals: [],
      totals: { workSeconds: 3600, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 3600, totalSeconds: 3600 },
    };
    const grid = buildPayrollPivotGrid(data, { start: "2026-08-10", end: "2026-08-10" }, "workTime");
    expect(grid.weeklyTotalColumns).toBeUndefined();
    expect(grid.employees[0].grandTotal).toBe("1:00");
    expect(grid.grandTotal).toBe("1:00");
  });
});
