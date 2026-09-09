// @vitest-environment jsdom
//
// Tests the Inputs employee-list panel's per-employee paid-hours total,
// sourced from GET /api/inputs/employees' new paidSeconds field (see
// server/src/routes/inputs.ts's loadPaidSecondsByEmployee, which reuses the
// same authoritative computeWorkdayTotals formula GET /daily and Payroll
// already use). Covers what EmployeeListPanel.test.tsx can't on its own,
// since it only renders that component directly: a selected-date change
// requesting a fresh total (and not showing the previous date's now-stale
// number while that request is in flight, and the superseded request
// actually being aborted, not just ignored), the sidebar refreshing after
// an edit succeeds, staying current through the existing background poll/
// visibility/focus/online refresh lifecycle (no separate timer, no
// duplicate concurrent request), a server-signaled "unavailable" total
// rendering distinctly from a genuine zero, and — the N+1 requirement —
// that switching employees or loading a roster of several employees only
// ever issues ONE /api/inputs/employees request per load, never one per
// employee. Same deferred-promise lib/api.ts mocking convention as
// InputsPage.switching.test.tsx / InputsPage.deletePerformance.test.tsx,
// including that file's own abort-tracking convention for GET /daily,
// mirrored here for GET /employees.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../lib/api";
import { DailyInputsResponse, InputsEmployee } from "../../lib/inputsTypes";
import { formatDateLong, todayInAppTimezone } from "../../lib/timezone";

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

interface EmployeesCall {
  date: string;
  deferred: Deferred<{ employees: InputsEmployee[] }>;
  aborted: boolean;
}

let employeesCalls: EmployeesCall[] = [];
let dailyCalls: { date: string; deferred: Deferred<DailyInputsResponse> }[] = [];
let deleteCalls: { deferred: Deferred<{ ok: true }> }[] = [];

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
        const url = new URL(path, "http://test.local");
        const date = url.searchParams.get("date")!;
        const deferred = createDeferred<{ employees: InputsEmployee[] }>();
        const call: EmployeesCall = { date, deferred, aborted: false };
        employeesCalls.push(call);
        // Mirrors the /api/inputs/daily branch below (and
        // InputsPage.switching.test.tsx's own convention) — loadEmployees
        // now aborts whatever employees request was still in flight before
        // starting a new one (see InputsPage.tsx's employeesAbortControllerRef),
        // so a superseded request's own signal actually fires.
        const signal = options?.signal as AbortSignal | undefined;
        if (signal) {
          if (signal.aborted) {
            call.aborted = true;
            return Promise.reject(new DOMException("Aborted", "AbortError"));
          }
          signal.addEventListener("abort", () => {
            call.aborted = true;
            deferred.reject(new DOMException("Aborted", "AbortError"));
          });
        }
        return deferred.promise;
      }
      if (path.startsWith("/api/inputs/daily")) {
        const url = new URL(path, "http://test.local");
        const date = url.searchParams.get("date")!;
        const deferred = createDeferred<DailyInputsResponse>();
        dailyCalls.push({ date, deferred });
        return deferred.promise;
      }
      if (path.startsWith("/api/inputs/activity-runs/") && path.endsWith("/delete") && options?.method === "POST") {
        const deferred = createDeferred<{ ok: true }>();
        deleteCalls.push({ deferred });
        return deferred.promise;
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function employee(id: string, firstName: string, lastName: string, paidSeconds: number | null): InputsEmployee {
  return { id, firstName, lastName, photoUrl: null, paidSeconds };
}

function buildDaily(employeeId: string, firstName: string, lastName: string, date: string): DailyInputsResponse {
  return {
    employee: { id: employeeId, firstName, lastName, photoUrl: null },
    date,
    workStartTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: [
      {
        id: "run-1",
        activityId: "activity-1",
        activityName: "Picking Peppers",
        normalSpeedPerHour: null,
        activityDensitySource: null,
        densityType: null,
        calculatedSpeedPerHour: null,
        isUnresolvedRowCompletion: false,
        rowCompletion: null,
        segmentIds: ["run-1"],
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

function renderInputsPage() {
  return render(
    <MemoryRouter initialEntries={["/inputs"]}>
      <AuthProvider>
        <InputsPage />
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  employeesCalls = [];
  dailyCalls = [];
  deleteCalls = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("InputsPage — employee sidebar paid-hours totals", () => {
  it("renders each employee's own paidSeconds from the single employees response, including a zero total", async () => {
    renderInputsPage();
    await waitFor(() => expect(employeesCalls.length).toBe(1));
    await act(async () => {
      employeesCalls[0].deferred.resolve({
        employees: [
          employee("emp-a", "Alice", "Anderson", 8 * 3600),
          employee("emp-b", "Beatriz", "Barrios", 0),
        ],
      });
    });

    expect(await screen.findByText("8:00")).toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("issues exactly ONE /api/inputs/employees request for the initial load, regardless of employee count — never one per employee", async () => {
    renderInputsPage();
    await waitFor(() => expect(employeesCalls.length).toBe(1));
    await act(async () => {
      employeesCalls[0].deferred.resolve({
        employees: [
          employee("emp-a", "Alice", "Anderson", 3600),
          employee("emp-b", "Beatriz", "Barrios", 7200),
          employee("emp-c", "Charlie", "Chen", 0),
          employee("emp-d", "Dave", "Quiring", 5400),
          employee("emp-e", "Eva", "Schmitt", 1800),
        ],
      });
    });
    // "Alice Anderson" itself is ambiguous here (it also appears in the
    // auto-selected employee's skeleton/detail heading) — the row's own
    // paid-hours text is unique and proves the roster actually rendered.
    await screen.findByText("2:00");

    // Give any stray per-row effect a chance to fire before asserting the
    // count is still exactly one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(employeesCalls.length).toBe(1);
  });

  it("sends the exact date DateNav shows as selected, and requests a fresh total when it changes, hiding the previous date's now-stale number while the new one is in flight", async () => {
    renderInputsPage();
    await waitFor(() => expect(employeesCalls.length).toBe(1));
    const firstDate = employeesCalls[0].date;
    // No ?date= in the URL, so InputsPage defaults to today's own local
    // (APP_TIMEZONE) calendar date — the employees request must carry that
    // exact value, not some other derived/reformatted copy of it.
    expect(firstDate).toBe(todayInAppTimezone());
    // The date-nav control's own displayed date is built from the same
    // `date` value the employees request was sent with — proves the two
    // can never silently disagree.
    expect(screen.getByLabelText("Choose Inputs date")).toHaveTextContent(formatDateLong(firstDate));
    await act(async () => {
      employeesCalls[0].deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 8 * 3600)] });
    });
    await screen.findByText("8:00");
    // Resolve the auto-selected daily fetch too, so nothing is left hanging.
    await act(async () => {
      dailyCalls[0].deferred.resolve(buildDaily("emp-a", "Alice", "Anderson", firstDate));
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Next day"));

    await waitFor(() => expect(employeesCalls.length).toBe(2));
    expect(employeesCalls[1].date).not.toBe(firstDate);
    // The superseded request for the old date is actually cancelled, not
    // just ignored — the "no duplicate simultaneous requests" requirement.
    expect(employeesCalls[0].aborted).toBe(true);

    // Alice's OLD total must not still be shown while the NEW date's
    // employees request is still unresolved — showing "8:00" here would be
    // exactly the stale-total bug this guards against.
    expect(screen.queryByText("8:00")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Paid hours loading")).toBeInTheDocument();

    await act(async () => {
      employeesCalls[1].deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 5 * 3600 + 30 * 60)] });
    });
    expect(await screen.findByText("5:30")).toBeInTheDocument();
    expect(screen.queryByText("8:00")).not.toBeInTheDocument();
  });

  it("never displays a previous date's total even if that request resolves LATE, after a second rapid date switch already superseded it", async () => {
    renderInputsPage();
    await waitFor(() => expect(employeesCalls.length).toBe(1));
    await act(async () => {
      employeesCalls[0].deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 1 * 3600)] });
    });
    await screen.findByText("1:00");
    await act(async () => {
      dailyCalls[0].deferred.resolve(buildDaily("emp-a", "Alice", "Anderson", employeesCalls[0].date));
    });

    const user = userEvent.setup();
    // Two rapid clicks, before either resulting employees request resolves.
    await user.click(screen.getByLabelText("Next day"));
    await user.click(screen.getByLabelText("Next day"));

    await waitFor(() => expect(employeesCalls.length).toBe(3));
    const [firstCall, secondCall, thirdCall] = employeesCalls;
    expect(firstCall.aborted).toBe(true);
    expect(secondCall.aborted).toBe(true);

    // The middle (also-superseded) request resolving after the latest one
    // was already fired must never be applied.
    await act(async () => {
      secondCall.deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 2 * 3600)] });
    });
    expect(screen.queryByText("2:00")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Paid hours loading")).toBeInTheDocument();

    // Only the third (current) request's own response is ever shown.
    await act(async () => {
      thirdCall.deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 3 * 3600)] });
    });
    expect(await screen.findByText("3:00")).toBeInTheDocument();
    expect(screen.queryByText("1:00")).not.toBeInTheDocument();
    expect(screen.queryByText("2:00")).not.toBeInTheDocument();
  });

  it("refreshes the sidebar total after a successful edit (activity-log deletion)", async () => {
    renderInputsPage();
    await waitFor(() => expect(employeesCalls.length).toBe(1));
    const date = employeesCalls[0].date;
    await act(async () => {
      employeesCalls[0].deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 3600)] });
    });
    await screen.findByText("1:00");

    await waitFor(() => expect(dailyCalls.length).toBe(1));
    await act(async () => {
      dailyCalls[0].deferred.resolve(buildDaily("emp-a", "Alice", "Anderson", date));
    });
    await screen.findByText("Picking Peppers");

    const user = userEvent.setup();
    await user.click(screen.getByText("Picking Peppers"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("Delete activity log?");
    await user.click(screen.getByRole("button", { name: "Delete Log" }));

    await act(async () => {
      deleteCalls[0].deferred.resolve({ ok: true });
    });
    // The deletion handler's own post-delete GET /daily reload — its
    // "await loadDaily()" must resolve before the handler's own next line
    // (loadEmployees()) ever runs, so this has to be resolved first.
    await waitFor(() => expect(dailyCalls.length).toBe(2));
    await act(async () => {
      dailyCalls[1].deferred.resolve({ ...buildDaily("emp-a", "Alice", "Anderson", date), runs: [] });
    });

    // The sidebar total refresh this change adds — a second
    // /api/inputs/employees request, triggered by the same deletion
    // success, not just the one from initial page load.
    await waitFor(() => expect(employeesCalls.length).toBe(2));
    await act(async () => {
      employeesCalls[1].deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 0)] });
    });

    expect(await screen.findByText("0:00")).toBeInTheDocument();
  });

  it("keeps an open workday's paid-hours total climbing through the existing 10-second background poll — no separate timer, no placeholder flash, no duplicate concurrent request", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"] });
    renderInputsPage();

    // loadEmployees' own initial call is itself scheduled via a debounce
    // setTimeout (0ms with no search text) — faked setTimeout means it
    // never fires until timers are advanced. Every step below asserts
    // synchronously right after the `act` that should have produced it,
    // rather than polling with (testing-library's real-timer-based)
    // waitFor/findByText, which would stall forever under fake timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(employeesCalls.length).toBe(1);
    const date = employeesCalls[0].date;
    await act(async () => {
      employeesCalls[0].deferred.resolve({ employees: [employee("emp-a", "Alice", "Anderson", 3 * 3600)] });
    });
    expect(screen.getByText("3:00")).toBeInTheDocument();

    // The auto-select effect's own GET /daily for Alice — also scheduled
    // behind a tick, resolved here just to leave nothing hanging.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(dailyCalls.length).toBe(1);
    await act(async () => {
      dailyCalls[0].deferred.resolve(buildDaily("emp-a", "Alice", "Anderson", date));
    });

    const callsBeforePoll = employeesCalls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    // The same 10-second interval that already drives loadDaily's own
    // background refresh (POLL_INTERVAL_MS) — no second, independently-
    // scheduled timer of its own.
    expect(employeesCalls.length).toBe(callsBeforePoll + 1);

    // A background refresh must be silent — the still-accurate "3:00"
    // stays on screen the whole time, never replaced by a loading
    // placeholder while the new total is in flight.
    expect(screen.getByText("3:00")).toBeInTheDocument();
    expect(screen.queryByLabelText("Paid hours loading")).not.toBeInTheDocument();

    await act(async () => {
      employeesCalls[employeesCalls.length - 1].deferred.resolve({
        employees: [employee("emp-a", "Alice", "Anderson", 3 * 3600 + 60)],
      });
    });
    // Alice's open workday (no ended_at) keeps accruing paid time each poll
    // — the total actually moved, proving this refresh path (not just the
    // detail view's own poll) is what's keeping it current.
    expect(screen.getByText("3:01")).toBeInTheDocument();
    expect(screen.queryByText("3:00")).not.toBeInTheDocument();

    // A second poll tick shortly after must not stack a duplicate request
    // on top of one that might still be settling.
    const callsAfterFirstPoll = employeesCalls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(employeesCalls.length).toBe(callsAfterFirstPoll + 1);
  });

  it("shows — with an accessible 'Paid hours unavailable' label when the server couldn't compute a total, distinct from a genuine 0:00", async () => {
    renderInputsPage();
    await waitFor(() => expect(employeesCalls.length).toBe(1));
    await act(async () => {
      employeesCalls[0].deferred.resolve({
        employees: [
          employee("emp-a", "Alice", "Anderson", null),
          employee("emp-b", "Beatriz", "Barrios", 0),
        ],
      });
    });

    const unavailableRow = await screen.findByRole("button", { name: /Alice Anderson/ });
    expect(within(unavailableRow).getByText("—")).toBeInTheDocument();
    expect(within(unavailableRow).getByLabelText("Paid hours unavailable")).toBeInTheDocument();
    expect(within(unavailableRow).queryByText("0:00")).not.toBeInTheDocument();

    // A real, successfully-computed zero on a different row still renders
    // as "0:00" with its own normal accessible label, not "—" — the two
    // must never be conflated.
    const zeroRow = screen.getByRole("button", { name: /Beatriz Barrios/ });
    expect(within(zeroRow).getByText("0:00")).toBeInTheDocument();
    expect(within(zeroRow).getByLabelText("0 hours paid")).toBeInTheDocument();
    expect(within(zeroRow).queryByLabelText("Paid hours unavailable")).not.toBeInTheDocument();
  });
});
