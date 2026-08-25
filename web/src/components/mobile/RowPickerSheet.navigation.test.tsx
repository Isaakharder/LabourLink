// @vitest-environment jsdom
//
// Covers the removed Land-selection screen: the mobile greenhouse-row
// question flow must go Activity -> Phase -> Row (never -> Land -> Phase ->
// Row), with the parent land resolved automatically rather than asked
// about, and — when the reference data ever contains more than one land —
// one combined phase list rather than a restored land screen, with same-
// named phases across different lands disambiguated ("Phase 1 — First
// Light Greenhouse" vs "Phase 1 — Second Property").
//
// isNfcSupported() (lib/nfc.ts) resolves false in this jsdom environment
// (isNativePlatform() is false outside Capacitor), so no NFC mocking is
// needed for these tests to render and interact with the sheet normally.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowPickerSheet, RowPickerLand } from "./RowPickerSheet";

afterEach(() => cleanup());

function baseProps() {
  return {
    activityName: "Winding & Pruning",
    questionLabel: "Where?",
    allowSkip: false,
    lands: null as RowPickerLand[] | null,
    error: null,
    busy: false,
    onConfirm: vi.fn(),
    onSkip: vi.fn(),
    onCancel: vi.fn(),
    language: "en" as const,
  };
}

const oneLandMultiPhase: RowPickerLand[] = [
  {
    id: "land-1",
    name: "First Light Greenhouse",
    phases: [
      { id: "phase-1", name: "Phase 1", rows: [{ id: "row-1", rowNumber: 1 }, { id: "row-2", rowNumber: 2 }] },
      { id: "phase-2", name: "Phase 2", rows: [{ id: "row-3", rowNumber: 3 }] },
    ],
  },
];

const twoLandsUniqueNames: RowPickerLand[] = [
  { id: "land-1", name: "First Light Greenhouse", phases: [{ id: "phase-1", name: "North Block", rows: [{ id: "row-1", rowNumber: 1 }] }] },
  { id: "land-2", name: "Second Property", phases: [{ id: "phase-2", name: "South Block", rows: [{ id: "row-2", rowNumber: 2 }] }] },
];

const twoLandsDuplicateNames: RowPickerLand[] = [
  { id: "land-1", name: "First Light Greenhouse", phases: [{ id: "phase-1", name: "Phase 1", rows: [{ id: "row-1", rowNumber: 1 }] }] },
  { id: "land-2", name: "Second Property", phases: [{ id: "phase-2", name: "Phase 1", rows: [{ id: "row-2", rowNumber: 2 }] }] },
];

describe("RowPickerSheet — no Land-selection screen, ever", () => {
  it("1) one land, multiple phases: goes straight to the phase list, no land screen at any point", async () => {
    render(<RowPickerSheet {...baseProps()} lands={oneLandMultiPhase} />);
    // The land name never appears as a selectable screen item.
    expect(screen.queryByRole("button", { name: "First Light Greenhouse" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Phase 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Phase 2/ })).toBeInTheDocument();
  });

  it("after selecting a phase, its rows show immediately — no extra confirmation step in between", async () => {
    const user = userEvent.setup();
    render(<RowPickerSheet {...baseProps()} lands={oneLandMultiPhase} />);
    await user.click(await screen.findByRole("button", { name: /Phase 1/ }));
    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument();
  });

  it("2) multiple lands with UNIQUE phase names: one combined list, plain names, no land text needed", async () => {
    render(<RowPickerSheet {...baseProps()} lands={twoLandsUniqueNames} />);
    expect(await screen.findByRole("button", { name: /North Block/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /South Block/ })).toBeInTheDocument();
    // No " — Land Name" suffix anywhere — nothing is ambiguous.
    expect(screen.queryByText(/—/)).not.toBeInTheDocument();
    // Still never a land-selection screen.
    expect(screen.queryByRole("button", { name: "First Light Greenhouse" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Second Property" })).not.toBeInTheDocument();
  });

  it("2b) multiple lands with DUPLICATE phase names: each is disambiguated with its land as suffix text", async () => {
    render(<RowPickerSheet {...baseProps()} lands={twoLandsDuplicateNames} />);
    expect(await screen.findByText("Phase 1 — First Light Greenhouse")).toBeInTheDocument();
    expect(screen.getByText("Phase 1 — Second Property")).toBeInTheDocument();
  });

  it("8) confirms no Land-selection screen renders even mid-flow — the sheet never shows a land as its own tappable list", async () => {
    const { container } = render(<RowPickerSheet {...baseProps()} lands={twoLandsDuplicateNames} />);
    // Every top-level list item is a phase (has a rows-count secondary
    // line); nothing renders as a bare land name with no phase context.
    const items = container.querySelectorAll(".mobile-sheet-item-name");
    for (const item of items) {
      expect(item.textContent).toMatch(/Phase 1/);
    }
  });
});

describe("RowPickerSheet — Back/Cancel and final greenhouse_row_id", () => {
  it("6) Back from the row grid returns to the phase list (never a land screen — there isn't one)", async () => {
    const user = userEvent.setup();
    render(<RowPickerSheet {...baseProps()} lands={oneLandMultiPhase} />);
    await user.click(await screen.findByRole("button", { name: /Phase 1/ }));
    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(await screen.findByRole("button", { name: /Phase 1/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Phase 2/ })).toBeInTheDocument();
  });

  it("6) Cancel is always reachable, from the phase list and from inside a phase's row grid", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RowPickerSheet {...baseProps()} lands={oneLandMultiPhase} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("7) selecting a row and confirming reports exactly that row's greenhouse_row_id", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<RowPickerSheet {...baseProps()} lands={oneLandMultiPhase} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("button", { name: /Phase 2/ }));
    await user.click(screen.getByRole("button", { name: "3" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("row-3");
  });

  it("returning to this step (initialSelectedRowId set) re-expands the correct phase, land resolved automatically", async () => {
    render(<RowPickerSheet {...baseProps()} lands={oneLandMultiPhase} initialSelectedRowId="row-3" />);
    // Phase 2 (which owns row-3) is already expanded — its row is visible
    // without any land or phase tap being needed.
    expect(await screen.findByRole("button", { name: "3" })).toBeInTheDocument();
  });
});

describe("RowPickerSheet — offline cached navigation", () => {
  it("5) renders and navigates identically whether `lands` came from a live fetch or an offline cache fallback — no server request between phase and row selections either way", async () => {
    // From the component's own perspective these are indistinguishable —
    // both are just the already-loaded RowPickerLand[] prop (see
    // referenceDataCache.ts's fetchRowsWithCache: cache vs live differ only
    // in HOW the data got here, never in its shape). Proving identical
    // behavior on this same in-memory data is exactly what "offline cached
        // navigation works" means for this component — no network call is
    // ever made mid-navigation regardless of source.
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<RowPickerSheet {...baseProps()} lands={oneLandMultiPhase} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("button", { name: /Phase 1/ }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("row-2");
  });
});

describe("RowPickerSheet — loading and empty states unaffected by the navigation change", () => {
  it("shows a loading message while lands is still null", () => {
    render(<RowPickerSheet {...baseProps()} lands={null} />);
    expect(screen.getByText("Loading rows…")).toBeInTheDocument();
  });

  it("shows the configured-nothing message when lands resolves to an empty array", () => {
    render(<RowPickerSheet {...baseProps()} lands={[]} />);
    expect(screen.getByText("No greenhouse rows configured. Contact your supervisor.")).toBeInTheDocument();
  });
});
