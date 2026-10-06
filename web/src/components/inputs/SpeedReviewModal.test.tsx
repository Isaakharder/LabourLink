// @vitest-environment jsdom
//
// Bulk speed review popup (Inputs "Review speeds" / "Review all employees").
// Server-side grouping and saving are covered by
// server/src/routes/rowCompletions.bulkReview.test.ts; this covers the
// popup's own behavior: cards organized by employee, selection and bulk
// action with per-card overrides, nothing saved before Apply, one
// submission per click, per-group results, and the read-only Manager view.
// Same api-mocking convention as RowCompletionReviewModal.test.tsx.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeedReviewModal } from "./SpeedReviewModal";
import { api } from "../../lib/api";
import { SpeedReviewGroup } from "../../lib/speedReviewTypes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let groupsResponse: { date: string; groups: SpeedReviewGroup[] };
let applyDeferred: Deferred<{ results: any[] }>;

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
      if (path.startsWith("/api/row-completions/review-groups")) return Promise.resolve(groupsResponse);
      if (path === "/api/row-completions/bulk-review") return applyDeferred.promise;
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

const DATE = "2026-10-05";

function visit(id: string, employeeId: string, employeeName: string, overrides: Record<string, unknown> = {}) {
  return {
    visitId: id,
    segmentIds: [id],
    employeeId,
    employeeName,
    date: DATE,
    startedAt: "2026-10-05T17:18:00.000Z",
    endedAt: "2026-10-05T17:37:00.000Z",
    durationSeconds: 19 * 60,
    isOpen: false,
    carriers: ["Bin 70"],
    quantityPerRow: 500,
    ...overrides,
  };
}

function group(overrides: Partial<SpeedReviewGroup> & Pick<SpeedReviewGroup, "id" | "employeeId" | "employeeName" | "rowLabel">): SpeedReviewGroup {
  return {
    date: DATE,
    activityId: "act-picking",
    activityName: "Picking Peppers",
    greenhouseRowId: `row-${overrides.id}`,
    densityType: "stems",
    unit: "stems/hour",
    reasons: ["Phase 1 · Row 174 also has another visit less than 7 days apart: Larry Banguigui (Sep 29)."],
    visits: [visit(`seg-${overrides.id}`, overrides.employeeId, overrides.employeeName)],
    contextVisits: [visit("seg-larry", "emp-larry", "Larry Banguigui", { date: "2026-09-29" })],
    actions: {
      merge: { available: false, unavailableReason: "Only one visit by this employee on this date — the other visits are by different employees or on different dates and are never merged.", preview: null },
      separate: { available: true, unavailableReason: null, previews: [{ visitId: `seg-${overrides.id}`, quantity: 500, durationSeconds: 19 * 60, speedPerHour: 1578.9473684210527 }] },
    },
    suggestedAction: "separate",
    ...overrides,
  };
}

const merge570 = group({
  id: "k570",
  employeeId: "emp-khen",
  employeeName: "Khen Lagto",
  rowLabel: "Phase 2 · Row 570",
  reasons: ["Khen Lagto worked Phase 2 · Row 570 2 separate times on Oct 5."],
  visits: [
    { ...visit("seg-570a", "emp-khen", "Khen Lagto"), segmentIds: ["seg-570a", "seg-570b"], durationSeconds: 163 * 60 },
    visit("seg-570c", "emp-khen", "Khen Lagto", { durationSeconds: 35 * 60 }),
  ],
  contextVisits: [],
  actions: {
    merge: { available: true, unavailableReason: null, preview: { quantity: 500, durationSeconds: 198 * 60, speedPerHour: 151.51515151515153 } },
    separate: {
      available: true,
      unavailableReason: null,
      previews: [
        { visitId: "seg-570a", quantity: 500, durationSeconds: 163 * 60, speedPerHour: 184.0490797546012 },
        { visitId: "seg-570c", quantity: 500, durationSeconds: 35 * 60, speedPerHour: 857.1428571428571 },
      ],
    },
  },
  suggestedAction: "merge",
});
const sep174 = group({ id: "k174", employeeId: "emp-khen", employeeName: "Khen Lagto", rowLabel: "Phase 1 · Row 174" });
const other174 = group({ id: "o174", employeeId: "emp-other", employeeName: "Ana Other", rowLabel: "Phase 1 · Row 174" });
const open92 = group({
  id: "j92",
  employeeId: "emp-jeff",
  employeeName: "Jeffrey Santiago",
  rowLabel: "Phase 1 · Row 92",
  visits: [visit("seg-92", "emp-jeff", "Jeffrey Santiago", { endedAt: null, isOpen: true })],
  actions: {
    merge: { available: false, unavailableReason: "A visit is still in progress — it can be reviewed once it ends.", preview: null },
    separate: { available: false, unavailableReason: "A visit is still in progress — it can be reviewed once it ends.", previews: null },
  },
  suggestedAction: null,
});

beforeEach(() => {
  groupsResponse = { date: DATE, groups: [merge570, sep174, open92, other174] };
  applyDeferred = createDeferred();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(props: Partial<Parameters<typeof SpeedReviewModal>[0]> = {}) {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(<SpeedReviewModal date={DATE} employeeId={null} canApply onClose={onClose} onApplied={onApplied} {...props} />);
  return { onClose, onApplied };
}

const card = (name: string) => screen.getByRole("article", { name });
const applyButton = () => screen.getByRole("button", { name: /Apply changes|Applying/ });
const postCalls = () => vi.mocked(api).mock.calls.filter(([path]) => path === "/api/row-completions/bulk-review");

describe("SpeedReviewModal", () => {
  it("lists every group as a card organized by employee, with reason, bin, work time and the suggested result", async () => {
    renderModal();
    expect(await screen.findByRole("region", { name: "Khen Lagto" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Jeffrey Santiago" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Ana Other" })).toBeInTheDocument();
    const k570 = card("Khen Lagto · Phase 2 · Row 570");
    expect(within(k570).getByText(/worked Phase 2 · Row 570 2 separate times/)).toBeInTheDocument();
    expect(within(k570).getByText(/2 visits/)).toBeInTheDocument();
    expect(within(k570).getByText("Result: 500 stems ÷ 3:18:00 work = 151.5 stems/hour")).toBeInTheDocument();
    expect(within(card("Khen Lagto · Phase 1 · Row 174")).getByText(/Bin 70/)).toBeInTheDocument();
  });

  it("asks for one employee's groups when scoped to an employee", async () => {
    renderModal({ employeeId: "emp-khen", employeeName: "Khen Lagto" });
    await screen.findByRole("article", { name: "Khen Lagto · Phase 2 · Row 570" });
    expect(vi.mocked(api).mock.calls[0][0]).toBe(`/api/row-completions/review-groups?date=${DATE}&employeeId=emp-khen`);
  });

  it("keeps an unresolvable group pending: not selectable, with the reason", async () => {
    renderModal();
    const j92 = await screen.findByRole("article", { name: "Jeffrey Santiago · Phase 1 · Row 92" });
    expect(within(j92).getByRole("checkbox")).toBeDisabled();
    expect(within(j92).getByText(/Can't be resolved here yet: A visit is still in progress/)).toBeInTheDocument();
  });

  it("select all eligible / deselect all, and the footer summary follows", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole("button", { name: "Select all eligible (3)" }));
    expect(screen.getByText(/3 selected · 3 to apply · 2 employees affected · 1 will stay pending/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(screen.getByText(/0 selected · 0 to apply/)).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });

  it("a bulk action applies to selected cards that support it, and a card can be overridden afterwards", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole("button", { name: "Select all eligible (3)" }));

    await user.selectOptions(screen.getByRole("combobox"), "merge");
    await user.click(screen.getByRole("button", { name: "Set action" }));
    expect(screen.getByText(/2 selected groups don't support "Merge for speed"/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox"), "separate");
    await user.click(screen.getByRole("button", { name: "Set action" }));
    const k570 = card("Khen Lagto · Phase 2 · Row 570");
    expect(within(k570).getByRole("radio", { name: /Keep separate/ })).toBeChecked();

    // Exception: put row 570 back to merge, skip the other employee's card.
    await user.click(within(k570).getByRole("radio", { name: /Merge for speed/ }));
    await user.click(within(card("Ana Other · Phase 1 · Row 174")).getByRole("radio", { name: /Skip/ }));
    expect(screen.getByText(/3 selected · 2 to apply · 1 employee affected · 2 will stay pending/)).toBeInTheDocument();

    expect(postCalls()).toHaveLength(0); // nothing saved before Apply
    await user.click(applyButton());
    expect(postCalls()).toHaveLength(1);
    const body = JSON.parse((postCalls()[0][1] as { body: string }).body);
    expect(body).toEqual({
      date: DATE,
      groups: [
        { groupId: "k570", action: "merge", visits: [["seg-570a", "seg-570b"], ["seg-570c"]] },
        { groupId: "k174", action: "separate", visits: [["seg-k174"]] },
      ],
    });
  });

  it("submits once even on repeated clicks, then shows which groups saved and which stay pending", async () => {
    const user = userEvent.setup();
    const { onApplied } = renderModal();
    await user.click(await screen.findByRole("button", { name: "Select all eligible (3)" }));
    await user.click(applyButton());
    await user.click(applyButton());
    expect(applyButton()).toHaveTextContent("Applying…");
    expect(applyButton()).toBeDisabled();
    expect(postCalls()).toHaveLength(1);

    await act(async () => {
      applyDeferred.resolve({
        results: [
          { groupId: "k570", ok: true, completionIds: ["c1"] },
          { groupId: "k174", ok: true, completionIds: ["c2"] },
          { groupId: "o174", ok: false, error: "One or more entries already belong to a completed row" },
        ],
      });
    });
    await waitFor(() => expect(screen.getByText(/2 saved · 1 not saved \(still pending\)/)).toBeInTheDocument());
    expect(within(card("Khen Lagto · Phase 2 · Row 570")).getByText("Saved")).toBeInTheDocument();
    const failed = card("Ana Other · Phase 1 · Row 174");
    expect(within(failed).getByText("Not saved")).toBeInTheDocument();
    expect(within(failed).getByText("One or more entries already belong to a completed row")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
    // The footer's own Close (the modal's × is also labelled "Close").
    expect(screen.getByText("Close", { selector: "button" })).toBeInTheDocument();
  });

  it("is read-only for a Manager: nothing selectable, Apply disabled, with the reason", async () => {
    renderModal({ canApply: false });
    const k570 = await screen.findByRole("article", { name: "Khen Lagto · Phase 2 · Row 570" });
    expect(within(k570).getByRole("checkbox")).toBeDisabled();
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText(/Only administrators can apply changes/)).toBeInTheDocument();
  });

  it("shows details on demand: the grouped visits and the other visits in the cycle as unchanged context", async () => {
    const user = userEvent.setup();
    renderModal();
    const k174 = await screen.findByRole("article", { name: "Khen Lagto · Phase 1 · Row 174" });
    expect(within(k174).queryByText(/shown for context, not changed/)).not.toBeInTheDocument();
    await user.click(within(k174).getByRole("button", { name: "Details" }));
    expect(within(k174).getByText(/shown for context, not changed/)).toBeInTheDocument();
    expect(within(k174).getByText("Larry Banguigui")).toBeInTheDocument();
    expect(within(k174).getByText(/Merge for speed: Only one visit by this employee/)).toBeInTheDocument();
  });

  it("says so when nothing needs review", async () => {
    groupsResponse = { date: DATE, groups: [] };
    renderModal();
    expect(await screen.findByText("Nothing needs speed review on this date.")).toBeInTheDocument();
  });
});
