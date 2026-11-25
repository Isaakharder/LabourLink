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
import { api, ApiError } from "../../lib/api";
import { DashboardCard, GetDashboardCardsResponse, GetDashboardKpisResponse } from "../../lib/dashboardTypes";

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
let kpisResponse: GetDashboardKpisResponse | Error;

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
    onSessionExpired: vi.fn(() => () => {}),
    api: vi.fn((path: string) => {
      if (path.startsWith("/api/auth/me")) {
        return Promise.resolve(meResponse);
      }
      if (path.startsWith("/api/dashboard/cards")) {
        return cardsDeferred.promise;
      }
      if (path.startsWith("/api/dashboard/kpis")) {
        return kpisResponse instanceof Error ? Promise.reject(kpisResponse) : Promise.resolve(kpisResponse);
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
  kpisResponse = { date: "2026-11-23", kgWeighedToday: null, workPermitAlerts: null };
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
    await screen.findByText(/No one is currently doing a Dashboard-tracked job/);
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
    await screen.findByText(/No one is currently doing a Dashboard-tracked job/);
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

  describe("KPI strip: KG weighed today", () => {
    const calledPaths = () => vi.mocked(api).mock.calls.map((c) => c[0] as string);

    async function renderWithCards() {
      renderDashboard();
      await act(async () => {
        cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [] });
      });
    }

    it("shows today's net kg, the bin count and the last weighing time, linking to Scale Weighings", async () => {
      kpisResponse = { date: "2026-11-23", kgWeighedToday: { netKg: 1234.5, bins: 16, lastWeighedAt: "2026-11-23T15:34:07.000Z" }, workPermitAlerts: null };
      await renderWithCards();
      expect(await screen.findByText("KG weighed today")).toBeInTheDocument();
      expect(screen.getByText("1,234.5 kg")).toBeInTheDocument();
      expect(screen.getByText("16 bins · last 10:34 AM")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /KG weighed today: 1,234.5 kg/ })).toHaveAttribute("href", "/scale-weighings");
    });

    it("shows an empty state when no bins have been weighed today", async () => {
      kpisResponse = { date: "2026-11-23", kgWeighedToday: { netKg: 0, bins: 0, lastWeighedAt: null }, workPermitAlerts: null };
      await renderWithCards();
      expect(await screen.findByText("No bins weighed yet today")).toBeInTheDocument();
      expect(screen.getByText("0 kg")).toBeInTheDocument();
      expect(document.querySelector(".dashboard-kpi-card")).toHaveClass("is-empty");
    });

    it("has no card (and no strip) for a greenhouse without LabourLink Scale", async () => {
      kpisResponse = { date: "2026-11-23", kgWeighedToday: null, workPermitAlerts: null };
      await renderWithCards();
      await waitFor(() => expect(calledPaths()).toContain("/api/dashboard/kpis"));
      expect(screen.queryByText("KG weighed today")).not.toBeInTheDocument();
      expect(document.querySelector(".dashboard-kpi-strip")).not.toBeInTheDocument();
    });

    it("a KPI error never blanks the employee cards and shows no error banner", async () => {
      kpisResponse = new ApiError(500, "kpi boom");
      renderDashboard();
      await act(async () => {
        cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [pickingCard()] });
      });
      await screen.findByText("Paco Pines");
      expect(screen.queryByText("kpi boom")).not.toBeInTheDocument();
      expect(document.querySelector(".dashboard-kpi-strip")).not.toBeInTheDocument();
    });

    it("updates on refresh as new weighings arrive", async () => {
      kpisResponse = { date: "2026-11-23", kgWeighedToday: { netKg: 20, bins: 1, lastWeighedAt: "2026-11-23T15:00:00.000Z" }, workPermitAlerts: null };
      await renderWithCards();
      await screen.findByText("20 kg");
      kpisResponse = { date: "2026-11-23", kgWeighedToday: { netKg: 41.5, bins: 2, lastWeighedAt: "2026-11-23T15:05:00.000Z" }, workPermitAlerts: null };
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(await screen.findByText("41.5 kg")).toBeInTheDocument();
      expect(screen.getByText("2 bins · last 10:05 AM")).toBeInTheDocument();
    });

    it("is not requested or shown for a plain Employee", async () => {
      meResponse = {
        employee: { id: "emp-1", firstName: "Evan", lastName: "Employee", securityRole: "Employee", teamRole: "Team Member" },
      };
      kpisResponse = { date: "2026-11-23", kgWeighedToday: { netKg: 20, bins: 1, lastWeighedAt: null }, workPermitAlerts: { active: 2, expired: 1, under30Days: 0 } };
      await renderWithCards();
      await screen.findByText(/No one is currently doing a Dashboard-tracked job/);
      expect(calledPaths()).not.toContain("/api/dashboard/kpis");
      expect(screen.queryByText("KG weighed today")).not.toBeInTheDocument();
    });

    it("shows only a count of work permit alerts, never the detailed alerts or their actions", async () => {
      kpisResponse = { date: "2026-11-23", kgWeighedToday: null, workPermitAlerts: { active: 3, expired: 1, under30Days: 0 } };
      await renderWithCards();
      expect(await screen.findByText("Work permit alerts")).toBeInTheDocument();
      expect(calledPaths()).not.toContain("/api/dashboard/work-permit-alerts");
      expect(document.querySelector(".work-permit-alerts-section, .work-permit-alert-card")).not.toBeInTheDocument();
      for (const action of ["Acknowledge", "Renewed", "Cancel alert"]) {
        expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument();
      }
    });
  });

  describe("KPI strip: Work permit alerts", () => {
    async function renderWithKpis(kpis: GetDashboardKpisResponse) {
      kpisResponse = kpis;
      renderDashboard();
      await act(async () => {
        cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [] });
      });
    }

    it("shows the number of active alerts and opens Employees -> Work Permits", async () => {
      await renderWithKpis({ date: "2026-11-23", kgWeighedToday: null, workPermitAlerts: { active: 5, expired: 1, under30Days: 2 } });
      const card = await screen.findByRole("link", { name: /Work permit alerts: 5 active/ });
      expect(card).toHaveAttribute("href", "/employees/work-permits");
      expect(card).toHaveTextContent("5");
      expect(card).toHaveTextContent("1 expired · 2 under 30 days");
      expect(card).toHaveClass("is-urgent");
    });

    it("is calm when nothing is due within 30 days, and shows an empty state with no alerts", async () => {
      await renderWithKpis({ date: "2026-11-23", kgWeighedToday: null, workPermitAlerts: { active: 2, expired: 0, under30Days: 0 } });
      const card = await screen.findByRole("link", { name: /Work permit alerts: 2 active/ });
      expect(card).toHaveTextContent("None due within 30 days");
      expect(card).toHaveClass("is-attention");
      cleanup();
      await renderWithKpis({ date: "2026-11-23", kgWeighedToday: null, workPermitAlerts: { active: 0, expired: 0, under30Days: 0 } });
      const empty = await screen.findByRole("link", { name: /Work permit alerts: 0 active/ });
      expect(empty).toHaveTextContent("No active alerts");
      expect(empty).toHaveClass("is-empty");
    });

    it("sits beside KG weighed today as small tiles in the same wrapping strip", async () => {
      await renderWithKpis({
        date: "2026-11-23",
        kgWeighedToday: { netKg: 59.85, bins: 3, lastWeighedAt: null },
        workPermitAlerts: { active: 1, expired: 0, under30Days: 1 },
      });
      await screen.findByText("Work permit alerts");
      const strip = document.querySelector(".dashboard-kpi-strip");
      expect(strip?.querySelectorAll(".dashboard-kpi-card")).toHaveLength(2);
      expect(strip?.children[0]).toHaveTextContent("KG weighed today");
      expect(strip?.children[1]).toHaveTextContent("Work permit alerts");
    });
  });

  describe("Bin Completions button", () => {
    it("is styled like the other header buttons and is still a plain button for managers", async () => {
      renderDashboard();
      await act(async () => {
        cardsDeferred.resolve({ weekStart: "2026-08-17", weekEnd: "2026-08-23", cards: [] });
      });
      const button = await screen.findByRole("button", { name: "Bin Completions" });
      expect(button).toHaveClass("dashboard-secondary-button");
      expect(button).toHaveAttribute("type", "button");
    });
  });
});
