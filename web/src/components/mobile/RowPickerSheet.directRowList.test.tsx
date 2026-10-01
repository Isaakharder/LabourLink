// @vitest-environment jsdom
//
// Job selection's row step (directRowList): no intermediate phase screen —
// "Choose a row" lists every row from every phase at once, naturally sorted
// by row number, with a phase label only on row numbers that exist in more
// than one phase, and confirms the row's own id. Tag registration (no
// directRowList) must keep its phase -> row drill-down unchanged.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowPickerSheet, RowPickerLand } from "./RowPickerSheet";

afterEach(() => cleanup());

function baseProps() {
  return {
    activityName: "Picking Peppers",
    questionLabel: "Where?",
    allowSkip: false,
    lands: null as RowPickerLand[] | null,
    error: null,
    busy: false,
    onConfirm: vi.fn(),
    onSkip: vi.fn(),
    onCancel: vi.fn(),
    language: "en" as const,
    directRowList: true,
  };
}

// Phase 10 deliberately listed before Phase 2 to prove ordering doesn't
// depend on input order; row 12 exists in both Phase 2 and Phase 10.
const lands: RowPickerLand[] = [
  {
    id: "land-1",
    name: "First Light Greenhouse",
    phases: [
      {
        id: "phase-10",
        name: "Phase 10",
        rows: [
          { id: "p10-r12", rowNumber: 12 },
          { id: "p10-r101", rowNumber: 101 },
        ],
      },
      {
        id: "phase-2",
        name: "Phase 2",
        rows: [
          { id: "p2-r2", rowNumber: 2 },
          { id: "p2-r12", rowNumber: 12 },
          { id: "p2-r1", rowNumber: 1 },
        ],
      },
    ],
  },
];

function gridButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".mobile-row-grid-item"));
}

describe("RowPickerSheet directRowList (job selection)", () => {
  it("is titled 'Choose a row' and shows every row across phases with no phase-selection step", () => {
    render(<RowPickerSheet {...baseProps()} lands={lands} />);
    expect(screen.getByRole("heading", { name: "Choose a row" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose a row" })).toBeInTheDocument();
    expect(screen.queryByText("Where?")).not.toBeInTheDocument();
    // No phase list buttons ("Phase 2 / 3 rows") anywhere.
    expect(screen.queryByText(/rows$/)).not.toBeInTheDocument();
    expect(gridButtons()).toHaveLength(5);
  });

  it("sorts naturally by row number, with identical numbers ordered by phase naturally", () => {
    render(<RowPickerSheet {...baseProps()} lands={lands} />);
    expect(gridButtons().map((b) => b.dataset.rowId)).toEqual(["p2-r1", "p2-r2", "p2-r12", "p10-r12", "p10-r101"]);
  });

  it("labels only duplicated row numbers with their phase", () => {
    render(<RowPickerSheet {...baseProps()} lands={lands} />);
    const byId = Object.fromEntries(gridButtons().map((b) => [b.dataset.rowId, b]));
    expect(within(byId["p2-r12"]).getByText("Phase 2")).toBeInTheDocument();
    expect(within(byId["p10-r12"]).getByText("Phase 10")).toBeInTheDocument();
    expect(byId["p2-r1"].querySelector(".mobile-row-grid-item-phase")).toBeNull();
    expect(byId["p10-r101"].querySelector(".mobile-row-grid-item-phase")).toBeNull();
  });

  it("confirms the chosen duplicate row's own id, not its number", async () => {
    const onConfirm = vi.fn();
    render(<RowPickerSheet {...baseProps()} lands={lands} onConfirm={onConfirm} />);
    const byId = Object.fromEntries(gridButtons().map((b) => [b.dataset.rowId, b]));
    await userEvent.click(byId["p10-r12"]);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("p10-r12");
  });

  it("row-number search covers all phases and keeps the duplicate labels", async () => {
    render(<RowPickerSheet {...baseProps()} lands={lands} />);
    await userEvent.type(screen.getByPlaceholderText("Search row number"), "12");
    expect(gridButtons().map((b) => b.dataset.rowId)).toEqual(["p2-r12", "p10-r12"]);
    expect(screen.getByText("Phase 2")).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText("Search row number"));
    await userEvent.type(screen.getByPlaceholderText("Search row number"), "10");
    expect(gridButtons().map((b) => b.dataset.rowId)).toEqual(["p10-r101"]);
    await userEvent.clear(screen.getByPlaceholderText("Search row number"));
    await userEvent.type(screen.getByPlaceholderText("Search row number"), "7");
    expect(screen.getByText("No matching rows")).toBeInTheDocument();
  });

  it("disambiguates same-named phases in different lands the same way as before", () => {
    const twoLands: RowPickerLand[] = [
      { id: "l1", name: "First Light Greenhouse", phases: [{ id: "a", name: "Phase 1", rows: [{ id: "a-5", rowNumber: 5 }] }] },
      { id: "l2", name: "Second Property", phases: [{ id: "b", name: "Phase 1", rows: [{ id: "b-5", rowNumber: 5 }] }] },
    ];
    render(<RowPickerSheet {...baseProps()} lands={twoLands} />);
    expect(screen.getByText("Phase 1 — First Light Greenhouse")).toBeInTheDocument();
    expect(screen.getByText("Phase 1 — Second Property")).toBeInTheDocument();
  });

  it("pre-selects the prior row (Back / editing the current row)", () => {
    render(<RowPickerSheet {...baseProps()} lands={lands} initialSelectedRowId="p10-r12" />);
    const selected = document.querySelector(".mobile-row-grid-item-selected") as HTMLElement;
    expect(selected.dataset.rowId).toBe("p10-r12");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  it("keeps Skip (optional), Cancel, loading and empty states", async () => {
    const onSkip = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<RowPickerSheet {...baseProps()} lands={null} allowSkip onSkip={onSkip} onCancel={onCancel} />);
    expect(screen.getByText("Loading rows…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip — No row" }));
    expect(onSkip).toHaveBeenCalled();
    rerender(<RowPickerSheet {...baseProps()} lands={[]} allowSkip onSkip={onSkip} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("disables selection while a submission is in flight", () => {
    render(<RowPickerSheet {...baseProps()} lands={lands} busy />);
    expect(gridButtons().every((b) => b.disabled)).toBe(true);
  });
});

describe("RowPickerSheet without directRowList (tag registration) is unchanged", () => {
  it("still shows the question label and the phase list first", async () => {
    render(<RowPickerSheet {...baseProps()} directRowList={false} lands={lands} />);
    expect(screen.getByRole("heading", { name: "Where?" })).toBeInTheDocument();
    expect(gridButtons()).toHaveLength(0);
    await userEvent.click(screen.getByText("Phase 2"));
    expect(gridButtons().map((b) => b.dataset.rowId)).toEqual(["p2-r2", "p2-r12", "p2-r1"]);
    expect(screen.getByRole("button", { name: /Back/ })).toBeInTheDocument();
  });
});
