// @vitest-environment jsdom
//
// Scale Weighings -> Review allocation (Administrator only): the day's shared
// and to-review bins, the allocation dialog with each picker's minutes, share
// and kilograms, confirm / correct (exclude a contribution, kilograms by
// hand that must add up) / exclude / reset with a reason, the version and
// records fingerprint sent with every decision, a 409 asking to reload, and
// the history. lib/api.ts and auth are mocked.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductivityAllocationsPanel } from "./ProductivityAllocationsPanel";
import { api, ApiError } from "../../lib/api";
import { AllocationDetail, AllocationList } from "../../lib/scaleProductivityAllocationTypes";

let role = "Administrator";
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "u-1", firstName: "Ada", lastName: "Admin", securityRole: role, teamRole: "Team Member" } }),
}));
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, api: vi.fn() };
});
const apiMock = vi.mocked(api);

const hugo = { employeeId: "e-h", name: "Hugo Diaz", matchedMinutes: 60, matchedSeconds: 3600, percent: 66.67, proposedKg: 100, countedKg: null, counted: false, scanned: true, otherJobMinutes: 0, firstAt: "2026-11-23T21:00:00Z", lastAt: "2026-11-23T22:00:00Z" };
const ivy = { employeeId: "e-i", name: "Ivy Chan", matchedMinutes: 30, matchedSeconds: 1800, percent: 33.33, proposedKg: 50, countedKg: null, counted: false, scanned: true, otherJobMinutes: 0, firstAt: "2026-11-24T12:30:00Z", lastAt: "2026-11-24T13:00:00Z" };
const list: AllocationList = {
  date: "2026-11-24",
  jobs: [{ id: "job-1", name: "Picking Peppers" }],
  activityId: "job-1",
  bins: [
    {
      weighingId: "w-2",
      bin: "Bin 67",
      weighedAt: "2026-11-24T13:10:00Z",
      netKg: 150,
      officialCredit: { id: "e-i", name: "Ivy Chan" },
      status: "review",
      decided: false,
      reasons: [{ code: "overnight_handover", label: "Another employee continued this bin on a later day" }],
      contributors: [hugo, ivy],
    },
    {
      weighingId: "w-1",
      bin: "Bin 36",
      weighedAt: "2026-11-24T14:00:00Z",
      netKg: 200,
      officialCredit: { id: "e-j", name: "Jeffrey Sol" },
      status: "shared_auto",
      decided: false,
      reasons: [],
      contributors: [
        { ...hugo, employeeId: "e-jo", name: "Jose Cruz", percent: 66.67, proposedKg: 133.333, countedKg: 133.333, counted: true },
        { ...ivy, employeeId: "e-j", name: "Jeffrey Sol", percent: 33.33, proposedKg: 66.667, countedKg: 66.667, counted: true },
      ],
    },
  ],
};
const detail: AllocationDetail = {
  activityId: "job-1",
  weighingId: "w-2",
  bin: "Bin 67",
  weighedAt: "2026-11-24T13:10:00Z",
  netKg: 150,
  grossKg: 300,
  tareKg: 150,
  weighingStatus: "credited",
  officialCredit: { id: "e-i", name: "Ivy Chan" },
  version: 0,
  decision: null,
  history: [],
  allocatable: true,
  status: "review",
  basis: null,
  reasons: [{ code: "overnight_handover", label: "Another employee continued this bin on a later day" }],
  contributors: [hugo, ivy, { ...ivy, employeeId: "e-s", name: "Sam Stray", matchedMinutes: 0, matchedSeconds: 0, percent: 0, proposedKg: 0 }],
  fingerprint: "v1|150000|x|e-h:3600,e-i:1800",
  loadStart: "2026-11-23T20:00:00Z",
};

function route(over: { detail?: AllocationDetail; post?: (body: any) => unknown } = {}) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return (over.post ?? (() => ({ ok: true, version: 1 })))(JSON.parse(String(init.body)));
    if (path.startsWith("/api/scale-productivity-allocations?")) return list;
    if (path.startsWith("/api/scale-productivity-allocations/w-2")) return over.detail ?? detail;
    throw new Error(`unexpected ${path}`);
  });
}
const posts = () => apiMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST").map((c) => JSON.parse(String((c[1] as RequestInit).body)));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  role = "Administrator";
});

describe("Review allocation", () => {
  it("is not shown to a Manager (and never asks the server)", async () => {
    role = "Manager";
    route();
    const { container } = render(<ProductivityAllocationsPanel date="2026-11-24" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("lists the day's shared and to-review bins with each picker's minutes and share", async () => {
    route();
    render(<ProductivityAllocationsPanel date="2026-11-24" />);
    expect(await screen.findByText("1 bin to review")).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("To review")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Another employee continued this bin on a later day")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Hugo Diaz · 60 min · 66.7% · 100.0 kg")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Shared automatically")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Jose Cruz · 60 min · 66.7% · 133.333 kg")).toBeInTheDocument();
    expect(apiMock.mock.calls[0][0]).toBe("/api/scale-productivity-allocations?date=2026-11-24");
  });

  it("an Administrator confirms the proposed allocation with a reason; version and fingerprint are sent", async () => {
    route();
    render(<ProductivityAllocationsPanel date="2026-11-24" />);
    await userEvent.click(await screen.findByText("Bin 67"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("100.0 (estimated)")).toBeInTheDocument();
    expect(within(dialog).getByText("Scanned the bin, no picking time (gets nothing)")).toBeInTheDocument();
    expect(within(dialog).getByText(/Not changed by this allocation/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm proposed allocation" }));
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Bin stayed in the row overnight");
    await userEvent.click(save);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ action: "confirm", activityId: "job-1", expectedVersion: 0, expectedFingerprint: detail.fingerprint, reason: "Bin stayed in the row overnight" });
    expect(posts()[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("corrects by hand: kilograms must add up to the net weight before saving", async () => {
    route();
    render(<ProductivityAllocationsPanel date="2026-11-24" />);
    await userEvent.click(await screen.findByText("Bin 67"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Correct allocation" }));
    await userEvent.click(within(dialog).getByLabelText("Set kilograms by hand"));
    const hugoKg = within(dialog).getByLabelText("Kilograms for Hugo Diaz");
    await userEvent.clear(hugoKg);
    await userEvent.type(hugoKg, "90");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Weighed portions");
    expect(within(dialog).getByText(/must add up to the net weight/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    const ivyKg = within(dialog).getByLabelText("Kilograms for Ivy Chan");
    await userEvent.clear(ivyKg);
    await userEvent.type(ivyKg, "60");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      action: "override",
      shares: [
        { employeeId: "e-h", included: true, allocatedKg: 90 },
        { employeeId: "e-i", included: true, allocatedKg: 60 },
      ],
    });
  });

  it("excludes an accidental contribution (proportional among the rest)", async () => {
    route();
    render(<ProductivityAllocationsPanel date="2026-11-24" />);
    await userEvent.click(await screen.findByText("Bin 67"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Correct allocation" }));
    await userEvent.click(within(dialog).getByLabelText("Include Hugo Diaz"));
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Bin was emptied overnight");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].shares).toEqual([
      { employeeId: "e-h", included: false, allocatedKg: null },
      { employeeId: "e-i", included: true, allocatedKg: null },
    ]);
  });

  it("someone else changed it first: the 409 asks to reload", async () => {
    route({
      post: () => {
        throw new ApiError(409, "Someone else changed this allocation. Reload to see the latest.");
      },
    });
    render(<ProductivityAllocationsPanel date="2026-11-24" />);
    await userEvent.click(await screen.findByText("Bin 67"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Exclude from kg/hour" }));
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Mixed load");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Someone else changed this allocation");
    expect(within(dialog).getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("shows the decision, that it no longer applies after a correction, and the history; reset is offered", async () => {
    route({
      detail: {
        ...detail,
        version: 1,
        status: "review",
        reasons: [{ code: "inputs_changed", label: "The time records changed after this allocation was reviewed" }],
        decision: { action: "confirm", method: "proportional", reason: "Checked", decidedAt: "2026-11-24T15:00:00Z", decidedBy: "Ada Admin", shares: [] },
        history: [
          {
            id: "h1",
            action: "confirm",
            reason: "Checked",
            previous: null,
            next: { action: "confirm", method: "proportional", shares: [{ employeeId: "e-h", included: true, allocatedGrams: 100_000 }, { employeeId: "e-i", included: true, allocatedGrams: 50_000 }] },
            proposal: { netGrams: 150_000, status: "review", reasons: ["overnight_handover"], contributors: [] },
            performed_at: "2026-11-24T15:00:00Z",
            performed_by: "Ada Admin",
          },
        ],
      },
    });
    render(<ProductivityAllocationsPanel date="2026-11-24" />);
    await userEvent.click(await screen.findByText("Bin 67"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/no longer applies; the records changed since/)).toBeInTheDocument();
    expect(within(dialog).getByText("Shared by minutes: Hugo Diaz 100.0 kg, Ivy Chan 50.0 kg")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Reset to automatic" })).toBeInTheDocument();
  });
});
