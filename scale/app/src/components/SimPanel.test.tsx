// Simulator phone-scan controls: a delayed scan must be aimed at a specific
// bin use (weighing), or at the bin's next use, never at "N minutes ago" by
// default, which used to land scans in the wrong cycle.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimBody, SimPanel } from "./SimPanel";
import { makeSnapshot } from "../testFixtures";

const posts: { path: string; body: unknown }[] = [];

vi.mock("../api", () => ({
  call: vi.fn((path: string, init: { body?: unknown } = {}) => {
    if (init.body !== undefined) {
      posts.push({ path, body: init.body });
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({
      carriers: [
        { id: "sim-carrier-01", name: "Sim Bin 1", rfidTag: "0000000182225750", tareG: 27_500, isActive: true },
        { id: "sim-carrier-02", name: "Sim Bin 2", rfidTag: "0000000182225751", tareG: 27_250, isActive: true },
      ],
      employees: [
        { id: "sim-employee-1", name: "Picker Alpha" },
        { id: "sim-employee-3", name: "Picker Charlie" },
      ],
      claims: [
        { id: "c1", employeeName: "Picker Alpha", carrierName: "Sim Bin 1", occurredAt: "2026-10-27T10:00:00Z", clockTrusted: true, consumedBy: "W1", state: "used" },
        { id: "c2", employeeName: "Picker Delta", carrierName: "Sim Bin 1", occurredAt: "2026-10-27T10:00:30Z", clockTrusted: true, consumedBy: null, state: "conflict" },
      ],
      serverWeighings: [
        { id: "W3", carrierId: "sim-carrier-01", carrierName: "Sim Bin 1", weighedAt: "2026-10-27T10:20:00Z", status: "pending", employeeName: null },
        { id: "W1", carrierId: "sim-carrier-01", carrierName: "Sim Bin 1", weighedAt: "2026-10-27T10:01:00Z", status: "credited", employeeName: "Picker Alpha" },
      ],
      serverOnline: true,
      unregisteredTag: "0000000099999999",
    });
  }),
}));

beforeEach(() => {
  posts.length = 0;
});
afterEach(cleanup);

describe("claimBody", () => {
  it("targets a specific weighing, the next use, or (advanced) minutes ago", () => {
    expect(claimBody("w:W3", "e1", "sim-carrier-01", "20", true)).toEqual({ employeeId: "e1", timing: "beforeWeighing", weighingId: "W3", clockTrusted: true });
    expect(claimBody("next", "e1", "sim-carrier-02", "20", true)).toEqual({ employeeId: "e1", timing: "now", carrierId: "sim-carrier-02", clockTrusted: true });
    expect(claimBody("ago", "e1", "sim-carrier-02", "7", false)).toEqual({
      employeeId: "e1",
      timing: "minutesAgo",
      carrierId: "sim-carrier-02",
      minutesAgo: 7,
      clockTrusted: false,
    });
  });
});

describe("SimPanel phone scans", () => {
  it("syncs a scan for the second use of Bin 1 to that weighing", async () => {
    const user = userEvent.setup();
    render(<SimPanel s={makeSnapshot()} />);
    const scanFor = await screen.findByLabelText("Scan for");
    await user.selectOptions(screen.getByLabelText("Picker"), "sim-employee-3");
    const secondUse = screen.getByRole("option", { name: /Sim Bin 1 \(awaiting assignment\)/ });
    await user.selectOptions(scanFor, secondUse);
    expect(screen.queryByLabelText("Bin")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scanned minutes ago")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sync phone bin scan" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/api/sim/claim", body: { employeeId: "sim-employee-3", timing: "beforeWeighing", weighingId: "W3", clockTrusted: true } });
  });

  it("defaults to the bin's next use, not 'minutes ago'", async () => {
    const user = userEvent.setup();
    render(<SimPanel s={makeSnapshot()} />);
    await screen.findByLabelText("Scan for");
    await user.click(screen.getByRole("button", { name: "Sync phone bin scan" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toMatchObject({ timing: "now", carrierId: "sim-carrier-01" });
  });

  it("explains what happened to each scan, including flagged conflicts", async () => {
    render(<SimPanel s={makeSnapshot()} />);
    expect(await screen.findByText(/Picker Alpha → Sim Bin 1: ✓ credited this use/)).toBeInTheDocument();
    expect(screen.getByText(/Picker Delta → Sim Bin 1: ⚠ conflict: flagged for supervisor, credit unchanged/)).toBeInTheDocument();
  });

  it("'Simulate 24 h passing' is a one-off expiry step", async () => {
    const user = userEvent.setup();
    render(<SimPanel s={makeSnapshot()} />);
    await user.click(await screen.findByRole("button", { name: "Simulate 24 h passing" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/sim/advance", body: { hours: 24 } }]));
  });
});
