// @vitest-environment jsdom
//
// Regression coverage for the Inputs activity-log deletion delay
// investigation's CLIENT-side requirements: the Delete button must disable
// and show "Deleting…" immediately (before the network call resolves — no
// waiting on a round trip for basic visual feedback), exactly one DELETE
// request and exactly one subsequent daily refresh must occur (no duplicate
// mutation from a double-click, no duplicate refresh from the background-
// poll effect firing on top of the explicit post-delete reload), and a
// failed delete must never leave the UI in a changed state (nothing here
// does an optimistic removal, so there is nothing to roll back — the row
// simply never disappears until the server confirms it's gone).
//
// Same mocking convention as InputsPage.switching.test.tsx (lib/api.ts
// mocked, deferred promises resolved on demand) — this file is deliberately
// separate from that one rather than added to it, since it exercises a
// different flow (delete) with its own dedicated call-tracking.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
  date: string;
  deferred: Deferred<DailyInputsResponse>;
}

let dailyCalls: DailyCall[] = [];
let deleteCalls: { path: string; deferred: Deferred<{ ok: true }> }[] = [];

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
        return Promise.resolve({ employees: [{ id: "emp-a", firstName: "Alice", lastName: "Anderson", photoUrl: null }] });
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
        deleteCalls.push({ path, deferred });
        return deferred.promise;
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function buildDaily(date: string): DailyInputsResponse {
  return {
    employee: { id: "emp-a", firstName: "Alice", lastName: "Anderson", photoUrl: null },
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
  dailyCalls = [];
  deleteCalls = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// Loads the page, resolves the initial daily fetch, selects the run, and
// opens the delete-confirmation modal — the common setup every test below
// starts from.
async function loadAndOpenDeleteModal() {
  renderInputsPage();
  await waitFor(() => expect(dailyCalls.length).toBeGreaterThan(0));
  await act(async () => {
    dailyCalls[0].deferred.resolve(buildDaily("2026-08-24"));
  });
  await screen.findByText("Picking Peppers");

  const user = userEvent.setup();
  await user.click(screen.getByText("Picking Peppers")); // selects the run — reveals its row Delete button
  await user.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("Delete activity log?");
  return user;
}

describe("InputsPage — activity-log delete performance/UX", () => {
  it("disables the Delete button and shows 'Deleting…' immediately, before the network call resolves", async () => {
    const user = await loadAndOpenDeleteModal();
    const confirmButton = screen.getByRole("button", { name: "Delete Log" });
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);

    // Synchronous with the click — no `act`/`waitFor` needed, and
    // deliberately BEFORE resolving the mocked DELETE call below, proving
    // this doesn't wait on a round trip.
    expect(await screen.findByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect(deleteCalls.length).toBe(1);
  });

  it("makes exactly ONE DELETE call and exactly ONE subsequent daily refresh — no duplicate mutation or duplicate refresh", async () => {
    const user = await loadAndOpenDeleteModal();
    const dailyCallsBeforeDelete = dailyCalls.length;

    await user.click(screen.getByRole("button", { name: "Delete Log" }));
    expect(deleteCalls.length).toBe(1);

    await act(async () => {
      deleteCalls[0].deferred.resolve({ ok: true });
    });

    // The post-delete refresh: exactly one new GET /daily call, not two
    // (the explicit reload the delete handler itself makes, plus a second
    // one from the background-poll "falling edge" effect firing right after
    // deletionSubmitting flips back to false, would both land here as two
    // separate calls if the duplicate-refresh bug were present).
    await waitFor(() => expect(dailyCalls.length).toBe(dailyCallsBeforeDelete + 1));
    await act(async () => {
      dailyCalls[dailyCalls.length - 1].deferred.resolve(buildDaily("2026-08-24"));
    });
    await screen.findByText("Activity log deleted.");

    // Give any stray extra effect/timer a chance to fire before asserting
    // the call count is still exactly right — a real duplicate-refresh bug
    // would show up here as a second, unresolved daily call left dangling.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deleteCalls.length).toBe(1);
    expect(dailyCalls.length).toBe(dailyCallsBeforeDelete + 1);
  });

  it("never removes the row, and shows the server's real error, when the delete request fails — nothing to roll back because nothing was optimistically changed", async () => {
    const user = await loadAndOpenDeleteModal();

    await user.click(screen.getByRole("button", { name: "Delete Log" }));
    await act(async () => {
      deleteCalls[0].deferred.reject(new ApiError(500, "Could not delete this activity log"));
    });

    await screen.findByText("Could not delete this activity log");
    // The modal stays open (still showing Delete Log, not gone) and the
    // original row is still fully present underneath it — no premature
    // removal ever happened, so there's nothing to undo.
    expect(screen.getByRole("button", { name: "Delete Log" })).toBeEnabled();
    expect(screen.getByText("Picking Peppers")).toBeInTheDocument();
    // No extra daily refresh was triggered by the failure either.
    expect(dailyCalls.length).toBe(1);
  });
});
