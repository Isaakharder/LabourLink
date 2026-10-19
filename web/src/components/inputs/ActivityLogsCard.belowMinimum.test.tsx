// Inputs → Activity details: a finished run shorter than its activity's
// Minimum duration gets the whole row tinted light orange, with a
// "Below N-minute minimum" tooltip and screen-reader text — visual review
// guidance only. The server decides isBelowMinimumDuration from the
// unrounded worked seconds (see inputs.belowMinimumDuration.test.ts); this
// file proves the card renders that flag faithfully and that selection,
// hover, Edit and Delete keep working on a flagged row. The CSS block at the
// bottom guards that hover/selection layer over the orange instead of
// replacing it (jsdom doesn't paint, so the rule itself is what's checked).
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLogsCard } from "./ActivityLogsCard";
import { ActivityRunDto } from "../../lib/inputsTypes";

afterEach(() => {
  cleanup();
});

function makeRun(overrides: Partial<ActivityRunDto> = {}): ActivityRunDto {
  return {
    id: "run-1",
    activityId: "act-peppers",
    activityName: "Picking Peppers",
    normalSpeedPerHour: null,
    activityDensitySource: null,
    densityType: null,
    calculatedSpeedPerHour: null,
    isUnresolvedRowCompletion: false,
    rowCompletion: null,
    segmentIds: ["run-1"],
    durationSeconds: 124,
    minimumDurationMinutes: 3,
    isBelowMinimumDuration: true,
    startedAt: "2026-10-13T14:00:00.000Z",
    currentSegmentStartedAt: "2026-10-13T14:00:00.000Z",
    endedAt: "2026-10-13T14:02:04.000Z",
    startedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtOriginalTime: null,
    endedAtCorrectedFrom: null,
    isOpen: false,
    canEdit: true,
    row: { id: "row-1", label: "Phase 1 · Row 4" },
    carrier: null,
    autoClosed: false,
    manualEntry: null,
    ...overrides,
  };
}

const employee = { id: "emp-1", firstName: "Isaak", lastName: "Harder", photoUrl: null };

function renderCard(
  runs: ActivityRunDto[],
  opts: { selectedRunId?: string | null; onSelectRun?: () => void; onStartEdit?: () => void } = {}
) {
  const props = {
    employee,
    date: "2026-10-13",
    runs,
    totals: { workedSeconds: 600, breakSeconds: 0 },
    selectedRunId: opts.selectedRunId ?? null,
    onSelectRun: opts.onSelectRun ?? vi.fn(),
    editingRunId: null,
    editStartTimeValue: "",
    editEndTimeValue: "",
    onStartEdit: opts.onStartEdit ?? vi.fn(),
    onEditStartTimeChange: vi.fn(),
    onEditEndTimeChange: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onRowCompletionChanged: vi.fn(),
    saving: false,
  };
  const result = render(<ActivityLogsCard {...props} />);
  return { ...result, rerenderRuns: (next: ActivityRunDto[]) => result.rerender(<ActivityLogsCard {...props} runs={next} />) };
}

const rowFor = (index: number) => document.querySelectorAll("tbody tr")[index] as HTMLTableRowElement;

describe("ActivityLogsCard — below-minimum warning", () => {
  it("tints only the flagged rows, with a tooltip and accessible label naming that activity's minimum", () => {
    renderCard([
      makeRun({ id: "short", durationSeconds: 179, isBelowMinimumDuration: true }),
      makeRun({ id: "exact", durationSeconds: 180, isBelowMinimumDuration: false }),
      makeRun({ id: "long", durationSeconds: 600, isBelowMinimumDuration: false }),
      makeRun({
        id: "other",
        activityId: "act-tomatoes",
        activityName: "Picking Tomatoes",
        durationSeconds: 400,
        minimumDurationMinutes: 10,
        isBelowMinimumDuration: true,
      }),
    ]);
    const [short, exact, long, other] = [0, 1, 2, 3].map(rowFor);
    expect(short).toHaveClass("inputs-log-row", "inputs-log-row-below-minimum");
    expect(short).toHaveAttribute("title", "Below 3-minute minimum");
    expect(short).toHaveTextContent("Below 3-minute minimum");
    for (const row of [exact, long]) {
      expect(row).not.toHaveClass("inputs-log-row-below-minimum");
      expect(row).not.toHaveAttribute("title");
      expect(row).not.toHaveTextContent("minimum");
    }
    // Each activity uses its own configured minimum in the label.
    expect(other).toHaveClass("inputs-log-row-below-minimum");
    expect(other).toHaveAttribute("title", "Below 10-minute minimum");
    // No extra column — the table still has its 8 header cells.
    expect(document.querySelectorAll("thead th").length).toBe(8);
  });

  it("never flags an in-progress run", () => {
    renderCard([makeRun({ isOpen: true, endedAt: null, canEdit: false, durationSeconds: 0, isBelowMinimumDuration: false })]);
    expect(rowFor(0)).not.toHaveClass("inputs-log-row-below-minimum");
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
  });

  it("treats a manual entry the same way and keeps its Manually added badge", () => {
    renderCard([
      makeRun({ manualEntry: { createdByEmployeeId: "admin", createdByName: "Ada Admin", creationReason: "Forgot phone" } }),
    ]);
    expect(rowFor(0)).toHaveClass("inputs-log-row-below-minimum");
    expect(screen.getByText("Manually added")).toBeInTheDocument();
  });

  it("keeps the warning on a selected row alongside the selected styling, with its delete checkbox and Edit still working", () => {
    const onSelectRun = vi.fn();
    const onStartEdit = vi.fn();
    renderCard([makeRun()], { selectedRunId: "run-1", onSelectRun, onStartEdit });
    const row = rowFor(0);
    expect(row).toHaveClass("inputs-log-row-selected", "inputs-log-row-below-minimum");
    const checkbox = within(row).getByRole("checkbox");
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onSelectRun).toHaveBeenCalledWith("run-1", true);
    fireEvent.click(row.querySelector(".inputs-log-starttime")!);
    expect(onStartEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1" }));
  });

  it("selects a flagged row on click like any other row", () => {
    const onSelectRun = vi.fn();
    renderCard([makeRun()], { onSelectRun });
    fireEvent.click(rowFor(0));
    expect(onSelectRun).toHaveBeenCalledWith("run-1", false);
  });

  it("drops the warning as soon as a refresh reports the corrected run meets the minimum", () => {
    const { rerenderRuns } = renderCard([makeRun()]);
    expect(rowFor(0)).toHaveClass("inputs-log-row-below-minimum");
    rerenderRuns([makeRun({ durationSeconds: 200, endedAt: "2026-10-13T14:03:20.000Z", isBelowMinimumDuration: false })]);
    expect(rowFor(0)).not.toHaveClass("inputs-log-row-below-minimum");
    expect(rowFor(0)).not.toHaveAttribute("title");
  });

  it("keeps a short carrier-change segment flagged while the long segment after it on the same row is not", () => {
    renderCard([
      makeRun({ id: "seg-a", carrier: { id: "c1", name: "Bin 1" }, durationSeconds: 8, isBelowMinimumDuration: true }),
      makeRun({ id: "seg-b", carrier: { id: "c2", name: "Bin 2" }, durationSeconds: 900, isBelowMinimumDuration: false }),
    ]);
    expect(rowFor(0)).toHaveClass("inputs-log-row-below-minimum");
    expect(rowFor(1)).not.toHaveClass("inputs-log-row-below-minimum");
  });
});

describe("below-minimum CSS", () => {
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    expect(m, `expected a CSS rule for ${selector}`).not.toBeNull();
    return m![1];
  };

  it("uses a translucent orange, never the danger red", () => {
    const body = rule(".inputs-log-row-below-minimum td");
    expect(body).toMatch(/background-color:\s*rgba\(251,\s*146,\s*60,\s*0\.\d+\)/);
    expect(body).not.toMatch(/--color-danger|#dc2626/);
  });

  it("keeps a selected flagged row orange, marking the selection with an outline instead of the blue tint", () => {
    const body = rule(".inputs-log-row-below-minimum.inputs-log-row-selected td");
    expect(body).toMatch(/background:\s*rgba\(251,\s*146,\s*60/);
    expect(body).toMatch(/box-shadow:[^;]*var\(--color-primary\)/);
    // Must come after the plain selected rule so it wins on equal footing.
    expect(css.indexOf(".inputs-log-row-below-minimum.inputs-log-row-selected td")).toBeGreaterThan(
      css.indexOf(".inputs-log-row-selected td")
    );
  });

  it("stays orange on hover", () => {
    expect(rule(".inputs-log-row-below-minimum:hover td")).toMatch(/background:\s*rgba\(251,\s*146,\s*60/);
  });
});
