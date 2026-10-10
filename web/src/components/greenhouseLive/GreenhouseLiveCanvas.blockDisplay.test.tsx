// @vitest-environment jsdom
//
// Display → Map block display (office preview and TV share this canvas and
// legend): rows are coloured only by work state — idle rows are the same
// uniform "no activity" style whichever Employee Block they belong to — and
// each block is shown by a dashed outline per phase plus its label, never by
// recolouring its rows.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GreenhouseLiveCanvas } from "./GreenhouseLiveCanvas";
import { EmployeeBlockLegend } from "./EmployeeBlockLegend";
import { LiveBlockSummary, LivePhase } from "../../lib/greenhouseLiveTypes";

beforeAll(() => {
  // jsdom has no ResizeObserver; the canvas only uses it to report its size.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

function row(n: number, blockId: string | null, state: "blue" | "green" | "neutral") {
  return { id: `r${n}`, rowNumber: n, xFt: 2, yFt: (n % 100) * 6, widthFt: 4, lengthFt: 50, orientation: "horizontal" as const, state, employees: [], blockId };
}
const phases: LivePhase[] = [
  {
    id: "p1", name: "Phase 1", description: null, northSouthFeet: 80, eastWestFeet: 60, xFeetFromWest: 0, yFeetFromNorth: 0, isActive: true, sortOrder: 1,
    rows: [row(101, "bA", "neutral"), row(102, "bA", "neutral"), row(103, "bB", "green"), row(104, "bB", "neutral"), row(105, null, "neutral")],
  },
  {
    id: "p2", name: "Phase 2", description: null, northSouthFeet: 80, eastWestFeet: 60, xFeetFromWest: 70, yFeetFromNorth: 0, isActive: true, sortOrder: 2,
    rows: [row(201, "bC", "blue"), row(202, "bC", "neutral"), row(203, "bB", "neutral")],
  },
];
const blocks: LiveBlockSummary[] = [
  { id: "bA", name: "Block A", employeeId: "e1", employeeFirstName: "Mia", employeeLastName: "Cruz", colorKey: "softPlum", totalRows: 2, completedRows: 0 },
  { id: "bB", name: "Block B", employeeId: "e2", employeeFirstName: "Larry", employeeLastName: "B", colorKey: "mutedAmber", totalRows: 3, completedRows: 1 },
  { id: "bC", name: "Block C", employeeId: null, employeeFirstName: null, employeeLastName: null, colorKey: "slate", totalRows: 2, completedRows: 0 },
];
const land = { id: "land", name: "Main", northSouthFeet: 100, eastWestFeet: 140, isActive: true, phases };

function renderCanvas(withBlocks = true) {
  return render(
    <GreenhouseLiveCanvas
      land={land}
      phases={phases}
      phaseFilterId={null}
      transform={{ pan: { x: 0, y: 0 }, scale: 4 }}
      onTransformChange={() => {}}
      onViewportSize={() => {}}
      minScale={0.1}
      maxScale={20}
      rotationDegrees={0}
      blocks={withBlocks ? blocks : undefined}
    />
  );
}

const rowRect = (container: HTMLElement, n: number) =>
  [...container.querySelectorAll("rect.greenhouse-live-row-rect")].find((r) => r.querySelector("title")?.textContent?.startsWith(`Row ${n}`)) ??
  [...container.querySelectorAll("rect.greenhouse-live-row-rect")][[101, 102, 103, 104, 105, 201, 202, 203].indexOf(n)];

describe("Display → Map block display", () => {
  it("colours rows only by work state: idle rows look the same in every block, with no per-block colour", () => {
    const { container } = renderCanvas();
    const rects = [...container.querySelectorAll("rect.greenhouse-live-row-rect")];
    expect(rects).toHaveLength(8);
    expect(rects.every((r) => !r.getAttribute("style"))).toBe(true);
    for (const n of [101, 102, 104, 105, 202, 203]) expect(rowRect(container, n)).toHaveClass("greenhouse-live-row-neutral");
    expect(rowRect(container, 103)).toHaveClass("greenhouse-live-row-green");
    expect(rowRect(container, 201)).toHaveClass("greenhouse-live-row-blue");
  });

  it("draws one dashed outline per block per phase and labels each with block and employee", () => {
    const { container } = renderCanvas();
    // A in phase 1, B in phases 1 and 2, C in phase 2.
    expect(container.querySelectorAll("rect.greenhouse-live-block-outline")).toHaveLength(4);
    const pills = [...container.querySelectorAll(".greenhouse-live-block-label-pill")].map((p) => p.textContent);
    expect(pills).toEqual(expect.arrayContaining(["Block A — Mia Cruz", "Block B — Larry B", "Block C — Unassigned"]));
  });

  it("draws no outlines when the map has no blocks (selection-mode canvases)", () => {
    const { container } = renderCanvas(false);
    expect(container.querySelectorAll("rect.greenhouse-live-block-outline")).toHaveLength(0);
  });

  it("legend lists blocks with the outline swatch, names and progress — no colours", () => {
    const { container } = render(<EmployeeBlockLegend blocks={blocks} />);
    const swatches = [...container.querySelectorAll(".greenhouse-live-block-legend-swatch")];
    expect(swatches).toHaveLength(3);
    expect(swatches.every((s) => !s.getAttribute("style"))).toBe(true);
    expect(screen.getByText(/Block B — Larry B/)).toHaveTextContent("1 / 3 rows");
  });
});
