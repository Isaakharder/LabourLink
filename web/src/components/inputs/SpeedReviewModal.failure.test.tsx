// @vitest-environment jsdom
//
// Bulk speed review: what the popup does when Apply doesn't simply succeed
// (2026-10-10 incident — a deploy restarted the API mid-apply and the popup
// only said "Request failed"). The server is all-or-nothing and says whether
// it saved (`saved`); when its answer never arrives the popup reloads the
// review to find out. In every case the message says whether anything was
// saved, selections stay available, and onApplied (the page's refresh of
// speeds, badges and totals) runs only when something was saved.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeedReviewModal } from "./SpeedReviewModal";
import { api, ApiError } from "../../lib/api";
import { SpeedReviewGroup } from "../../lib/speedReviewTypes";

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    body?: unknown;
    constructor(status: number, message: string, _errors?: unknown, code?: string, body?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }
  return { ApiError, api: vi.fn() };
});

const DATE = "2026-10-07";

function group(id: string, employeeId: string, employeeName: string, action: "merge" | "separate"): SpeedReviewGroup {
  const v = (vid: string) => ({
    visitId: vid,
    segmentIds: [vid],
    employeeId,
    employeeName,
    date: DATE,
    startedAt: "2026-10-07T12:00:00.000Z",
    endedAt: "2026-10-07T13:00:00.000Z",
    durationSeconds: 3600,
    isOpen: false,
    carriers: ["Bin 70"],
    quantityPerRow: 636,
  });
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
    reasons: ["Needs review."],
    visits: action === "merge" ? [v(`${id}-a`), v(`${id}-b`)] : [v(`${id}-a`)],
    contextVisits: [],
    actions: {
      merge: { available: action === "merge", unavailableReason: action === "merge" ? null : "One visit", preview: action === "merge" ? { quantity: 636, durationSeconds: 7200, speedPerHour: 318 } : null },
      separate: { available: true, unavailableReason: null, previews: [{ visitId: `${id}-a`, quantity: 636, durationSeconds: 3600, speedPerHour: 636 }] },
    },
    suggestedAction: action,
  } as SpeedReviewGroup;
}

const mergeG = group("m1", "emp-a", "Ana A", "merge");
const sepG = group("s1", "emp-b", "Ben B", "separate");

// Review responses in order (the last one repeats); apply outcome per call.
let reviewResponses: SpeedReviewGroup[][];
let applyOutcomes: (() => Promise<unknown>)[];
const applyCalls = () => vi.mocked(api).mock.calls.filter(([p]) => p === "/api/row-completions/bulk-review");
const reviewCalls = () => vi.mocked(api).mock.calls.filter(([p]) => (p as string).startsWith("/api/row-completions/review-groups"));

beforeEach(() => {
  reviewResponses = [[mergeG, sepG]];
  applyOutcomes = [];
  vi.mocked(api).mockImplementation(((path: string) => {
    if (path.startsWith("/api/row-completions/review-groups")) {
      const groups = reviewResponses.length > 1 ? reviewResponses.shift()! : reviewResponses[0];
      return Promise.resolve({ date: DATE, groups, windowDays: 3 });
    }
    if (path === "/api/row-completions/bulk-review") return applyOutcomes.shift()!();
    return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
  }) as typeof api);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openAndSelectBoth(onApplied = vi.fn()) {
  const user = userEvent.setup();
  render(<SpeedReviewModal date={DATE} employeeId={null} canApply onClose={() => {}} onApplied={onApplied} />);
  await user.click(await screen.findByRole("button", { name: /Select all eligible/ }));
  return { user, onApplied };
}
const checkbox = (g: SpeedReviewGroup) => screen.getByRole("checkbox", { name: `Select ${g.rowLabel} for ${g.employeeName}` });
const card = (g: SpeedReviewGroup) => screen.getByRole("article", { name: `${g.employeeName} · ${g.rowLabel}` });

describe("SpeedReviewModal when Apply doesn't simply succeed", () => {
  it("proxy error page (the incident): reloads, says nothing was saved, keeps selections, and a retry is possible", async () => {
    // Railway's own 502 body has no `error` field — api() turns it into "Request failed".
    applyOutcomes.push(() => Promise.reject(new ApiError(502, "Request failed", undefined, undefined, { status: "error", code: 502 })));
    const { user, onApplied } = await openAndSelectBoth();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server didn't confirm the result (HTTP 502). Nothing was saved — all 2 selected groups are still pending. Your selections are kept; applying again is safe."
    );
    expect(screen.queryByText("Request failed")).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(2);
    expect(checkbox(mergeG)).toBeChecked();
    expect(checkbox(sepG)).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(applyCalls()[0][1]).toMatchObject({ method: "POST", timeoutMs: 120000 });

    applyOutcomes.push(() => Promise.resolve({ saved: true, results: [{ groupId: "m1", ok: true, completionIds: ["c1"] }, { groupId: "s1", ok: true, completionIds: ["c2"] }] }));
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(within(card(mergeG)).getByText("Saved")).toBeInTheDocument();
  });

  it("lost answer but the batch was saved: reload shows it, cards say Saved and the page refreshes", async () => {
    applyOutcomes.push(() => Promise.reject(new ApiError(502, "Request failed", undefined, undefined, { status: "error" })));
    reviewResponses = [[mergeG, sepG], []];
    const { user, onApplied } = await openAndSelectBoth();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));

    expect(await screen.findByText(/but the review shows all 2 selected groups were saved/)).toBeInTheDocument();
    expect(within(card(mergeG)).getByText("Saved")).toBeInTheDocument();
    expect(within(card(sepG)).getByText("Saved")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("timeout: says it took too long and whether anything was saved", async () => {
    applyOutcomes.push(() => Promise.reject(Object.assign(new TypeError("Request timed out after 120000ms"), { timeout: true })));
    const { user, onApplied } = await openAndSelectBoth();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/took too long to confirm the result\. Nothing was saved/);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("stale group: nothing saved, the stale card says why and is deselected, the other stays selected for another try", async () => {
    applyOutcomes.push(() =>
      Promise.reject(
        new ApiError(409, "1 of 2 selected groups changed after the review was opened, so nothing was saved.", undefined, "BULK_REVIEW_STALE", {
          code: "BULK_REVIEW_STALE",
          saved: false,
          results: [
            { groupId: "m1", ok: false, status: "ready" },
            { groupId: "s1", ok: false, status: "stale", error: "This group no longer needs review — it was resolved or changed after the review was opened." },
          ],
        })
      )
    );
    const { user, onApplied } = await openAndSelectBoth();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));

    expect(await screen.findByText("1 of 2 selected groups changed after the review was opened, so nothing was saved.")).toBeInTheDocument();
    expect(within(card(sepG)).getByText(/no longer needs review/)).toBeInTheDocument();
    expect(within(card(sepG)).getByText("Not saved")).toBeInTheDocument();
    expect(checkbox(sepG)).not.toBeChecked();
    expect(checkbox(mergeG)).toBeChecked();
    expect(within(card(mergeG)).queryByText("Not saved")).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(1);
    expect(onApplied).not.toHaveBeenCalled();

    applyOutcomes.push(() => Promise.resolve({ saved: true, results: [{ groupId: "m1", ok: true, completionIds: ["c1"] }] }));
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    const second = JSON.parse(applyCalls()[1][1]!.body as string);
    expect(second.groups.map((g: { groupId: string }) => g.groupId)).toEqual(["m1"]);
  });

  it("server-side failure with nothing saved: shows the reason on the group and keeps every selection", async () => {
    applyOutcomes.push(() =>
      Promise.reject(
        new ApiError(500, "Unexpected error while saving — nothing was saved and all selected groups are still pending. Retrying is safe.", undefined, "BULK_REVIEW_FAILED", {
          code: "BULK_REVIEW_FAILED",
          saved: false,
          results: [
            { groupId: "m1", ok: false, status: "ready" },
            { groupId: "s1", ok: false, status: "ready", error: "Unexpected error saving this group." },
          ],
        })
      )
    );
    const { user, onApplied } = await openAndSelectBoth();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByText(/nothing was saved and all selected groups are still pending/)).toBeInTheDocument();
    expect(within(card(sepG)).getByText("Unexpected error saving this group.")).toBeInTheDocument();
    expect(checkbox(mergeG)).toBeChecked();
    expect(checkbox(sepG)).toBeChecked();
    expect(reviewCalls()).toHaveLength(1);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("success after an earlier partial save: already-saved groups say so and the page refreshes", async () => {
    applyOutcomes.push(() =>
      Promise.resolve({ saved: true, results: [{ groupId: "m1", ok: true, alreadySaved: true }, { groupId: "s1", ok: true, completionIds: ["c2"] }] })
    );
    const { user, onApplied } = await openAndSelectBoth();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(within(card(mergeG)).getByText("Already saved")).toBeInTheDocument();
    expect(within(card(sepG)).getByText("Saved")).toBeInTheDocument();
  });
});
