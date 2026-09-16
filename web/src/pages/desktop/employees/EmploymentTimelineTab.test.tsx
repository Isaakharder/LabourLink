// @vitest-environment jsdom
//
// Control-behavior regression tests for the Employment Timeline toolbar
// after the "Fit all" redesign: Full timeline is the default/primary view
// (no Month/Quarter/Year window, no Prev/Next), Graph/Table stays a
// two-way segmented choice, Today/zoom/export/print controls still fire
// their underlying actions, and a custom From/To override changes the
// displayed range. lib/api and lib/employmentTimelineExport are mocked the
// same way EmployeesPage.test.tsx mocks lib/api — no real network/PDF work
// happens.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmploymentTimelineTab } from "./EmploymentTimelineTab";
import { AuthProvider } from "../../../context/AuthContext";
import { EmploymentTimelineEmployee } from "../../../lib/employmentPeriodTypes";
import { todayInAppTimezone } from "../../../lib/timezone";

const TODAY = todayInAppTimezone();

let meResponse: { employee: { id: string; firstName: string; lastName: string; securityRole: string; teamRole: string } };
let timelineResponse: { employees: EmploymentTimelineEmployee[] };

vi.mock("../../../lib/api", () => {
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
      if (path.startsWith("/api/auth/me")) return Promise.resolve(meResponse);
      if (path.startsWith("/api/employment-periods")) return Promise.resolve(timelineResponse);
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

const exportCsv = vi.fn();
const exportPdf = vi.fn();
const printTimeline = vi.fn();
vi.mock("../../../lib/employmentTimelineExport", () => ({
  exportEmploymentTimelineCsv: (...args: unknown[]) => exportCsv(...args),
  exportEmploymentTimelinePdf: (...args: unknown[]) => exportPdf(...args),
  printEmploymentTimeline: (...args: unknown[]) => printTimeline(...args),
}));

function makeTimelineEmployee(overrides: Partial<EmploymentTimelineEmployee> = {}): EmploymentTimelineEmployee {
  return {
    id: "emp-1",
    firstName: "Eve",
    lastName: "Employee",
    nationality: "Canadian",
    jobGroup: "Greenhouse",
    isActive: true,
    workPermit: null,
    hasUsableDates: true,
    periods: [
      {
        id: "period-1",
        employeeId: "emp-1",
        startDate: "2024-08-01",
        expectedFinishDate: null,
        actualFinishDate: null,
        employmentType: "Permanent",
        workGroup: "Greenhouse",
        workGroupOtherDescription: null,
        notes: null,
        statuses: ["current"],
        timelineEffectiveEndDate: TODAY,
        timelineLabel: "ongoing",
        synthesized: false,
        createdAt: "2024-08-01T00:00:00.000Z",
        updatedAt: "2024-08-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderTab() {
  return render(
    <AuthProvider>
      <EmploymentTimelineTab />
    </AuthProvider>
  );
}

beforeEach(() => {
  meResponse = {
    employee: { id: "admin-1", firstName: "Ada", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" },
  };
  timelineResponse = { employees: [makeTimelineEmployee()] };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EmploymentTimelineTab controls", () => {
  it("defaults to the Graph view with a Full timeline / Today / Zoom toolbar, no Month/Quarter/Year or Prev/Next", async () => {
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });

    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Month" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quarter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();

    const graph = screen.getByRole("button", { name: "Graph" });
    const table = screen.getByRole("button", { name: "Table" });
    expect(graph).toHaveAttribute("aria-pressed", "true");
    expect(table).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".employment-timeline-graph-wrap")).toBeInTheDocument();
  });

  it("fits the full employment range by default — the earliest period start and today both appear as month marks", async () => {
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });
    // The mock period starts 2024-08 and is ongoing through today — the
    // fitted range must span both ends. Only the first mark and any
    // January mark carry the year suffix (see buildTimelineMonthMarks), so
    // check the current year appears somewhere rather than assuming it's
    // on the very last mark.
    const marks = Array.from(document.querySelectorAll(".employment-timeline-month-mark")).map((el) => el.textContent ?? "");
    expect(marks[0]).toContain("2024");
    expect(marks.some((m) => m.includes(TODAY.slice(0, 4)))).toBe(true);
  });

  it("switches the Graph/Table segmented control and swaps the rendered view", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("button", { name: "Graph" });

    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector("table.employment-timeline-table")).toBeInTheDocument();
    expect(document.querySelector(".employment-timeline-graph-wrap")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(document.querySelector(".employment-timeline-graph-wrap")).toBeInTheDocument();
  });

  it("still fires Export CSV, Export PDF and Print on click", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("button", { name: /Export CSV/ });

    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(exportCsv).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /Export PDF/ }));
    expect(exportPdf).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /Print/ }));
    // Print switches to the table view first, then prints on the next frame.
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  });

  it("Zoom in increases the graph track's minimum pixel width; Full timeline resets it", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });

    const track = document.querySelector(".employment-timeline-track") as HTMLElement;
    const baselineWidth = track.style.minWidth;

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomedTrack = document.querySelector(".employment-timeline-track") as HTMLElement;
    expect(parseFloat(zoomedTrack.style.minWidth)).toBeGreaterThan(parseFloat(baselineWidth));

    await user.click(screen.getByRole("button", { name: "Full timeline" }));
    const resetTrack = document.querySelector(".employment-timeline-track") as HTMLElement;
    expect(resetTrack.style.minWidth).toBe(baselineWidth);
  });

  it("a custom From/To range overrides the fitted range, and Full timeline clears it", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });

    const [fromInput, toInput] = screen.getAllByDisplayValue("") as HTMLInputElement[];
    // fireEvent.change (not user.type) — native date inputs don't reliably
    // accept segment-by-segment keystroke typing in jsdom.
    fireEvent.change(fromInput, { target: { value: "2026-01-01" } });
    fireEvent.change(toInput, { target: { value: "2026-03-31" } });

    const marks = Array.from(document.querySelectorAll(".employment-timeline-month-mark")).map((el) => el.textContent ?? "");
    expect(marks).toEqual(["Jan 2026", "Feb", "Mar"]);

    await user.click(screen.getByRole("button", { name: "Full timeline" }));
    expect((screen.getAllByDisplayValue("")[0] as HTMLInputElement).value).toBe("");
  });

  it("an employee with no employment dates renders as a flagged row, not a bar, in both Graph and Table", async () => {
    timelineResponse = {
      employees: [makeTimelineEmployee(), makeTimelineEmployee({ id: "no-dates", firstName: "No", lastName: "Dates", hasUsableDates: false, periods: [] })],
    };
    renderTab();
    // Graph: a short inline flag next to the name (the full sentence would
    // grow that row's height out of sync with its date track — see
    // EmploymentTimelineGraph's own comment on the two-panel layout).
    await screen.findByText("(no dates)");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Table" }));
    // Table/CSV/PDF/Print all read the same buildEmploymentTimelineRows
    // output, which spells it out in full there instead.
    expect(screen.getAllByText("No employment dates recorded").length).toBeGreaterThan(0);
  });

  it("still renders all five filters with consistent trigger styling", async () => {
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });

    for (const label of ["Employee: All", "Nationality: All", "Work Group: All", "Employment Type: All", "Status: All"]) {
      const trigger = screen.getByText(label).closest("button");
      expect(trigger).toHaveClass("employment-timeline-filter-trigger");
    }
  });
});
