// Tests the Activity Report "Total Paid Time" column at the pivot-grid
// level: buildActivityPivotGrid must expose an independent per-employee
// Paid time total (and a bottom-row combined total) whenever the caller
// passes includePaidTimeTotal — using the report's own existing Paid time
// formula (pivotCellValue's "paidTime" case: workSeconds + paidBreakSeconds,
// summed server-side from the underlying seconds — see
// reports.activityPaidTime.test.ts for that data's own correctness), never
// a separately invented payroll formula. The column must stay populated
// regardless of which `metric` currently drives cells/grandTotal (the
// "Show:" dropdown), and must be entirely absent when the caller omits
// includePaidTimeTotal (Paid time unchecked).
import { describe, expect, it } from "vitest";
import { buildActivityPivotGrid } from "./reportPivot";
import { ActivityReportData } from "./reportTypes";

function emptyActivityTotals() {
  return { workSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, rowsTouched: 0, quantityWorked: null, rowsCompleted: 0, averageSpeed: null };
}

describe("buildActivityPivotGrid — Total Paid Time column", () => {
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

  it("3) multiple employees, multiple days — each employee's Total Paid Time is their own workSeconds + paidBreakSeconds sum across the whole range", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        { employeeId: "e1", employeeName: "Alice", ...emptyActivityTotals(), workSeconds: 6.5 * 3600, paidBreakSeconds: 15 * 60 }, // 6:45
        { employeeId: "e2", employeeName: "Bob", ...emptyActivityTotals(), workSeconds: 2 * 3600, paidBreakSeconds: 0 }, // 2:00
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 8.5 * 3600, paidBreakSeconds: 15 * 60 },
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

  it("4) paid vs unpaid breaks — Total Paid Time includes ONLY paidBreakSeconds, unpaidBreakSeconds never contributes", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        { employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 4.75 * 3600, paidBreakSeconds: 15 * 60, unpaidBreakSeconds: 30 * 60 },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 4.75 * 3600, paidBreakSeconds: 15 * 60, unpaidBreakSeconds: 30 * 60 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-12", end: "2026-08-12" }, "workTime", true);
    // 4:45 work + 0:15 paid break = 5:00 — the 30-minute unpaid break
    // deliberately excluded, exactly the report's existing rule.
    expect(grid.employees[0].totalPaidTime).toBe("5:00");
  });

  it("5) THE EXACT CASE: Paid time checked while Average Speed is the selected Show metric — cells/grandTotal show speed, Total Paid Time independently shows paid time", () => {
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
        },
      ],
      employeeTotals: [
        { employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 4 * 3600, paidBreakSeconds: 30 * 60, averageSpeed: 50 },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 4 * 3600, paidBreakSeconds: 30 * 60, averageSpeed: 50 },
    };
    const grid = buildActivityPivotGrid(data, { start: "2026-08-13", end: "2026-08-13" }, "averageSpeed", true);
    // The main grid is driven by "averageSpeed" — cells/grandTotal show speed.
    expect(grid.employees[0].cells).toEqual(["50.0 plants/hour"]);
    expect(grid.employees[0].grandTotal).toBe("50.0 plants/hour");
    // Total Paid Time is completely independent of the selected metric —
    // 4:00 work + 0:30 paid break = 4:30, never a speed value.
    expect(grid.employees[0].totalPaidTime).toBe("4:30");
    expect(grid.totalPaidTimeGrandTotal).toBe("4:30");
  });

  it("6) CROSS-CHECK against the existing 'Show: Paid time' mechanism — Total Paid Time always agrees with what selecting Paid time as the Show metric already produces, for the same underlying data (same formula, not a different one)", () => {
    const data: ActivityReportData = {
      activity: { id: "act-1", name: "Winding", normalSpeedPerHour: null, speedUnit: null },
      rows: [],
      employeeTotals: [
        { employeeId: "e1", employeeName: "Alice", ...emptyActivityTotals(), workSeconds: 7123, paidBreakSeconds: 456 },
        { employeeId: "e2", employeeName: "Bob", ...emptyActivityTotals(), workSeconds: 51234, paidBreakSeconds: 0 },
      ],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 58357, paidBreakSeconds: 456 },
    };
    // Grid A: "Show:" is set to some OTHER metric (workTime), with the new
    // column requested.
    const gridA = buildActivityPivotGrid(data, { start: "2026-08-14", end: "2026-08-14" }, "workTime", true);
    // Grid B: "Show:" is set to "paidTime" itself — the pre-existing
    // mechanism this whole feature must never disagree with.
    const gridB = buildActivityPivotGrid(data, { start: "2026-08-14", end: "2026-08-14" }, "paidTime", false);

    for (let i = 0; i < gridA.employees.length; i++) {
      expect(gridA.employees[i].totalPaidTime).toBe(gridB.employees[i].grandTotal);
    }
    expect(gridA.totalPaidTimeGrandTotal).toBe(gridB.grandTotal);
  });

  it("7) a day with no row for an employee doesn't affect Total Paid Time — it's the range-wide employeeTotals value, not derived from the per-day cells", () => {
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
        },
      ],
      employeeTotals: [{ employeeId: "e1", employeeName: "A", ...emptyActivityTotals(), workSeconds: 3600 }],
      dateTotals: [],
      totals: { ...emptyActivityTotals(), workSeconds: 3600 },
    };
    // Range spans two days; the employee only has a row for the first.
    const grid = buildActivityPivotGrid(data, { start: "2026-08-15", end: "2026-08-16" }, "workTime", true);
    expect(grid.employees[0].cells).toEqual(["1:00", "—"]);
    expect(grid.employees[0].totalPaidTime).toBe("1:00");
  });
});
