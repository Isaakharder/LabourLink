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
    },
  ],
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

vi.mock("../../lib/api", () => ({
  ApiError: class extends Error {},
  api: vi.fn((path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith("/api/scale-weighings?")) return Promise.resolve(day);
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
    if (path.startsWith("/api/scale-weighings/")) return Promise.resolve({ weighing: detail() });
    return Promise.reject(new Error(`unexpected ${path}`));
  }),
}));

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const listCalls = () => apiMock.mock.calls.map((c) => c[0] as string).filter((p) => p.startsWith("/api/scale-weighings?"));
const lastListCall = () => listCalls()[listCalls().length - 1];

beforeEach(() => {
  role = "Administrator";
  voidCalls = [];
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "not_credited");
    await waitFor(() => expect(lastListCall()).toContain("status=not_credited"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Bin" }), "b-77");
    await waitFor(() => expect(lastListCall()).toContain("carrierId=b-77"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Employee" }), "e-1");
    await waitFor(() => expect(lastListCall()).toContain("employeeId=e-1"));
    await user.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(lastListCall()).toContain(`date=${todayInAppTimezone()}`));
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
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

  it("does not offer voiding to a Manager", async () => {
    role = "Manager";
    const user = userEvent.setup();
    render(<ScaleWeighingsPage />);
    await user.click(await screen.findByText("Ruben Ortiz", { selector: "td" }));
    await screen.findByText(/Ruben Ortiz chose this bin at/);
    expect(screen.queryByRole("button", { name: "Void this credit" })).toBeNull();
  });
});
