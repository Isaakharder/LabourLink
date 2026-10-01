// @vitest-environment jsdom
//
// Full job-selection flow on Home with the direct row list: choose activity
// -> "Choose a row" (every phase at once, no phase step) -> bin (when the
// activity asks for one; Skip when optional) -> start. Also covers the
// row switch while working, NFC selection on the row step, and offline use
// (cached reference data, local-first perform()).
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse } from "../../context/WorkSessionContext";

const h = vi.hoisted(() => ({
  perform: vi.fn(),
  setError: vi.fn(),
  handleApiError: vi.fn(),
  me: null as unknown,
  online: true,
  serverReachable: true,
  nfcSupported: false,
  scanCallbacks: new Map<string, (tag: { id: string }) => void>(),
}));

vi.mock("../../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({
    cachedEmployee: { employeeId: "emp-1", firstName: "Khen", lastName: "Lagto", preferredLanguage: null, lastVerifiedAt: "x" },
    serverReachable: h.serverReachable,
  }),
}));

vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({
    me: h.me,
    language: "en",
    verified: true,
    busy: false,
    online: h.online,
    error: null,
    setError: h.setError,
    retryAction: null,
    pending: 0,
    syncProblem: false,
    pendingActivityName: null,
    handleApiError: h.handleApiError,
    perform: h.perform,
  }),
}));

const ACTIVITIES = [
  {
    id: "act-pick",
    name: "Picking Peppers",
    normalSpeed: null,
    speedUnit: null,
    questions: [
      { id: "q-row", questionType: "greenhouse_row", label: "Where?", isRequired: true },
      { id: "q-bin", questionType: "carrier", label: "Which Carrier?", isRequired: false },
    ],
  },
  {
    id: "act-wind",
    name: "Winding & Pruning",
    normalSpeed: null,
    speedUnit: null,
    questions: [{ id: "q-row2", questionType: "greenhouse_row", label: "Where?", isRequired: true }],
  },
];

const LANDS = [
  {
    id: "land-1",
    name: "First Light Greenhouse",
    phases: [
      { id: "ph-2", name: "Phase 2", rows: [{ id: "p2-r7", rowNumber: 7 }, { id: "p2-r3", rowNumber: 3 }] },
      { id: "ph-3", name: "Phase 3", rows: [{ id: "p3-r7", rowNumber: 7 }, { id: "p3-r40", rowNumber: 40 }] },
    ],
  },
];

vi.mock("../../lib/referenceDataCache", () => ({
  fetchActivitiesWithCache: () => Promise.resolve({ data: { activities: ACTIVITIES }, fromCache: false }),
  fetchRowsWithCache: () => Promise.resolve({ data: { lands: LANDS }, fromCache: !h.online }),
  fetchCarriersWithCache: () => Promise.resolve({ data: { carriers: [{ id: "bin-10", name: "Bin 10" }] }, fromCache: !h.online }),
}));

vi.mock("../../lib/nfc", () => ({
  isNfcSupported: () => Promise.resolve(h.nfcSupported),
  startScanSession: (cb: (tag: { id: string }) => void, _opts?: unknown, source?: string) => {
    h.scanCallbacks.set(source ?? "unknown", cb);
    return () => h.scanCallbacks.delete(source ?? "unknown");
  },
}));

vi.mock("../../lib/nfcMappingCache", () => ({
  refreshTagMappingCache: () => Promise.resolve(),
  resolveScannedTag: (tag: { id: string }) =>
    tag.id === "tag-p3-r7" ? { targetType: "greenhouse_row", targetId: "p3-r7" } : null,
}));

vi.mock("../../lib/feedback", () => ({ playErrorFeedback: vi.fn(), playSuccessFeedback: vi.fn() }));
vi.mock("../../lib/localEventStore", () => ({ logCheckpoint: vi.fn() }));

import { HomeScreen } from "./HomeScreen";

function idleMe(): MeResponse {
  return {
    employee: { id: "emp-1", firstName: "Khen", lastName: "Lagto", preferredLanguage: null, securityRole: "Employee" },
    status: "idle",
    currentActivity: null,
    since: null,
    previousActivity: null,
    recentJobs: [],
  };
}

function rowButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".mobile-row-grid-item"));
}

function rowById(id: string) {
  return rowButtons().find((b) => b.dataset.rowId === id)!;
}

beforeEach(() => {
  h.perform.mockReset();
  h.me = idleMe();
  h.online = true;
  h.serverReachable = true;
  h.nfcSupported = false;
  h.scanCallbacks.clear();
});

afterEach(() => cleanup());

async function openActivity(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Choose a job" }));
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

describe("Home job selection with the direct row list", () => {
  it("activity -> Choose a row (all phases, no phase step) -> bin -> start, saving the row's UUID", async () => {
    render(<HomeScreen />);
    await openActivity("Picking Peppers");

    expect(await screen.findByRole("heading", { name: "Choose a row" })).toBeInTheDocument();
    expect(screen.queryByText("Phase 2", { selector: ".mobile-sheet-item-name" })).not.toBeInTheDocument();
    expect(rowButtons().map((b) => b.dataset.rowId)).toEqual(["p2-r3", "p2-r7", "p3-r7", "p3-r40"]);

    await userEvent.click(rowById("p3-r7"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    // Bin step, optional here.
    expect(await screen.findByRole("heading", { name: "Which Carrier?" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Bin 10"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(h.perform).toHaveBeenCalledTimes(1);
    const [path, body] = h.perform.mock.calls[0];
    expect(path).toBe("/api/mobile/time-entries/work");
    expect(body.activityId).toBe("act-pick");
    expect(body.answers).toEqual([
      { questionId: "q-row", greenhouseRowId: "p3-r7" },
      { questionId: "q-bin", carrierId: "bin-10" },
    ]);
    expect(typeof body.idempotencyKey).toBe("string");
  });

  it("an optional bin can be skipped", async () => {
    render(<HomeScreen />);
    await openActivity("Picking Peppers");
    await screen.findByRole("heading", { name: "Choose a row" });
    await userEvent.click(rowById("p2-r3"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("heading", { name: "Which Carrier?" });
    await userEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(h.perform.mock.calls[0][1].answers).toEqual([{ questionId: "q-row", greenhouseRowId: "p2-r3" }]);
  });

  it("an activity with only a row question starts straight after the row", async () => {
    render(<HomeScreen />);
    await openActivity("Winding & Pruning");
    await screen.findByRole("heading", { name: "Choose a row" });
    await userEvent.click(rowById("p2-r7"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(h.perform.mock.calls[0][1]).toMatchObject({
      activityId: "act-wind",
      answers: [{ questionId: "q-row2", greenhouseRowId: "p2-r7" }],
    });
  });

  it("Cancel on the row step starts nothing", async () => {
    render(<HomeScreen />);
    await openActivity("Picking Peppers");
    await screen.findByRole("heading", { name: "Choose a row" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Choose a row" })).not.toBeInTheDocument();
    expect(h.perform).not.toHaveBeenCalled();
  });

  it("search on the row step finds the duplicate row number in both phases", async () => {
    render(<HomeScreen />);
    await openActivity("Picking Peppers");
    await screen.findByRole("heading", { name: "Choose a row" });
    await userEvent.type(screen.getByPlaceholderText("Search row number"), "7");
    expect(rowButtons().map((b) => b.dataset.rowId)).toEqual(["p2-r7", "p3-r7"]);
    expect(rowById("p3-r7")).toHaveTextContent("Phase 3");
  });

  it("an NFC row tag on the row step selects that exact row and moves on", async () => {
    h.nfcSupported = true;
    render(<HomeScreen />);
    await openActivity("Picking Peppers");
    await screen.findByRole("heading", { name: "Choose a row" });
    await act(async () => {
      await Promise.resolve();
    });
    const cb = h.scanCallbacks.get("RowPickerSheet");
    expect(cb).toBeDefined();
    await act(async () => cb!({ id: "tag-p3-r7" }));
    expect(await screen.findByRole("heading", { name: "Which Carrier?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(h.perform.mock.calls[0][1].answers).toEqual([{ questionId: "q-row", greenhouseRowId: "p3-r7" }]);
  });

  it("works offline from cached rows (local-first start)", async () => {
    h.online = false;
    h.serverReachable = false;
    render(<HomeScreen />);
    await openActivity("Winding & Pruning");
    await screen.findByRole("heading", { name: "Choose a row" });
    await userEvent.click(rowById("p3-r40"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.perform.mock.calls[0][1].answers).toEqual([{ questionId: "q-row2", greenhouseRowId: "p3-r40" }]);
  });

  it("switching rows while working uses the same direct list, pre-selecting the current row", async () => {
    h.me = {
      ...idleMe(),
      status: "work",
      since: new Date().toISOString(),
      currentActivity: {
        id: "act-wind",
        name: "Winding & Pruning",
        row: { id: "p2-r7", label: "Phase 2 · Row 7" },
        carrier: null,
      },
    } as unknown as MeResponse;
    render(<HomeScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "Phase 2 · Row 7" }));
    expect(await screen.findByRole("heading", { name: "Choose a row" })).toBeInTheDocument();
    expect((document.querySelector(".mobile-row-grid-item-selected") as HTMLElement).dataset.rowId).toBe("p2-r7");
    await userEvent.click(rowById("p3-r40"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(h.perform.mock.calls[0][1]).toMatchObject({
      activityId: "act-wind",
      answers: [{ questionId: "q-row2", greenhouseRowId: "p3-r40" }],
    });
  });
});
