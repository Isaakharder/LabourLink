// @vitest-environment jsdom
//
// Tests the "Rounded" badge on break rows: it must appear exactly when a
// break's startedAtOriginalTime/endedAtOriginalTime (the employee's raw
// tap, kept alongside the possibly-rounded effective value — see
// server/src/routes/inputs.ts and mobileTime.ts's break/start and
// break/end routes) differs from the displayed startedAt/endedAt, and must
// never appear when they match or are null. Renders WorkdayDetailsCard
// directly with fabricated BreakDtos, same convention as
// InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkdayDetailsCard } from "./WorkdayDetailsCard";
import { BreakDto } from "../../lib/inputsTypes";

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
      workStartOriginalTime={null}
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
      onDeleteBreak={vi.fn()}
      editingWorkStart={false}
      editWorkStartTimeValue=""
      onStartEditWorkStart={vi.fn()}
      onEditWorkStartTimeChange={vi.fn()}
      onSaveEditWorkStart={vi.fn()}
      onCancelEditWorkStart={vi.fn()}
    />
  );
}

describe("WorkdayDetailsCard break rounding badge", () => {
  it("shows the Rounded badge on the start cell when startedAtOriginalTime differs from startedAt", () => {
    renderCard([
      makeBreak({
        id: "b1",
        startedAt: "2026-08-15T16:00:00.000Z",
        startedAtOriginalTime: "2026-08-15T15:55:42.000Z",
      }),
    ]);
    expect(screen.getAllByText("Rounded")).toHaveLength(1);
  });

  it("shows the Rounded badge on the end cell when endedAtOriginalTime differs from endedAt", () => {
    renderCard([
      makeBreak({
        id: "b1",
        endedAt: "2026-08-15T16:15:00.000Z",
        endedAtOriginalTime: "2026-08-15T16:13:53.000Z",
      }),
    ]);
    expect(screen.getAllByText("Rounded")).toHaveLength(1);
  });

  it("shows both badges when both start and end were rounded", () => {
    renderCard([
      makeBreak({
        id: "b1",
        startedAt: "2026-08-15T16:00:00.000Z",
        startedAtOriginalTime: "2026-08-15T15:55:42.000Z",
        endedAt: "2026-08-15T16:15:00.000Z",
        endedAtOriginalTime: "2026-08-15T16:13:53.000Z",
      }),
    ]);
    expect(screen.getAllByText("Rounded")).toHaveLength(2);
  });

  it("shows no badge when startedAtOriginalTime/endedAtOriginalTime are null (never rounded)", () => {
    renderCard([makeBreak({ id: "b1", startedAtOriginalTime: null, endedAtOriginalTime: null })]);
    expect(screen.queryByText("Rounded")).toBeNull();
  });

  it("shows no badge when startedAtOriginalTime/endedAtOriginalTime equal the effective values (rounding landed exactly on a boundary)", () => {
    renderCard([
      makeBreak({
        id: "b1",
        startedAt: "2026-08-15T16:00:00.000Z",
        startedAtOriginalTime: "2026-08-15T16:00:00.000Z",
        endedAt: "2026-08-15T16:15:00.000Z",
        endedAtOriginalTime: "2026-08-15T16:15:00.000Z",
      }),
    ]);
    expect(screen.queryByText("Rounded")).toBeNull();
  });

  it("shows no badge on an in-progress break's end cell (no endedAt yet)", () => {
    renderCard([
      makeBreak({
        id: "b1",
        endedAt: null,
        endedAtOriginalTime: null,
        durationSeconds: 0,
      }),
    ]);
    expect(screen.queryByText("Rounded")).toBeNull();
    // "In progress" legitimately appears twice for an open, unpaid break —
    // once in the End Time cell, once in the Unpaid Time cell.
    expect(screen.getAllByText("In progress")).toHaveLength(2);
  });

  it("scopes each break's badge to its own row across multiple breaks", () => {
    renderCard([
      makeBreak({
        id: "b1",
        name: "Morning break",
        startedAt: "2026-08-15T13:00:00.000Z",
        startedAtOriginalTime: "2026-08-15T12:55:42.000Z",
        endedAt: "2026-08-15T13:15:00.000Z",
        endedAtOriginalTime: "2026-08-15T13:15:00.000Z",
      }),
      makeBreak({
        id: "b2",
        name: "Afternoon break",
        startedAt: "2026-08-15T15:00:00.000Z",
        startedAtOriginalTime: "2026-08-15T15:00:00.000Z",
        endedAt: "2026-08-15T15:15:00.000Z",
        endedAtOriginalTime: "2026-08-15T15:15:00.000Z",
      }),
    ]);
    // Only b1's start was actually rounded — exactly one badge overall,
    // and it lives in b1's row, not b2's.
    expect(screen.getAllByText("Rounded")).toHaveLength(1);
    const b1Row = screen.getByText("Morning break").closest("tr") as HTMLElement;
    const b2Row = screen.getByText("Afternoon break").closest("tr") as HTMLElement;
    expect(within(b1Row).getByText("Rounded")).toBeInTheDocument();
    expect(within(b2Row).queryByText("Rounded")).toBeNull();
  });
});
