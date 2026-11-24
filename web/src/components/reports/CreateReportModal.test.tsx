// @vitest-environment jsdom
//
// Covers the Activity (Job) Report branch of the create wizard's Step 3:
// one "Daily cells" <select> and a "Summary columns" checkbox row, both
// offering only the six REPORT_METRIC_CHOICES (Rows, Total Hours, Paid
// Hours, Stems/Hr, Kg/Hr, Plants/Hr), chosen independently. Choices that
// don't apply to the chosen Job are disabled. POSTs {dailyMetric,
// weeklyTotals}, never the old flat {metrics} list. Payroll's own Step 3
// (its original checkbox grid, POSTing {metrics}) must stay untouched —
// covered by the second describe block below.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateReportModal } from "./CreateReportModal";

const apiMock = vi.fn();
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
    api: (...args: unknown[]) => apiMock(...args),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ACTIVITIES = [
  { id: "act-1", name: "Winding & Pruning", isActive: true, productivityMetric: "density", densitySource: "stems" },
  { id: "act-2", name: "Picking Peppers", isActive: true, productivityMetric: "scale_kg", densitySource: null },
];

async function goToActivityStep3(user: ReturnType<typeof userEvent.setup>, activityId = "act-1", onSaved = vi.fn()) {
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/activities?status=active") return Promise.resolve({ activities: ACTIVITIES });
    if (path === "/api/reports") return Promise.resolve({ id: "new-report-1" });
    return Promise.reject(new Error(`Unhandled mock api() call: ${path}`));
  });

  render(<CreateReportModal onClose={vi.fn()} onSaved={onSaved} />);
  await user.click(screen.getByRole("button", { name: /job report/i }));
  await user.type(screen.getByLabelText(/name/i), "Weekly");
  await user.click(screen.getByRole("button", { name: /^next$/i }));
  await screen.findByText(/step 3 of 3/i);
  await waitFor(() => expect(screen.getByRole("combobox", { name: /job$/i })).toBeInTheDocument());
  await user.selectOptions(screen.getByRole("combobox", { name: /job$/i }), activityId);
  return onSaved;
}

const SIX = ["Rows", "Total Hours", "Paid Hours", "Stems/Hr", "Kg/Hr", "Plants/Hr"];

describe("CreateReportModal — Job Report daily cells + summary columns", () => {
  it("offers exactly the six choices in the dropdown and as summary checkboxes", async () => {
    const user = userEvent.setup();
    await goToActivityStep3(user);

    const daily = screen.getByRole("combobox", { name: /daily cells/i });
    const options = Array.from(daily.querySelectorAll("option")).map((o) => o.textContent!.replace(" (n/a)", ""));
    expect(options).toEqual(SIX);
    const group = screen.getByRole("group", { name: /summary columns/i });
    const boxes = Array.from(group.querySelectorAll("label")).map((l) => l.textContent);
    expect(boxes).toEqual(SIX);
    // None of the old options remain.
    expect(screen.queryByRole("checkbox", { name: "Employee Paid Time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Weekly Job Hours" })).not.toBeInTheDocument();
  });

  it("disables what doesn't apply: Kg/Hr and Plants/Hr on a stems Job; nothing ruled out by unit for a Scale Job without a density source", async () => {
    const user = userEvent.setup();
    await goToActivityStep3(user, "act-1");
    expect(screen.getByRole("checkbox", { name: "Kg/Hr" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Plants/Hr" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Stems/Hr" })).toBeEnabled();

    await user.selectOptions(screen.getByRole("combobox", { name: /job$/i }), "act-2");
    expect(screen.getByRole("checkbox", { name: "Kg/Hr" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Stems/Hr" })).toBeEnabled();
  });

  it("defaults to Total Hours in both places, and disables Save when no summary column is left", async () => {
    const user = userEvent.setup();
    await goToActivityStep3(user);

    expect(screen.getByRole("combobox", { name: /daily cells/i })).toHaveValue("totalHours");
    const totalHours = screen.getByRole("checkbox", { name: "Total Hours" });
    expect(totalHours).toBeChecked();
    await user.click(totalHours);
    expect(screen.getByText(/choose at least one summary column/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save report/i })).toBeDisabled();
  });

  it("POSTs independently chosen {dailyMetric, weeklyTotals} — never the old flat {metrics} array", async () => {
    const user = userEvent.setup();
    const onSaved = await goToActivityStep3(user, "act-2");

    await user.selectOptions(screen.getByRole("combobox", { name: /daily cells/i }), "rows");
    await user.click(screen.getByRole("checkbox", { name: "Kg/Hr" }));
    await user.click(screen.getByRole("checkbox", { name: "Paid Hours" }));
    await user.click(screen.getByRole("button", { name: /save report/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("new-report-1"));
    const postCall = apiMock.mock.calls.find(([path]) => path === "/api/reports");
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.dailyMetric).toBe("rows");
    // Always in the fixed choice order, whatever order they were ticked in.
    expect(body.weeklyTotals).toEqual(["totalHours", "paidHours", "kgPerHour"]);
    expect(body.metrics).toBeUndefined();
  });

  it("switching to a Job a choice doesn't apply to drops that choice", async () => {
    const user = userEvent.setup();
    await goToActivityStep3(user, "act-2");
    await user.selectOptions(screen.getByRole("combobox", { name: /daily cells/i }), "kgPerHour");
    await user.click(screen.getByRole("checkbox", { name: "Kg/Hr" }));

    await user.selectOptions(screen.getByRole("combobox", { name: /job$/i }), "act-1");
    expect(screen.getByRole("combobox", { name: /daily cells/i })).toHaveValue("totalHours");
    expect(screen.getByRole("checkbox", { name: "Kg/Hr" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Total Hours" })).toBeChecked();
  });
});

describe("CreateReportModal — Payroll Report step 3 stays the original flat metrics checkbox grid", () => {
  it("shows checkboxes for every PAYROLL_METRICS entry and no Daily metric/Weekly totals controls", async () => {
    const user = userEvent.setup();
    render(<CreateReportModal onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /payroll report/i }));
    await user.type(screen.getByLabelText(/name/i), "Payroll — Biweekly");
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await screen.findByText(/step 3 of 3/i);

    expect(screen.getByRole("checkbox", { name: "Total hours (H:MM)" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /daily cells/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /summary columns/i })).not.toBeInTheDocument();
  });

  it("POSTs the original {metrics} array, never dailyMetric/weeklyTotals", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path === "/api/reports") return Promise.resolve({ id: "new-payroll-1" });
      return Promise.reject(new Error(`Unhandled mock api() call: ${path}`));
    });
    const onSaved = vi.fn();
    render(<CreateReportModal onClose={vi.fn()} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: /payroll report/i }));
    await user.type(screen.getByLabelText(/name/i), "Payroll — Biweekly");
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await screen.findByText(/step 3 of 3/i);
    await user.click(screen.getByRole("button", { name: /save report/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("new-payroll-1"));
    const postCall = apiMock.mock.calls.find(([path]) => path === "/api/reports");
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(Array.isArray(body.metrics)).toBe(true);
    expect(body.metrics.length).toBeGreaterThan(0);
    expect(body.dailyMetric).toBeUndefined();
    expect(body.weeklyTotals).toBeUndefined();
  });
});
