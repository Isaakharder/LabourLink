// @vitest-environment jsdom
//
// Focused coverage for the Inputs date calendar popover added to DateNav:
// opening/closing (including Escape and outside-click), month/year
// navigation to a distant date, that selecting a day goes through the same
// date-loading path as the arrow buttons (URL update + GET /daily reload),
// that it preserves other URL params (the selected employee), and that the
// arrow buttons keep working normally afterward. lib/api.ts is mocked the
// same way as InputsPage.switching.test.tsx so every network call is fully
// controlled by the test.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../lib/api";
import { DailyInputsResponse, InputsEmployee } from "../../lib/inputsTypes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface DailyCall {
  employeeId: string;
  date: string;
  deferred: Deferred<DailyInputsResponse>;
}

let employeesResponse: { employees: InputsEmployee[] } = { employees: [] };
let dailyCalls: DailyCall[] = [];

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
      if (path.startsWith("/api/auth/me")) {
        return Promise.reject(new ApiError(401, "not authed"));
      }
      if (path.startsWith("/api/inputs/employees")) {
        return Promise.resolve(employeesResponse);
      }
      if (path.startsWith("/api/inputs/daily")) {
        const url = new URL(path, "http://test.local");
        const employeeId = url.searchParams.get("employeeId")!;
        const date = url.searchParams.get("date")!;
        const deferred = createDeferred<DailyInputsResponse>();
        const call: DailyCall = { employeeId, date, deferred };
        dailyCalls.push(call);
        const signal = options?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => deferred.reject(new DOMException("Aborted", "AbortError")));
        }
        return deferred.promise;
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function employee(id: string, firstName: string, lastName: string): InputsEmployee {
  return { id, firstName, lastName, photoUrl: null };
}

function buildDaily(emp: InputsEmployee, date: string, activityName: string): DailyInputsResponse {
  return {
    employee: { id: emp.id, firstName: emp.firstName, lastName: emp.lastName, photoUrl: null },
    date,
    workStartTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: [
      {
        id: `run-${emp.id}-${date}`,
        activityId: `activity-${emp.id}`,
        activityName,
        normalSpeedPerHour: null,
        activityDensitySource: null,
        densityType: null,
        calculatedSpeedPerHour: null,
        isUnresolvedRowCompletion: false,
        rowCompletion: null,
        segmentIds: [`run-${emp.id}-${date}`],
        durationSeconds: 3600,
        startedAtOriginalTime: null,
        startedAtCorrectedFrom: null,
        endedAtOriginalTime: null,
        endedAtCorrectedFrom: null,
        startedAt: `${date}T13:00:00.000Z`,
        currentSegmentStartedAt: `${date}T13:00:00.000Z`,
        endedAt: `${date}T14:00:00.000Z`,
        isOpen: false,
        canEdit: true,
        row: null,
        carrier: null,
        autoClosed: false,
        manualEntry: null,
      },
    ],
    breaks: [],
    totals: { workedSeconds: 3600, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 },
    canEdit: true,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

function renderInputsPage(initialPath = "/inputs?date=2026-08-11&employee=emp-a") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <InputsPage />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>
  );
}

function findDailyCall(employeeId: string, date: string): DailyCall {
  const call = [...dailyCalls].reverse().find((c) => c.employeeId === employeeId && c.date === date);
  if (!call) throw new Error(`No GET /daily call recorded for employeeId=${employeeId} date=${date}`);
  return call;
}

const empA = employee("emp-a", "Alice", "Anderson");
const empB = employee("emp-b", "Beatriz", "Barrios");

beforeEach(() => {
  dailyCalls = [];
  employeesResponse = { employees: [empA, empB] };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function resolveInitialLoad() {
  await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
  await act(async () => {
    findDailyCall(empA.id, "2026-08-11").deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Activity"));
  });
  await screen.findByText("Alice's Activity");
}

describe("InputsPage date calendar popover", () => {
  it("opens on click, shows the selected/today state, and closes on Escape", async () => {
    renderInputsPage();
    await resolveInitialLoad();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose Inputs date" }));

    const popover = screen.getByRole("dialog", { name: "Choose Inputs date" });
    expect(popover).toBeInTheDocument();
    // The 11th is selected in the initially-visible month (August 2026).
    expect(within(popover).getByRole("button", { name: "11", pressed: true })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Choose Inputs date" })).not.toBeInTheDocument();
  });

  it("closes when clicking outside the popover", async () => {
    renderInputsPage();
    await resolveInitialLoad();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose Inputs date" }));
    expect(screen.getByRole("dialog", { name: "Choose Inputs date" })).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole("dialog", { name: "Choose Inputs date" })).not.toBeInTheDocument();
  });

  it("navigates far away via the year/month selects and selects a distant date", async () => {
    renderInputsPage();
    await resolveInitialLoad();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose Inputs date" }));
    const popover = screen.getByRole("dialog", { name: "Choose Inputs date" });

    await user.selectOptions(within(popover).getByRole("combobox", { name: "Year" }), "2030");
    await user.selectOptions(within(popover).getByRole("combobox", { name: "Month" }), "December");

    await user.click(within(popover).getByRole("button", { name: "15" }));

    // Same date-loading path as the arrows: URL updates, a new GET /daily
    // fires for the new date (same employee), and the popover closes.
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("date=2030-12-15")
    );
    expect(screen.getByTestId("location-probe")).toHaveTextContent("employee=emp-a");
    expect(screen.queryByRole("dialog", { name: "Choose Inputs date" })).not.toBeInTheDocument();

    await act(async () => {
      findDailyCall(empA.id, "2030-12-15").deferred.resolve(buildDaily(empA, "2030-12-15", "Distant Activity"));
    });
    await screen.findByText("Distant Activity");
  });

  it("preserves the selected employee param when picking a date, falling back like a normal date change if unset", async () => {
    renderInputsPage("/inputs?date=2026-08-11&employee=emp-b");
    await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
    await act(async () => {
      findDailyCall(empB.id, "2026-08-11").deferred.resolve(buildDaily(empB, "2026-08-11", "Beatriz's Activity"));
    });
    await screen.findByText("Beatriz's Activity");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose Inputs date" }));
    const popover = screen.getByRole("dialog", { name: "Choose Inputs date" });
    await user.click(within(popover).getByRole("button", { name: "20" }));

    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent("date=2026-08-20")
    );
    // The employee param (Beatriz) survives the date-only change, exactly
    // as it does for the arrow buttons.
    expect(screen.getByTestId("location-probe")).toHaveTextContent("employee=emp-b");
  });

  it("keeps the arrow buttons working normally after the calendar has been used", async () => {
    renderInputsPage();
    await resolveInitialLoad();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose Inputs date" }));
    const popover = screen.getByRole("dialog", { name: "Choose Inputs date" });
    await user.click(within(popover).getByRole("button", { name: "12" }));
    await waitFor(() => expect(screen.getByTestId("location-probe")).toHaveTextContent("date=2026-08-12"));
    await act(async () => {
      findDailyCall(empA.id, "2026-08-12").deferred.resolve(buildDaily(empA, "2026-08-12", "Aug 12 Activity"));
    });
    await screen.findByText("Aug 12 Activity");

    await user.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(screen.getByTestId("location-probe")).toHaveTextContent("date=2026-08-13"));
    await act(async () => {
      findDailyCall(empA.id, "2026-08-13").deferred.resolve(buildDaily(empA, "2026-08-13", "Aug 13 Activity"));
    });
    await screen.findByText("Aug 13 Activity");

    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(screen.getByTestId("location-probe")).toHaveTextContent("date=2026-08-12"));
  });
});
