// @vitest-environment jsdom
//
// Inputs page: the employee sidebar under Employee Group headings, search
// across every group (headings and counts follow the matches), the selected
// employee kept, and the bulk speed-review controls still in place.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { DailyInputsResponse, InputsEmployee } from "../../lib/inputsTypes";

const DATE = "2026-10-05";
const pickers = { id: "g-pick", name: "Pickers" };
const crew = { id: "g-crew", name: "Bean Crew" };
const ALL: InputsEmployee[] = [
  { id: "e-larry", firstName: "Larry", lastName: "Banguigui", photoUrl: null, paidSeconds: 26760, employeeGroup: pickers },
  { id: "e-khen", firstName: "Khen", lastName: "Lagto", photoUrl: null, paidSeconds: 27900, employeeGroup: pickers },
  { id: "e-feli", firstName: "Felimar", lastName: "Realin", photoUrl: null, paidSeconds: 27000, employeeGroup: crew },
  { id: "e-anto", firstName: "Antonio", lastName: "Miss", photoUrl: null, paidSeconds: 27000, employeeGroup: null },
];

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "me", firstName: "Isaak", lastName: "Harder", securityRole: "Administrator" } }),
}));

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
      const url = new URL(path, "http://t");
      if (url.pathname === "/api/inputs/employees") {
        // Server-side search, same matching as GET /api/inputs/employees.
        const q = (url.searchParams.get("search") ?? "").toLowerCase();
        return Promise.resolve({ employees: ALL.filter((e) => `${e.firstName} ${e.lastName}`.toLowerCase().includes(q)) });
      }
      if (url.pathname === "/api/inputs/daily") return Promise.resolve(daily(url.searchParams.get("employeeId")!));
      if (url.pathname === "/api/row-completions/review-groups") return Promise.resolve({ date: DATE, groups: [] });
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function daily(employeeId: string): DailyInputsResponse {
  const e = ALL.find((x) => x.id === employeeId)!;
  return {
    employee: { id: e.id, firstName: e.firstName, lastName: e.lastName, photoUrl: null },
    date: DATE,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const headings = () => screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);

describe("Inputs sidebar grouped by Employee Group", () => {
  it("shows employees under their group headings, Ungrouped last, with hours and the review controls", async () => {
    render(
      <MemoryRouter initialEntries={[`/inputs?date=${DATE}&employee=e-khen`]}>
        <InputsPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(headings()).toEqual(["Bean Crew1", "Pickers2", "Ungrouped1"]));
    const khen = within(screen.getByRole("region", { name: "Pickers (2)" })).getByRole("button", { name: /Khen Lagto/ });
    expect(khen).toHaveClass("inputs-employee-item-selected");
    expect(khen).toHaveTextContent("7:45");
    expect(screen.getByRole("button", { name: /Review all employees/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review speeds/ })).toBeInTheDocument();
  });

  it("search works across every group; headings and counts follow the matches; selection is kept", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/inputs?date=${DATE}&employee=e-khen`]}>
        <InputsPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(headings()).toHaveLength(3));
    // "la" matches Larry, Khen Lagto (Pickers) — and nobody in the other groups.
    await user.type(screen.getByPlaceholderText("Search employees"), "la");
    await waitFor(() => expect(headings()).toEqual(["Pickers2"]));
    await user.clear(screen.getByPlaceholderText("Search employees"));
    await user.type(screen.getByPlaceholderText("Search employees"), "i");
    // Larry? no "i"… Khen? no. Felimar Realin, Antonio Miss, Larry Banguigui: yes.
    await waitFor(() => expect(headings()).toEqual(["Bean Crew1", "Pickers1", "Ungrouped1"]));
    await user.clear(screen.getByPlaceholderText("Search employees"));
    await waitFor(() => expect(headings()).toHaveLength(3));
    expect(within(screen.getByRole("region", { name: "Pickers (2)" })).getByRole("button", { name: /Khen Lagto/ })).toHaveClass(
      "inputs-employee-item-selected"
    );
  });
});
