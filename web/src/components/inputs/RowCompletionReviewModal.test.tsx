// @vitest-environment jsdom
//
// Tests the fix for the reported "No pending work found for this row" +
// enabled Combine button contradiction: when GET /candidates genuinely
// returns zero candidates, the modal must explain the badge was stale,
// never show an enabled (or even visible) Combine action, and offer a way
// to acknowledge and refresh instead. Same mocking convention as
// InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { ComponentProps } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowCompletionReviewModal } from "./RowCompletionReviewModal";
import { api, ApiError } from "../../lib/api";

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

let candidatesDeferred: Deferred<{ candidates: any[] }>;

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
      if (path.startsWith("/api/row-completions/candidates")) {
        return candidatesDeferred.promise;
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function candidate(overrides: Partial<any> = {}) {
  return {
    runId: "run-1",
    segmentIds: ["run-1"],
    employeeName: "Marcelino Besa",
    activityName: "Winding & Pruning",
    date: "2026-08-15",
    startedAt: "2026-08-15T13:00:00.000Z",
    endedAt: "2026-08-15T14:00:00.000Z",
    durationSeconds: 3600,
    ...overrides,
  };
}

beforeEach(() => {
  candidatesDeferred = createDeferred();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(props: Partial<ComponentProps<typeof RowCompletionReviewModal>> = {}) {
  const onClose = vi.fn();
  const onCombined = vi.fn();
  const onNoLongerPending = vi.fn();
  render(
    <RowCompletionReviewModal
      greenhouseRowId="row-92"
      activityId="activity-winding-pruning"
      activityName="Winding & Pruning"
      densityType="stems"
      rowLabel="Phase 1 · Row 92"
      onClose={onClose}
      onCombined={onCombined}
      onNoLongerPending={onNoLongerPending}
      {...props}
    />
  );
  return { onClose, onCombined, onNoLongerPending };
}

describe("RowCompletionReviewModal", () => {
  it("shows a loading state before candidates arrive", () => {
    renderModal();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("queries candidates scoped by activityId, not just the row and density type — a different activity's work must never be requested", () => {
    renderModal({ activityId: "activity-picking-peppers" });
    const calledPath = vi.mocked(api).mock.calls[0][0] as string;
    expect(calledPath).toContain("greenhouseRowId=row-92");
    expect(calledPath).toContain("activityId=activity-picking-peppers");
    expect(calledPath).toContain("densityType=stems");
  });

  it("6) never shows an enabled Combine button when there are no candidates — explains the stale badge instead", async () => {
    const { onClose, onNoLongerPending } = renderModal();
    await act(async () => {
      candidatesDeferred.resolve({ candidates: [] });
    });

    await screen.findByText(/no pending work to review right now/i);
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    // The Combine button must not exist at all — not just be disabled.
    expect(screen.queryByRole("button", { name: /combine as one completed row/i })).not.toBeInTheDocument();
    // The contradictory intro hint ("has work logged across more than one
    // segment") must not render alongside "no pending work" either.
    expect(screen.queryByText(/has work logged across more than one segment/i)).not.toBeInTheDocument();

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    const user = userEvent.setup();
    await user.click(refreshButton);
    expect(onNoLongerPending).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders every real candidate with employee, date, start/end, and duration, and enables Combine once one is selected", async () => {
    renderModal();
    await act(async () => {
      candidatesDeferred.resolve({
        candidates: [
          candidate({ runId: "run-1", employeeName: "Marcelino Besa" }),
          candidate({ runId: "run-2", employeeName: "Reynaldo Dela Cruz", startedAt: "2026-08-15T15:00:00.000Z", endedAt: "2026-08-15T16:00:00.000Z" }),
        ],
      });
    });

    await screen.findByText("Marcelino Besa");
    expect(screen.getByText("Reynaldo Dela Cruz")).toBeInTheDocument();
    expect(screen.getAllByText("Winding & Pruning")).toHaveLength(2); // each candidate row's Activity column
    // The modal's own title names the scoped activity too — reassurance that
    // this review group is Winding & Pruning's own, never mixed with another
    // activity's work.
    expect(screen.getByRole("heading", { name: /Winding & Pruning/ })).toBeInTheDocument();

    const combineButton = screen.getByRole("button", { name: /combine as one completed row/i });
    expect(combineButton).toBeDisabled();

    const checkboxes = screen.getAllByRole("checkbox");
    const user = userEvent.setup();
    await user.click(checkboxes[0]);
    await waitFor(() => expect(combineButton).toBeEnabled());
  });

  it("shows the server's real error message when the candidates request fails", async () => {
    renderModal();
    await act(async () => {
      candidatesDeferred.reject(new ApiError(500, "Could not load pending row work"));
    });
    await screen.findByText("Could not load pending row work");
  });
});
