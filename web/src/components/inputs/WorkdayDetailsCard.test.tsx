// @vitest-environment jsdom
//
// Workday details shows each break's effective (possibly rounded) times
// only — there is deliberately no "Rounded" badge, even when a break's
// startedAtOriginalTime/endedAtOriginalTime (the employee's raw tap, kept
// alongside the effective value — see server/src/routes/inputs.ts and
// mobileTime.ts's break/start and break/end routes) differs. That raw tap
// stays in the API data and audit history; this is display-only. The other
// provenance/status badges (Auto-added, Manually added, Auto-closed, In
// progress) are unaffected. Renders WorkdayDetailsCard directly with
// fabricated BreakDtos, same convention as InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkdayDetailsCard } from "./WorkdayDetailsCard";
import { BreakDto } from "../../lib/inputsTypes";
import { formatTimeInAppTimezone } from "../../lib/timezone";

// This project's vitest config doesn't set testing-library's auto-cleanup
// globals, so each render must be explicitly unmounted — otherwise a later
// test's queries would also match DOM left over from an earlier render in
// the same file (same convention as InputsPage.switching.test.tsx).
afterEach(() => {
  cleanup();
});

function makeBreak(overrides: Partial<BreakDto> = {}): BreakDto {
  return {
    id: "break-1",
    startedAt: "2026-08-15T16:00:00.000Z",
    endedAt: "2026-08-15T16:15:00.000Z",
    startedAtOriginalTime: null,
    endedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtCorrectedFrom: null,
    durationSeconds: 900,
    name: "Break",
    isPaid: false,
    source: "manual",
    breakProfileItemId: null,
    canEdit: true,
    autoClosed: false,
    manualEntry: null,
    ...overrides,
  };
}

function renderCard(breaks: BreakDto[]) {
  return render(
    <WorkdayDetailsCard
      workStartTime="2026-08-15T14:00:00.000Z"
      workStartCorrectedFrom={null}
      workStartManualEntry={null}
      breaks={breaks}
      paidBreakSeconds={0}
      unpaidBreakSeconds={900}
      selectedBreakId={null}
      onSelectBreak={vi.fn()}
      editingBreak={null}
      editBreakTimeValue=""
      onStartEditBreak={vi.fn()}
      onEditBreakTimeChange={vi.fn()}
      onSaveEditBreak={vi.fn()}
      onCancelEditBreak={vi.fn()}
      editingWorkStart={false}
      editWorkStartTimeValue=""
      onStartEditWorkStart={vi.fn()}
      onEditWorkStartTimeChange={vi.fn()}
      onSaveEditWorkStart={vi.fn()}
      onCancelEditWorkStart={vi.fn()}
    />
  );
}

describe("WorkdayDetailsCard — no Rounded badge", () => {
  it("never shows a Rounded badge, even when a break's start and end were both rounded", () => {
    renderCard([
      makeBreak({
        id: "b1",
        startedAt: "2026-08-15T16:00:00.000Z",
        startedAtOriginalTime: "2026-08-15T15:55:42.000Z",
        endedAt: "2026-08-15T16:15:00.000Z",
        endedAtOriginalTime: "2026-08-15T16:13:53.000Z",
      }),
    ]);
    expect(screen.queryByText("Rounded")).toBeNull();
    expect(document.querySelector(".inputs-rounded-badge")).toBeNull();
  });

  it("shows the effective (rounded) times, never the raw tap times", () => {
    renderCard([
      makeBreak({
        id: "b1",
        name: "Morning break",
        startedAt: "2026-08-15T16:00:00.000Z",
        startedAtOriginalTime: "2026-08-15T15:55:42.000Z",
        endedAt: "2026-08-15T16:15:00.000Z",
        endedAtOriginalTime: "2026-08-15T16:13:53.000Z",
      }),
    ]);
    const row = screen.getByText("Morning break").closest("tr") as HTMLElement;
    expect(within(row).getByText(formatTimeInAppTimezone("2026-08-15T16:00:00.000Z"))).toBeInTheDocument();
    expect(within(row).getByText(formatTimeInAppTimezone("2026-08-15T16:15:00.000Z"))).toBeInTheDocument();
    expect(row).not.toHaveTextContent(formatTimeInAppTimezone("2026-08-15T15:55:42.000Z"));
    expect(row).not.toHaveTextContent(formatTimeInAppTimezone("2026-08-15T16:13:53.000Z"));
    // Not even as a tooltip — the raw tap lives in the data/audit history only.
    expect(row.querySelector("[title*='Actual tap time']")).toBeNull();
  });

  it("keeps the other badges: Auto-added, Manually added and Auto-closed", () => {
    renderCard([
      makeBreak({
        id: "b1",
        name: "Coffee",
        source: "auto",
        autoClosed: true,
        startedAtOriginalTime: "2026-08-15T15:55:42.000Z",
      }),
      makeBreak({
        id: "b2",
        name: "Lunch",
        startedAt: "2026-08-15T18:00:00.000Z",
        endedAt: "2026-08-15T18:30:00.000Z",
        manualEntry: { createdByEmployeeId: "admin", createdByName: "Ada Admin", creationReason: "Missed tap" },
      }),
    ]);
    expect(screen.getByText("Auto-added")).toBeInTheDocument();
    expect(screen.getByText("Auto-closed")).toBeInTheDocument();
    expect(screen.getByText("Manually added")).toBeInTheDocument();
    expect(screen.queryByText("Rounded")).toBeNull();
  });

  it("still shows In progress for an open break", () => {
    renderCard([makeBreak({ id: "b1", endedAt: null, endedAtOriginalTime: null, durationSeconds: 0 })]);
    // Once in the End Time cell, once in the Unpaid Time cell.
    expect(screen.getAllByText("In progress")).toHaveLength(2);
  });

  it("shows the Work start time without a Rounded badge", () => {
    renderCard([]);
    const row = screen.getByText("Work start time").closest("tr") as HTMLElement;
    expect(within(row).getByText(formatTimeInAppTimezone("2026-08-15T14:00:00.000Z"))).toBeInTheDocument();
    expect(within(row).queryByText("Rounded")).toBeNull();
  });
});
