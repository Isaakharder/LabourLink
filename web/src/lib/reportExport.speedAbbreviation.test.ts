// @vitest-environment jsdom
//
// Covers the two export-side requirements of the speed-unit abbreviation
// feature: CSV must stay unambiguous (full "stems/hour"/"plants/hour",
// never abbreviated, since there's no accompanying note in a CSV file),
// while PDF — a visual document like the screen — DOES abbreviate its
// speed cells and prints the same explanatory note used on screen/print.
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
  configuration: { metrics: ["employee", "averageSpeed"] },
  employeeSelectionMode: "all",
  employeeIds: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const grid: PivotGrid = {
  dates: ["2026-08-17"],
  employees: [{ employeeId: "e1", employeeName: "Byron Escober", cells: ["51.8 stems/hour"], grandTotal: "48.0 stems/hour" }],
  columnTotals: ["45.0 stems/hour"],
  grandTotal: "46.5 stems/hour",
};

const STEMS_NOTE = "Speed shown as st/hr (stems per hour).";

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  textCalls.length = 0;
  saveCalls.length = 0;
  lastAutoTableConfig = null;
});

describe("exportPivotCsv — Average Speed stays fully spelled out", () => {
  it("never abbreviates stems/hour, so the CSV file is unambiguous on its own", async () => {
    const { exportPivotCsv } = await import("./reportExport");

    let capturedText = "";
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      // Blob.text() is async; the assertion below awaits it before the
      // test ends, same as reading any other captured side effect.
      (blob as Blob).text().then((t) => {
        capturedText = t;
      });
      return "blob:mock";
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();

    exportPivotCsv(report, grid, "Average speed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedText).toContain("51.8 stems/hour");
    expect(capturedText).toContain("48.0 stems/hour");
    expect(capturedText).toContain("45.0 stems/hour");
    expect(capturedText).toContain("46.5 stems/hour");
    expect(capturedText).not.toContain("st/hr");

    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevoke;
  });
});

describe("exportPivotPdf — Average Speed cells are abbreviated, with the note printed alongside them", () => {
  it("abbreviates every speed cell in the PDF table body and prints the stems note", async () => {
    const { exportPivotPdf } = await import("./reportExport");

    exportPivotPdf(report, { start: "2026-08-17", end: "2026-08-17" }, grid, "Average speed", "landscape", STEMS_NOTE);

    expect(lastAutoTableConfig).toBeTruthy();
    const bodyText = JSON.stringify(lastAutoTableConfig.body);
    expect(bodyText).toContain("51.8 st/hr");
    expect(bodyText).toContain("48.0 st/hr");
    expect(bodyText).toContain("45.0 st/hr");
    expect(bodyText).toContain("46.5 st/hr");
    expect(bodyText).not.toContain("stems/hour");

    const allText = textCalls.map((args) => args[0]).join(" | ");
    expect(allText).toContain(STEMS_NOTE);
    expect(saveCalls.length).toBe(1);
  });

  it("prints no note line when speedUnitNote is null (e.g. a non-speed metric, or Average Speed with a free-text unit)", async () => {
    const { exportPivotPdf } = await import("./reportExport");

    exportPivotPdf(report, { start: "2026-08-17", end: "2026-08-17" }, grid, "Average speed", "landscape", null);

    const allText = textCalls.map((args) => args[0]).join(" | ");
    expect(allText).not.toContain(STEMS_NOTE);
    expect(allText).not.toContain("pl/hr");
  });
});
