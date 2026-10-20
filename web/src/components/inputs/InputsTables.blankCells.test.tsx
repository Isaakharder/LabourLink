// @vitest-environment jsdom
//
// Inputs tables: the Row column shows just "Row <n>" (phase in the tooltip),
// and a cell with no data is left blank, with no "—" placeholder, in both
// Activity details and Workday details. Real values, including zero, still show.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLogsCard, rowNumberLabel } from "./ActivityLogsCard";
import { WorkdayDetailsCard } from "./WorkdayDetailsCard";
import { ActivityRunDto, BreakDto } from "../../lib/inputsTypes";

afterEach(() => {
  cleanup();
});

function makeRun(overrides: Partial<ActivityRunDto> = {}): ActivityRunDto {
  return {
    id: "run-1",
    activityId: "act-1",
    activityName: "Picking Peppers",
    normalSpeedPerHour: null,
    activityDensitySource: null,
    densityType: null,
    calculatedSpeedPerHour: null,
    isUnresolvedRowCompletion: false,
    rowCompletion: null,
    segmentIds: ["run-1"],
    durationSeconds: 7200,
    minimumDurationMinutes: 0,
    isBelowMinimumDuration: false,
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
    name: "Lunch",
    isPaid: false,
    source: "auto",
    breakProfileItemId: null,
    canEdit: true,
    autoClosed: false,
    manualEntry: null,
    ...overrides,
  };
}

function renderActivity(runs: ActivityRunDto[]) {
  return render(
    <ActivityLogsCard
      employee={{ id: "emp-1", firstName: "Khen", lastName: "Lagto", photoUrl: null }}
      date="2026-08-15"
      runs={runs}
      totals={{ workedSeconds: 7200, breakSeconds: 0 }}
      selectedRunId={null}
      onSelectRun={vi.fn()}
      editingRunId={null}
      editStartTimeValue=""
      editEndTimeValue=""
      onStartEdit={vi.fn()}
      onEditStartTimeChange={vi.fn()}
      onEditEndTimeChange={vi.fn()}
      onSaveEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onRowCompletionChanged={vi.fn()}
      saving={false}
    />
  );
}

function renderWorkday(breaks: BreakDto[], workStartTime: string | null = "2026-08-15T14:00:00.000Z") {
  return render(
    <WorkdayDetailsCard
      workStartTime={workStartTime}
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

const cell = (table: string, row: number, column: string) =>
  document.querySelector(`${table} tbody tr:nth-child(${row}) ${column}`) as HTMLElement;

describe("rowNumberLabel", () => {
  it("keeps only the row part of the server's '<phase> · Row <n>' label", () => {
    expect(rowNumberLabel("Phase 2 · Row 102")).toBe("Row 102");
    expect(rowNumberLabel("North · East · Row 7")).toBe("Row 7");
  });

  it("shows any other label shape unchanged", () => {
    expect(rowNumberLabel("Bay 4")).toBe("Bay 4");
  });
});

describe("Activity details", () => {
  it("shows only 'Row <n>' in the Row column, with the full label in the tooltip", () => {
    renderActivity([makeRun({ row: { id: "r-102", label: "Phase 2 · Row 102" } })]);
    const rowCell = cell(".inputs-logs-table", 1, ".inputs-log-row-cell");
    expect(rowCell).toHaveTextContent(/^Row 102$/);
    expect(rowCell.querySelector("span")).toHaveAttribute("title", "Phase 2 · Row 102");
    expect(screen.queryByText(/Phase 2/)).toBeNull();
  });

  it("leaves Row, Carrier, Speed and End Time blank when there's no data — no '—'", () => {
    renderActivity([makeRun({ endedAt: null, isOpen: false })]);
    for (const column of [".inputs-log-row-cell", ".inputs-log-carrier-cell", ".inputs-log-speed", ".inputs-log-endtime"]) {
      expect(cell(".inputs-logs-table", 1, column)).toBeEmptyDOMElement();
    }
    expect(document.querySelector(".inputs-logs-table")).not.toHaveTextContent("—");
  });

  it("leaves Speed blank for a non-finite speed value", () => {
    renderActivity([makeRun({ activityDensitySource: "stems", calculatedSpeedPerHour: { value: NaN, unit: "stems" } })]);
    expect(cell(".inputs-logs-table", 1, ".inputs-log-speed")).toBeEmptyDOMElement();
  });

  it("still shows real values, including zero", () => {
    renderActivity([
      makeRun({
        durationSeconds: 0,
        activityDensitySource: "stems",
        calculatedSpeedPerHour: { value: 0, unit: "stems" },
        carrier: { id: "c-3", name: "Cart 3" },
      }),
    ]);
    expect(cell(".inputs-logs-table", 1, ".inputs-log-duration")).toHaveTextContent("0:00:00");
    expect(cell(".inputs-logs-table", 1, ".inputs-log-speed")).toHaveTextContent("0.0 stems");
    expect(cell(".inputs-logs-table", 1, ".inputs-log-carrier-cell")).toHaveTextContent("Cart 3");
  });

  it("keeps 'In progress' for an open run's End Time", () => {
    renderActivity([makeRun({ endedAt: null, isOpen: true })]);
    expect(cell(".inputs-logs-table", 1, ".inputs-log-endtime")).toHaveTextContent("In progress");
  });
});

describe("Workday details", () => {
  it("leaves the Work start row's empty cells blank — no '—'", () => {
    renderWorkday([]);
    const cells = [...document.querySelectorAll(".inputs-workday-table tbody tr:nth-child(1) td")];
    // select, name, start, end, paid, unpaid
    expect(cells.slice(3).every((td) => td.textContent === "")).toBe(true);
    expect(document.querySelector(".inputs-workday-table")).not.toHaveTextContent("—");
  });

  it("leaves Work start blank when the day has none", () => {
    renderWorkday([], null);
    expect(document.querySelector(".inputs-workday-table tbody tr:nth-child(1) td:nth-child(3)")).toBeEmptyDOMElement();
  });

  it("shows a break's duration only under Paid or Unpaid, leaving the other blank", () => {
    renderWorkday([makeBreak({ id: "unpaid", isPaid: false }), makeBreak({ id: "paid", name: "Tea", isPaid: true, durationSeconds: 0 })]);
    const durations = (row: number) =>
      [...document.querySelectorAll(`.inputs-workday-table tbody tr:nth-child(${row}) .inputs-workday-duration`)].map((td) => td.textContent);
    expect(durations(2)).toEqual(["", "0:15:00"]);
    // A real zero-length paid break still shows its 0:00:00.
    expect(durations(3)).toEqual(["0:00:00", ""]);
    expect(document.querySelector(".inputs-workday-table")).not.toHaveTextContent("—");
  });
});
