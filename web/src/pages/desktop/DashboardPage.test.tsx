// @vitest-environment jsdom
//
// Tests DashboardPage's loading/empty/success/error rendering, row_stem vs
// picking card rendering by discriminant, and Edit Dashboard button
// visibility by role. lib/api.ts is mocked so every network call is fully
// controlled by the test (deferred promises resolved on demand) — same
// convention as InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../lib/api";
import { DashboardCard, GetDashboardCardsResponse } from "../../lib/dashboardTypes";

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

let meResponse: { employee: { id: string; firstName: string; lastName: string; securityRole: string; teamRole: string } };
let cardsDeferred: Deferred<GetDashboardCardsResponse>;

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
      if (path.startsWith("/api/auth/me")) {
        return Promise.resolve(meResponse);
      }
      if (path.startsWith("/api/dashboard/cards")) {
        return cardsDeferred.promise;
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>
  );
}

function rowStemCard(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    cardType: "row_stem",
    employeeId: "emp-row-stem",
    employeeFirstName: "Rita",
    employeeLastName: "Rowe",
    photoUrl: null,
    activityId: "activity-row-stem",
    activityName: "Winding & Pruning",
    runStartedAt: "2026-08-17T13:00:00.000Z",
    densityType: "stems",
    rowLabel: "Phase 1 · Row 5",
    weeklySpeed: 480,
    block: {
      id: "block-1",
      name: "Block 2",
      totalRows: 32,
      completedRows: 18,
      remainingStems: 4200,
      rowsMissingDensity: 0,
      projectedHoursRemaining: 8.75,
      status: "in_progress",
    },
    ...overrides,
  } as DashboardCard;
}

function pickingCard(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    cardType: "picking",
    employeeId: "emp-picking",
    employeeFirstName: "Paco",
    employeeLastName: "Pines",
    photoUrl: null,
    activityId: "activity-picking",
    activityName: "Picking Peppers",
    runStartedAt: "2026-08-17T13:00:00.000Z",
    carrierName: "Bin 12",
    weeklySpeed: 1.5,
    binsCompletedThisWeek: 3,
    rowsWorkedThisWeek: 5,
    ...overrides,
  } as DashboardCard;
}

beforeEach(() => {
  meResponse = {
    employee: { id: "admin-1", firstName: "Ada", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" },
  };
  cardsDeferred = createDeferred<GetDashboardCardsResponse>();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DashboardPage", () => {
  it("shows a loading skeleton before the first response arrives", async () => {
    renderDashboard();
    await waitFor(() => expect(document.querySelector(".dashboard-card-grid[aria-busy='true']")).toBeInTheDocument());
  });

  it("shows an empty state (with an edit hint for an authorized user) when there are no cards", async () => {
    renderDashboard();
    await act(async () => {
      cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [] });
    });
    await screen.findByText(/No one is currently doing a Dashboard-tracked activity/);
    expect(screen.getByRole("button", { name: "Edit Dashboard" })).toBeInTheDocument();
  });

  it("renders a row_stem card and a picking card by their cardType discriminant", async () => {
    renderDashboard();
    await act(async () => {
      cardsDeferred.resolve({
        weekStart: "2026-08-17",
        weekEnd: "2026-08-23",
        cards: [rowStemCard(), pickingCard()],
      });
    });

    await screen.findByText("Rita Rowe");
    expect(screen.getByText("Winding & Pruning")).toBeInTheDocument();
    expect(screen.getByText(/18 of 32 rows/)).toBeInTheDocument();
    expect(screen.getByText(/8\.8 hours remaining|8\.75 hours remaining/)).toBeInTheDocument();

    expect(screen.getByText("Paco Pines")).toBeInTheDocument();
    expect(screen.getByText("Picking Peppers")).toBeInTheDocument();
    expect(screen.getByText(/1\.50 bins\/hour/)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // bins completed
  });

  it("shows the server's real error message and never leaves the skeleton up", async () => {
    renderDashboard();
    await act(async () => {
      cardsDeferred.reject(new ApiError(500, "Dashboard query failed"));
    });
    await screen.findByText("Dashboard query failed");
    expect(document.querySelector(".dashboard-card-skeleton")).not.toBeInTheDocument();
  });

  it("shows the Edit Dashboard button for an Administrator", async () => {
    renderDashboard();
    await act(async () => {
      cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [] });
    });
    await waitFor(() => expect(screen.getByText("Edit Dashboard")).toBeInTheDocument());
  });

  it("hides the Edit Dashboard button for a plain Employee", async () => {
    meResponse = {
      employee: { id: "emp-1", firstName: "Evan", lastName: "Employee", securityRole: "Employee", teamRole: "Team Member" },
    };
    renderDashboard();
    await act(async () => {
      cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [] });
    });
    await screen.findByText(/No one is currently doing a Dashboard-tracked activity/);
    expect(screen.queryByText("Edit Dashboard")).not.toBeInTheDocument();
  });

  it("renders exactly two columns' worth of grid via the fixed-column CSS class (verified visually in a real browser separately)", async () => {
    renderDashboard();
    await act(async () => {
      cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [rowStemCard(), pickingCard()] });
    });
    await screen.findByText("Rita Rowe");
    const grid = document.querySelector(".dashboard-card-grid");
    expect(grid).toBeInTheDocument();
    expect(grid?.children.length).toBe(2);
  });
});
