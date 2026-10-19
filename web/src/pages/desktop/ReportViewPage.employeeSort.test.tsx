// @vitest-environment jsdom
//
// Covers the "Sort employees" control on the real ReportViewPage: the
// alphabetical default, switching to "Speed: highest first" without any
// refetch, DAY TOTAL staying last, re-sorting after a date-range or
// employee-filter change, the employee search still working, the Print
// preview + CSV following the on-screen order, the choice surviving
// navigation, and Payroll (no speed) disabling the option. Same api()
// mocking convention as ReportViewPage.payrollFormat.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportViewPage } from "./ReportViewPage";
import { api } from "../../lib/api";
import { ActivityReportData, PayrollReportData, SavedReportDetail } from "../../lib/reportTypes";
import { DEFAULT_EMPLOYEE_SORT, setSessionEmployeeSort } from "../../lib/reportEmployeeSort";

const csvCalls: { names: string[] }[] = [];

vi.mock("../../lib/reportExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/reportExport")>();
  return {
    ...actual,
    exportPivotCsv: vi.fn((_report, grid) => {
      csvCalls.push({ names: grid.employees.map((e: { employeeName: string }) => e.employeeName) });
    }),
    printReport: vi.fn(),
  };
});

const THIS_RANGE = { start: "2026-08-17", end: "2026-08-17" };

function activityReport(): SavedReportDetail {
  return {
    id: "report-1",
    name: "Picking Peppers",
    reportType: "activity",
    activity: { id: "act-1", name: "Picking Peppers" },
    configuration: { dailyMetric: "workTime", weeklyTotals: ["activityHours", "averageSpeed"], lastDateRange: THIS_RANGE },
    employeeSelectionMode: "all",
    employeeIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function payrollReport(): SavedReportDetail {
  return { ...activityReport(), name: "Payroll", reportType: "payroll", activity: null, configuration: { metrics: ["workTime"], lastDateRange: THIS_RANGE } };
}

function activityData(employees: { id: string; name: string; speed: number | null }[]): ActivityReportData {
  return {
    activity: { id: "act-1", name: "Picking Peppers", normalSpeedPerHour: 900, speedUnit: "stems/hour" },
    rows: [],
    employeeTotals: employees.map((e) => ({
      employeeId: e.id,
      employeeName: e.name,
      workSeconds: 3600,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      rowsTouched: 1,
      quantityWorked: e.speed,
      rowsCompleted: 1,
      averageSpeed: e.speed,
      employeePaidSeconds: 3600,
    })),
    dateTotals: [],
    totals: {
      workSeconds: 3600,
      breakSeconds: 0,
      paidBreakSeconds: 0,
      unpaidBreakSeconds: 0,
      quantityWorked: null,
      rowsCompleted: 1,
      rowsTouched: 1,
      averageSpeed: 500,
      employeePaidSeconds: 3600,
    },
  };
}

const ALL_EMPLOYEES = [
  { id: "ana", name: "Ana Lopez", speed: 9.5 },
  { id: "bea", name: "Bea Cruz", speed: null },
  { id: "carlos", name: "Carlos Diaz", speed: 1140.6 },
  { id: "diego", name: "Diego Ruiz", speed: 10.2 },
];

const payrollData = {
  rows: [],
  employeeTotals: [
    { employeeId: "bea", employeeName: "Bea Cruz", workSeconds: 3600, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 3600, totalSeconds: 3600 },
    { employeeId: "ana", employeeName: "Ana Lopez", workSeconds: 7200, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 7200, totalSeconds: 7200 },
  ],
  dateTotals: [],
  totals: { workSeconds: 10800, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0, paidSeconds: 10800, totalSeconds: 10800 },
  daysWorkedByEmployee: [],
  activityBreakdown: [],
  weeklyTotals: [],
} as unknown as PayrollReportData;

let currentReport: SavedReportDetail = activityReport();
// Returns the data for a given data-request query string, so a date-range
// change can hand back a different set of employees.
let dataFor: (query: string) => ActivityReportData | PayrollReportData = () => activityData(ALL_EMPLOYEES);

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
        return Promise.resolve({
          employees: ALL_EMPLOYEES.map((e) => {
            const [firstName, lastName] = e.name.split(" ");
            return { id: e.id, firstName, lastName, isActive: true };
          }),
        });
      }
      if (path.startsWith("/api/reports/report-1/data")) {
        return Promise.resolve({ data: dataFor(path.slice(path.indexOf("?") + 1)) });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  csvCalls.length = 0;
  currentReport = activityReport();
  dataFor = () => activityData(ALL_EMPLOYEES);
  setSessionEmployeeSort(DEFAULT_EMPLOYEE_SORT);
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

function rowNames(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole("row")
    .slice(1) // header
    .map((r) => r.querySelector("td")?.textContent ?? "");
}

function mainTable(): HTMLElement {
  return document.querySelector(".report-view-main .report-pivot-table") as HTMLElement;
}

async function waitForTable() {
  await screen.findByText("Ana Lopez");
}

function sortSelect(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Sort employees" }) as HTMLSelectElement;
}

function dataRequests() {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith("/api/reports/report-1/data"));
}

describe("ReportViewPage — Sort employees", () => {
  it("defaults to Alphabetical with the existing order and DAY TOTAL last", async () => {
    renderPage();
    await waitForTable();
    expect(sortSelect().value).toBe("alphabetical");
    expect(rowNames(mainTable())).toEqual(["Ana Lopez", "Bea Cruz", "Carlos Diaz", "Diego Ruiz", "DAY TOTAL"]);
  });

  it("re-orders by numeric speed immediately, missing speeds last, without refetching", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTable();
    const before = dataRequests().length;

    await user.selectOptions(sortSelect(), "speedDesc");

    expect(rowNames(mainTable())).toEqual(["Carlos Diaz", "Diego Ruiz", "Ana Lopez", "Bea Cruz", "DAY TOTAL"]);
    expect(dataRequests().length).toBe(before);

    await user.selectOptions(sortSelect(), "alphabetical");
    expect(rowNames(mainTable())).toEqual(["Ana Lopez", "Bea Cruz", "Carlos Diaz", "Diego Ruiz", "DAY TOTAL"]);
  });

  it("re-sorts the new results when the date range changes", async () => {
    const user = userEvent.setup();
    dataFor = (query) =>
      query.includes(`start=${THIS_RANGE.start}`)
        ? activityData(ALL_EMPLOYEES)
        : activityData([
            { id: "ana", name: "Ana Lopez", speed: 2000 },
            { id: "elena", name: "Elena Gil", speed: 3000 },
            { id: "bea", name: "Bea Cruz", speed: 1 },
          ]);
    renderPage();
    await waitForTable();
    await user.selectOptions(sortSelect(), "speedDesc");

    await user.click(screen.getByRole("button", { name: "Last Week" }));

    await waitFor(() => expect(rowNames(mainTable())).toEqual(["Elena Gil", "Ana Lopez", "Bea Cruz", "DAY TOTAL"]));
    expect(sortSelect().value).toBe("speedDesc");
  });

  it("keeps the employee filter and its search working, and re-sorts the filtered results", async () => {
    const user = userEvent.setup();
    dataFor = () =>
      activityData(
        currentReport.employeeSelectionMode === "selected"
          ? ALL_EMPLOYEES.filter((e) => currentReport.employeeIds.includes(e.id))
          : ALL_EMPLOYEES
      );
    renderPage();
    await waitForTable();
    await user.selectOptions(sortSelect(), "speedDesc");

    await user.click(screen.getByRole("button", { name: /All employees/ }));
    const panel = screen.getByRole("dialog", { name: "Select employees" });
    await user.click(within(panel).getByRole("radio", { name: "Select specific employees" }));
    await user.type(within(panel).getByPlaceholderText("Search employees..."), "a");
    // "a" matches every name; narrow further to prove search still filters.
    await user.type(within(panel).getByPlaceholderText("Search employees..."), "n");
    expect(within(panel).getByRole("checkbox", { name: /Ana Lopez/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox", { name: /Carlos Diaz/ })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("checkbox", { name: /Ana Lopez/ }));
    await user.clear(within(panel).getByPlaceholderText("Search employees..."));
    await user.click(within(panel).getByRole("checkbox", { name: /Diego Ruiz/ }));
    await user.click(within(panel).getByRole("checkbox", { name: /Bea Cruz/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(rowNames(mainTable())).toEqual(["Diego Ruiz", "Ana Lopez", "Bea Cruz", "DAY TOTAL"]));
  });

  it("Print preview and CSV export use the selected order", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTable();
    await user.selectOptions(sortSelect(), "speedDesc");

    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(csvCalls).toEqual([{ names: ["Carlos Diaz", "Diego Ruiz", "Ana Lopez", "Bea Cruz"] }]);

    await user.click(screen.getByRole("button", { name: "Print" }));
    const preview = document.querySelector(".report-preview-page .report-pivot-table") as HTMLElement;
    expect(rowNames(preview)).toEqual(["Carlos Diaz", "Diego Ruiz", "Ana Lopez", "Bea Cruz", "DAY TOTAL"]);
  });

  it("remembers the selection when navigating away and back within the session", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await waitForTable();
    await user.selectOptions(sortSelect(), "speedDesc");
    unmount();

    renderPage();
    await waitForTable();
    expect(sortSelect().value).toBe("speedDesc");
    expect(rowNames(mainTable())[0]).toBe("Carlos Diaz");
  });

  it("Payroll (no speed metric) disables the Speed option and stays alphabetical even if Speed was chosen earlier", async () => {
    setSessionEmployeeSort("speedDesc");
    currentReport = payrollReport();
    dataFor = () => payrollData;
    renderPage();
    await screen.findByText("Ana Lopez");

    expect(sortSelect().value).toBe("alphabetical");
    const speedOption = within(sortSelect()).getByRole("option", { name: /Speed: highest first/ }) as HTMLOptionElement;
    expect(speedOption.disabled).toBe(true);
    expect(rowNames(mainTable())).toEqual(["Ana Lopez", "Bea Cruz", "DAY TOTAL"]);
  });
});
