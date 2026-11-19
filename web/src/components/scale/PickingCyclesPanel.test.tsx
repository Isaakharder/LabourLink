// @vitest-environment jsdom
//
// Open picking cycles panel: hidden until cycle tracking has started, lists
// open cycles, and only Administrators can close one without weighing (reason
// required, one request id per dialog). lib/api.ts and auth are mocked.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PickingCyclesPanel } from "./PickingCyclesPanel";
import { api } from "../../lib/api";
import { BinCycle } from "../../lib/scaleWeighingTypes";

let role = "Administrator";
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "u-1", firstName: "Ada", lastName: "Admin", securityRole: role, teamRole: "Team Member" } }),
}));
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, api: vi.fn() };
});
const apiMock = vi.mocked(api);

const cycle: BinCycle = {
  id: "c-1",
  bin: { id: "b-43", name: "Bin 43" },
  status: "awaiting_weighing",
  employee: { id: "e-1", name: "Jose Cruz" },
  openedAt: "2026-11-19T12:00:00Z",
  lastScanAt: "2026-11-19T12:20:00Z",
  awaitingSince: "2026-11-19T13:00:00Z",
  reviewReason: null,
  scanCount: 2,
  weighing: null,
  closedAt: null,
  closeReason: null,
  closedBy: null,
};

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  role = "Administrator";
});

describe("PickingCyclesPanel", () => {
  it("shows nothing until cycle tracking has started", async () => {
    apiMock.mockResolvedValue({ trackingStartedAt: null, cycles: [] });
    const { container } = render(<PickingCyclesPanel onChanged={() => {}} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("stays visible, saying so, after tracking was stopped", async () => {
    apiMock.mockResolvedValue({ trackingStartedAt: null, trackingEverStarted: true, cycles: [] });
    render(<PickingCyclesPanel onChanged={() => {}} />);
    expect(await screen.findByText(/Picking-cycle tracking is stopped/)).toBeInTheDocument();
  });

  it("lists open cycles; a Manager can't close one", async () => {
    role = "Manager";
    apiMock.mockResolvedValue({ trackingStartedAt: "2026-11-19T06:00:00Z", cycles: [cycle] });
    render(<PickingCyclesPanel onChanged={() => {}} />);
    expect(await screen.findByText("Bin 43")).toBeInTheDocument();
    expect(screen.getByText("Awaiting weighing")).toBeInTheDocument();
    expect(screen.getByText("Jose Cruz")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close without weighing" })).not.toBeInTheDocument();
  });

  it("an Administrator closes a cycle with a reason", async () => {
    const onChanged = vi.fn();
    apiMock.mockResolvedValue({ trackingStartedAt: "2026-11-19T06:00:00Z", cycles: [cycle] });
    render(<PickingCyclesPanel onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole("button", { name: "Close without weighing" }));
    const submit = screen.getByRole("button", { name: "Close cycle" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason/), "Bin emptied without weighing");
    apiMock.mockResolvedValueOnce({ cycle: { ...cycle, status: "closed_unweighed" }, replay: false });
    apiMock.mockResolvedValueOnce({ trackingStartedAt: "2026-11-19T06:00:00Z", cycles: [] });
    await userEvent.click(submit);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const post = apiMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(post[0]).toBe("/api/bin-cycles/c-1/close");
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body.reason).toBe("Bin emptied without weighing");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("No open picking cycles.")).toBeInTheDocument();
  });
});
