// @vitest-environment jsdom
//
// The Inputs sidebar's review indicator: a faint orange row plus a count for
// every employee with items in the speed review for the selected date. It is
// built only from the same GET /api/row-completions/review-groups response
// that already drives "Review all employees" (all groups) and "Review speeds"
// (the selected employee's groups) — one group belongs to exactly one
// employee, so a row's count is that employee's groups and the rows add up
// to the global count. No extra request, no browser-side review rules.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { api } from "../../lib/api";
import { ActivityRunDto, DailyInputsResponse } from "../../lib/inputsTypes";
import { renderInputsOn } from "../../lib/testUtils/inputsToday";

const DATE = "2026-10-05";
const NEXT_DATE = "2026-10-06";
const LONG_NAME = "Maximiliano-Bartholomew Featherstonehaugh-Worthington";

let role = "Administrator";

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-admin", firstName: "Ada", lastName: "Admin", securityRole: role } }),
}));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const pickers = { id: "g-pick", name: "Pickers" };
const beans = { id: "g-bean", name: "Bean Crew" };
const ROSTER = [
  { id: "emp-khen", firstName: "Khen", lastName: "Lagto", employeeGroup: pickers, paidSeconds: 27900 },
  { id: "emp-larry", firstName: "Larry", lastName: "Banguigui", employeeGroup: pickers, paidSeconds: 26760 },
  { id: "emp-mia", firstName: "Mia", lastName: "Santos", employeeGroup: beans, paidSeconds: 18000 },
  { id: "emp-long", firstName: LONG_NAME.split(" ")[0], lastName: LONG_NAME.split(" ")[1], employeeGroup: null, paidSeconds: 30600 },
  { id: "emp-zed", firstName: "Zed", lastName: "Quinn", employeeGroup: null, paidSeconds: 3600 },
];
const fullName = (id: string) => {
  const e = ROSTER.find((r) => r.id === id)!;
  return `${e.firstName} ${e.lastName}`;
};

// What the server's grouping returns per date (each group owned by one
// employee — see server/src/lib/speedReviewGroups.ts).
let groupsByDate: Record<string, ReturnType<typeof reviewGroup>[]> = {};
// Holds a date's review-groups response until released (stale-loading tests).
let holdReview: Record<string, Deferred> = {};
let runs: ActivityRunDto[] = [];

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
    api: vi.fn(async (path: string, options?: RequestInit) => {
      const url = new URL(path, "http://t");
      if (url.pathname === "/api/inputs/employees") {
        const search = (url.searchParams.get("search") ?? "").toLowerCase();
        return {
          employees: ROSTER.filter((e) => `${e.firstName} ${e.lastName}`.toLowerCase().includes(search)).map((e) => ({ ...e, photoUrl: null })),
        };
      }
      if (url.pathname === "/api/inputs/daily") {
        return daily(url.searchParams.get("employeeId")!, url.searchParams.get("date")!);
      }
      if (url.pathname === "/api/row-completions/review-groups") {
        const date = url.searchParams.get("date")!;
        const scoped = url.searchParams.get("employeeId");
        const hold = holdReview[date];
        if (hold) await hold.promise;
        const groups = (groupsByDate[date] ?? []).filter((g) => !scoped || g.employeeId === scoped);
        return { date, groups, windowDays: 7 };
      }
      if (url.pathname === "/api/row-completions/bulk-review" && options?.method === "POST") {
        const sent = (JSON.parse(options.body as string).groups as { groupId: string }[]).map((g) => g.groupId);
        groupsByDate[DATE] = (groupsByDate[DATE] ?? []).filter((g) => !sent.includes(g.id));
        return { results: sent.map((groupId) => ({ groupId, ok: true, completionIds: ["c"] })) };
      }
      if (url.pathname === "/api/inputs/activity-runs/bulk-delete" && options?.method === "POST") {
        const gone = new Set((JSON.parse(options.body as string).runs as string[][]).flat());
        runs = runs.filter((r) => !gone.has(r.id));
        // The deleted visit was what made Khen's row ambiguous: the server's
        // grouping no longer returns his group.
        groupsByDate[DATE] = (groupsByDate[DATE] ?? []).filter((g) => g.employeeId !== "emp-khen");
        return { ok: true, deleted: gone.size };
      }
      return {};
    }),
  };
});

function reviewGroup(id: string, employeeId: string, contextEmployeeIds: string[] = []) {
  const visit = (vid: string, empId: string) => ({
    visitId: vid,
    segmentIds: [vid],
    employeeId: empId,
    employeeName: fullName(empId),
    date: DATE,
    startedAt: `${DATE}T17:18:00.000Z`,
    endedAt: `${DATE}T17:37:00.000Z`,
    durationSeconds: 1140,
    isOpen: false,
    carriers: ["Bin 70"],
    quantityPerRow: 500,
  });
  const v = visit(`seg-${id}`, employeeId);
  return {
    id,
    employeeId,
    employeeName: fullName(employeeId),
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
    contextVisits: contextEmployeeIds.map((empId, i) => visit(`ctx-${id}-${i}`, empId)),
    actions: {
      merge: { available: false, unavailableReason: "Only one visit — nothing to merge.", preview: null },
      separate: { available: true, unavailableReason: null, previews: [{ visitId: v.visitId, quantity: 500, durationSeconds: 1140, speedPerHour: 1578.9 }] },
    },
    suggestedAction: "separate",
  };
}

function run(id: string, activityName: string): ActivityRunDto {
  return {
    id,
    activityId: `act-${id}`,
    activityName,
    normalSpeedPerHour: null,
    activityDensitySource: null,
    densityType: null,
    calculatedSpeedPerHour: null,
    isUnresolvedRowCompletion: false,
    rowCompletion: null,
    segmentIds: [id],
    durationSeconds: 1800,
    startedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtOriginalTime: null,
    endedAtCorrectedFrom: null,
    startedAt: `${DATE}T13:00:00.000Z`,
    currentSegmentStartedAt: `${DATE}T13:00:00.000Z`,
    endedAt: `${DATE}T13:30:00.000Z`,
    isOpen: false,
    canEdit: true,
    row: null,
    carrier: null,
    autoClosed: false,
    manualEntry: null,
  } as ActivityRunDto;
}

function daily(employeeId: string, date: string): DailyInputsResponse {
  return {
    employee: { id: employeeId, firstName: "X", lastName: "Y", photoUrl: null },
    date,
    workStartTime: null,
    workEndTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: employeeId === "emp-khen" ? runs : [],
    breaks: [],
    totals: { workedSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 },
    canEdit: true,
  } as unknown as DailyInputsResponse;
}

function renderPage(employee = "emp-larry") {
  return renderInputsOn(DATE, () =>
    render(
      <MemoryRouter initialEntries={[`/inputs?employee=${employee}`]}>
        <InputsPage />
      </MemoryRouter>
    )
  );
}

const row = (id: string) => screen.getByRole("button", { name: new RegExp(`^${fullName(id)}`) });
const badge = (id: string) => row(id).querySelector(".inputs-employee-review");
const marked = (id: string) => row(id).classList.contains("inputs-employee-item-needs-review");
const reviewCalls = () => vi.mocked(api).mock.calls.map(([p]) => p as string).filter((p) => p.startsWith("/api/row-completions/review-groups"));
// Waits for the sidebar and its counts to be on screen.
async function sidebarReady() {
  await screen.findByRole("button", { name: new RegExp(`^${fullName("emp-zed")}`) });
  await waitFor(() => expect(screen.getByRole("button", { name: /Review all employees/ }).querySelector(".inputs-review-count")).not.toBeNull());
}

beforeEach(() => {
  role = "Administrator";
  holdReview = {};
  runs = [run("r-bags", "Packing Bags")];
  groupsByDate = {
    [DATE]: [reviewGroup("g1", "emp-khen"), reviewGroup("g2", "emp-khen"), reviewGroup("g3", "emp-mia")],
    [NEXT_DATE]: [reviewGroup("n1", "emp-zed")],
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("which employees are marked", () => {
  it("marks employees with review items in every group, leaves the rest unchanged, and keeps the worked time", async () => {
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(marked("emp-khen")).toBe(true));

    // Pickers: Khen (2) marked, Larry not. Bean Crew: Mia (1). Ungrouped: none.
    expect(badge("emp-khen")).toHaveTextContent("2");
    expect(badge("emp-mia")).toHaveTextContent("1");
    expect(marked("emp-mia")).toBe(true);
    for (const id of ["emp-larry", "emp-zed", "emp-long"]) {
      expect(marked(id)).toBe(false);
      expect(badge(id)).toBeNull();
    }
    // Worked-time totals stay on every row.
    expect(within(row("emp-khen")).getByText("7:45")).toBeInTheDocument();
    expect(within(row("emp-larry")).getByText("7:26")).toBeInTheDocument();
    // Exactly one request for all of it — the one the global count already uses.
    expect(reviewCalls()).toEqual([`/api/row-completions/review-groups?date=${DATE}`]);
  });

  it("has a tooltip and accessible text with the right plural", async () => {
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());
    expect(badge("emp-khen")).toHaveAttribute("title", "2 items need review");
    expect(badge("emp-mia")).toHaveAttribute("title", "1 item needs review");
    expect(screen.getByRole("button", { name: /^Khen Lagto, 2 items need review/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Mia Santos, 1 item needs review/ })).toBeInTheDocument();
    expect(row("emp-larry")).not.toHaveAccessibleName(/review/);
  });

  it("the selected employee keeps the blue selected style and still shows the badge", async () => {
    renderPage("emp-khen");
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());
    expect(row("emp-khen")).toHaveClass("inputs-employee-item-selected");
    expect(row("emp-khen")).toHaveClass("inputs-employee-item-needs-review");
    expect(badge("emp-khen")).toHaveTextContent("2");
    // Same number as the selected employee's "Review speeds" badge.
    expect(within(screen.getByRole("button", { name: /Review speeds/ })).getByLabelText("2 pending speed reviews for this employee")).toBeInTheDocument();
  });

  it("a long name keeps both its badge and its worked time", async () => {
    groupsByDate[DATE].push(reviewGroup("g4", "emp-long"));
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-long")).not.toBeNull());
    const r = row("emp-long");
    expect(r.querySelector(".inputs-employee-name")).toHaveTextContent(LONG_NAME);
    expect(badge("emp-long")).toHaveTextContent("1");
    expect(within(r).getByText("8:30")).toBeInTheDocument();
    // Name, badge, hours — in that order, so the hours stay on the right.
    expect([...r.children].map((c) => c.className)).toEqual(["inputs-employee-name", "inputs-employee-review", "inputs-employee-hours"]);
  });

  it("a row cycle shared by two employees counts once on each of their rows, adding up to the global count", async () => {
    // One ambiguous row cycle worked by Khen and Mia: the server returns one
    // group per employee, each showing the other's visit as read-only context.
    groupsByDate[DATE] = [reviewGroup("shared-khen", "emp-khen", ["emp-mia"]), reviewGroup("shared-mia", "emp-mia", ["emp-khen"])];
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).toHaveTextContent("1"));
    expect(badge("emp-mia")).toHaveTextContent("1");
    expect(within(screen.getByRole("button", { name: /Review all employees/ })).getByLabelText("2 pending speed reviews for all employees")).toBeInTheDocument();
  });
});

describe("permissions", () => {
  it("a Manager (can view the review) sees the indicators", async () => {
    role = "Manager";
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).toHaveTextContent("2"));
  });

  it("a Supervisor (no access to the review) sees no indicators and never requests review data", async () => {
    role = "Supervisor";
    renderPage();
    await screen.findByRole("button", { name: new RegExp(`^${fullName("emp-zed")}`) });
    await screen.findByText("Activity details");
    expect(document.querySelectorAll(".inputs-employee-item-needs-review, .inputs-employee-review")).toHaveLength(0);
    expect(reviewCalls()).toHaveLength(0);
  });
});

describe("keeping the indicators current", () => {
  it("a date change never shows the previous date's indicators, and a late answer for the old date is ignored", async () => {
    const user = userEvent.setup();
    holdReview[DATE] = deferred();
    renderPage();
    await screen.findByRole("button", { name: new RegExp(`^${fullName("emp-zed")}`) });

    // Move on before the first date's answer arrives, and hold the new one too.
    holdReview[NEXT_DATE] = deferred();
    await user.click(screen.getByRole("button", { name: "Next day" }));
    await act(async () => holdReview[DATE].resolve());
    await screen.findByRole("button", { name: new RegExp(`^${fullName("emp-zed")}`) });
    expect(document.querySelectorAll(".inputs-employee-review")).toHaveLength(0);

    await act(async () => holdReview[NEXT_DATE].resolve());
    await waitFor(() => expect(badge("emp-zed")).toHaveTextContent("1"));
    expect(badge("emp-khen")).toBeNull();
    expect(badge("emp-mia")).toBeNull();
  });

  it("going back to a date shows that date's indicators again, without a flash of the other date's", async () => {
    const user = userEvent.setup();
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());
    holdReview[NEXT_DATE] = deferred();
    await user.click(screen.getByRole("button", { name: "Next day" }));
    expect(badge("emp-khen")).toBeNull();
    await act(async () => holdReview[NEXT_DATE].resolve());
    await waitFor(() => expect(badge("emp-zed")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    expect(badge("emp-zed")).toBeNull();
    await waitFor(() => expect(badge("emp-khen")).toHaveTextContent("2"));
  });

  it("search only changes which rows are listed; the visible ones keep their indicators", async () => {
    const user = userEvent.setup();
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());
    await user.type(screen.getByPlaceholderText("Search employees"), "kh");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Mia Santos/ })).toBeNull());
    await waitFor(() => expect(badge("emp-khen")).toHaveTextContent("2"));
    await user.clear(screen.getByPlaceholderText("Search employees"));
    await waitFor(() => expect(badge("emp-mia")).toHaveTextContent("1"));
  });

  it("Review all employees clears the reviewed employees' indicators as soon as it is applied", async () => {
    const user = userEvent.setup();
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());

    await user.click(screen.getByRole("button", { name: /Review all employees/ }));
    const dialog = await screen.findByRole("dialog", { name: "Review speeds — all employees" });
    await user.click(await within(dialog).findByRole("button", { name: "Select all eligible (3)" }));
    await user.selectOptions(within(dialog).getByRole("combobox"), "separate");
    await user.click(within(dialog).getByRole("button", { name: "Set action" }));
    await user.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(document.querySelectorAll(".inputs-employee-review")).toHaveLength(0));
    expect(document.querySelectorAll(".inputs-employee-item-needs-review")).toHaveLength(0);
  });

  it("a delete that resolves an employee's ambiguity clears their indicator", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen");
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());
    const table = await waitFor(() => document.querySelector("table.inputs-logs-table") as HTMLElement);
    await user.click(within(within(table).getByText("Packing Bags").closest("tr") as HTMLElement).getByRole("checkbox"));
    await user.click(within(document.querySelector(".inputs-section-header-with-status") as HTMLElement).getByRole("button", { name: /^Delete/ }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete 1 entry" }));
    });
    await waitFor(() => expect(badge("emp-khen")).toBeNull());
    expect(badge("emp-mia")).toHaveTextContent("1");
  });

  it("the automatic 10-second refresh picks up review items that appear or disappear", async () => {
    // Capture the page's own poll callback rather than faking timers, which
    // would also stop waitFor's polling.
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());
    const poll = setIntervalSpy.mock.calls.find(([, ms]) => ms === 10_000)?.[0] as (() => void) | undefined;
    expect(poll).toBeDefined();

    groupsByDate[DATE] = [reviewGroup("g9", "emp-larry")];
    await act(async () => {
      poll!();
    });
    await waitFor(() => expect(badge("emp-larry")).toHaveTextContent("1"));
    expect(badge("emp-khen")).toBeNull();
    expect(badge("emp-mia")).toBeNull();
    setIntervalSpy.mockRestore();
  });

  it("returning to the window refreshes them too", async () => {
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-mia")).not.toBeNull());
    groupsByDate[DATE] = [];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(badge("emp-mia")).toBeNull());
  });

  it("navigating away and back reloads them from the server", async () => {
    const first = renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-khen")).not.toBeNull());
    first.unmount();

    groupsByDate[DATE] = [reviewGroup("g5", "emp-zed")];
    renderPage();
    await sidebarReady();
    await waitFor(() => expect(badge("emp-zed")).toHaveTextContent("1"));
    expect(badge("emp-khen")).toBeNull();
  });
});
