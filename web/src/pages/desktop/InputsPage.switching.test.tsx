// @vitest-environment jsdom
//
// Tests InputsPage's employee-switching behavior added by the Inputs
// employee-switch performance fix: the previous employee's data must
// disappear immediately (not linger until the new response arrives),
// editing controls must be unavailable while the new employee's data is
// still loading, a slower/earlier response must never overwrite a faster/
// later selection, and the existing 10-second background refresh must
// keep working exactly as before. lib/api.ts is mocked so every network
// call is fully controlled by the test (deferred promises resolved on
// demand), rather than hitting a real server.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../lib/api";
import { BreakDto, DailyInputsResponse, InputsEmployee } from "../../lib/inputsTypes";
import { formatTimeInAppTimezone } from "../../lib/timezone";

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
  aborted: boolean;
}

let employeesResponse: { employees: InputsEmployee[] } = { employees: [] };
let dailyCalls: DailyCall[] = [];
let breakPatchFailure: { status: number; message: string } | null = null;

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
        const call: DailyCall = { employeeId, date, deferred, aborted: false };
        dailyCalls.push(call);
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
      if (path.endsWith("/correction-preview") && options?.method === "POST") {
        // Same simulated failure surfaces here now — the preview computes
        // the identical plan PATCH would apply, so an invalid correction
        // is now rejected at preview time, before any commit.
        if (breakPatchFailure) {
          return Promise.reject(new ApiError(breakPatchFailure.status, breakPatchFailure.message));
        }
        return Promise.resolve({ messages: [], workedMinutesRemoved: 0 });
      }
      if (path.startsWith("/api/inputs/breaks/") && options?.method === "PATCH") {
        if (breakPatchFailure) {
          return Promise.reject(new ApiError(breakPatchFailure.status, breakPatchFailure.message));
        }
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function employee(id: string, firstName: string, lastName: string): InputsEmployee {
  return { id, firstName, lastName, photoUrl: null };
}

// One distinguishing, easy-to-assert-on activity name per fixture employee
// — standing in for "this employee's real data," so a test can check it's
// genuinely gone from the page rather than just checking a loading flag.
function buildDaily(emp: InputsEmployee, date: string, activityName: string, breaks: BreakDto[] = []): DailyInputsResponse {
  return {
    employee: { id: emp.id, firstName: emp.firstName, lastName: emp.lastName, photoUrl: null },
    date,
    workStartTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: [
      {
        id: `run-${emp.id}`,
        activityId: `activity-${emp.id}`,
        activityName,
        normalSpeedPerHour: null,
        activityDensitySource: null,
        densityType: null,
        calculatedSpeedPerHour: null,
        isUnresolvedRowCompletion: false,
        rowCompletion: null,
        segmentIds: [`run-${emp.id}`],
        durationSeconds: 3600,
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
    breaks,
    totals: { workedSeconds: 3600, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 },
    canEdit: true,
  };
}

function buildBreak(id: string, name: string, startedAt: string, endedAt: string): BreakDto {
  return {
    id,
    startedAt,
    endedAt,
    startedAtOriginalTime: null,
    endedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtCorrectedFrom: null,
    durationSeconds: 900,
    name,
    isPaid: false,
    source: "manual",
    breakProfileItemId: null,
    canEdit: true,
    autoClosed: false,
    manualEntry: null,
  };
}

function renderInputsPage(initialPath = "/inputs") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <InputsPage />
      </AuthProvider>
    </MemoryRouter>
  );
}

function findDailyCall(employeeId: string): DailyCall {
  const call = [...dailyCalls].reverse().find((c) => c.employeeId === employeeId);
  if (!call) throw new Error(`No GET /daily call recorded for employeeId=${employeeId}`);
  return call;
}

const empA = employee("emp-a", "Alice", "Anderson");
const empB = employee("emp-b", "Beatriz", "Barrios");

beforeEach(() => {
  dailyCalls = [];
  employeesResponse = { employees: [empA, empB] };
  breakPatchFailure = null;
});

afterEach(() => {
  // Explicit rather than relying on @testing-library/react's automatic
  // afterEach registration — this project's vitest config doesn't set
  // test.globals: true, so that auto-registration never fires and each
  // render() would otherwise accumulate in the document across tests in
  // this file.
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("InputsPage employee switching", () => {
  it("clears the previous employee's data immediately on switch, before the new response arrives", async () => {
    renderInputsPage();

    // Auto-select lands on Alice (first alphabetically, no signed-in match).
    await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
    await act(async () => {
      findDailyCall(empA.id).deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Activity"));
    });
    await screen.findByText("Alice's Activity");

    // Switch to Beatriz — her GET /daily is deliberately left unresolved.
    const user = userEvent.setup();
    await user.click(screen.getByText("Beatriz Barrios"));

    // Alice's real data must already be gone, synchronously with the
    // click's own re-render — not still visible while Beatriz's request is
    // in flight.
    expect(screen.queryByText("Alice's Activity")).not.toBeInTheDocument();
    // The skeleton shows who is loading, from the already-loaded employee
    // list, without waiting on the network.
    expect(screen.getByLabelText("Loading employee data")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Beatriz Barrios" })).toBeInTheDocument();

    await act(async () => {
      findDailyCall(empB.id).deferred.resolve(buildDaily(empB, "2026-08-11", "Beatriz's Activity"));
    });
    await screen.findByText("Beatriz's Activity");
    expect(screen.queryByLabelText("Loading employee data")).not.toBeInTheDocument();
  });

  it("has no editing controls available while the newly-selected employee's data is still loading", async () => {
    renderInputsPage();
    await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
    await act(async () => {
      findDailyCall(empA.id).deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Activity"));
    });
    await screen.findByText("Alice's Activity");
    // Sanity check: an editable day does render its Add-entry controls.
    expect(screen.getByText("Add activity")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("Beatriz Barrios"));

    // No add/edit/delete affordance of any kind while `daily` is null —
    // ActivityLogsCard/WorkdayDetailsCard (the only place those controls
    // are rendered) are replaced entirely by the skeleton.
    expect(screen.queryByText("Add activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Add work start")).not.toBeInTheDocument();
    expect(screen.queryByText("Add break")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("never lets a slower, superseded response overwrite a faster, later selection (rapid switching)", async () => {
    renderInputsPage();
    await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
    await act(async () => {
      findDailyCall(empA.id).deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Activity"));
    });
    await screen.findByText("Alice's Activity");

    const user = userEvent.setup();
    // Switch A -> B -> back to A rapidly, in one go, before any of the
    // resulting requests resolve.
    await user.click(screen.getByText("Beatriz Barrios"));
    const firstBCall = findDailyCall(empB.id);
    await user.click(screen.getByText("Alice Anderson"));
    const secondACall = findDailyCall(empA.id);
    expect(secondACall).not.toBe(firstBCall);

    // The FIRST (now-superseded) request for Beatriz resolves after the
    // second request for Alice was already issued — its abort signal
    // should already have fired, and even if it hadn't, the response must
    // never be applied since a newer request is in flight.
    await act(async () => {
      firstBCall.deferred.resolve(buildDaily(empB, "2026-08-11", "Beatriz's Activity"));
    });
    expect(screen.queryByText("Beatriz's Activity")).not.toBeInTheDocument();
    expect(firstBCall.aborted).toBe(true);

    // The current, latest request (Alice again) resolving is what actually
    // updates the page.
    await act(async () => {
      secondACall.deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Activity"));
    });
    await screen.findByText("Alice's Activity");
    expect(screen.queryByText("Beatriz's Activity")).not.toBeInTheDocument();
  });

  it("never lets a slower, superseded response overwrite a faster, later selection (rapid date navigation)", async () => {
    // Same requestSeqRef/AbortController protection loadDaily uses for
    // employee switching (the test above) — this exercises the identical
    // mechanism via DATE changes instead, per the Inputs blank-screen-crash
    // investigation's explicit "out-of-order date-navigation requests"
    // concern. Confirmed here rather than assumed to still hold: it's the
    // same code path, but the trigger (Next day) is genuinely different
    // from a click on a different employee row.
    // Pinned via the URL, not left to default to "today" — the other
    // tests in this file don't care what date they land on, but this one
    // asserts on exact "Next day" results, which has to start from a known
    // date.
    renderInputsPage("/inputs?date=2026-08-11");
    await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
    await act(async () => {
      findDailyCall(empA.id).deferred.resolve(buildDaily(empA, "2026-08-11", "Day 11 Activity"));
    });
    await screen.findByText("Day 11 Activity");

    const user = userEvent.setup();
    const callsSoFar = dailyCalls.length;
    // Two "Next day" clicks in a row, before either request resolves —
    // 08-12 then 08-13.
    await user.click(screen.getByLabelText("Next day"));
    await user.click(screen.getByLabelText("Next day"));
    const dateCalls = dailyCalls.slice(callsSoFar);
    expect(dateCalls.map((c) => c.date)).toEqual(["2026-08-12", "2026-08-13"]);
    const [supersededCall, latestCall] = dateCalls;

    // The FIRST (now-superseded) 08-12 request resolves after 08-13 was
    // already issued — must never be applied, even though it arrives
    // "successfully."
    await act(async () => {
      supersededCall.deferred.resolve(buildDaily(empA, "2026-08-12", "Day 12 Activity"));
    });
    expect(screen.queryByText("Day 12 Activity")).not.toBeInTheDocument();
    expect(supersededCall.aborted).toBe(true);

    await act(async () => {
      latestCall.deferred.resolve(buildDaily(empA, "2026-08-13", "Day 13 Activity"));
    });
    await screen.findByText("Day 13 Activity");
    expect(screen.queryByText("Day 12 Activity")).not.toBeInTheDocument();
  });

  it("survives the exact real-world malformed shape (endedAtCorrectedFrom: the string \"null\") without blanking or crashing", async () => {
    // Reproduces the literal real-world shape (a server-computed
    // *CorrectedFrom field carrying the string "null", not JSON null). The
    // root cause is fixed server-side (inputs.ts no longer emits this) AND
    // the client's own formatter is independently hardened (see
    // lib/timezone.ts) — so this specific shape no longer even reaches the
    // InputsErrorBoundary at all, it degrades gracefully inline. Both
    // layers matter: this proves the inner one; InputsErrorBoundary.test.tsx
    // proves the outer backstop for anything neither layer anticipated.
    renderInputsPage("/inputs?date=2026-08-11");
    await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));

    const goodRun = buildDaily(empA, "2026-08-11", "Healthy Activity").runs[0];
    const malformedRun = { ...goodRun, id: "run-malformed", activityName: "Malformed Activity", endedAtCorrectedFrom: "null" };
    await act(async () => {
      findDailyCall(empA.id).deferred.resolve({
        ...buildDaily(empA, "2026-08-11", "Healthy Activity"),
        runs: [goodRun, malformedRun],
      });
    });

    // Both rows render — nothing threw, nothing blanked.
    await screen.findByText("Healthy Activity");
    expect(screen.getByText("Malformed Activity")).toBeInTheDocument();
    // The malformed field degrades to a labeled, honest fallback instead
    // of a real (fabricated) time.
    expect(screen.getByText("Corrected")).toBeInTheDocument();
    // Navigation/admin controls are unaffected either way.
    expect(screen.getByText("Beatriz Barrios")).toBeInTheDocument();
    expect(screen.getByLabelText("Next day")).toBeEnabled();
  });

  it("still refreshes the current employee in the background every 10 seconds, without clearing the display", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"] });
    renderInputsPage();

    await vi.waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
    await act(async () => {
      findDailyCall(empA.id).deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Activity"));
    });
    await vi.waitFor(() => expect(screen.getByText("Alice's Activity")).toBeInTheDocument());

    const callsBeforePoll = dailyCalls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(dailyCalls.length).toBeGreaterThan(callsBeforePoll);

    // The background poll must never clear `daily` while it's in flight —
    // Alice's data (and no skeleton) stays visible throughout.
    expect(screen.getByText("Alice's Activity")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading employee data")).not.toBeInTheDocument();

    const pollCall = findDailyCall(empA.id);
    await act(async () => {
      pollCall.deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Updated Activity"));
    });
    await vi.waitFor(() => expect(screen.getByText("Alice's Updated Activity")).toBeInTheDocument());
  });

  it("renders break-correction feedback inside the Activity details header instead of above the card", async () => {
    breakPatchFailure = { status: 409, message: "Corrected break overlaps a work entry" };
    const teaBreak = buildBreak(
      "break-1",
      "Tea break",
      "2026-08-11T14:00:00.000Z",
      "2026-08-11T14:15:00.000Z"
    );

    renderInputsPage();

    await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
    await act(async () => {
      findDailyCall(empA.id).deferred.resolve(buildDaily(empA, "2026-08-11", "Alice's Activity", [teaBreak]));
    });
    await screen.findByText("Alice's Activity");

    const user = userEvent.setup();
    await user.click(screen.getByText("Tea break"));
    await user.click(screen.getByText(formatTimeInAppTimezone(teaBreak.endedAt!)));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const statusMessage = await screen.findByText("Corrected break overlaps a work entry");
    const header = screen.getByText("Activity details").closest(".inputs-section-header");

    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText("Corrected break overlaps a work entry")).toBe(statusMessage);
    expect(statusMessage.closest(".inputs-section-header")).toBe(header);
    expect(statusMessage.closest(".inputs-workspace-placeholder")).toBeNull();
  });
});
