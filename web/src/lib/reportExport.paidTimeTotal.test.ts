// @vitest-environment jsdom
//
// Covers the "Total Paid Time" column in CSV and PDF export — the same
// values ReportPivotTable renders on screen (reportPivot.activityPaidTimeTotal.test.ts,
// ReportPivotTable.paidTimeTotal.test.tsx), read from the same PivotGrid,
// present exactly when grid.totalPaidTimeGrandTotal is set and completely
// absent otherwise.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedReportDetail } from "./reportTypes";
import { PivotGrid } from "./reportPivot";

const textCalls: unknown[][] = [];
const saveCalls: unknown[] = [];
let lastAutoTableConfig: any = null;

vi.mock("jspdf", () => {
  class MockJsPDF {
    setFontSize(...args: unknown[]) {}
    text(...args: unknown[]) {
      textCalls.push(args);
    }
    save(name: unknown) {
      saveCalls.push(name);
    }
  }
  return { default: MockJsPDF };
});

vi.mock("jspdf-autotable", () => {
  return {
    default: (_doc: unknown, config: any) => {
      lastAutoTableConfig = config;
    },
  };
});

const report: SavedReportDetail = {
  id: "report-1",
  name: "Winding & Pruning",
  reportType: "activity",
  activity: { id: "act-1", name: "Winding & Pruning" },
  configuration: { metrics: ["employee", "workTime", "paidTime"] },
  employeeSelectionMode: "all",
  employeeIds: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const gridWithPaidTime: PivotGrid = {
  dates: ["2026-08-17"],
  employees: [
    { employeeId: "e1", employeeName: "Alice", cells: ["4:00"], grandTotal: "4:00", totalPaidTime: "4:30" },
    { employeeId: "e2", employeeName: "Bob", cells: ["2:00"], grandTotal: "2:00", totalPaidTime: "2:00" },
  ],
  columnTotals: ["6:00"],
  grandTotal: "6:00",
  totalPaidTimeGrandTotal: "6:30",
};

const gridWithoutPaidTime: PivotGrid = {
  dates: ["2026-08-17"],
  employees: [{ employeeId: "e1", employeeName: "Alice", cells: ["4:00"], grandTotal: "4:00" }],
  columnTotals: ["4:00"],
  grandTotal: "4:00",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  textCalls.length = 0;
  saveCalls.length = 0;
  lastAutoTableConfig = null;
});

async function captureCsvText(exportFn: () => void): Promise<string> {
  let capturedText = "";
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    (blob as Blob).text().then((t) => {
      capturedText = t;
    });
    return "blob:mock";
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();

  exportFn();
  await new Promise((resolve) => setTimeout(resolve, 0));

  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevoke;
  return capturedText;
}

describe("exportPivotCsv — Total Paid Time column", () => {
  it("includes a 'Total Paid Time' header and every employee's/DAY TOTAL's value when the grid has them", async () => {
    const { exportPivotCsv } = await import("./reportExport");
    const text = await captureCsvText(() => exportPivotCsv(report, gridWithPaidTime, "Work time"));

    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Employee,Aug 17,Employee Total,Total Paid Time");
    expect(lines).toContain("Alice,4:00,4:00,4:30");
    expect(lines).toContain("Bob,2:00,2:00,2:00");
    expect(lines).toContain("DAY TOTAL,6:00,6:00,6:30");
  });

  it("omits the column entirely (header and every row) when the grid has no paid-time totals", async () => {
    const { exportPivotCsv } = await import("./reportExport");
    const text = await captureCsvText(() => exportPivotCsv(report, gridWithoutPaidTime, "Work time"));

    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Employee,Aug 17,Employee Total");
    expect(lines).toContain("Alice,4:00,4:00");
    expect(lines).toContain("DAY TOTAL,4:00,4:00");
  });
});

describe("exportPivotPdf — Total Paid Time column", () => {
  it("adds a 'Total Paid Time' head column and every row's value when the grid has them", async () => {
    const { exportPivotPdf } = await import("./reportExport");
    exportPivotPdf(report, { start: "2026-08-17", end: "2026-08-17" }, gridWithPaidTime, "Work time", "landscape", null);

    expect(lastAutoTableConfig).toBeTruthy();
    expect(lastAutoTableConfig.head[0]).toEqual(["Employee", "Aug 17", "Employee Total", "Total Paid Time"]);
    const bodyText = JSON.stringify(lastAutoTableConfig.body);
    expect(bodyText).toContain("4:30");
    expect(bodyText).toContain("2:00");
    expect(bodyText).toContain("6:30");
  });

  it("omits the column entirely from the PDF table when the grid has no paid-time totals", async () => {
    const { exportPivotPdf } = await import("./reportExport");
    exportPivotPdf(report, { start: "2026-08-17", end: "2026-08-17" }, gridWithoutPaidTime, "Work time", "landscape", null);

    expect(lastAutoTableConfig.head[0]).toEqual(["Employee", "Aug 17", "Employee Total"]);
    const bodyText = JSON.stringify(lastAutoTableConfig.body);
    expect(bodyText).not.toContain("Total Paid Time");
  });

  it("bolds both total columns (Employee Total and Total Paid Time), not just the last one", async () => {
    const { exportPivotPdf } = await import("./reportExport");
    exportPivotPdf(report, { start: "2026-08-17", end: "2026-08-17" }, gridWithPaidTime, "Work time", "landscape", null);

    const didParseCell = lastAutoTableConfig.didParseCell as (data: any) => void;
    // Employee Total is column index 2 (Employee, date, Employee Total, Total Paid Time).
    const employeeTotalCell = { row: { index: 0 }, column: { index: 2 }, section: "body", cell: { styles: {} as { fontStyle?: string } } };
    didParseCell(employeeTotalCell);
    expect(employeeTotalCell.cell.styles.fontStyle).toBe("bold");

    const paidTimeCell = { row: { index: 0 }, column: { index: 3 }, section: "body", cell: { styles: {} as { fontStyle?: string } } };
    didParseCell(paidTimeCell);
    expect(paidTimeCell.cell.styles.fontStyle).toBe("bold");

    // A plain date cell (not a total column) stays unbolded.
    const dateCell = { row: { index: 0 }, column: { index: 1 }, section: "body", cell: { styles: {} as { fontStyle?: string } } };
    didParseCell(dateCell);
    expect(dateCell.cell.styles.fontStyle).toBeUndefined();
  });
});
