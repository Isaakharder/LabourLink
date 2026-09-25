// Tests the Activity Report "Employee Paid Time" column at the pivot-grid
// level: buildActivityPivotGrid must expose an independent per-employee
// whole-shift paid-time total (and a bottom-row combined total) whenever the
// caller passes includePaidTimeTotal — formatting
// ActivityEmployeeTotal/ActivityDateTotal/totals.employeePaidSeconds
// directly (reportQueries.ts computes this via computeWorkdayTotals, the
// same span-based whole-shift formula Payroll/Inputs already use — every
// activity combined for that employee/day, see
// reports.activityPaidTime.test.ts for that data's own correctness).
//
// Deliberately NOT the same number as the activity-scoped "Paid time"
// metric (pivotCellValue's "paidTime" case: workSeconds + paidBreakSeconds,
// scoped to just the report's one activity) — see test 6 below, which
// proves the two genuinely diverge on a day the employee also worked a
// different activity. The column must stay populated regardless of which
// `metric` currently drives cells/grandTotal (the "Show:" dropdown), and
// must be entirely absent when the caller omits includePaidTimeTotal (Paid
// time unchecked).
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

describe("buildActivityPivotGrid — Employee Paid Time column", () => {
  it("1) hidden by default — omitting includePaidTimeTotal leaves both fields undefined", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [{ employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 3600 }],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-10", end: "2026-08-10" }, "workTime");
    expect(grid.employees[0].totalPaidTime).toBeUndefined();
    expect(grid.totalPaidTimeGrandTotal).toBeUndefined();
  });

  it("2) hidden when includePaidTimeTotal is explicitly false — Paid time unchecked", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [{ employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 3600 }],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-10", end: "2026-08-10" }, "workTime", false);
    expect(grid.employees[0].totalPaidTime).toBeUndefined();
    expect(grid.totalPaidTimeGrandTotal).toBeUndefined();
  });

  it("3) multiple employees, multiple days — each employee's Employee Paid Time is their own employeePaidSeconds sum across the whole range", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        { employeeId: "e1", employeeName: "Alice", ...emptyActivityTotals(), employeePaidSeconds: 6.75 * 3600 }, // 6:45
        { employeeId: "e2", employeeName: "Bob", ...emptyActivityTotals(), employeePaidSeconds: 2 * 3600 }, // 2:00
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), employeePaidSeconds: 8.75 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-10", end: "2026-08-11" }, "workTime", true);
    const alice = grid.employees.find((e) => e.employeeName === "Alice")!;
    const bob = grid.employees.find((e) => e.employeeName === "Bob")!;
    expect(alice.totalPaidTime).toBe("6:45");
    expect(bob.totalPaidTime).toBe("2:00");
    // Bottom row: combined paid time across the displayed employees, a
    // total (not an average) — 6:45 + 2:00 = 8:45.
    expect(grid.totalPaidTimeGrandTotal).toBe("8:45");
  });

  it("4) whole-shift paid time already folds in paid breaks (computeWorkdayTotals never subtracts them) — employeePaidSeconds is the one number to format, no separate break math here", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [{ employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), employeePaidSeconds: 5 * 3600 }],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), employeePaidSeconds: 5 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-12", end: "2026-08-12" }, "workTime", true);
    expect(grid.employees[0].totalPaidTime).toBe("5:00");
  });

  it("5) THE EXACT CASE: Paid time checked while Average Speed is the selected Show metric — cells/grandTotal show speed, Employee Paid Time independently shows whole-shift paid time", () => {
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
        { employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 4 * 3600, averageSpeed: 50, employeePaidSeconds: 4.5 * 3600 },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 4 * 3600, averageSpeed: 50, employeePaidSeconds: 4.5 * 3600 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-13", end: "2026-08-13" }, "averageSpeed", true);
    // The main grid is driven by "averageSpeed" — cells/grandTotal show speed.
    expect(grid.employees[0].cells).toEqual(["50.0 plants/hour"]);
    expect(grid.employees[0].grandTotal).toBe("50.0 plants/hour");
    // Employee Paid Time is completely independent of the selected metric —
    // 4:30 whole-shift, never a speed value.
    expect(grid.employees[0].totalPaidTime).toBe("4:30");
    expect(grid.totalPaidTimeGrandTotal).toBe("4:30");
  });

  it("6) GENUINELY DIFFERENT from the activity-scoped 'Show: Paid time' metric on a multi-activity day — Employee Paid Time reflects the employee's WHOLE shift, not just this one activity's contribution", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        // This activity contributed only 2h of work + 0 paid breaks that
        // day, but the employee's WHOLE shift (this activity plus another
        // one, plus a paid break) was 5h — employeePaidSeconds must be the
        // full 5h, not the narrower activity-scoped 2h.
        { employeeId: "e1", employeeName: "Alice", ...emptyActivityTotals(), workSeconds: 2 * 3600, paidBreakSeconds: 0, employeePaidSeconds: 5 * 3600 },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 2 * 3600, paidBreakSeconds: 0, employeePaidSeconds: 5 * 3600 },
    };
    // Grid A: the new whole-shift column.
    const gridA = buildActivityPivotGrid(data, { start: "2026-08-14", end: "2026-08-14" }, "workTime", true);
    // Grid B: "Show:" set to the activity-scoped "paidTime" metric itself —
    // workSeconds + paidBreakSeconds for THIS activity only (2:00 + 0:00).
    const gridB = buildActivityPivotGrid(data, { start: "2026-08-14", end: "2026-08-14" }, "paidTime", false);

    expect(gridA.employees[0].totalPaidTime).toBe("5:00");
    expect(gridB.employees[0].grandTotal).toBe("2:00");
    expect(gridA.employees[0].totalPaidTime).not.toBe(gridB.employees[0].grandTotal);
  });

  it("7) a day with no row for an employee doesn't affect Employee Paid Time — it's the range-wide employeeTotals value, not derived from the per-day cells", () => {
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
    const grid = buildActivityPivotGrid(data, { start: "2026-08-15", end: "2026-08-16" }, "workTime", true);
    expect(grid.employees[0].cells).toEqual(["1:00", "—"]);
    expect(grid.employees[0].totalPaidTime).toBe("1:00");
  });
});
