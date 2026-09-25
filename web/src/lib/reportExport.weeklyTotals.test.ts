// @vitest-environment jsdom
//
// Covers CSV/PDF export's trailing-column layout — the same
// discriminated-by-grid.weeklyTotalColumns contract ReportPivotTable
// renders on screen (reportPivot.weeklyTotals.test.ts,
// ReportPivotTable.weeklyTotals.test.tsx), read from the same PivotGrid:
// Activity's N saved weekly-total columns when present, Payroll's single
// Employee Total column when absent.
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

const activityReport: SavedReportDetail = {
  id: "report-1",
  name: "Winding & Pruning",
  reportType: "activity",
  activity: { id: "act-1", name: "Winding & Pruning" },
  configuration: { dailyMetric: "workTime", weeklyTotals: ["activityHours", "employeePaidTime"] },
  employeeSelectionMode: "all",
  employeeIds: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const payrollReport: SavedReportDetail = {
  ...activityReport,
  reportType: "payroll",
  activity: null,
  configuration: { metrics: ["employee", "workTime"] },
};

const gridWithWeeklyTotals: PivotGrid = {
  dates: ["2026-08-17"],
  employees: [
    { employeeId: "e1", employeeName: "Alice", cells: ["4:00"], weeklyTotals: ["4:00", "4:30"] },
    { employeeId: "e2", employeeName: "Bob", cells: ["2:00"], weeklyTotals: ["2:00", "2:00"] },
  ],
  columnTotals: ["6:00"],
  weeklyTotalColumns: [
    { key: "activityHours", label: "Weekly Activity Hours" },
    { key: "employeePaidTime", label: "Employee Paid Time" },
  ],
  weeklyTotalColumnTotals: ["6:00", "6:30"],
};

const gridWithEmployeeTotal: PivotGrid = {
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

describe("exportPivotCsv — weekly totals columns", () => {
  it("Activity: includes one header/column per weeklyTotalColumns entry, in order, never 'Employee Total'", async () => {
    const { exportPivotCsv } = await import("./reportExport");
    const text = await captureCsvText(() => exportPivotCsv(activityReport, gridWithWeeklyTotals, "Work time"));

    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Employee,Aug 17,Weekly Activity Hours,Employee Paid Time");
    expect(lines).toContain("Alice,4:00,4:00,4:30");
    expect(lines).toContain("Bob,2:00,2:00,2:00");
    expect(lines).toContain("DAY TOTAL,6:00,6:00,6:30");
  });

  it("Payroll: still uses the single 'Employee Total' column (unaffected by the Activity redesign)", async () => {
    const { exportPivotCsv } = await import("./reportExport");
    const text = await captureCsvText(() => exportPivotCsv(payrollReport, gridWithEmployeeTotal, "Work time"));

    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Employee,Aug 17,Employee Total");
    expect(lines).toContain("Alice,4:00,4:00");
    expect(lines).toContain("DAY TOTAL,4:00,4:00");
  });
});

describe("exportPivotPdf — weekly totals columns", () => {
  it("Activity: adds one head column per weeklyTotalColumns entry and every row's value", async () => {
    const { exportPivotPdf } = await import("./reportExport");
    exportPivotPdf(activityReport, { start: "2026-08-17", end: "2026-08-17" }, gridWithWeeklyTotals, "Work time", "landscape", null);

    expect(lastAutoTableConfig).toBeTruthy();
    expect(lastAutoTableConfig.head[0]).toEqual(["Employee", "Aug 17", "Weekly Activity Hours", "Employee Paid Time"]);
    const bodyText = JSON.stringify(lastAutoTableConfig.body);
    expect(bodyText).toContain("4:30");
    expect(bodyText).toContain("2:00");
    expect(bodyText).toContain("6:30");
  });

  it("Payroll: still uses the single 'Employee Total' head column", async () => {
    const { exportPivotPdf } = await import("./reportExport");
    exportPivotPdf(payrollReport, { start: "2026-08-17", end: "2026-08-17" }, gridWithEmployeeTotal, "Work time", "landscape", null);

    expect(lastAutoTableConfig.head[0]).toEqual(["Employee", "Aug 17", "Employee Total"]);
    const bodyText = JSON.stringify(lastAutoTableConfig.body);
    expect(bodyText).not.toContain("Weekly Activity Hours");
  });

  it("bolds every trailing weekly-total column (not just the last one), a plain date cell stays unbolded", async () => {
    const { exportPivotPdf } = await import("./reportExport");
    exportPivotPdf(activityReport, { start: "2026-08-17", end: "2026-08-17" }, gridWithWeeklyTotals, "Work time", "landscape", null);

    const didParseCell = lastAutoTableConfig.didParseCell as (data: any) => void;
    // Head: Employee(0), Aug 17(1), Weekly Activity Hours(2), Employee Paid Time(3).
    const activityHoursCell = { row: { index: 0 }, column: { index: 2 }, section: "body", cell: { styles: {} as { fontStyle?: string } } };
    didParseCell(activityHoursCell);
    expect(activityHoursCell.cell.styles.fontStyle).toBe("bold");

    const paidTimeCell = { row: { index: 0 }, column: { index: 3 }, section: "body", cell: { styles: {} as { fontStyle?: string } } };
    didParseCell(paidTimeCell);
    expect(paidTimeCell.cell.styles.fontStyle).toBe("bold");

    const dateCell = { row: { index: 0 }, column: { index: 1 }, section: "body", cell: { styles: {} as { fontStyle?: string } } };
    didParseCell(dateCell);
    expect(dateCell.cell.styles.fontStyle).toBeUndefined();
  });
});
