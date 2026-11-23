// @vitest-environment jsdom
//
// Scale Weighings page: today by default, day navigation and filters sent to
// the server, the day's totals, status badges (duplicate / trial), the
// detail dialog with its history, and voiding a credit — Administrators
// only, reason required. lib/api.ts and the auth context are mocked.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScaleWeighingsPage } from "./ScaleWeighingsPage";
import { api } from "../../lib/api";
import { ScaleWeighingDay, ScaleWeighingDetail } from "../../lib/scaleWeighingTypes";
import { todayInAppTimezone, addCalendarDays } from "../../lib/timezone";

let role = "Administrator";
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "u-1", firstName: "Ada", lastName: "Admin", securityRole: role, teamRole: "Team Member" } }),
}));

const day: ScaleWeighingDay = {
  date: todayInAppTimezone(),
  totals: { netKg: 38.1, binsWeighed: 2, creditedNetKg: 18.1, credited: 1, pending: 1, needsReview: 0, neverCredited: 0, duplicates: 1, voided: 0, trial: 0 },
  weighings: [
    {
      id: "w-1",
      weighedAt: "2026-10-31T10:00:00Z",
      bin: { id: "b-77", name: "Bin 77" },
      rfidTag: "0000000182225750",
      grossKg: 172.5,
      tareKg: 154.4,
      netKg: 18.1,
      employee: { id: "e-1", name: "Ruben Ortiz" },
      status: "credited",
      creditsLive: true,
      isDuplicate: false,
      countsForProduction: true,
      matchReason: "One employee chose this bin on their phone during this bin use",
      pendingUntil: null,
      stationName: "Weigh station 1",
      flagCount: 0,
      rows: {
        status: "known",
        rows: [
          { id: "r-12", phaseName: "Phase 1", rowNumber: 12, label: "Phase 1 · Row 12" },
          { id: "r-13", phaseName: "Phase 1", rowNumber: 13, label: "Phase 1 · Row 13" },
          { id: "r-571", phaseName: "Phase 2", rowNumber: 571, label: "Phase 2 · Row 571" },
        ],
      },
    },
    {
      id: "w-2",
      weighedAt: "2026-10-31T10:02:00Z",
      bin: { id: "b-77", name: "Bin 77" },
      rfidTag: "0000000182225750",
      grossKg: 172.5,
      tareKg: 154.4,
      netKg: 18.1,
      employee: null,
      status: "needs_review",
      creditsLive: true,
      isDuplicate: true,
      countsForProduction: false,
      matchReason: "The same bin was weighed less than five minutes earlier. Not counted.",
      pendingUntil: null,
      stationName: "Weigh station 1",
      flagCount: 0,
      rows: { status: "unknown", reason: "A repeat weighing of the same bin within five minutes; the rows are on the first weighing." },
    },
  ],
  statusCounts: { all: 2, credited: 1, pending: 0, needs_review: 1, expired: 0, voided: 0, not_credited: 1 },
  filters: { bins: [{ id: "b-77", name: "Bin 77" }], employees: [{ id: "e-1", name: "Ruben Ortiz" }] },
};

function detail(over: Partial<ScaleWeighingDetail> = {}): ScaleWeighingDetail {
  const { flagCount: _f, ...row } = day.weighings[0];
  return {
    ...row,
    stationWeighingId: "s-1",
    receivedAt: "2026-10-31T10:00:05Z",
    samplesKg: [172.5, 172.5],
    countsAsCredit: true,
    resolvedAt: "2026-10-31T10:00:05Z",
    history: [
      { kind: "received", fromStatus: null, toStatus: "pending", reason: null, at: "2026-10-31T10:00:05Z", employeeName: null, actorName: null },
      { kind: "status", fromStatus: "pending", toStatus: "credited", reason: "One employee chose this bin", at: "2026-10-31T10:00:05Z", employeeName: "Ruben Ortiz", actorName: null },
    ],
    claims: [{ employeeName: "Ruben Ortiz", occurredAt: "2026-10-31T09:30:00Z", receivedAt: "2026-10-31T09:31:00Z", eventType: "activity_switch", deviceName: "Ruben's phone" }],
    flags: [],
    corrections: [],
    ...over,
  };
}

let voidCalls: { path: string; body: Record<string, unknown> }[] = [];
let resolveCalls: { path: string; body: Record<string, unknown> }[] = [];
let nextDetail: ScaleWeighingDetail | null = null;
let reviewCalls: { path: string; body: Record<string, unknown> }[] = [];

// Bin 56: Patrick's cycle superseded by Ruben's; the weighing credited Ruben.
const reused = (moved: boolean): ScaleWeighingDetail =>
  detail({
    employee: moved ? { id: "e-3", name: "Patrick Jones" } : { id: "e-1", name: "Ruben Ortiz" },
    claims: [],
    pickingCycle: {
      id: moved ? "c-p" : "c-r",
      status: "closed",
      employeeName: moved ? "Patrick Jones" : "Ruben Ortiz",
      openedAt: "2026-11-19T13:08:00Z",
      lastScanAt: "2026-11-19T13:47:00Z",
      reviewReason: null,
      closeReason: null,
      scans: [{ employeeId: "e-1", employeeName: "Ruben Ortiz", occurredAt: "2026-11-19T13:08:00Z", receivedAt: "2026-11-19T13:08:05Z" }],
      resolution: null,
      supersededCycles: moved
        ? []
        : [
            {
              id: "c-p",
              employeeId: "e-3",
              employeeName: "Patrick Jones",
              openedAt: "2026-11-18T16:20:00Z",
              lastScanAt: "2026-11-18T20:16:00Z",
              supersededAt: "2026-11-19T13:08:00Z",
              reviewStatus: "open",
              reason: "Another employee started using this bin before it was weighed.",
              scans: [{ occurredAt: "2026-11-18T16:20:00Z", receivedAt: "2026-11-18T16:21:00Z" }],
            },
          ],
    },
  });

const disputed = (resolved: boolean): ScaleWeighingDetail =>
  detail({
    status: resolved ? "credited" : "needs_review",
    employee: resolved ? { id: "e-2", name: "Maria Lopez" } : null,
    countsAsCredit: resolved,
    claims: [],
    pickingCycle: {
      id: "c-9",
      status: "closed",
      employeeName: "Ruben Ortiz",
      openedAt: "2026-10-31T09:00:00Z",
      lastScanAt: "2026-10-31T09:20:00Z",
      reviewReason: "Chosen by more than one employee: Maria Lopez, Ruben Ortiz",
      closeReason: null,
      scans: [
        { employeeId: "e-1", employeeName: "Ruben Ortiz", occurredAt: "2026-10-31T09:00:00Z", receivedAt: "2026-10-31T09:00:05Z" },
        { employeeId: "e-2", employeeName: "Maria Lopez", occurredAt: "2026-10-31T09:20:00Z", receivedAt: "2026-10-31T09:20:05Z" },
      ],
      resolution: resolved
        ? { employeeName: "Maria Lopez", resolvedBy: "Ada Admin", resolvedAt: "2026-10-31T12:00:00Z", reason: "Maria filled it", previousStatus: "needs_review" }
        : null,
    },
  });

vi.mock("../../lib/api", () => ({
  ApiError: class extends Error {},
  api: vi.fn((path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith("/api/scale-weighings?")) return Promise.resolve(day);
    if (path.startsWith("/api/bin-cycles?")) return Promise.resolve({ trackingStartedAt: null, trackingEverStarted: false, cycles: [] });
    if (path.endsWith("/reinstate") || path.endsWith("/confirm-superseded")) {
      reviewCalls.push({ path, body: JSON.parse(init!.body!) });
      nextDetail = reused(true);
      return Promise.resolve({ cycle: {}, replay: false });
    }
    if (path.endsWith("/resolve")) {
      resolveCalls.push({ path, body: JSON.parse(init!.body!) });
      nextDetail = disputed(true);
      return Promise.resolve({ cycle: {}, replay: false });
    }
    if (path.endsWith("/void")) {
      voidCalls.push({ path, body: JSON.parse(init!.body!) });
      return Promise.resolve({
        weighing: detail({
          status: "voided",
          countsAsCredit: false,
          countsForProduction: false,
          corrections: [{ action: "void", reason: "Wrong picker", previousStatus: "credited", previousEmployeeName: "Ruben Ortiz", performedAt: "2026-10-31T12:00:00Z", performedBy: "Ada Admin" }],
        }),
      });
    }
    if (path.startsWith("/api/scale-weighings/")) return Promise.resolve({ weighing: nextDetail ?? detail() });
    return Promise.reject(new Error(`unexpected ${path}`));
  }),
}));

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const listCalls = () => apiMock.mock.calls.map((c) => c[0] as string).filter((p) => p.startsWith("/api/scale-weighings?"));
const lastListCall = () => listCalls()[listCalls().length - 1];

beforeEach(() => {
  role = "Administrator";
  voidCalls = [];
  resolveCalls = [];
  reviewCalls = [];
  nextDetail = null;
  apiMock.mockClear();
});
afterEach(cleanup);

describe("ScaleWeighingsPage", () => {
  it("shows today's weighings, totals and badges", async () => {
    render(<ScaleWeighingsPage />);
    expect(await screen.findByText("Ruben Ortiz", { selector: "td" })).toBeInTheDocument();
    expect(listCalls()[0]).toContain(`date=${todayInAppTimezone()}`);
    const totals = screen.getByRole("list", { name: "Day totals" });
    expect(within(totals).getByText("38.1 kg")).toBeInTheDocument();
    expect(within(totals).getByText("18.1 kg")).toBeInTheDocument();
    expect(screen.getByText(/1 duplicate not counted/)).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("Credited")).toBeInTheDocument();
    expect(within(rows[1]).getByText("172.5")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Duplicate")).toBeInTheDocument();
    expect(rows[2]).toHaveClass("scale-weighing-not-counted");
  });

  it("sends the day and filters to the server", async () => {
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await screen.findByText("Ruben Ortiz", { selector: "td" });
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(lastListCall()).toContain(`date=${addCalendarDays(todayInAppTimezone(), -1)}`));
    await user.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: /Not credited/ }));
    await waitFor(() => expect(lastListCall()).toContain("status=not_credited"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Bin" }), "b-77");
    await waitFor(() => expect(lastListCall()).toContain("carrierId=b-77"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Employee" }), "e-1");
    await waitFor(() => expect(lastListCall()).toContain("employeeId=e-1"));
    await user.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(lastListCall()).toContain(`date=${todayInAppTimezone()}`));
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
  });

  it("shows the rows each bin was picked in, grouped by phase, and — when unknown", async () => {
    render(<ScaleWeighingsPage />);
    await screen.findByText("Ruben Ortiz", { selector: "td" });
    const rows = screen.getAllByRole("row");
    const known = within(rows[1]).getByLabelText("Rows: Phase 1 · Row 12, Phase 1 · Row 13, Phase 2 · Row 571");
    expect(within(known).getByText("12, 13")).toBeInTheDocument();
    expect(within(known).getByText("571")).toBeInTheDocument();
    expect(within(known).getByText("Phase 2")).toBeInTheDocument();
    const unknown = within(rows[2]).getByLabelText(/^Rows unknown: A repeat weighing/);
    expect(unknown).toHaveTextContent("—");
    expect(unknown).toHaveAttribute("title", expect.stringContaining("repeat weighing"));
  });

  it("shows status counts on the filter chips and clears filters", async () => {
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await screen.findByText("Ruben Ortiz", { selector: "td" });
    const tabs = within(screen.getByRole("group", { name: "Status" }));
    expect(tabs.getByRole("button", { name: "All 2" })).toHaveAttribute("aria-pressed", "true");
    expect(tabs.getByRole("button", { name: "Needs review 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    await user.click(tabs.getByRole("button", { name: "Credited 1" }));
    await waitFor(() => expect(lastListCall()).toContain("status=credited"));
    expect(tabs.getByRole("button", { name: "Credited 1" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    await waitFor(() => expect(lastListCall()).toContain("status=all"));
  });

  it("shows the rows in the weighing's detail", async () => {
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    expect(await screen.findByText("Rows 12, 13")).toBeInTheDocument();
    expect(screen.getByText("Row 571")).toBeInTheDocument();
  });

  it("opens a weighing with its history, and an Administrator can void the credit with a reason", async () => {
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    expect(await screen.findByText(/Ruben Ortiz chose this bin at/)).toBeInTheDocument();
    expect(screen.getByText("Received from the station")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Void this credit" }));
    const submit = screen.getByRole("button", { name: "Void credit" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "Wrong picker");
    await user.click(submit);
    await waitFor(() => expect(voidCalls).toHaveLength(1));
    expect(voidCalls[0].body.reason).toBe("Wrong picker");
    expect(typeof voidCalls[0].body.correctionId).toBe("string");
    expect(await screen.findByText(/Credit to Ruben Ortiz voided by Ada Admin/)).toBeInTheDocument();
    expect(screen.getByText(/Not counted in production totals/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void this credit" })).toBeNull();
  });

  it("an Administrator resolves a disputed picking cycle: chooses one of its scanners and gives a reason", async () => {
    nextDetail = disputed(false);
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    expect(await screen.findByText("Phone scans in this picking cycle")).toBeInTheDocument();
    expect(screen.getByText(/^Maria Lopez:/)).toBeInTheDocument();
    expect(screen.getByText(/^Ruben Ortiz:/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resolve: choose the employee" }));
    const submit = screen.getByRole("button", { name: "Credit this employee" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Maria Lopez" }));
    expect(submit).toBeDisabled(); // still needs a reason
    await user.type(screen.getByRole("textbox"), "Maria filled it");
    await user.click(submit);
    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    expect(resolveCalls[0].path).toBe("/api/bin-cycles/c-9/resolve");
    expect(resolveCalls[0].body).toMatchObject({ employeeId: "e-2", reason: "Maria filled it" });
    expect(typeof resolveCalls[0].body.requestId).toBe("string");
    expect(await screen.findByText(/Resolved by Ada Admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve: choose the employee" })).toBeNull();
  });

  it("shows superseded cycles and an Administrator can credit one instead, with a reason", async () => {
    nextDetail = reused(false);
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    expect(await screen.findByText("Earlier picking cycles superseded before this weighing")).toBeInTheDocument();
    expect(screen.getByText("Patrick Jones")).toBeInTheDocument();
    expect(screen.getByText("· To review")).toBeInTheDocument();
    expect(screen.getByText(/Bin reused before weighing/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Credit this cycle instead" }));
    const submit = screen.getByRole("button", { name: "Credit Patrick Jones" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "Ruben scanned the wrong bin");
    await user.click(submit);
    await waitFor(() => expect(reviewCalls).toHaveLength(1));
    expect(reviewCalls[0].path).toBe("/api/bin-cycles/c-p/reinstate");
    expect(reviewCalls[0].body).toMatchObject({ reason: "Ruben scanned the wrong bin" });
    expect(typeof reviewCalls[0].body.requestId).toBe("string");
    await waitFor(() => expect(screen.queryByText("Earlier picking cycles superseded before this weighing")).toBeNull());
  });

  it("marks a late conflict as such", async () => {
    const d = reused(false);
    if (d.pickingCycle && d.pickingCycle !== "none") d.pickingCycle.supersededCycles![0].lateScan = true;
    nextDetail = d;
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    expect(await screen.findByText(/Late conflict: this scan reached LabourLink after the weighing was credited/)).toBeInTheDocument();
  });

  it("does not offer moving a credit to a Manager", async () => {
    role = "Manager";
    nextDetail = reused(false);
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    await screen.findByText("Earlier picking cycles superseded before this weighing");
    expect(screen.queryByRole("button", { name: "Credit this cycle instead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm superseded" })).toBeNull();
  });

  it("does not offer resolving to a Manager", async () => {
    role = "Manager";
    nextDetail = disputed(false);
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    await screen.findByText("Phone scans in this picking cycle");
    expect(screen.queryByRole("button", { name: "Resolve: choose the employee" })).toBeNull();
  });

  it("does not offer voiding to a Manager", async () => {
    role = "Manager";
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    await screen.findByText(/Ruben Ortiz chose this bin at/);
    expect(screen.queryByRole("button", { name: "Void this credit" })).toBeNull();
  });
});
