// @vitest-environment jsdom
//
// Inputs header "Employees working" totals (InputsDayTotals, fed by GET
// /api/inputs/employees' workingTotals): shown beside the heading with a
// per-group breakdown, unchanged by the sidebar search, never showing the
// previous date's numbers after a date switch, and refreshed after work is
// added. Counting rules themselves are covered server-side by
// server/src/routes/inputs.workingTotals.test.ts.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { api } from "../../lib/api";
import { DailyInputsResponse, InputsWorkingTotals } from "../../lib/inputsTypes";

const DATE = "2026-10-05";
const NEXT_DATE = "2026-10-06";

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-admin", firstName: "Ada", lastName: "Admin", securityRole: "Administrator" } }),
}));

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status = 500;
  }
  return { ApiError, api: vi.fn() };
});

const EMPLOYEES = [
  { id: "emp-khen", firstName: "Khen", lastName: "Lagto", employeeGroup: { id: "g-loc", name: "Locals" } },
  { id: "emp-larry", firstName: "Larry", lastName: "Banguigui", employeeGroup: { id: "g-gh", name: "Greenhouse Guys" } },
];

let totalsByDate: Record<string, InputsWorkingTotals> = {};
// When set, the employees request for this date stays pending until released.
let holdDate: string | null = null;
let release: (() => void) | null = null;

function totals(total: number, groups: [string | null, string, number][]): InputsWorkingTotals {
  return { total, groups: groups.map(([id, name, count]) => ({ id, name, count })) };
}

function mockApi(path: string, options?: RequestInit): Promise<unknown> {
  const url = new URL(path, "http://t");
  if (url.pathname === "/api/inputs/employees") {
    const date = url.searchParams.get("date")!;
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const body = () => ({
      workingTotals: totalsByDate[date],
      employees: EMPLOYEES.filter((e) => `${e.firstName} ${e.lastName}`.toLowerCase().includes(search)).map((e) => ({
        ...e,
        photoUrl: null,
        paidSeconds: 3600,
      })),
    });
    if (date === holdDate) return new Promise((resolve) => (release = () => resolve(body())));
    return Promise.resolve(body());
  }
  if (url.pathname === "/api/inputs/daily") return Promise.resolve(daily(url.searchParams.get("employeeId")!, url.searchParams.get("date")!));
  if (url.pathname === "/api/row-completions/review-groups") return Promise.resolve({ date: DATE, groups: [] });
  if (url.pathname === "/api/inputs/employee-options") {
    return Promise.resolve({ employees: [{ id: "emp-mia", firstName: "Mia", lastName: "Reyes", employeeGroup: null }] });
  }
  if (url.pathname === "/api/inputs/employee-activities") {
    return Promise.resolve({ activities: [{ id: "act-plain", name: "Cleaning", normalSpeed: null, speedUnit: null, questions: [] }] });
  }
  if (url.pathname === "/api/inputs/greenhouse-rows") return Promise.resolve({ lands: [] });
  if (url.pathname === "/api/inputs/carriers") return Promise.resolve({ carriers: [] });
  if (url.pathname === "/api/inputs/activities" && options?.method === "POST") {
    totalsByDate[DATE] = totals(23, [["g-anna", "Anna's Contractors", 4], ["g-gh", "Greenhouse Guys", 8], ["g-loc", "Locals", 6], ["g-reg", "Reginos Contractors", 4], [null, "Ungrouped", 1]]);
    return Promise.resolve({ ok: true });
  }
  return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
}

function daily(employeeId: string, date: string): DailyInputsResponse {
  const e = EMPLOYEES.find((x) => x.id === employeeId) ?? { firstName: "Mia", lastName: "Reyes" };
  return {
    employee: { id: employeeId, firstName: e.firstName, lastName: e.lastName, photoUrl: null },
    date,
    workStartTime: null,
    workEndTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: [],
    breaks: [],
    totals: { workedSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 },
    canEdit: true,
  } as unknown as DailyInputsResponse;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/inputs?date=${DATE}&employee=emp-khen`]}>
      <InputsPage />
    </MemoryRouter>
  );
}

const header = () => screen.getByRole("heading", { name: "Inputs" }).parentElement as HTMLElement;
const breakdown = () =>
  within(header())
    .queryAllByRole("listitem")
    .map((li) => li.textContent);

beforeEach(() => {
  holdDate = null;
  release = null;
  totalsByDate = {
    [DATE]: totals(22, [["g-anna", "Anna's Contractors", 4], ["g-gh", "Greenhouse Guys", 8], ["g-loc", "Locals", 6], ["g-reg", "Reginos Contractors", 4]]),
    [NEXT_DATE]: totals(3, [["g-anna", "Anna's Contractors", 0], ["g-gh", "Greenhouse Guys", 2], ["g-loc", "Locals", 0], ["g-reg", "Reginos Contractors", 0], [null, "Ungrouped", 1]]),
  };
  vi.mocked(api).mockImplementation(mockApi as typeof api);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Inputs header: employees working totals", () => {
  it("shows the day's total and every group's count beside the Inputs heading", async () => {
    renderPage();
    await waitFor(() => expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("Employees working: 22"));
    expect(breakdown()).toEqual(["Anna's Contractors: 4", "Greenhouse Guys: 8", "Locals: 6", "Reginos Contractors: 4"]);
    expect(within(header()).getByRole("list", { name: "Employees working by group" })).toBeInTheDocument();
  });

  it("search filters the sidebar but leaves the header totals unchanged", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("22"));
    expect(screen.getByRole("button", { name: /Larry Banguigui/ })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search employees"), "khen");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Larry Banguigui/ })).not.toBeInTheDocument());
    expect(vi.mocked(api).mock.calls.some(([p]) => (p as string).includes("search=khen"))).toBe(true);
    expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("Employees working: 22");
    expect(breakdown()).toEqual(["Anna's Contractors: 4", "Greenhouse Guys: 8", "Locals: 6", "Reginos Contractors: 4"]);
  });

  it("switching dates never shows the previous date's totals, then shows the new date's (with Ungrouped)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("22"));

    holdDate = NEXT_DATE;
    await user.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("Employees working: —"));
    expect(breakdown()).toEqual([]);

    release!();
    await waitFor(() => expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("Employees working: 3"));
    expect(breakdown()).toEqual(["Anna's Contractors: 0", "Greenhouse Guys: 2", "Locals: 0", "Reginos Contractors: 0", "Ungrouped: 1"]);
  });

  it("refreshes after work is added", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("22"));

    await user.click(screen.getByRole("button", { name: "Add employee to this day" }));
    const dialog = await screen.findByRole("dialog");
    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect).getByRole("option", { name: "Mia Reyes" })).toBeInTheDocument());
    await user.selectOptions(employeeSelect, "emp-mia");
    const activitySelect = within(dialog).getByRole("combobox", { name: /Activity/ });
    await waitFor(() => expect(within(activitySelect).getByRole("option", { name: "Cleaning" })).toBeInTheDocument());
    await user.selectOptions(activitySelect, "act-plain");
    await user.type(within(dialog).getByLabelText(/Work start time/), "07:00:00");
    await user.type(within(dialog).getByLabelText(/End time/), "09:00:00");
    await user.click(within(dialog).getByRole("button", { name: "Add to day" }));

    await waitFor(() => expect(within(header()).getByText(/Employees working:/)).toHaveTextContent("Employees working: 23"));
    expect(breakdown()).toContain("Ungrouped: 1");
  });
});
