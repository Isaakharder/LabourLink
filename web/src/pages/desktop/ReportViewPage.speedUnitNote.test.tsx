// @vitest-environment jsdom
//
// Covers the on-screen half of the Activity Report speed-unit abbreviation
// feature: the "Speed shown as st/hr..." note only appears when the
// selected pivot metric is Average Speed AND the activity's speed unit has
// a defined abbreviation, and the pivot cells themselves render abbreviated
// on screen. Same api() mocking convention as ReportViewPage.payrollFormat
// .test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportViewPage } from "./ReportViewPage";
import { ActivityReportData, SavedReportDetail } from "../../lib/reportTypes";

function makeReport(): SavedReportDetail {
  return {
    id: "report-1",
    name: "Winding & Pruning",
    reportType: "activity",
    activity: { id: "act-1", name: "Winding & Pruning" },
    configuration: { metrics: ["employee", "averageSpeed"], lastDateRange: { start: "2026-08-17", end: "2026-08-17" } },
    employeeSelectionMode: "all",
    employeeIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeData(speedUnit: string | null): ActivityReportData {
  return {
    activity: { id: "act-1", name: "Winding & Pruning", normalSpeedPerHour: 180, speedUnit },
    rows: [
      {
        employeeId: "byron",
        employeeName: "Byron Escober",
        date: "2026-08-17",
        startedAt: "2026-08-17T13:00:00.000Z",
        endedAt: "2026-08-17T17:00:00.000Z",
        workSeconds: 14400,
        breakSeconds: 0,
        paidBreakSeconds: 0,
        unpaidBreakSeconds: 0,
        rowsTouched: 2,
        quantityWorked: 200,
        rowsCompleted: 1,
        averageSpeed: 51.8,
      },
    ],
    employeeTotals: [
      {
        employeeId: "byron",
        employeeName: "Byron Escober",
        workSeconds: 14400,
        breakSeconds: 0,
        paidBreakSeconds: 0,
        unpaidBreakSeconds: 0,
        rowsTouched: 2,
        quantityWorked: 200,
        rowsCompleted: 1,
        averageSpeed: 48.0,
      },
    ],
    dateTotals: [
      { date: "2026-08-17", workSeconds: 14400, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, rowsTouched: 2, quantityWorked: 200, rowsCompleted: 1, averageSpeed: 45.0 },
    ],
    totals: { workSeconds: 14400, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, rowsTouched: 2, quantityWorked: 200, rowsCompleted: 1, averageSpeed: 46.5 },
  };
}

let currentSpeedUnit: string | null = "stems/hour";

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
    api: vi.fn((path: string) => {
      if (path === "/api/reports/report-1") return Promise.resolve({ report: makeReport() });
      if (path === "/api/employees") return Promise.resolve({ employees: [] });
      if (path.startsWith("/api/reports/report-1/data")) return Promise.resolve({ data: makeData(currentSpeedUnit) });
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentSpeedUnit = "stems/hour";
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

describe("ReportViewPage — Activity Report speed-unit abbreviation note", () => {
  it("shows the stems note and abbreviated cells when the metric is Average Speed and the unit is stems/hour", async () => {
    currentSpeedUnit = "stems/hour";
    renderPage();

    expect(await screen.findByText("Speed shown as st/hr (stems per hour).")).toBeInTheDocument();
    expect(screen.getByText("51.8 st/hr")).toBeInTheDocument();
    expect(screen.getByText("48.0 st/hr")).toBeInTheDocument();
    expect(screen.getByText("45.0 st/hr")).toBeInTheDocument();
    expect(screen.getByText("46.5 st/hr")).toBeInTheDocument();
    expect(screen.queryByText(/stems\/hour/)).not.toBeInTheDocument();
  });

  it("shows the plants note and pl/hr cells when the unit is plants/hour", async () => {
    currentSpeedUnit = "plants/hour";
    renderPage();

    expect(await screen.findByText("pl/hr means plants per hour.")).toBeInTheDocument();
    expect(screen.getByText("51.8 pl/hr")).toBeInTheDocument();
    expect(screen.queryByText(/plants\/hour/)).not.toBeInTheDocument();
  });

  it("shows no note (and no abbreviation) for a free-text speed unit with no defined abbreviation", async () => {
    currentSpeedUnit = "rows/hour";
    renderPage();

    await screen.findByText("51.8 rows/hour");
    expect(screen.queryByText(/^Speed shown as/)).not.toBeInTheDocument();
    expect(screen.queryByText(/means .* per hour\./)).not.toBeInTheDocument();
  });

  it("shows no note when the activity has no configured speed unit at all", async () => {
    currentSpeedUnit = null;
    renderPage();

    await screen.findByText("Byron Escober");
    expect(screen.queryByText(/^Speed shown as/)).not.toBeInTheDocument();
    expect(screen.queryByText(/means .* per hour\./)).not.toBeInTheDocument();
  });
});
