// @vitest-environment jsdom
//
// Sync conflicts page with real-shaped data. Regression: opening the page
// crashed the whole app whenever there was at least one conflict, because
// each row's full timestamp ("2026-10-12T16:54:15.605Z") went to
// formatDateLong, which only accepts a plain "YYYY-MM-DD" date and threw
// "RangeError: Invalid time value" during render.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncConflictsPage } from "./SyncConflictsPage";

let conflicts: unknown[] = [];

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { ApiError, api: vi.fn(async () => ({ conflicts })) };
});
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ employee: null }) }));

afterEach(cleanup);

function conflict(overrides: Record<string, unknown>) {
  return {
    id: "1",
    clientEventId: "e1a79ae2-ba93-4aeb-a3a2-752593434e09",
    deviceName: "Ulefone",
    employeeName: "Khen Lagto",
    deviceSeq: 12,
    eventType: "activity_switch",
    occurredAtUtc: "2026-10-12T16:54:15.605Z",
    receivedAt: "2026-10-12T16:54:20.000Z",
    processingStatus: "accepted",
    conflictReason: "Applied before the rounded work-start boundary",
    conflictDetail: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides,
  };
}

describe("SyncConflictsPage", () => {
  it("shows conflicts with their date and time in the organization's time zone", async () => {
    conflicts = [
      conflict({}),
      // 00:30 UTC on Oct 9 is still the evening of Thursday Oct 8 in Toronto.
      conflict({ id: "2", processingStatus: "permanent_conflict", occurredAtUtc: "2026-10-09T00:30:00.000Z", conflictReason: "midnight cutoff" }),
    ];
    render(<SyncConflictsPage />);
    expect((await screen.findAllByText("Khen Lagto")).length).toBe(2);
    const cells = screen.getAllByText(/2026/).map((el) => el.textContent);
    expect(cells).toEqual(["Monday, October 12, 2026 12:54:15 PM", "Thursday, October 8, 2026 8:30:00 PM"]);
  });

  it("never blanks the page on a malformed timestamp", async () => {
    conflicts = [conflict({ occurredAtUtc: "null" })];
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SyncConflictsPage />);
    expect(await screen.findByText("Khen Lagto")).toBeInTheDocument();
    expect(screen.getByText(/Unknown date/)).toBeInTheDocument();
  });
});
