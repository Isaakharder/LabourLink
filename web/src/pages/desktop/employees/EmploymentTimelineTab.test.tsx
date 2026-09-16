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
let displayStartResponse: { displayStart: string | null };

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
    api: vi.fn((path: string, options?: { method?: string; body?: string }) => {
      if (path.startsWith("/api/auth/me")) return Promise.resolve(meResponse);
      if (path.startsWith("/api/employment-periods/settings/display-start")) {
        if (options?.method === "PATCH") {
          const body = JSON.parse(options.body ?? "{}") as { displayStart?: string | null };
          displayStartResponse = { displayStart: body.displayStart ?? null };
        }
        return Promise.resolve(displayStartResponse);
      }
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
  displayStartResponse = { displayStart: null };
  // jsdom never lays anything out, so a real DOM element's clientWidth is
  // always 0 — EmploymentTimelineGraph measures its own scroll container
  // to compute the "Fit all" density, so a hardcoded realistic width here
  // is what makes the adaptive header-granularity choice (and zoom limits)
  // behave the way an actual browser would, rather than always collapsing
  // to the coarsest (year) granularity.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1400 });
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

    // At the mocked 1400px container width, a 90-day range fits at
    // ~15.6px/day — fine enough for weekly (not monthly) header marks, per
    // buildTimelineHeaderMarks' adaptive granularity (see its own unit
    // tests in employmentTimeline.test.ts for the full tier breakdown).
    const marks = Array.from(document.querySelectorAll(".employment-timeline-month-mark")).map((el) => el.textContent ?? "");
    expect(marks[0]).toBe("Dec 29"); // the Monday-start week containing 2026-01-01
    expect(marks[marks.length - 1]).toBe("Mar 30");
    expect(marks.length).toBeGreaterThan(3); // meaningfully finer than month-level for this range/width

    await user.click(screen.getByRole("button", { name: "Full timeline" }));
    expect((screen.getAllByDisplayValue("")[0] as HTMLInputElement).value).toBe("");
  });

  it("an employee with no employment dates renders as a full-width dashed row, not a bar, in both Graph and Table", async () => {
    timelineResponse = {
      employees: [makeTimelineEmployee(), makeTimelineEmployee({ id: "no-dates", firstName: "No", lastName: "Dates", hasUsableDates: false, periods: [] })],
    };
    renderTab();
    const flaggedRow = await screen.findByRole("button", { name: "Add employment dates for No Dates" });
    expect(flaggedRow).toHaveTextContent("No Dates · Missing employment dates");
    expect(flaggedRow).toHaveClass("employment-timeline-bar-missing-dates");
    expect(flaggedRow).not.toBeDisabled(); // Administrator (canEdit) in this fixture

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Table" }));
    // Table/CSV/PDF/Print all read the same buildEmploymentTimelineRows
    // output, which spells it out as its own Status value there.
    expect(screen.getAllByText("No employment dates recorded").length).toBeGreaterThan(0);
  });

  it("clicking the missing-dates row opens the Add-period modal for that employee", async () => {
    timelineResponse = {
      employees: [makeTimelineEmployee(), makeTimelineEmployee({ id: "no-dates", firstName: "No", lastName: "Dates", hasUsableDates: false, periods: [] })],
    };
    renderTab();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add employment dates for No Dates" }));
    expect(await screen.findByRole("heading", { name: "Add employment period — No Dates" })).toBeInTheDocument();
  });

  it("a Manager (view-only) cannot click the missing-dates row — no permission to create a period", async () => {
    meResponse = { employee: { id: "mgr-1", firstName: "Mo", lastName: "Manager", securityRole: "Manager", teamRole: "Team Member" } };
    timelineResponse = {
      employees: [makeTimelineEmployee(), makeTimelineEmployee({ id: "no-dates", firstName: "No", lastName: "Dates", hasUsableDates: false, periods: [] })],
    };
    renderTab();
    expect(await screen.findByRole("button", { name: "Add employment dates for No Dates" })).toBeDisabled();
  });

  it("renders each bar's label as 'Employee Name · Status' and opens the period editor on click, for any viewer", async () => {
    renderTab();
    const bar = await screen.findByRole("button", { name: "View or edit Eve Employee's employment period" });
    expect(bar).toHaveTextContent("Eve Employee · Ongoing");
    expect(bar).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(bar);
    expect(await screen.findByRole("heading", { name: "Edit employment period — Eve Employee" })).toBeInTheDocument();
  });

  it("a Manager (view-only) can still open a real period read-only, but not a bar that would create one", async () => {
    meResponse = { employee: { id: "mgr-1", firstName: "Mo", lastName: "Manager", securityRole: "Manager", teamRole: "Team Member" } };
    renderTab();
    const bar = await screen.findByRole("button", { name: "View or edit Eve Employee's employment period" });
    expect(bar).not.toBeDisabled();
    const user = userEvent.setup();
    await user.click(bar);
    expect(await screen.findByRole("heading", { name: "Eve Employee — Employment period" })).toBeInTheDocument();
  });

  it("the Add-period modal offers 'Add another period' when editing a real period, wired to reopen in add mode", async () => {
    renderTab();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "View or edit Eve Employee's employment period" }));
    await screen.findByRole("heading", { name: "Edit employment period — Eve Employee" });

    await user.click(screen.getByRole("button", { name: "Add another period" }));
    expect(await screen.findByRole("heading", { name: "Add employment period — Eve Employee" })).toBeInTheDocument();
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

describe("EmploymentTimelineTab — 'Timeline starts' saved display-cutoff setting", () => {
  it("loads and shows the saved cutoff; an Administrator can edit and Save it", async () => {
    displayStartResponse = { displayStart: "2024-03-01" };
    const user = userEvent.setup();
    renderTab();

    const input = (await screen.findByLabelText("Timeline starts")) as HTMLInputElement;
    expect(input.value).toBe("2024-03-01");
    expect(input).not.toBeDisabled();

    fireEvent.change(input, { target: { value: "2025-01-01" } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Persisted through the mocked PATCH — a fresh read would see it too.
    expect(displayStartResponse.displayStart).toBe("2025-01-01");
  });

  it("Reset to earliest employee start clears the saved cutoff (PATCHes null)", async () => {
    displayStartResponse = { displayStart: "2024-03-01" };
    const user = userEvent.setup();
    renderTab();
    await screen.findByDisplayValue("2024-03-01");

    await user.click(screen.getByRole("button", { name: "Reset to earliest employee start" }));

    expect(displayStartResponse.displayStart).toBeNull();
    expect((screen.getByLabelText("Timeline starts") as HTMLInputElement).value).toBe("");
  });

  it("a Manager sees the saved cutoff read-only — disabled input, no Save/Reset, with an explanatory note", async () => {
    meResponse = { employee: { id: "mgr-1", firstName: "Mo", lastName: "Manager", securityRole: "Manager", teamRole: "Team Member" } };
    displayStartResponse = { displayStart: "2024-03-01" };
    renderTab();

    const input = (await screen.findByLabelText("Timeline starts")) as HTMLInputElement;
    expect(input.value).toBe("2024-03-01");
    expect(input).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to earliest employee start" })).not.toBeInTheDocument();
    expect(screen.getByText("Only an Administrator can change this.")).toBeInTheDocument();
  });

  it("a period starting before the saved cutoff is clipped with a continuation indicator, not hidden or moved", async () => {
    displayStartResponse = { displayStart: "2025-01-01" };
    timelineResponse = {
      employees: [
        makeTimelineEmployee({
          periods: [
            {
              id: "period-1",
              employeeId: "emp-1",
              startDate: "2020-06-01", // well before the saved cutoff
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
              createdAt: "2020-06-01T00:00:00.000Z",
              updatedAt: "2020-06-01T00:00:00.000Z",
            },
          ],
        }),
      ],
    };
    renderTab();

    const bar = await screen.findByRole("button", { name: "View or edit Eve Employee's employment period" });
    expect(bar.style.left).toBe("0%"); // drawn from the display boundary
    expect(bar.querySelector(".employment-timeline-bar-clip-notch")).toBeInTheDocument();
    expect(bar.getAttribute("title")).toContain("2020-06-01"); // true start date still surfaced
    expect(bar.getAttribute("title")).toContain("employment began before the displayed range");
  });

  it("clearing a custom From/To override returns to the saved cutoff, not the raw earliest employee start", async () => {
    displayStartResponse = { displayStart: "2025-06-01" };
    timelineResponse = {
      employees: [makeTimelineEmployee({ periods: [{ ...makeTimelineEmployee().periods[0], startDate: "2018-01-01" }] })],
    };
    const user = userEvent.setup();
    renderTab();
    await screen.findByDisplayValue("2025-06-01");

    const [fromInput, toInput] = screen.getAllByDisplayValue("").filter((el) => el.closest(".employment-timeline-range-picker")) as HTMLInputElement[];
    fireEvent.change(fromInput, { target: { value: "2026-01-01" } });
    fireEvent.change(toInput, { target: { value: "2026-03-31" } });
    let marks = Array.from(document.querySelectorAll(".employment-timeline-month-mark")).map((el) => el.textContent ?? "");
    expect(marks[0]).not.toContain("2018");

    await user.click(screen.getByRole("button", { name: "Full timeline" }));
    marks = Array.from(document.querySelectorAll(".employment-timeline-month-mark")).map((el) => el.textContent ?? "");
    // Back to the saved cutoff (2025-06-01), never the true 2018 start.
    expect(marks.some((m) => m.includes("2018"))).toBe(false);
    expect(marks[0]).toContain("2025");
  });
});
