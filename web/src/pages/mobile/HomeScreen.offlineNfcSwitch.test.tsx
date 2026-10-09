// @vitest-environment jsdom
//
// Offline NFC row/bin switching while working. On iPhone a scanned tag that
// resolves from this phone's saved tag list switches the row exactly like a
// manual switch (local-first perform(): recorded with its own timestamp,
// synced in order later). Android keeps its online-only rule.
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
  online: false,
  ios: true,
  scanCallbacks: new Map<string, (tag: { id: string }) => void>(),
}));

vi.mock("../../lib/platform", () => ({
  isNativePlatform: () => true,
  isIosNativePlatform: () => h.ios,
}));

const cachedEmployee = { employeeId: "emp-1", firstName: "Khen", lastName: "Lagto", preferredLanguage: null, lastVerifiedAt: "x" };
vi.mock("../../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({ cachedEmployee, serverReachable: h.online }),
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
    id: "act-wind",
    name: "Winding & Pruning",
    normalSpeed: null,
    speedUnit: null,
    questions: [{ id: "q-row", questionType: "greenhouse_row", label: "Where?", isRequired: true }],
  },
];
const LANDS = [
  { id: "land-1", name: "GH", phases: [{ id: "ph-1", name: "Phase 1", rows: [{ id: "row-6", rowNumber: 6 }, { id: "row-7", rowNumber: 7 }] }] },
];

vi.mock("../../lib/referenceDataCache", () => ({
  fetchActivitiesWithCache: () => Promise.resolve({ data: { activities: ACTIVITIES }, fromCache: true }),
  fetchRowsWithCache: () => Promise.resolve({ data: { lands: LANDS }, fromCache: true }),
  fetchCarriersWithCache: () => Promise.resolve({ data: { carriers: [] }, fromCache: true }),
}));

vi.mock("../../lib/nfc", () => ({
  isNfcSupported: () => Promise.resolve(true),
  startScanSession: (cb: (tag: { id: string }) => void, _onError?: unknown, source?: string) => {
    h.scanCallbacks.set(source ?? "unknown", cb);
    return () => h.scanCallbacks.delete(source ?? "unknown");
  },
}));

vi.mock("../../lib/nfcMappingCache", () => ({
  refreshTagMappingCache: () => Promise.reject(new Error("offline")),
  resolveScannedTag: (tag: { id: string }) =>
    tag.id === "tag-row-7" ? { targetType: "greenhouse_row", targetId: "row-7", label: "Phase 1 · Row 7" } : null,
}));

vi.mock("../../lib/feedback", () => ({ playErrorFeedback: vi.fn(), playSuccessFeedback: vi.fn() }));
vi.mock("../../lib/localEventStore", () => ({ logCheckpoint: vi.fn() }));

import { HomeScreen } from "./HomeScreen";

function workingOnRow6(): MeResponse {
  return {
    employee: { id: "emp-1", firstName: "Khen", lastName: "Lagto", preferredLanguage: null, securityRole: "Employee" },
    status: "work",
    since: new Date().toISOString(),
    currentActivity: { id: "act-wind", name: "Winding & Pruning", row: { id: "row-6", label: "Phase 1 · Row 6" }, carrier: null },
    previousActivity: null,
    recentJobs: [],
  } as unknown as MeResponse;
}

async function scanOnHome(tagId: string) {
  render(<HomeScreen />);
  if (h.ios) await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
  await act(async () => {
    await Promise.resolve();
  });
  const cb = h.scanCallbacks.get("HomeScreen");
  expect(cb).toBeDefined();
  await act(async () => cb!({ id: tagId }));
}

beforeEach(() => {
  h.perform.mockReset();
  h.me = workingOnRow6();
  h.online = false;
  h.ios = true;
  h.scanCallbacks.clear();
});
afterEach(() => cleanup());

describe("Home: NFC row switching while offline", () => {
  it("iPhone offline: a saved tag switches the row through the local-first path", async () => {
    await scanOnHome("tag-row-7");
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.perform.mock.calls[0][1]).toMatchObject({ activityId: "act-wind", answers: [{ questionId: "q-row", greenhouseRowId: "row-7" }] });
    expect(screen.queryByText(/Can't switch rows while offline/)).not.toBeInTheDocument();
  });

  it("iPhone offline: a tag not saved on this phone says so, and nothing switches", async () => {
    await scanOnHome("tag-unknown");
    expect(h.perform).not.toHaveBeenCalled();
    expect(await screen.findByText(/isn't saved on this phone yet/)).toBeInTheDocument();
  });

  it("Android offline: unchanged — no switch, existing message", async () => {
    h.ios = false;
    await scanOnHome("tag-row-7");
    expect(h.perform).not.toHaveBeenCalled();
    expect(await screen.findByText(/Can't switch rows while offline/)).toBeInTheDocument();
  });
});
