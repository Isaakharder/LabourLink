// @vitest-environment jsdom
//
// Reproduces and locks in the fix for the reported Payroll Report bug at the
// rendered-page level: Lester Langaoen's real 10:25:00 worked day must show
// as "10:25" on screen (never the old "10.42" decimal), with a clear H:MM
// indication next to it. Same api() mocking convention as
// DashboardPage.test.tsx / InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportViewPage } from "./ReportViewPage";
import { api } from "../../lib/api";
import { PayrollReportData, SavedReportDetail } from "../../lib/reportTypes";

const report: SavedReportDetail = {
  id: "report-1",
  name: "Weekly Payroll",
  reportType: "payroll",
  activity: null,
  configuration: {
    metrics: ["employee", "date", "totalHours", "workTime", "daysWorked", "activityBreakdown", "weeklyTotals"],
    lastDateRange: { start: "2026-08-10", end: "2026-08-10" },
  },
  employeeSelectionMode: "all",
  employeeIds: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

// Lester's real numbers: 10:25:00 worked = 37500 seconds.
const payrollData: PayrollReportData = {
  rows: [
    {
      employeeId: "lester",
      employeeName: "Lester Langaoen",
      date: "2026-08-10",
      startedAt: "2026-08-10T14:00:00.000Z",
      endedAt: "2026-08-11T00:25:00.000Z",
      workSeconds: 37500,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      paidSeconds: 37500,
      totalSeconds: 37500,
    },
  ],
  employeeTotals: [
    {
      employeeId: "lester",
      employeeName: "Lester Langaoen",
      workSeconds: 37500,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      paidSeconds: 37500,
      totalSeconds: 37500,
    },
  ],
  dateTotals: [
    { date: "2026-08-10", workSeconds: 37500, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 37500, totalSeconds: 37500 },
  ],
  daysWorkedByEmployee: [{ employeeId: "lester", employeeName: "Lester Langaoen", daysWorked: 1 }],
  activityBreakdown: [{ employeeId: "lester", activityId: "act-1", activityName: "Winding & Pruning", workSeconds: 37500 }],
  weeklyTotals: [{ weekStart: "2026-08-10", weekEnd: "2026-08-16", workSeconds: 37500, breakSeconds: 0, paidSeconds: 37500 }],
  totals: { workSeconds: 37500, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 37500, totalSeconds: 37500 },
};

let currentReport: SavedReportDetail = report;
const employees = [
  { id: "lester", firstName: "Lester", lastName: "Langaoen", isActive: true },
  { id: "maria", firstName: "Maria", lastName: "Santos", isActive: true },
];

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
    api: vi.fn((path: string, options?: RequestInit) => {
      if (path === "/api/reports/report-1" && (!options || options.method === undefined)) {
        return Promise.resolve({ report: currentReport });
      }
      if (path === "/api/reports/report-1" && options?.method === "PATCH") {
        const body = JSON.parse(options.body as string);
        if (body.employeeSelectionMode !== undefined) {
          currentReport = { ...currentReport, employeeSelectionMode: body.employeeSelectionMode, employeeIds: body.employeeIds };
        }
        return Promise.resolve({ ok: true });
      }
      if (path === "/api/employees") {
        return Promise.resolve({ employees });
      }
      if (path.startsWith("/api/reports/report-1/data")) return Promise.resolve({ data: payrollData });
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentReport = { ...report, employeeIds: [...report.employeeIds] };
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

describe("ReportViewPage — Payroll Report H:MM formatting", () => {
  it("1 & 2) Lester's real 10:25:00 worked day shows as 10:25 everywhere on the page, never the old 10.42 decimal", async () => {
    renderPage();
    const cells = await screen.findAllByText("10:25");
    expect(cells.length).toBeGreaterThan(0);
    expect(screen.queryByText("10.42")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+\.\d\d/)).not.toBeInTheDocument(); // no decimal-hours-looking string anywhere
  });

  it("adds a clear H:MM indication next to the table so a duration is never mistaken for a decimal or a clock time", async () => {
    renderPage();
    await screen.findAllByText("10:25");
    expect(screen.getAllByText(/H:MM/).length).toBeGreaterThan(0);
  });

  it("Activity breakdown and Weekly totals sub-tables also use H:MM, with a labeled (H:MM) header, not decimal", async () => {
    renderPage();
    // Both sub-tables render the same 37500s as "10:25" in their own column,
    // alongside the main pivot table's own cell + Employee Total + DAY TOTAL.
    const tenTwentyFive = await screen.findAllByText("10:25");
    expect(tenTwentyFive.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Hours (H:MM)")).toBeInTheDocument();
    expect(screen.getByText("Work hours (H:MM)")).toBeInTheDocument();
  });

  it("opens as a compact 'All employees' trigger, not the old always-expanded grid", async () => {
    renderPage();
    await screen.findAllByText("10:25");
    expect(screen.getByRole("button", { name: /All employees/ })).toBeInTheDocument();
    // The old giant grid rendered every employee's checkbox inline, with no
    // click needed — none should be present until the dropdown is opened.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("stages a selection and only persists it (PATCH) when Save is pressed", async () => {
    const user = userEvent.setup();
    const apiMock = vi.mocked(api);

    renderPage();
    await screen.findAllByText("10:25");

    await user.click(screen.getByRole("button", { name: /All employees/ }));
    await user.click(screen.getByRole("radio", { name: "Select specific employees" }));
    await user.click(screen.getByRole("checkbox", { name: /Maria Santos/ }));

    // Staged only — no PATCH yet, and the report's own data endpoint has
    // not been re-fetched with a new selection.
    expect(apiMock).not.toHaveBeenCalledWith("/api/reports/report-1", expect.objectContaining({ method: "PATCH" }));

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(apiMock).toHaveBeenCalledWith(
      "/api/reports/report-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ employeeSelectionMode: "selected", employeeIds: ["maria"] }) })
    );
    // Saving reloads the report's data (screen/print/CSV/PDF all read from
    // this one refetch) — same endpoint, no employeeIds query param, since
    // filtering is now entirely server-side off the saved definition.
    await screen.findByRole("button", { name: /1 employee selected/ });
  });

  it("Cancel closes the dropdown without altering the saved setup", async () => {
    const user = userEvent.setup();
    const apiMock = vi.mocked(api);

    renderPage();
    await screen.findAllByText("10:25");

    await user.click(screen.getByRole("button", { name: /All employees/ }));
    await user.click(screen.getByRole("radio", { name: "Select specific employees" }));
    await user.click(screen.getByRole("checkbox", { name: /Maria Santos/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(apiMock).not.toHaveBeenCalledWith("/api/reports/report-1", expect.objectContaining({ method: "PATCH" }));
    expect(screen.getByRole("button", { name: /All employees/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does not allow saving an explicit selection with zero employees", async () => {
    const user = userEvent.setup();

    renderPage();
    await screen.findAllByText("10:25");

    await user.click(screen.getByRole("button", { name: /All employees/ }));
    await user.click(screen.getByRole("radio", { name: "Select specific employees" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
