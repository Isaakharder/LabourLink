// Regression test for a real production incident: a fresh pairing on iOS
// Safari's standalone "Add to Home Screen" PWA left the Home screen stuck
// on "Loading..." forever. Root cause: foldPendingEventsOntoMe awaited the
// local SQLite event store (jeep-sqlite/IndexedDB on the web backend)
// unconditionally, and a documented WebKit bug lets an IndexedDB operation
// hang forever with no error in that exact browser/mode — nothing ever
// called setMe(), so the Home screen's "!me && !cachedEmployee" loading
// gate never cleared. This proves the timeout fallback added to fix it
// actually works, not just that it typechecks.
import { describe, expect, it, vi } from "vitest";

const { getLocalEventStoreMock } = vi.hoisted(() => ({
  getLocalEventStoreMock: vi.fn(),
}));

vi.mock("./localEventStore", () => ({
  getLocalEventStore: getLocalEventStoreMock,
}));

vi.mock("./referenceDataCache", () => ({}));

import { foldPendingEventsOntoMe } from "./localSessionState";
import { MeResponse } from "../context/WorkSessionContext";

const baseMe = { employee: { id: "emp-1" } } as unknown as MeResponse;

describe("foldPendingEventsOntoMe", () => {
  it("resolves with the untouched server response, not hanging forever, when the local store never responds", async () => {
    vi.useFakeTimers();
    getLocalEventStoreMock.mockReturnValue({
      getPendingEvents: () => new Promise(() => {}), // never resolves — the iOS PWA IndexedDB hang
    });

    const promise = foldPendingEventsOntoMe("device-1", baseMe);
    let settled = false;
    promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(3999);
    expect(settled).toBe(false); // hasn't given up yet — a healthy call could still land

    await vi.advanceTimersByTimeAsync(2);
    const result = await promise;
    expect(result).toBe(baseMe);

    vi.useRealTimers();
  });

  it("still folds normally when the local store responds quickly (the healthy path is unaffected)", async () => {
    getLocalEventStoreMock.mockReturnValue({
      getPendingEvents: () => Promise.resolve([]),
    });

    const result = await foldPendingEventsOntoMe("device-1", baseMe);
    expect(result).toBe(baseMe);
  });
});

describe("applyLocalEventToMe: bin_rescan (picking cycles)", () => {
  it("changes nothing on the phone: same job, row, bin and start time", async () => {
    const { applyLocalEventToMe } = await import("./localSessionState");
    const working = {
      employee: { id: "emp-1", firstName: "Ruben", lastName: "O", preferredLanguage: null, securityRole: "Employee" },
      status: "work",
      currentActivity: {
        id: "act-1",
        name: "Picking",
        startedAt: "2026-11-19T12:00:00Z",
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: 0,
        row: { id: "row-1", label: "Row 7" },
        carrier: { id: "bin-43", name: "Bin 43" },
      },
      since: null,
      previousActivity: null,
      recentJobs: [],
      features: { binRescan: true },
    } as unknown as MeResponse;
    const rescan = {
      deviceId: "d",
      employeeId: "emp-1",
      eventType: "bin_rescan",
      occurredAtUtc: "2026-11-19T13:00:00Z",
      activityId: "act-1",
      carrierId: "bin-43",
      answers: [{ questionId: "q", carrierId: "bin-43" }],
      clientEventId: "e",
      deviceSeq: 9,
    } as never;
    expect(applyLocalEventToMe(working, rescan, {})).toEqual(working);
  });
});
