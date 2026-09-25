// @vitest-environment jsdom
//
// Covers the Activity Report branch of the create wizard's Step 3: the
// checkbox-plus-"Show:"-dropdown workflow is gone, replaced by a single
// "Daily metric" <select> (DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS) plus a
// "Weekly totals" multi-select checkbox group
// (WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS, min 1) — see reportTypes.ts.
// POSTs {dailyMetric, weeklyTotals}, never the old flat {metrics} list.
// Payroll's own Step 3 (its original checkbox grid, POSTing {metrics})
// must stay completely untouched by this redesign — covered by the second
// describe block below.
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

async function goToActivityStep3(user: ReturnType<typeof userEvent.setup>) {
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/activities?status=active") {
      return Promise.resolve({ activities: [{ id: "act-1", name: "Winding & Pruning", isActive: true }] });
    }
    return Promise.reject(new Error(`Unhandled mock api() call: ${path}`));
  });

  render(<CreateReportModal onClose={vi.fn()} onSaved={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /activity report/i }));
  await user.type(screen.getByLabelText(/name/i), "Winding — Weekly");
  await user.click(screen.getByRole("button", { name: /^next$/i }));
  await screen.findByText(/step 3 of 3/i);
  await waitFor(() => expect(screen.getByRole("combobox", { name: /activity$/i })).toBeInTheDocument());
  await user.selectOptions(screen.getByRole("combobox", { name: /activity$/i }), "act-1");
}

describe("CreateReportModal — Activity Report daily metric + weekly totals", () => {
  it("shows a Daily metric select and a Weekly totals checkbox group instead of the old flat metrics checkbox grid", async () => {
    const user = userEvent.setup();
    await goToActivityStep3(user);

    expect(screen.getByRole("combobox", { name: /daily metric/i })).toBeInTheDocument();
    // No lone flat metrics checkbox grid — "Weekly totals" is its own
    // labeled fieldset, distinct from the Daily metric selector.
    expect(screen.getByText(/weekly totals/i)).toBeInTheDocument();
    // Every daily-metric option is a real activity metric label.
    expect(screen.getByRole("option", { name: "Activity hours" })).toBeInTheDocument();
    // Employee Paid Time is only ever a weekly total, never a daily-metric
    // option (it's a whole-shift figure, not meaningful per activity-day).
    expect(screen.queryByRole("option", { name: "Employee Paid Time" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Employee Paid Time" })).toBeInTheDocument();
  });

  it("defaults to Activity hours checked as the only weekly total, and disables Save when none remain checked", async () => {
    const user = userEvent.setup();
    await goToActivityStep3(user);

    const activityHoursCheckbox = screen.getByRole("checkbox", { name: "Weekly Activity Hours" });
    expect(activityHoursCheckbox).toBeChecked();

    await user.click(activityHoursCheckbox);
    expect(screen.getByText(/at least one weekly total must be selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save report/i })).toBeDisabled();
  });

  it("POSTs {dailyMetric, weeklyTotals} — never the old flat {metrics} array", async () => {
    const user = userEvent.setup();
    await goToActivityStep3(user);

    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/reports" && init?.method === "POST") {
        return Promise.resolve({ id: "new-report-1" });
      }
      return Promise.reject(new Error(`Unhandled mock api() call: ${path}`));
    });

    await user.selectOptions(screen.getByRole("combobox", { name: /daily metric/i }), "averageSpeed");
    await user.click(screen.getByRole("checkbox", { name: "Employee Paid Time" }));

    const onSaved = vi.fn();
    cleanup();
    render(<CreateReportModal onClose={vi.fn()} onSaved={onSaved} />);
    apiMock.mockImplementation((path: string) => {
      if (path === "/api/activities?status=active") {
        return Promise.resolve({ activities: [{ id: "act-1", name: "Winding & Pruning", isActive: true }] });
      }
      if (path === "/api/reports") {
        return Promise.resolve({ id: "new-report-1" });
      }
      return Promise.reject(new Error(`Unhandled mock api() call: ${path}`));
    });
    await user.click(screen.getByRole("button", { name: /activity report/i }));
    await user.type(screen.getByLabelText(/name/i), "Winding — Weekly");
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: /activity$/i })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: /activity$/i }), "act-1");
    await user.selectOptions(screen.getByRole("combobox", { name: /daily metric/i }), "averageSpeed");
    await user.click(screen.getByRole("checkbox", { name: "Employee Paid Time" }));
    await user.click(screen.getByRole("button", { name: /save report/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("new-report-1"));
    const postCall = apiMock.mock.calls.find(([path]) => path === "/api/reports");
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.dailyMetric).toBe("averageSpeed");
    expect(body.weeklyTotals).toEqual(expect.arrayContaining(["activityHours", "employeePaidTime"]));
    expect(body.metrics).toBeUndefined();
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
    expect(screen.queryByRole("combobox", { name: /daily metric/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/weekly totals \(right-hand/i)).not.toBeInTheDocument();
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
