// @vitest-environment jsdom
//
// Inputs page wiring for the bulk speed review: "Review speeds" (selected
// employee) and "Review all employees" buttons, their pending-review count
// badges for the selected date, which scope each one opens, and role
// visibility (Administrator/Manager see them; a Supervisor, who can't load
// review data, doesn't). The popup itself is covered by
// SpeedReviewModal.test.tsx; grouping/saving by the server's
// rowCompletions.bulkReview.test.ts.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { api } from "../../lib/api";
import { DailyInputsResponse } from "../../lib/inputsTypes";

const DATE = "2026-10-05";
let role = "Administrator";
// Set once a bulk review has been applied: Khen's groups are then resolved.
let applied = false;

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-admin", firstName: "Ada", lastName: "Admin", securityRole: role } }),
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
    api: vi.fn((path: string, options?: RequestInit) => {
      if (path.startsWith("/api/inputs/employees")) {
        return Promise.resolve({
          employees: [
            { id: "emp-khen", firstName: "Khen", lastName: "Lagto", photoUrl: null, paidSeconds: 27900 },
            { id: "emp-larry", firstName: "Larry", lastName: "Banguigui", photoUrl: null, paidSeconds: 26760 },
          ],
        });
      }
      if (path.startsWith("/api/inputs/daily")) {
        const employeeId = new URL(path, "http://t").searchParams.get("employeeId")!;
        return Promise.resolve(daily(employeeId));
      }
      if (path.startsWith("/api/row-completions/review-groups")) {
        const scoped = new URL(path, "http://t").searchParams.get("employeeId");
        const groups = [
          reviewGroup("g1", "emp-khen", "Khen Lagto"),
          reviewGroup("g2", "emp-khen", "Khen Lagto"),
          reviewGroup("g3", "emp-khen", "Khen Lagto"),
          reviewGroup("g4", "emp-jeff", "Jeffrey Santiago"),
        ]
          .filter((g) => !scoped || g.employeeId === scoped)
          .filter((g) => !(applied && g.employeeId === "emp-khen"));
        return Promise.resolve({ date: DATE, groups });
      }
      if (path === "/api/row-completions/bulk-review" && options?.method === "POST") {
        applied = true;
        const sent = JSON.parse(options.body as string).groups as { groupId: string }[];
        return Promise.resolve({ results: sent.map((g) => ({ groupId: g.groupId, ok: true, completionIds: ["c"] })) });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function reviewGroup(id: string, employeeId: string, employeeName: string) {
  const v = {
    visitId: `seg-${id}`,
    segmentIds: [`seg-${id}`],
    employeeId,
    employeeName,
    date: DATE,
    startedAt: `${DATE}T17:18:00.000Z`,
    endedAt: `${DATE}T17:37:00.000Z`,
    durationSeconds: 1140,
    isOpen: false,
    carriers: ["Bin 70"],
    quantityPerRow: 500,
  };
  return {
    id,
    employeeId,
    employeeName,
    date: DATE,
    activityId: "act",
    activityName: "Picking Peppers",
    greenhouseRowId: `row-${id}`,
    rowLabel: `Phase 1 · Row ${id}`,
    densityType: "stems",
    unit: "stems/hour",
    spansDates: [DATE],
    reasons: ["Also visited by someone else less than 7 days apart."],
    visits: [v],
    contextVisits: [],
    actions: {
      merge:
        id === "g2"
          ? { available: true, unavailableReason: null, preview: { quantity: 500, durationSeconds: 2280, speedPerHour: 789.5 } }
          : { available: false, unavailableReason: "Only one visit — nothing to merge.", preview: null },
      separate: { available: true, unavailableReason: null, previews: [{ visitId: v.visitId, quantity: 500, durationSeconds: 1140, speedPerHour: 1578.9 }] },
    },
    suggestedAction: "separate",
  };
}

function daily(employeeId: string): DailyInputsResponse {
  return {
    employee: { id: employeeId, firstName: employeeId === "emp-khen" ? "Khen" : "Larry", lastName: "X", photoUrl: null },
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

function renderPage(employee = "emp-khen") {
  return render(
    <MemoryRouter initialEntries={[`/inputs?date=${DATE}&employee=${employee}`]}>
      <InputsPage />
    </MemoryRouter>
  );
}

const reviewCalls = () => vi.mocked(api).mock.calls.map(([p]) => p as string).filter((p) => p.startsWith("/api/row-completions/review-groups"));

beforeEach(() => {
  role = "Administrator";
  applied = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InputsPage bulk speed review buttons", () => {
  it("shows the selected employee's and the whole date's pending review counts", async () => {
    renderPage("emp-khen");
    const reviewSpeeds = await screen.findByRole("button", { name: /Review speeds/ });
    expect(await within(reviewSpeeds).findByLabelText("3 pending speed reviews for this employee")).toBeInTheDocument();
    const reviewAll = screen.getByRole("button", { name: /Review all employees/ });
    expect(within(reviewAll).getByLabelText("4 pending speed reviews for all employees")).toBeInTheDocument();
    expect(reviewCalls().every((p) => p === `/api/row-completions/review-groups?date=${DATE}`)).toBe(true);
  });

  it("shows 0 for an employee with nothing pending", async () => {
    renderPage("emp-larry");
    const reviewSpeeds = await screen.findByRole("button", { name: /Review speeds/ });
    expect(await within(reviewSpeeds).findByLabelText("0 pending speed reviews for this employee")).toBeInTheDocument();
  });

  it("Review speeds opens the popup for the selected employee; Review all employees for everyone on the date", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen");
    await user.click(await screen.findByRole("button", { name: /Review speeds/ }));
    expect(await screen.findByRole("dialog", { name: /Review speeds — Khen/ })).toBeInTheDocument();
    expect(reviewCalls()).toContain(`/api/row-completions/review-groups?date=${DATE}&employeeId=emp-khen`);
    await user.click(screen.getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: /Review all employees/ }));
    expect(await screen.findByRole("dialog", { name: "Review speeds — all employees" })).toBeInTheDocument();
  });

  it("one submission with mixed actions refreshes speeds and both review badges", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen");
    const reviewSpeeds = await screen.findByRole("button", { name: /Review speeds/ });
    await within(reviewSpeeds).findByLabelText("3 pending speed reviews for this employee");
    const dailyCallsBefore = vi.mocked(api).mock.calls.filter(([p]) => (p as string).startsWith("/api/inputs/daily")).length;

    await user.click(reviewSpeeds);
    const dialog = await screen.findByRole("dialog", { name: /Review speeds — Khen/ });
    await user.click(await within(dialog).findByRole("button", { name: "Select all eligible (3)" }));
    await user.selectOptions(within(dialog).getByRole("combobox"), "separate");
    await user.click(within(dialog).getByRole("button", { name: "Set action" }));
    await user.click(within(within(dialog).getByRole("article", { name: "Khen Lagto · Phase 1 · Row g2" })).getByRole("radio", { name: /Merge for speed/ }));
    expect(within(dialog).getByText("1 group to merge · 2 groups to keep separate · 0 pending · 1 employee affected")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Apply changes" }));
    const posts = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/row-completions/bulk-review");
    expect(posts).toHaveLength(1);
    expect(JSON.parse((posts[0][1] as RequestInit).body as string).groups.map((g: { action: string }) => g.action)).toEqual([
      "separate",
      "merge",
      "separate",
    ]);

    // Speeds reload (GET /daily) and both badges refresh from the server.
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.filter(([p]) => (p as string).startsWith("/api/inputs/daily")).length).toBeGreaterThan(dailyCallsBefore)
    );
    expect(await within(reviewSpeeds).findByLabelText("0 pending speed reviews for this employee")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Review all employees/ })).getByLabelText("1 pending speed reviews for all employees")).toBeInTheDocument();
  });

  it("a Manager sees the review buttons (read-only review)", async () => {
    role = "Manager";
    renderPage("emp-khen");
    expect(await screen.findByRole("button", { name: /Review speeds/ })).toBeInTheDocument();
  });

  it("a Supervisor doesn't see them and never requests review data", async () => {
    role = "Supervisor";
    renderPage("emp-khen");
    await screen.findByText("Activity details");
    expect(screen.queryByRole("button", { name: /Review speeds/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review all employees/ })).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(0);
  });
});
