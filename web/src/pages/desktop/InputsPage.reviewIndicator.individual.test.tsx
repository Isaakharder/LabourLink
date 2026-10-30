// @vitest-environment jsdom
//
// An individual review (Activity details' "Needs review" -> Combine / keep
// separate, RowCompletionReviewModal) must clear the sidebar's review
// indicator for that employee straight away. The modal itself is covered by
// RowCompletionReviewModal.test.tsx; here ActivityLogsCard is replaced by a
// stub that reports a saved review exactly as the real card does
// (onRowCompletionChanged), so this exercises InputsPage's own refresh wiring.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { renderInputsOn } from "../../lib/testUtils/inputsToday";

const DATE = "2026-10-05";
let pendingFor = new Set(["emp-khen", "emp-mia"]);

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-admin", firstName: "Ada", lastName: "Admin", securityRole: "Administrator" } }),
}));

vi.mock("../../components/inputs/ActivityLogsCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/inputs/ActivityLogsCard")>();
  return {
    ...actual,
    ActivityLogsCard: ({ onRowCompletionChanged }: { onRowCompletionChanged: () => void }) => (
      <button
        type="button"
        onClick={() => {
          // The server saved Khen's completion: his visit is no longer pending.
          pendingFor.delete("emp-khen");
          onRowCompletionChanged();
        }}
      >
        Save individual review
      </button>
    ),
  };
});

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
    api: vi.fn(async (path: string) => {
      const url = new URL(path, "http://t");
      if (url.pathname === "/api/inputs/employees") {
        return {
          employees: [
            { id: "emp-khen", firstName: "Khen", lastName: "Lagto", photoUrl: null, paidSeconds: 27900, employeeGroup: null },
            { id: "emp-mia", firstName: "Mia", lastName: "Santos", photoUrl: null, paidSeconds: 18000, employeeGroup: null },
          ],
        };
      }
      if (url.pathname === "/api/inputs/daily") {
        return {
          employee: { id: url.searchParams.get("employeeId"), firstName: "K", lastName: "L", photoUrl: null },
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
        };
      }
      if (url.pathname === "/api/row-completions/review-groups") {
        return { date: DATE, groups: [...pendingFor].map((employeeId, i) => ({ id: `g${i}`, employeeId })), windowDays: 7 };
      }
      return {};
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pendingFor = new Set(["emp-khen", "emp-mia"]);
});

const badgeOf = (name: RegExp) => screen.getByRole("button", { name }).querySelector(".inputs-employee-review");

describe("individual review", () => {
  it("clears the reviewed employee's indicator and leaves the others", async () => {
    renderInputsOn(DATE, () =>
      render(
        <MemoryRouter initialEntries={["/inputs?employee=emp-khen"]}>
          <InputsPage />
        </MemoryRouter>
      )
    );
    await waitFor(() => expect(badgeOf(/^Khen Lagto/)).toHaveTextContent("1"));
    expect(badgeOf(/^Mia Santos/)).toHaveTextContent("1");

    await act(async () => {
      screen.getByRole("button", { name: "Save individual review" }).click();
    });
    await waitFor(() => expect(badgeOf(/^Khen Lagto/)).toBeNull());
    expect(screen.getByRole("button", { name: /^Khen Lagto/ })).not.toHaveClass("inputs-employee-item-needs-review");
    expect(badgeOf(/^Mia Santos/)).toHaveTextContent("1");
  });
});
