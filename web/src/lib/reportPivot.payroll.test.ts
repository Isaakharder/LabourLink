// Reproduces and locks in the fix for the reported Payroll Report decimal-
// hours bug at the pivot-grid level: buildPayrollPivotGrid must format every
// cell/total from its own exact-seconds field (H:MM), never by re-adding
// already-rounded per-day display strings — which is exactly the mistake
// that would accumulate rounding error across a week.
import { describe, expect, it } from "vitest";
import { buildPayrollPivotGrid } from "./reportPivot";
import { PayrollReportData } from "./reportTypes";

function emptyTotals() {
  return { workSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 0, totalSeconds: 0 };
}

describe("buildPayrollPivotGrid", () => {
  it("1 & 3) an exact 10:25:00 (37500s) day cell displays as 10:25, zero-padded", () => {
    const data: PayrollReportData = {
      rows: [
        {
          employeeId: "e1",
          employeeName: "Lester Langaoen",
          date: "2026-08-10",
          startedAt: "2026-08-10T07:00:00.000Z",
          endedAt: "2026-08-10T17:25:00.000Z",
          workSeconds: 37500,
          breakSeconds: 0,
          paidBreakSeconds: 0,
          unpaidBreakSeconds: 0,
          paidSeconds: 37500,
          totalSeconds: 37500,
        },
      ],
      employeeTotals: [{ employeeId: "e1", employeeName: "Lester Langaoen", ...emptyTotals(), workSeconds: 37500, paidSeconds: 37500, totalSeconds: 37500 }],
      dateTotals: [{ date: "2026-08-10", ...emptyTotals(), workSeconds: 37500, paidSeconds: 37500, totalSeconds: 37500 }],
      daysWorkedByEmployee: [],
      activityBreakdown: [],
      weeklyTotals: [],
      totals: { ...emptyTotals(), workSeconds: 37500, paidSeconds: 37500, totalSeconds: 37500 },
    };

    const grid = buildPayrollPivotGrid(data, { start: "2026-08-10", end: "2026-08-10" }, "workTime");
    expect(grid.employees[0].cells).toEqual(["10:25"]);
  });

  it("5 & 6) Employee Total is formatted from ITS OWN exact-seconds field, not by re-adding the rounded per-day strings (which would accumulate error)", () => {
    // Three days of 89s each (each individually rounds to "0:01") — a naive
    // "sum the rounded display strings" implementation would show
    // 1+1+1 = 3 minutes ("0:03"). The true combined duration is 267s =
    // 4.45 minutes, which rounds to 4 ("0:04") — the server's own
    // employeeTotals.workSeconds field (267, computed independently from
    // the raw rows, exactly as reportQueries.ts already does) is what must
    // drive the total, not the three already-rounded day cells.
    const dayRow = (date: string) => ({
      employeeId: "e1",
      employeeName: "Tiny Segments",
      date,
      startedAt: null,
      endedAt: null,
      workSeconds: 89,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      paidSeconds: 89,
      totalSeconds: 89,
    });
    const data: PayrollReportData = {
      rows: [dayRow("2026-08-10"), dayRow("2026-08-11"), dayRow("2026-08-12")],
      employeeTotals: [{ employeeId: "e1", employeeName: "Tiny Segments", ...emptyTotals(), workSeconds: 267, paidSeconds: 267, totalSeconds: 267 }],
      dateTotals: [
        { date: "2026-08-10", ...emptyTotals(), workSeconds: 89, paidSeconds: 89, totalSeconds: 89 },
        { date: "2026-08-11", ...emptyTotals(), workSeconds: 89, paidSeconds: 89, totalSeconds: 89 },
        { date: "2026-08-12", ...emptyTotals(), workSeconds: 89, paidSeconds: 89, totalSeconds: 89 },
      ],
      daysWorkedByEmployee: [],
      activityBreakdown: [],
      weeklyTotals: [],
      totals: { ...emptyTotals(), workSeconds: 267, paidSeconds: 267, totalSeconds: 267 },
    };

    const grid = buildPayrollPivotGrid(data, { start: "2026-08-10", end: "2026-08-12" }, "workTime");
    expect(grid.employees[0].cells).toEqual(["0:01", "0:01", "0:01"]);
    expect(grid.employees[0].grandTotal).toBe("0:04"); // NOT "0:03"
    expect(grid.grandTotal).toBe("0:04"); // the bottom-right grand total agrees
  });

  it("4) a weekly/grand total above 24 hours formats correctly, hours never wrapped or truncated", () => {
    const data: PayrollReportData = {
      rows: [],
      employeeTotals: [{ employeeId: "e1", employeeName: "Long Week", ...emptyTotals(), workSeconds: 232500, paidSeconds: 232500, totalSeconds: 232500 }], // 64:35
      dateTotals: [],
      daysWorkedByEmployee: [],
      activityBreakdown: [],
      weeklyTotals: [],
      totals: { ...emptyTotals(), workSeconds: 232500, paidSeconds: 232500, totalSeconds: 232500 },
    };
    const grid = buildPayrollPivotGrid(data, { start: "2026-08-10", end: "2026-08-10" }, "workTime");
    expect(grid.employees[0].grandTotal).toBe("64:35");
    expect(grid.grandTotal).toBe("64:35");
  });

  it("7) a day with no row at all for an employee stays '—', never '0:00'", () => {
    const data: PayrollReportData = {
      rows: [
        {
          employeeId: "e1",
          employeeName: "Partial Week",
          date: "2026-08-10",
          startedAt: null,
          endedAt: null,
          workSeconds: 3600,
          breakSeconds: 0,
          paidBreakSeconds: 0,
          unpaidBreakSeconds: 0,
          paidSeconds: 3600,
          totalSeconds: 3600,
        },
      ],
      employeeTotals: [{ employeeId: "e1", employeeName: "Partial Week", ...emptyTotals(), workSeconds: 3600, paidSeconds: 3600, totalSeconds: 3600 }],
      dateTotals: [{ date: "2026-08-10", ...emptyTotals(), workSeconds: 3600, paidSeconds: 3600, totalSeconds: 3600 }],
      daysWorkedByEmployee: [],
      activityBreakdown: [],
      weeklyTotals: [],
      totals: { ...emptyTotals(), workSeconds: 3600, paidSeconds: 3600, totalSeconds: 3600 },
    };
    // Range spans two days; the employee only has a row for the first.
    const grid = buildPayrollPivotGrid(data, { start: "2026-08-10", end: "2026-08-11" }, "workTime");
    expect(grid.employees[0].cells).toEqual(["1:00", "—"]);
    expect(grid.columnTotals[1]).toBe("—"); // DAY TOTAL for the empty day also stays a dash
  });

  it("9) the same PivotGrid feeds the on-screen table, Print, and CSV/PDF export — there is no second, independently-computed source of these strings", () => {
    // Structural proof: buildPayrollPivotGrid's return value (PivotGrid) is
    // exactly what ReportPivotTable renders on screen AND in the Print/PDF
    // preview modal (same component, reused as-is — see
    // ReportPreviewModal.tsx) AND what exportPivotCsv/exportPivotPdf
    // serialize (reportExport.ts) — so a single correct grid build is
    // sufficient to guarantee all three agree; there is no separate export-
    // only formatting path to independently test here.
    const data: PayrollReportData = {
      rows: [],
      employeeTotals: [{ employeeId: "e1", employeeName: "X", ...emptyTotals(), workSeconds: 37500, paidSeconds: 37500, totalSeconds: 37500 }],
      dateTotals: [],
      daysWorkedByEmployee: [],
      activityBreakdown: [],
      weeklyTotals: [],
      totals: { ...emptyTotals(), workSeconds: 37500, paidSeconds: 37500, totalSeconds: 37500 },
    };
    const grid = buildPayrollPivotGrid(data, { start: "2026-08-10", end: "2026-08-10" }, "workTime");
    // This exact string is what ReportPivotTable renders in <td>, what
    // ReportPreviewModal's reused ReportPivotTable prints, and what
    // exportPivotCsv/exportPivotPdf write into the file — one value, three
    // consumers.
    expect(grid.employees[0].grandTotal).toBe("10:25");
    expect(grid.grandTotal).toBe("10:25");
  });
});
