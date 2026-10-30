// @vitest-environment jsdom
//
// The Employment Timeline tab: toolbar controls (Full timeline / Today /
// zoom / From-To / Graph-Table / exports), the "Employees: N" count and the
// numbering following every filter, the simplified three-date editor (same
// employee record as the Directory: PATCH /api/employees/:id with only
// those three fields), validation, read-only viewing, and the saved
// "Timeline starts" setting. lib/api and lib/employmentTimelineExport are
// mocked — no real network/PDF work happens.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
let patches: { path: string; body: Record<string, unknown> }[] = [];
let timelineLoads = 0;

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
    onSessionExpired: vi.fn(() => () => {}),
    api: vi.fn((path: string, options?: { method?: string; body?: string }) => {
      if (path.startsWith("/api/auth/me")) return Promise.resolve(meResponse);
      if (path.startsWith("/api/employment-periods/settings/display-start")) {
        if (options?.method === "PATCH") {
          const body = JSON.parse(options.body ?? "{}") as { displayStart?: string | null };
          displayStartResponse = { displayStart: body.displayStart ?? null };
        }
        return Promise.resolve(displayStartResponse);
      }
      if (path === "/api/employment-periods") {
        timelineLoads++;
        return Promise.resolve(timelineResponse);
      }
      if (path.startsWith("/api/employees/") && options?.method === "PATCH") {
        patches.push({ path, body: JSON.parse(options.body ?? "{}") });
        return Promise.resolve({ employee: {} });
      }
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

function emp(overrides: Partial<EmploymentTimelineEmployee> = {}): EmploymentTimelineEmployee {
  return {
    id: "emp-1",
    firstName: "Eve",
    lastName: "Employee",
    nationality: "Canadian",
    jobGroup: null,
    employeeGroup: { id: "g-gh", name: "Greenhouse Guys" },
    isActive: true,
    employmentStartDate: "2024-08-01",
    workPermitExpiryDate: null,
    endDifferentDate: null,
    vacationStartDate: null,
    vacationEndDate: null,
    workPermit: null,
    employmentType: "Permanent",
    workGroup: "Greenhouse",
    hasUsableDates: true,
    timelineEndDate: null,
    timelineEndSource: null,
    timelineLabel: "ongoing",
    statuses: ["current"],
    ...overrides,
  };
}

const crew = () => [
  emp(),
  emp({ id: "emp-2", firstName: "Gus", lastName: "Guatemala", nationality: "Guatemalan", employeeGroup: { id: "g-loc", name: "Locals" }, employmentType: "Seasonal" }),
  emp({ id: "emp-3", firstName: "Mia", lastName: "Mexico", nationality: "Mexican", employeeGroup: null, employmentType: null, statuses: ["permitExpired"], workPermitExpiryDate: "2025-01-31", timelineEndDate: "2025-01-31", timelineEndSource: "workPermitExpiry", timelineLabel: "permitExpired" }),
  emp({ id: "emp-4", firstName: "Zed", lastName: "Zulu", nationality: "Mexican", employeeGroup: { id: "g-gh", name: "Greenhouse Guys" } }),
];

function renderTab() {
  return render(
    <AuthProvider>
      <EmploymentTimelineTab />
    </AuthProvider>
  );
}

const count = () => document.querySelector(".employment-timeline-count")!.textContent;
const rowheads = () => [...document.querySelectorAll(".employment-timeline-rowhead")].map((r) => r.textContent);
const monthCells = () =>
  [...document.querySelectorAll(".employment-timeline-scale-months .employment-timeline-scale-cell")].map((el) => (el as HTMLElement).dataset.date);
const graphWidth = () => parseFloat((document.querySelector(".employment-timeline-graph") as HTMLElement).style.width);

async function pickFilter(user: ReturnType<typeof userEvent.setup>, trigger: string, option: string) {
  await user.click(screen.getByText(trigger).closest("button")!);
  const panel = document.querySelector(".employment-timeline-filter-panel") as HTMLElement;
  await user.click(within(panel).getByLabelText(option));
  await user.click(within(panel).getByRole("button", { name: /Apply/ }));
}

beforeEach(() => {
  meResponse = {
    employee: { id: "admin-1", firstName: "Ada", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" },
  };
  timelineResponse = { employees: [emp()] };
  displayStartResponse = { displayStart: null };
  patches = [];
  timelineLoads = 0;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1400 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EmploymentTimelineTab controls", () => {
  it("defaults to the Graph view with Full timeline / Today / Zoom, Graph-Table and the filters", async () => {
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });
    for (const name of ["Today", "Zoom in", "Zoom out"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
    for (const label of ["Employee: All", "Nationality: All", "Employee Group: All", "Work Group: All", "Employment Type: All", "Status: All"]) {
      expect(screen.getByText(label).closest("button")).toHaveClass("employment-timeline-filter-trigger");
    }
  });

  it("fits the full range: month gridlines from the earliest Employment Start Date through today", async () => {
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });
    const months = monthCells();
    expect(months[0]).toBe("2024-08-01");
    expect(months).toContain(`${TODAY.slice(0, 7)}-01`);
    expect([...document.querySelectorAll(".employment-timeline-scale-years .employment-timeline-scale-cell")].map((c) => c.textContent)).toContain("2024");
  });

  it("switches Graph/Table, and Print switches to the table first; CSV and PDF export the displayed employees", async () => {
    timelineResponse = { employees: crew() };
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("button", { name: "Table" });
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(document.querySelector("table.employment-timeline-table")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Graph" }));

    await pickFilter(user, "Nationality: All", "Mexican");
    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    await user.click(screen.getByRole("button", { name: /Export PDF/ }));
    expect(exportCsv.mock.calls[0][0].map((e: EmploymentTimelineEmployee) => e.id)).toEqual(["emp-3", "emp-4"]);
    expect(exportPdf.mock.calls[0][0].map((e: EmploymentTimelineEmployee) => e.id)).toEqual(["emp-3", "emp-4"]);
    await user.click(screen.getByRole("button", { name: /Print/ }));
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    const tableNumbers = [...document.querySelectorAll("table.employment-timeline-table tbody tr td:first-child")].map((td) => td.textContent);
    expect(tableNumbers).toEqual(["1", "2"]);
  });

  it("Zoom in widens the date track; Full timeline resets it", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });
    const baseline = graphWidth();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(graphWidth()).toBeGreaterThan(baseline);
    await user.click(screen.getByRole("button", { name: "Full timeline" }));
    expect(graphWidth()).toBeCloseTo(baseline, 5);
  });

  it("a custom From/To range sets the month labels; Full timeline clears it", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("button", { name: "Full timeline" });
    const [fromInput, toInput] = [...document.querySelectorAll(".employment-timeline-range-picker input")] as HTMLInputElement[];
    fireEvent.change(fromInput, { target: { value: "2026-01-01" } });
    fireEvent.change(toInput, { target: { value: "2026-03-31" } });
    expect(monthCells()).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect([...document.querySelectorAll(".employment-timeline-scale-months .employment-timeline-scale-cell")].map((c) => c.textContent)).toEqual(["Jan", "Feb", "Mar"]);
    await user.click(screen.getByRole("button", { name: "Full timeline" }));
    expect(fromInput.value).toBe("");
  });
});

describe("EmploymentTimelineTab — numbering and the Employees count", () => {
  it("shows 'Employees: N' for the displayed employees and numbers them 1..n", async () => {
    timelineResponse = { employees: crew() };
    renderTab();
    await screen.findByText("Employees:");
    expect(count()).toBe("Employees: 4");
    expect(rowheads()).toEqual(["1Eve Employee", "2Gus Guatemala", "3Mia Mexico", "4Zed Zulu"]);
  });

  it.each([
    ["Nationality: All", "Mexican", ["1Mia Mexico", "2Zed Zulu"]],
    ["Employee Group: All", "Greenhouse Guys", ["1Eve Employee", "2Zed Zulu"]],
    ["Employee Group: All", "Ungrouped", ["1Mia Mexico"]],
    ["Employment Type: All", "Seasonal", ["1Gus Guatemala"]],
    ["Status: All", "Permit expired", ["1Mia Mexico"]],
    ["Employee: All", "Zed Zulu", ["1Zed Zulu"]],
  ])("filter %s → %s renumbers from 1 and updates the count", async (trigger, option, expected) => {
    timelineResponse = { employees: crew() };
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Employees:");
    await pickFilter(user, trigger, option);
    expect(rowheads()).toEqual(expected);
    expect(count()).toBe(`Employees: ${expected.length}`);
  });

  it("an employee with no Employment Start Date is numbered and counted, shown as a dashed row in Graph and Table", async () => {
    timelineResponse = { employees: [emp(), emp({ id: "nd", firstName: "No", lastName: "Dates", hasUsableDates: false, employmentStartDate: null, timelineLabel: null })] };
    const user = userEvent.setup();
    renderTab();
    expect(await screen.findByRole("button", { name: "2. No Dates: add an Employment Start Date" })).toHaveClass("employment-timeline-bar-missing-dates");
    expect(count()).toBe("Employees: 2");
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByText("No Employment Start Date recorded")).toBeInTheDocument();
  });
});

describe("EmploymentTimelineTab — simplified employment-dates editor", () => {
  async function openEditor(user: ReturnType<typeof userEvent.setup>, name = "1. Eve Employee: edit employment dates") {
    await user.click(await screen.findByRole("button", { name }));
    return screen.getByRole("dialog");
  }

  it("shows the three employment dates and the two vacation dates — no type, group, notes, add or delete", async () => {
    timelineResponse = { employees: [emp({ workPermitExpiryDate: "2027-02-04", timelineEndDate: "2027-02-04", timelineEndSource: "workPermitExpiry", timelineLabel: "employed" })] };
    const user = userEvent.setup();
    renderTab();
    const dialog = await openEditor(user);
    expect(within(dialog).getByLabelText(/^Employment Start Date/)).toHaveValue("2024-08-01");
    expect(within(dialog).getByLabelText(/^Work Permit Expiry Date/)).toHaveValue("2027-02-04");
    expect(within(dialog).getByLabelText(/^End Different Date/)).toHaveValue("");
    expect(within(dialog).getByLabelText(/^Start Vacation/)).toHaveValue("");
    expect(within(dialog).getByLabelText(/^End Vacation/)).toHaveValue("");
    expect(dialog.querySelectorAll("input")).toHaveLength(5);
    expect(dialog.querySelectorAll("select, textarea")).toHaveLength(0);
    for (const gone of [/Employment type/i, /Work group/i, /Notes/i, /Add another period/i, /Delete period/i]) {
      expect(within(dialog).queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("saves the dates to the employee record (the same PATCH the Directory uses) and reloads the timeline", async () => {
    const user = userEvent.setup();
    renderTab();
    const dialog = await openEditor(user);
    fireEvent.change(within(dialog).getByLabelText(/^Employment Start Date/), { target: { value: "2024-07-15" } });
    fireEvent.change(within(dialog).getByLabelText(/^Work Permit Expiry Date/), { target: { value: "2027-02-04" } });
    fireEvent.change(within(dialog).getByLabelText(/^End Different Date/), { target: { value: "2026-12-15" } });
    fireEvent.change(within(dialog).getByLabelText(/^Start Vacation/), { target: { value: "2026-07-01" } });
    fireEvent.change(within(dialog).getByLabelText(/^End Vacation/), { target: { value: "2026-07-14" } });
    const loadsBefore = timelineLoads;
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      path: "/api/employees/emp-1",
      body: { startDate: "2024-07-15", workPermitExpiryDate: "2027-02-04", employmentEndDate: "2026-12-15", vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-14" },
    });
    // Never isActive or anything else — saving can't deactivate or clock out.
    expect(Object.keys(patches[0].body).sort()).toEqual(["employmentEndDate", "startDate", "vacationEndDate", "vacationStartDate", "workPermitExpiryDate"]);
    await waitFor(() => expect(timelineLoads).toBeGreaterThan(loadsBefore));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clearing the optional dates sends null for them", async () => {
    timelineResponse = { employees: [emp({ workPermitExpiryDate: "2027-02-04", endDifferentDate: "2026-12-15" })] };
    const user = userEvent.setup();
    renderTab();
    const dialog = await openEditor(user);
    fireEvent.change(within(dialog).getByLabelText(/^Work Permit Expiry Date/), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText(/^End Different Date/), { target: { value: "" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body).toEqual({ startDate: "2024-08-01", workPermitExpiryDate: null, employmentEndDate: null, vacationStartDate: null, vacationEndDate: null });
  });

  it("Clear vacation empties both vacation dates, and saving removes the vacation", async () => {
    timelineResponse = { employees: [emp({ workPermitExpiryDate: "2027-02-04", vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-14" })] };
    const user = userEvent.setup();
    renderTab();
    const dialog = await openEditor(user);
    expect(within(dialog).getByLabelText(/^Start Vacation/)).toHaveValue("2026-07-01");
    await user.click(within(dialog).getByRole("button", { name: "Clear vacation" }));
    expect(within(dialog).getByLabelText(/^Start Vacation/)).toHaveValue("");
    expect(within(dialog).getByLabelText(/^End Vacation/)).toHaveValue("");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body).toMatchObject({ vacationStartDate: null, vacationEndDate: null, workPermitExpiryDate: "2027-02-04" });
  });

  it.each([
    ["only Start Vacation", { start: "2026-07-01", end: "" }, "Enter both Start Vacation and End Vacation, or leave both empty"],
    ["End before Start", { start: "2026-07-10", end: "2026-07-01" }, "End Vacation can't be before Start Vacation"],
    ["before the Employment Start Date", { start: "2024-07-20", end: "2024-08-10" }, "Start Vacation can't be before the Employment Start Date"],
    ["past the Work Permit Expiry Date", { start: "2027-01-20", end: "2027-02-10" }, "End Vacation can't be after the Work Permit Expiry Date (2027-02-04)"],
  ])("rejects a vacation %s, saving nothing", async (_label, v, message) => {
    timelineResponse = { employees: [emp({ workPermitExpiryDate: "2027-02-04" })] };
    const user = userEvent.setup();
    renderTab();
    const dialog = await openEditor(user);
    fireEvent.change(within(dialog).getByLabelText(/^Start Vacation/), { target: { value: v.start } });
    fireEvent.change(within(dialog).getByLabelText(/^End Vacation/), { target: { value: v.end } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText(message)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  it("an End Different Date limits the vacation instead of the later permit; an ongoing employee may plan any future vacation", async () => {
    timelineResponse = { employees: [emp({ workPermitExpiryDate: "2027-02-04", endDifferentDate: "2026-10-31" })] };
    const user = userEvent.setup();
    renderTab();
    let dialog = await openEditor(user);
    fireEvent.change(within(dialog).getByLabelText(/^Start Vacation/), { target: { value: "2026-10-25" } });
    fireEvent.change(within(dialog).getByLabelText(/^End Vacation/), { target: { value: "2026-11-05" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("End Vacation can't be after the End Different Date (2026-10-31)")).toBeInTheDocument();
    cleanup();

    timelineResponse = { employees: [emp()] }; // ongoing: no permit, no End Different Date
    renderTab();
    dialog = await openEditor(user);
    fireEvent.change(within(dialog).getByLabelText(/^Start Vacation/), { target: { value: "2031-07-01" } });
    fireEvent.change(within(dialog).getByLabelText(/^End Vacation/), { target: { value: "2031-07-21" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body).toMatchObject({ vacationStartDate: "2031-07-01", vacationEndDate: "2031-07-21" });
  });

  it("rejects an ending date earlier than the Employment Start Date with a clear message, saving nothing", async () => {
    const user = userEvent.setup();
    renderTab();
    const dialog = await openEditor(user);
    fireEvent.change(within(dialog).getByLabelText(/^End Different Date/), { target: { value: "2024-01-01" } });
    fireEvent.change(within(dialog).getByLabelText(/^Work Permit Expiry Date/), { target: { value: "2024-07-31" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("End Different Date can't be earlier than the Employment Start Date")).toBeInTheDocument();
    expect(within(dialog).getByText("Work Permit Expiry Date can't be earlier than the Employment Start Date")).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  it("a Manager can open a bar read-only (no Save) and can't open the missing-dates row", async () => {
    meResponse = { employee: { id: "mgr-1", firstName: "Mo", lastName: "Manager", securityRole: "Manager", teamRole: "Team Member" } };
    timelineResponse = { employees: [emp(), emp({ id: "nd", firstName: "No", lastName: "Dates", hasUsableDates: false, employmentStartDate: null, timelineLabel: null })] };
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "1. Eve Employee: view employment dates" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(/^Employment Start Date/)).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2. No Dates: add an Employment Start Date" })).toBeDisabled();
  });
});

describe("EmploymentTimelineTab — 'Timeline starts' saved display-cutoff setting", () => {
  it("loads and shows the saved cutoff; an Administrator can edit and Save it", async () => {
    displayStartResponse = { displayStart: "2024-03-01" };
    const user = userEvent.setup();
    renderTab();
    const input = (await screen.findByLabelText("Timeline starts")) as HTMLInputElement;
    expect(input.value).toBe("2024-03-01");
    fireEvent.change(input, { target: { value: "2025-01-01" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(displayStartResponse.displayStart).toBe("2025-01-01");
  });

  it("Reset to earliest employee start clears the saved cutoff (PATCHes null)", async () => {
    displayStartResponse = { displayStart: "2024-03-01" };
    const user = userEvent.setup();
    renderTab();
    await screen.findByDisplayValue("2024-03-01");
    await user.click(screen.getByRole("button", { name: "Reset to earliest employee start" }));
    expect(displayStartResponse.displayStart).toBeNull();
  });

  it("a Manager sees the saved cutoff read-only", async () => {
    meResponse = { employee: { id: "mgr-1", firstName: "Mo", lastName: "Manager", securityRole: "Manager", teamRole: "Team Member" } };
    displayStartResponse = { displayStart: "2024-03-01" };
    renderTab();
    const input = (await screen.findByLabelText("Timeline starts")) as HTMLInputElement;
    expect(input).toBeDisabled();
    expect(screen.getByText("Only an Administrator can change this.")).toBeInTheDocument();
  });

  it("a start before the saved cutoff is clipped with a continuation indicator, not hidden or moved", async () => {
    displayStartResponse = { displayStart: "2025-01-01" };
    timelineResponse = { employees: [emp({ employmentStartDate: "2020-06-01" })] };
    renderTab();
    const bar = await screen.findByRole("button", { name: "1. Eve Employee: edit employment dates" });
    await waitFor(() => expect(bar.style.left).toBe("0%"));
    expect(bar.querySelector(".employment-timeline-bar-clip-notch")).toBeInTheDocument();
    expect(bar.getAttribute("title")).toContain("2020-06-01");
  });

  it("clearing a custom From/To override returns to the saved cutoff, not the raw earliest start", async () => {
    displayStartResponse = { displayStart: "2025-06-01" };
    timelineResponse = { employees: [emp({ employmentStartDate: "2018-01-01" })] };
    const user = userEvent.setup();
    renderTab();
    await screen.findByDisplayValue("2025-06-01");
    const [fromInput, toInput] = [...document.querySelectorAll(".employment-timeline-range-picker input")] as HTMLInputElement[];
    fireEvent.change(fromInput, { target: { value: "2026-01-01" } });
    fireEvent.change(toInput, { target: { value: "2026-03-31" } });
    expect(monthCells()[0]).toBe("2026-01-01");
    await user.click(screen.getByRole("button", { name: "Full timeline" }));
    expect(monthCells()[0]).toBe("2025-06-01");
    expect(monthCells().some((d) => d!.startsWith("2018"))).toBe(false);
  });
});
