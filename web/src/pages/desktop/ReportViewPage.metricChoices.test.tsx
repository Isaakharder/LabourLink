// @vitest-environment jsdom
//
// The Job Report's simplified metric choices on the report page:
//  - a report saved with the older keys (averageSpeed, activityHours, ...)
//    is shown as its closest new choice, without being rewritten;
//  - Kg/Hr cells and columns come from the scale figures the server sends
//    (the Dashboard/TV calculation), a dash while no bin is weighed, with
//    the explanatory note;
//  - Edit Metrics shows one dropdown + summary checkboxes, chosen
//    independently, disabling choices that don't apply to the Job, and Save
//    PATCHes only the new keys.
// Same api() mocking convention as ReportViewPage.payrollFormat.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportViewPage } from "./ReportViewPage";
import { ActivityReportData, ReportScaleProductivity, SavedReportDetail } from "../../lib/reportTypes";
import { api } from "../../lib/api";

let configuration: SavedReportDetail["configuration"] = {};
let job: { productivityMetric: "density" | "scale_kg"; quantityUnits: string[] } = { productivityMetric: "density", quantityUnits: ["stems"] };
let scale: ReportScaleProductivity | null = null;

function makeReport(): SavedReportDetail {
  return {
    id: "report-1",
    name: "Picking",
    reportType: "activity",
    activity: { id: "act-1", name: "Picking" },
    configuration: { ...configuration, lastDateRange: { start: "2026-11-24", end: "2026-11-25" } },
    employeeSelectionMode: "all",
    employeeIds: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

const zero = { breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 };

function makeData(): ActivityReportData {
  return {
    activity: { id: "act-1", name: "Picking", normalSpeedPerHour: 900, speedUnit: "stems/hour", ...job },
    rows: [
      {
        employeeId: "byron",
        employeeName: "Byron Escober",
        date: "2026-11-24",
        startedAt: "2026-11-24T12:00:00.000Z",
        endedAt: "2026-11-24T16:00:00.000Z",
        workSeconds: 14400,
        ...zero,
        rowsTouched: 7,
        quantityWorked: 3600,
        rowsCompleted: 4,
        averageSpeed: 900.4,
        employeePaidSeconds: 16200,
      },
    ],
    employeeTotals: [
      {
        employeeId: "byron",
        employeeName: "Byron Escober",
        workSeconds: 14400,
        ...zero,
        rowsTouched: 7,
        quantityWorked: 3600,
        rowsCompleted: 4,
        averageSpeed: 900.4,
        employeePaidSeconds: 16200,
      },
    ],
    dateTotals: [
      { date: "2026-11-24", workSeconds: 14400, ...zero, rowsTouched: 7, quantityWorked: 3600, rowsCompleted: 4, averageSpeed: 900.4, employeePaidSeconds: 16200 },
    ],
    totals: { workSeconds: 14400, ...zero, rowsTouched: 7, quantityWorked: 3600, rowsCompleted: 4, averageSpeed: 900.4, employeePaidSeconds: 16200 },
    scaleProductivity: scale,
  };
}

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    api: vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/reports/report-1" && init?.method === "PATCH") return Promise.resolve({ ok: true });
      if (path === "/api/reports/report-1") return Promise.resolve({ report: makeReport() });
      if (path === "/api/employees") return Promise.resolve({ employees: [] });
      if (path.startsWith("/api/reports/report-1/data")) return Promise.resolve({ data: makeData() });
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  configuration = {};
  job = { productivityMetric: "density", quantityUnits: ["stems"] };
  scale = null;
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/reports/report-1"]}>
      <Routes>
        <Route path="/reports/:id" element={<ReportViewPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function headerTexts() {
  return screen.getAllByRole("columnheader").map((h) => h.textContent);
}

describe("ReportViewPage — older saved keys", () => {
  it("shows a report saved as Average Speed + Job hours as Stems/Hr cells and a Total Hours column", async () => {
    configuration = { dailyMetric: "averageSpeed", weeklyTotals: ["activityHours"] };
    renderPage();

    await screen.findByText("Byron Escober");
    // The number only: the unit is in the choice's name, not each cell.
    expect(screen.getAllByText("900.4").length).toBeGreaterThan(0);
    expect(screen.queryByText(/st\/hr/)).not.toBeInTheDocument();
    expect(headerTexts()).toContain("Total Hours");
    expect(screen.getAllByText("4:00").length).toBeGreaterThan(0);
    // Read, not rewritten.
    expect(vi.mocked(api).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("shows Paid Hours as the whole-day payroll figure (employeePaidSeconds)", async () => {
    configuration = { dailyMetric: "workTime", weeklyTotals: ["employeePaidTime"] };
    renderPage();
    await screen.findByText("Byron Escober");
    expect(headerTexts()).toContain("Paid Hours");
    expect(screen.getAllByText("4:30").length).toBeGreaterThan(0);
  });
});

describe("ReportViewPage — Kg/Hr", () => {
  it("fills Kg/Hr from the scale figures by weighing day, a dash while waiting for bins, and lists employees with bins but no time in range", async () => {
    job = { productivityMetric: "scale_kg", quantityUnits: ["stems"] };
    configuration = { dailyMetric: "kgPerHour", weeklyTotals: ["rows", "kgPerHour"] };
    scale = {
      reportingFrom: "2026-11-24",
      byEmployeeDay: [
        { employeeId: "byron", date: "2026-11-24", netGrams: 600000, matchedSeconds: 14400, bins: 3, kgPerHour: 150 },
        { employeeId: "noe", date: "2026-11-25", netGrams: 157100, matchedSeconds: 3600, bins: 1, kgPerHour: 157.1 },
      ],
      byEmployee: [
        { employeeId: "byron", employeeName: "Byron Escober", openBins: 1, netGrams: 600000, matchedSeconds: 14400, bins: 3, kgPerHour: 150 },
        { employeeId: "noe", employeeName: "Noe Example", openBins: 0, netGrams: 157100, matchedSeconds: 3600, bins: 1, kgPerHour: 157.1 },
      ],
      byDate: [
        { date: "2026-11-24", netGrams: 600000, matchedSeconds: 14400, bins: 3, kgPerHour: 150 },
        { date: "2026-11-25", netGrams: 157100, matchedSeconds: 3600, bins: 1, kgPerHour: 157.1 },
      ],
      totals: { netGrams: 757100, matchedSeconds: 18000, bins: 4, kgPerHour: 151.4 },
    };
    renderPage();

    const byronRow = (await screen.findByText("Byron Escober")).closest("tr")!;
    // Tue 150.0, Wed — (no bin weighed), Rows 7, Kg/Hr 150.0
    expect(within(byronRow).getAllByText("150.0")).toHaveLength(2);
    expect(within(byronRow).getByText("—")).toBeInTheDocument();
    const noeRow = screen.getByText("Noe Example").closest("tr")!;
    expect(within(noeRow).getAllByText("157.1")).toHaveLength(2);
    // Weighted total: 757.1 kg / 5 h, never the mean of 150.0 and 157.1.
    expect(screen.getByText("151.4")).toBeInTheDocument();
    expect(screen.getByText(/Kg\/Hr counts weighed bins only, on the day each bin was weighed \(from Nov 24, 2026\)/)).toBeInTheDocument();
  });

  it("shows dashes, never 0, when no bin has been weighed", async () => {
    job = { productivityMetric: "scale_kg", quantityUnits: ["stems"] };
    configuration = { dailyMetric: "rows", weeklyTotals: ["kgPerHour"] };
    scale = { reportingFrom: "2026-11-24", byEmployeeDay: [], byEmployee: [], byDate: [], totals: { netGrams: 0, matchedSeconds: 0, bins: 0, kgPerHour: null } };
    renderPage();
    const row = (await screen.findByText("Byron Escober")).closest("tr")!;
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.0")).not.toBeInTheDocument();
  });
});

describe("ReportViewPage — Kg/Hr on a Job without LabourLink Scale", () => {
  it("says the Job isn't measured with LabourLink Scale, not that reporting starts later", async () => {
    configuration = { dailyMetric: "rows", weeklyTotals: ["kgPerHour"] };
    renderPage();
    await screen.findByText("Byron Escober");
    expect(screen.getByText(/Kg\/Hr is not reported for this Job: it is not measured with LabourLink Scale/)).toBeInTheDocument();
    expect(screen.queryByText(/reporting starts later/)).not.toBeInTheDocument();
  });
});

describe("ReportViewPage — Edit Metrics", () => {
  it("chooses daily cells and summary columns independently and saves only the new keys", async () => {
    configuration = { dailyMetric: "averageSpeed", weeklyTotals: ["activityHours", "averageSpeed"] };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Byron Escober");
    await user.click(screen.getByRole("button", { name: "Edit Metrics" }));

    expect(screen.getByRole("combobox", { name: /daily cells/i })).toHaveValue("stemsPerHour");
    expect(screen.getByRole("checkbox", { name: "Total Hours" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Stems/Hr" })).toBeChecked();
    // A row-count Job: no Kg/Hr, no Plants/Hr.
    expect(screen.getByRole("checkbox", { name: "Kg/Hr" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Plants/Hr" })).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox", { name: /daily cells/i }), "rows");
    await user.click(screen.getByRole("checkbox", { name: "Paid Hours" }));
    await user.click(screen.getByRole("checkbox", { name: "Stems/Hr" }));
    // The table follows the choices before saving.
    expect(headerTexts()).toEqual(expect.arrayContaining(["Total Hours", "Paid Hours"]));
    await user.click(within(document.querySelector<HTMLElement>(".report-metric-picker")!).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = vi.mocked(api).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ dailyMetric: "rows", weeklyTotals: ["totalHours", "paidHours"] });
    });
  });

  it("closing without saving puts the saved choices back", async () => {
    configuration = { dailyMetric: "rows", weeklyTotals: ["totalHours"] };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Byron Escober");
    await user.click(screen.getByRole("button", { name: "Edit Metrics" }));
    await user.click(screen.getByRole("checkbox", { name: "Paid Hours" }));
    expect(headerTexts()).toContain("Paid Hours");
    await user.click(screen.getByRole("button", { name: "Close Metrics" }));
    expect(headerTexts()).not.toContain("Paid Hours");
  });
});
