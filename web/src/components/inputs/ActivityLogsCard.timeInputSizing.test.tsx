// Regression coverage for the Safari/WebKit End Time editor sizing
// investigation: input[type="time"] sitting as a flex child next to the
// Save/Cancel buttons (inside .inputs-endtime-editor) used to be the ONLY
// shrinkable item in that row — Safari's own min-content floor for this
// native control is effectively near-zero, so it collapsed to a few
// unreadable pixels there while Chrome (whose floor is more generous) never
// showed the bug. The fix is the shared .inputs-time-input class (explicit
// width + min-width + flex-shrink: 0 — see index.css's own comment on it),
// applied to every inline time editor on this page. This test proves both
// the Start Time and End Time inputs actually receive that class — jsdom
// doesn't lay out native form controls, so it can't reproduce the visual
// collapse itself, but it can (and must) prove the fix's class/DOM
// contract holds, which is what index.css's sizing rule keys off of. Real
// rendering was confirmed separately against real macOS Safari at desktop,
// ~1040px-narrow, and iPad-portrait widths (see the investigation notes).
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLogsCard } from "./ActivityLogsCard";
import { ActivityRunDto } from "../../lib/inputsTypes";

// This project's vitest config doesn't set testing-library's auto-cleanup
// globals — same convention as WorkdayDetailsCard.test.tsx.
afterEach(() => {
  cleanup();
});

function makeRun(overrides: Partial<ActivityRunDto> = {}): ActivityRunDto {
  return {
    id: "run-1",
    activityId: "act-1",
    activityName: "Picking",
    normalSpeedPerHour: null,
    activityDensitySource: null,
    densityType: null,
    calculatedSpeedPerHour: null,
    isUnresolvedRowCompletion: false,
    rowCompletion: null,
    segmentIds: ["run-1"],
    durationSeconds: 7200,
    startedAt: "2026-08-15T14:00:00.000Z",
    currentSegmentStartedAt: "2026-08-15T14:00:00.000Z",
    endedAt: "2026-08-15T16:00:00.000Z",
    startedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtOriginalTime: null,
    endedAtCorrectedFrom: null,
    isOpen: false,
    canEdit: true,
    row: null,
    carrier: null,
    autoClosed: false,
    manualEntry: null,
    ...overrides,
  };
}

const employee = { id: "emp-1", firstName: "Isaak", lastName: "Harder", photoUrl: null };

function renderCard(run: ActivityRunDto, editingRunId: string | null) {
  return render(
    <ActivityLogsCard
      employee={employee}
      date="2026-08-15"
      runs={[run]}
      totals={{ workedSeconds: 7200, breakSeconds: 0 }}
      selectedRunId={run.id}
      onSelectRun={vi.fn()}
      editingRunId={editingRunId}
      editStartTimeValue="14:00:00"
      editEndTimeValue="16:00:00"
      onStartEdit={vi.fn()}
      onEditStartTimeChange={vi.fn()}
      onEditEndTimeChange={vi.fn()}
      onSaveEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onDeleteRun={vi.fn()}
      onRowCompletionChanged={vi.fn()}
      saving={false}
    />
  );
}

describe("ActivityLogsCard — inline time editor sizing", () => {
  it("gives the Start Time input the non-collapsing inputs-time-input class while editing", () => {
    renderCard(makeRun(), "run-1");
    const inputs = document.querySelectorAll('input[type="time"]');
    expect(inputs.length).toBe(2);
    for (const input of Array.from(inputs)) {
      expect(input).toHaveClass("inputs-time-input");
    }
  });

  it("keeps the End Time input's non-collapsing class alongside Save/Cancel inside the same flex editor", () => {
    renderCard(makeRun(), "run-1");
    const saveButton = screen.getByRole("button", { name: "Save" });
    const editor = saveButton.closest(".inputs-endtime-editor");
    expect(editor).not.toBeNull();
    const endTimeInput = editor!.querySelector('input[type="time"]');
    expect(endTimeInput).toHaveClass("inputs-time-input");
    // Save/Cancel must never be able to squeeze the input out — this is
    // the actual CSS mechanism (flex-shrink: 0 on .inputs-time-input,
    // matching the buttons' own existing flex-shrink: 0) the class name
    // stands in for here.
    expect(screen.getByRole("button", { name: "Cancel" }).closest(".inputs-endtime-editor")).toBe(editor);
  });

  it("renders no inline time inputs at all when the run isn't being edited", () => {
    renderCard(makeRun(), null);
    expect(document.querySelectorAll('input[type="time"]').length).toBe(0);
  });

  it("applies the class consistently across every editable run, not just the first", () => {
    const runA = makeRun({ id: "run-a" });
    const runB = makeRun({ id: "run-b", activityName: "Sorting" });
    render(
      <ActivityLogsCard
        employee={employee}
        date="2026-08-15"
        runs={[runA, runB]}
        totals={{ workedSeconds: 14400, breakSeconds: 0 }}
        selectedRunId="run-b"
        onSelectRun={vi.fn()}
        editingRunId="run-b"
        editStartTimeValue="14:00:00"
        editEndTimeValue="16:00:00"
        onStartEdit={vi.fn()}
        onEditStartTimeChange={vi.fn()}
        onEditEndTimeChange={vi.fn()}
        onSaveEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onDeleteRun={vi.fn()}
        onRowCompletionChanged={vi.fn()}
        saving={false}
      />
    );
    const inputs = document.querySelectorAll('input[type="time"]');
    expect(inputs.length).toBe(2);
    for (const input of Array.from(inputs)) {
      expect(input).toHaveClass("inputs-time-input");
    }
  });
});
