// Regression coverage for the same Safari/WebKit time-input sizing fix as
// ActivityLogsCard.timeInputSizing.test.tsx, applied here to the Workday
// details card's three inline editors (work-start, break-start, break-end)
// — they share the same .inputs-time-editor flex wrapper pattern as
// ActivityLogsCard's End Time editor (input + Save + Cancel), so they were
// exposed to the identical collapse risk even though the originally
// reported bug was specifically the Activity Logs table's End Time column.
// See index.css's .inputs-time-input comment for the underlying mechanism.
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkdayDetailsCard } from "./WorkdayDetailsCard";
import { BreakDto } from "../../lib/inputsTypes";

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

describe("WorkdayDetailsCard — inline time editor sizing", () => {
  it("gives the work-start editor's input the non-collapsing inputs-time-input class", () => {
    render(
      <WorkdayDetailsCard
        workStartTime="2026-08-15T14:00:00.000Z"
        workStartOriginalTime={null}
        workStartCorrectedFrom={null}
        workStartManualEntry={null}
        breaks={[]}
        paidBreakSeconds={0}
        unpaidBreakSeconds={0}
        selectedBreakId={null}
        onSelectBreak={vi.fn()}
        editingBreak={null}
        editBreakTimeValue=""
        onStartEditBreak={vi.fn()}
        onEditBreakTimeChange={vi.fn()}
        onSaveEditBreak={vi.fn()}
        onCancelEditBreak={vi.fn()}
        onDeleteBreak={vi.fn()}
        editingWorkStart={true}
        editWorkStartTimeValue="14:00:00"
        onStartEditWorkStart={vi.fn()}
        onEditWorkStartTimeChange={vi.fn()}
        onSaveEditWorkStart={vi.fn()}
        onCancelEditWorkStart={vi.fn()}
      />
    );
    const input = document.querySelector('input[type="time"]');
    expect(input).not.toBeNull();
    expect(input).toHaveClass("inputs-time-input");
  });

  it("gives both the break-start and break-end editors' inputs the non-collapsing class, one row at a time", () => {
    const brk = makeBreak();

    const { unmount } = render(
      <WorkdayDetailsCard
        workStartTime="2026-08-15T14:00:00.000Z"
        workStartOriginalTime={null}
        workStartCorrectedFrom={null}
        workStartManualEntry={null}
        breaks={[brk]}
        paidBreakSeconds={0}
        unpaidBreakSeconds={900}
        selectedBreakId={brk.id}
        onSelectBreak={vi.fn()}
        editingBreak={{ id: brk.id, field: "start" }}
        editBreakTimeValue="16:00:00"
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
    let input = document.querySelector('input[type="time"]');
    expect(input).not.toBeNull();
    expect(input).toHaveClass("inputs-time-input");
    // Save/Cancel share the same flex row as the input (the exact
    // collapse-prone layout) — confirm the input is still inside it.
    expect(screen.getByRole("button", { name: "Save" }).closest(".inputs-time-editor")).toContainElement(
      input as HTMLElement
    );
    unmount();

    render(
      <WorkdayDetailsCard
        workStartTime="2026-08-15T14:00:00.000Z"
        workStartOriginalTime={null}
        workStartCorrectedFrom={null}
        workStartManualEntry={null}
        breaks={[brk]}
        paidBreakSeconds={0}
        unpaidBreakSeconds={900}
        selectedBreakId={brk.id}
        onSelectBreak={vi.fn()}
        editingBreak={{ id: brk.id, field: "end" }}
        editBreakTimeValue="16:15:00"
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
    input = document.querySelector('input[type="time"]');
    expect(input).not.toBeNull();
    expect(input).toHaveClass("inputs-time-input");
  });

  it("renders no inline time inputs when nothing is being edited", () => {
    render(
      <WorkdayDetailsCard
        workStartTime="2026-08-15T14:00:00.000Z"
        workStartOriginalTime={null}
        workStartCorrectedFrom={null}
        workStartManualEntry={null}
        breaks={[makeBreak()]}
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
    expect(document.querySelectorAll('input[type="time"]').length).toBe(0);
  });
});
