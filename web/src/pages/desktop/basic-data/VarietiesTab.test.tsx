// @vitest-environment jsdom
//
// Basic Data -> Varieties tab: the variety summary with calculated vs
// entered figures labelled apart, adding a variety with plants planted,
// bulk row assignment by range (no shift-click, tablet-friendly) with a
// confirmation before reassigning, the read-only view for Managers, and
// the no-season empty state. lib/api.ts is mocked; the server rules are
// covered by server/src/routes/varieties.test.ts.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VarietiesTab } from "./VarietiesTab";
import { AuthProvider } from "../../../context/AuthContext";
import { api } from "../../../lib/api";
import { GrowingSeason, SeasonRow, Variety } from "../../../lib/varietyTypes";

let role = "Administrator";
let seasons: GrowingSeason[];
let varieties: Variety[];
let rows: SeasonRow[];
const writes: { path: string; method: string; body: unknown }[] = [];

vi.mock("../../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    errors?: Record<string, string>;
    constructor(status: number, message: string, errors?: Record<string, string>) {
      super(message);
      this.status = status;
      this.errors = errors;
    }
  }
  return {
    ApiError,
    onSessionExpired: vi.fn(() => () => {}),
    api: vi.fn(async (path: string, options?: RequestInit) => {
      if (path.startsWith("/api/auth/me")) {
        return { employee: { id: "me", firstName: "Ada", lastName: "Admin", securityRole: role, teamRole: "Team Member" } };
      }
      const method = options?.method ?? "GET";
      if (method !== "GET") {
        const body = options?.body ? JSON.parse(options.body as string) : undefined;
        writes.push({ path, method, body });
        if (path.endsWith("/rows") && method === "PUT") {
          const b = body as { rowIds: string[]; varietyId: string | null };
          rows = rows.map((r) => (b.rowIds.includes(r.id) ? { ...r, varietyId: b.varietyId } : r));
          return { rows };
        }
        return { id: "new-variety" };
      }
      if (path === "/api/varieties/seasons") return { seasons, defaultSeasonId: seasons.find((s) => s.isCurrent)?.id ?? seasons[0]?.id ?? null };
      if (path.startsWith("/api/varieties/rows")) return { rows };
      if (path.startsWith("/api/varieties")) return { seasonId: seasons[0]?.id ?? null, varieties };
      throw new Error(`Unhandled mock api() call: ${path}`);
    }),
  };
});

function variety(overrides: Partial<Variety>): Variety {
  return {
    id: "v-red",
    name: "Red Bell",
    notes: null,
    isActive: true,
    inUse: true,
    plantedThisSeason: true,
    totalPlants: 3180,
    summary: {
      rows: 10,
      deletedRows: 0,
      totalLengthM: 585.2,
      plantsPerMetre: 5.43,
      averageEstimatedPlantsPerRow: 318,
      rowsWithEnteredCount: 4,
      enteredPlantsTotal: 1272,
    },
    ...overrides,
  };
}

function seasonRows(): SeasonRow[] {
  return Array.from({ length: 8 }, (_, i) => ({
    id: `row-${i + 1}`,
    landName: "First Light",
    phaseId: "p1",
    phaseName: "Phase 1",
    rowNumber: i + 1,
    lengthFt: 192,
    deleted: false,
    varietyId: i < 2 ? "v-red" : null,
    enteredPlantsPerRow: null,
  }));
}

function renderTab() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <VarietiesTab />
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  role = "Administrator";
  seasons = [{ id: "s1", name: "2026 season", startsOn: "2026-01-05", endsOn: null, isCurrent: true, assignedRows: 2 }];
  varieties = [
    variety({}),
    variety({ id: "v-yellow", name: "Yellow Sun", totalPlants: null, inUse: false, plantedThisSeason: false, summary: { ...variety({}).summary, rows: 0, totalLengthM: 0, plantsPerMetre: null, averageEstimatedPlantsPerRow: null, rowsWithEnteredCount: 0, enteredPlantsTotal: null } }),
  ];
  rows = seasonRows();
  writes.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VarietiesTab", () => {
  it("shows each variety's summary with calculated and entered figures labelled apart", async () => {
    renderTab();
    const table = await screen.findByRole("table");
    const red = within(table).getByText("Red Bell").closest("tr")!;
    expect(red).toHaveTextContent("3,180");
    expect(red).toHaveTextContent("585.2 m");
    expect(red).toHaveTextContent("5.43");
    expect(red).toHaveTextContent("318");
    expect(within(table).getAllByText("Calculated")).toHaveLength(2);
    expect(within(table).getByText("Entered")).toBeInTheDocument();
    const yellow = within(table).getByText("Yellow Sun").closest("tr")!;
    expect(yellow).toHaveTextContent("Not recorded");
    expect(screen.getByText("2026 season (current)")).toBeInTheDocument();
  });

  it("adds a variety with plants planted for the selected season, rejecting a non-whole number first", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Add variety" }));
    await user.type(screen.getByLabelText("Name *"), "Orange Glow");
    await user.type(screen.getByLabelText(/Plants planted/), "12.5");
    await user.click(screen.getAllByRole("button", { name: "Add variety" }).slice(-1)[0]);
    expect(await screen.findByText("Enter a whole number of plants")).toBeInTheDocument();
    expect(writes).toHaveLength(0);

    await user.clear(screen.getByLabelText(/Plants planted/));
    await user.type(screen.getByLabelText(/Plants planted/), "148,500");
    await user.click(screen.getAllByRole("button", { name: "Add variety" }).slice(-1)[0]);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ path: "/api/varieties", method: "POST", body: { name: "Orange Glow", notes: null, seasonId: "s1", totalPlants: 148500 } });
  });

  it("selects a consecutive range of rows and assigns them in one request", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("8 rows · 6 unassigned");
    await user.type(screen.getByLabelText("From row"), "3");
    await user.type(screen.getByLabelText("To row"), "6");
    await user.click(screen.getByRole("button", { name: "Select range" }));
    expect(screen.getByText("4 rows selected")).toBeInTheDocument();
    for (const n of [3, 4, 5, 6]) expect(screen.getByRole("button", { name: `Row ${n}: Unassigned` })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Row 7: Unassigned" })).toHaveAttribute("aria-pressed", "false");

    await user.selectOptions(screen.getByLabelText("Assign to"), "v-yellow");
    await user.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: "/api/varieties/seasons/s1/rows",
      method: "PUT",
      body: { rowIds: ["row-3", "row-4", "row-5", "row-6"], varietyId: "v-yellow" },
    });
    expect(await screen.findByRole("button", { name: "Row 3: Yellow Sun" })).toBeInTheDocument();
  });

  it("asks before reassigning rows that already belong to another variety", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("8 rows · 6 unassigned");
    await user.type(screen.getByLabelText("From row"), "1");
    await user.type(screen.getByLabelText("To row"), "3");
    await user.click(screen.getByRole("button", { name: "Select range" }));
    await user.selectOptions(screen.getByLabelText("Assign to"), "v-yellow");
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByText(/2 of the 3 selected rows are assigned to Red Bell in 2026 season\. Reassign them to Yellow Sun\?/)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ rowIds: ["row-1", "row-2", "row-3"], varietyId: "v-yellow" });
  });

  it("explains an empty range instead of selecting nothing silently", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("8 rows · 6 unassigned");
    await user.type(screen.getByLabelText("From row"), "40");
    await user.type(screen.getByLabelText("To row"), "50");
    await user.click(screen.getByRole("button", { name: "Select range" }));
    expect(screen.getByText("No rows 40–50 in this phase")).toBeInTheDocument();
  });

  it("is read-only for a Manager: figures and row colours, no editing", async () => {
    role = "Manager";
    renderTab();
    await screen.findByRole("table");
    await screen.findByText("8 rows · 6 unassigned");
    expect(screen.queryByRole("button", { name: "Add variety" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New season" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("From row")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Row 1:/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Row 1: Red Bell")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rows for Red Bell" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rows for Yellow Sun" })).toBeDisabled();
  });

  it("asks for a growing season first when there is none", async () => {
    seasons = [];
    varieties = [];
    renderTab();
    expect(await screen.findByText(/Create a growing season to record plants planted/)).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByText(/Rows in/)).not.toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.some((c) => String(c[0]).startsWith("/api/varieties/rows"))).toBe(false);
  });
});
