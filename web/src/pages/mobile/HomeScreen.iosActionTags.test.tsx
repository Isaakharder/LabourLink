// @vitest-environment jsdom
//
// iPhone Home scans of activity and Start Break / End Break / End Work tags.
// Activity tags go through the same start/switch flow as picking the job
// (row/bin questions first; Cancel commits nothing). Break tags reuse the
// existing break actions; a repeat in the same state does nothing. End Work
// only opens the existing confirmation. No tag silently ends a break or
// starts work. Android is unchanged. NFC is mocked — not hardware evidence.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse } from "../../context/WorkSessionContext";

const h = vi.hoisted(() => ({
  perform: vi.fn(),
  startBreak: vi.fn(),
  endBreak: vi.fn(),
  openEndDayConfirm: vi.fn(),
  setError: vi.fn(),
  handleApiError: vi.fn(),
  me: null as unknown,
  ios: true,
  scanCallbacks: new Map<string, (tag: { id: string }) => void>(),
}));

vi.mock("../../lib/platform", () => ({ isNativePlatform: () => true, isIosNativePlatform: () => h.ios }));
const cachedEmployee = { employeeId: "emp-1", firstName: "Demo", lastName: "Worker", preferredLanguage: null, lastVerifiedAt: "x" };
vi.mock("../../context/DevicePairingContext", () => ({ useDevicePairing: () => ({ cachedEmployee, serverReachable: false }) }));
vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({
    me: h.me,
    language: "en",
    verified: true,
    busy: false,
    online: false,
    error: null,
    setError: h.setError,
    retryAction: null,
    pending: 0,
    syncProblem: false,
    pendingActivityName: null,
    handleApiError: h.handleApiError,
    perform: h.perform,
    startBreak: h.startBreak,
    endBreak: h.endBreak,
    openEndDayConfirm: h.openEndDayConfirm,
  }),
}));

const ACTIVITIES = [
  { id: "act-wind", name: "Winding", normalSpeed: null, speedUnit: null, questions: [{ id: "q-row", questionType: "greenhouse_row", label: "Where?", isRequired: true }] },
  { id: "act-clean", name: "Cleaning", normalSpeed: null, speedUnit: null, questions: [] },
];
const LANDS = [{ id: "land-1", name: "GH", phases: [{ id: "ph-1", name: "Phase 1", rows: [{ id: "row-6", rowNumber: 6 }, { id: "row-7", rowNumber: 7 }] }] }];
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
const TAGS: Record<string, { targetType: string; targetId: string; label: string }> = {
  "tag-wind": { targetType: "activity", targetId: "act-wind", label: "Winding" },
  "tag-clean": { targetType: "activity", targetId: "act-clean", label: "Cleaning" },
  "tag-other-job": { targetType: "activity", targetId: "act-not-mine", label: "Harvest" },
  "tag-start-break": { targetType: "action", targetId: "start_break", label: "Start Break" },
  "tag-end-break": { targetType: "action", targetId: "end_break", label: "End Break" },
  "tag-end-work": { targetType: "action", targetId: "end_work", label: "End Work" },
  "tag-row-7": { targetType: "greenhouse_row", targetId: "row-7", label: "Phase 1 · Row 7" },
};
vi.mock("../../lib/nfcMappingCache", () => ({
  refreshTagMappingCache: () => Promise.reject(new Error("offline")),
  resolveScannedTag: (tag: { id: string }) => TAGS[tag.id] ?? null,
}));
vi.mock("../../lib/feedback", () => ({ playErrorFeedback: vi.fn(), playSuccessFeedback: vi.fn() }));
vi.mock("../../lib/localEventStore", () => ({ logCheckpoint: vi.fn() }));

import { HomeScreen } from "./HomeScreen";

function me(status: "idle" | "work" | "break", activityId: string | null = null): MeResponse {
  return {
    employee: { id: "emp-1", firstName: "Demo", lastName: "Worker", preferredLanguage: null, securityRole: "Employee" },
    status,
    since: new Date().toISOString(),
    currentActivity: activityId ? { id: activityId, name: ACTIVITIES.find((a) => a.id === activityId)!.name, row: activityId === "act-wind" ? { id: "row-6", label: "Phase 1 · Row 6" } : null, carrier: null } : null,
    previousActivity: null,
    recentJobs: [],
  } as unknown as MeResponse;
}

async function openScan() {
  render(<HomeScreen />);
  if (h.ios) await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
  await act(async () => {
    await Promise.resolve();
  });
}
async function scan(tagId: string) {
  const cb = h.scanCallbacks.get("HomeScreen");
  expect(cb).toBeDefined();
  await act(async () => cb!({ id: tagId }));
}
function noWorkChange() {
  expect(h.perform).not.toHaveBeenCalled();
  expect(h.startBreak).not.toHaveBeenCalled();
  expect(h.endBreak).not.toHaveBeenCalled();
  expect(h.openEndDayConfirm).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const f of [h.perform, h.startBreak, h.endBreak, h.openEndDayConfirm]) f.mockReset();
  h.ios = true;
  h.scanCallbacks.clear();
});
afterEach(() => cleanup());

describe("iPhone Home: activity tags", () => {
  it("idle: an activity with a row question opens the question flow; Cancel commits nothing", async () => {
    h.me = me("idle");
    await openScan();
    await scan("tag-wind");
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(h.perform).not.toHaveBeenCalled();
    await userEvent.click(cancel);
    noWorkChange();
  });

  it("idle: completing the row commits once with the answer", async () => {
    h.me = me("idle");
    await openScan();
    await scan("tag-wind");
    await userEvent.click(await screen.findByRole("button", { name: "7" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.perform.mock.calls[0][0]).toBe("/api/mobile/time-entries/work");
    expect(h.perform.mock.calls[0][1]).toMatchObject({ activityId: "act-wind", answers: [{ questionId: "q-row", greenhouseRowId: "row-7" }] });
  });

  it("working: an activity with no questions switches at once through the normal path", async () => {
    h.me = me("work", "act-wind");
    await openScan();
    await scan("tag-clean");
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.perform.mock.calls[0][1]).toMatchObject({ activityId: "act-clean" });
  });

  it("the current activity again is a no-op", async () => {
    h.me = me("work", "act-clean");
    await openScan();
    await scan("tag-clean");
    expect(await screen.findByText("You're already working on Cleaning.")).toBeInTheDocument();
    noWorkChange();
  });

  it("an activity that isn't one of the employee's jobs does nothing", async () => {
    h.me = me("idle");
    await openScan();
    await scan("tag-other-job");
    expect(await screen.findByText("Harvest isn't one of your jobs.")).toBeInTheDocument();
    noWorkChange();
  });

  it("on a break, an activity tag never silently ends the break", async () => {
    h.me = me("break", "act-wind");
    await openScan();
    await scan("tag-clean");
    expect(await screen.findByText("You're on a break. End your break first.")).toBeInTheDocument();
    noWorkChange();
  });
});

describe("iPhone Home: break and End Work tags", () => {
  it("Start Break while working starts the break", async () => {
    h.me = me("work", "act-clean");
    await openScan();
    await scan("tag-start-break");
    expect(h.startBreak).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Break started.")).toBeInTheDocument();
  });

  it("Start Break again while already on a break is a no-op", async () => {
    h.me = me("break", "act-clean");
    await openScan();
    await scan("tag-start-break");
    expect(await screen.findByText("You're already on a break.")).toBeInTheDocument();
    noWorkChange();
  });

  it("Start Break while idle never starts work", async () => {
    h.me = me("idle");
    await openScan();
    await scan("tag-start-break");
    expect(await screen.findByText(/You're not working right now/)).toBeInTheDocument();
    noWorkChange();
  });

  it("End Break on a break ends it; again when working is a no-op", async () => {
    h.me = me("break", "act-clean");
    await openScan();
    await scan("tag-end-break");
    expect(h.endBreak).toHaveBeenCalledTimes(1);
    cleanup();
    h.endBreak.mockReset();
    h.me = me("work", "act-clean");
    await openScan();
    await scan("tag-end-break");
    expect(await screen.findByText("You're not on a break.")).toBeInTheDocument();
    noWorkChange();
  });

  it("End Work only opens the existing confirmation (working or on a break)", async () => {
    h.me = me("work", "act-clean");
    await openScan();
    await scan("tag-end-work");
    expect(h.openEndDayConfirm).toHaveBeenCalledTimes(1);
    expect(h.perform).not.toHaveBeenCalled();
  });

  it("End Work while idle does nothing", async () => {
    h.me = me("idle");
    await openScan();
    await scan("tag-end-work");
    noWorkChange();
  });

  it("a row tag on a break never ends the break", async () => {
    h.me = me("break", "act-wind");
    await openScan();
    await scan("tag-row-7");
    expect(await screen.findByText("You're on a break. End your break first.")).toBeInTheDocument();
    noWorkChange();
  });

  it("the on-screen buttons are still there", async () => {
    h.me = me("idle");
    render(<HomeScreen />);
    expect(await screen.findByRole("button", { name: "Scan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a job" })).toBeInTheDocument();
    cleanup();
    h.me = me("work", "act-clean");
    render(<HomeScreen />);
    expect(await screen.findByRole("button", { name: "Cleaning" })).toBeInTheDocument();
  });
});

describe("Android Home: unchanged", () => {
  it("action tags aren't acted on", async () => {
    h.ios = false;
    h.me = me("work", "act-wind");
    await openScan();
    await scan("tag-start-break");
    noWorkChange();
  });
});
