// @vitest-environment jsdom
//
// Display → Map block display (office preview and TV share this canvas and
// legend): rows are coloured only by work state — idle rows are the same
// uniform "no activity" style whichever Employee Block they belong to — and
// each block is shown only by a dashed outline per phase: no floating
// "Block — Employee" label and no recoloured rows. Live employee cards,
// around the drawing (never on it), still show who is working where.
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
  const employees =
    state === "blue" ? [{ id: "e9", firstName: "Khen", lastName: "Lagto", activityName: "Picking", startedAt: new Date().toISOString() }] : [];
  return { id: `r${n}`, rowNumber: n, xFt: 2, yFt: (n % 100) * 6, widthFt: 4, lengthFt: 50, orientation: "horizontal" as const, state, employees, blockId };
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

  it("draws one dashed outline per block per phase, with no floating block/employee labels", () => {
    const { container } = renderCanvas();
    // A in phase 1, B in phases 1 and 2, C in phase 2.
    expect(container.querySelectorAll("rect.greenhouse-live-block-outline")).toHaveLength(4);
    // Visible text only: a row's hover tooltip (<title>) may still name its
    // block, but nothing is drawn on the map itself.
    const visible = container.cloneNode(true) as HTMLElement;
    visible.querySelectorAll("title").forEach((t) => t.remove());
    expect(visible.textContent).not.toMatch(/Block [ABC]/);
    expect(visible.textContent).not.toMatch(/Mia Cruz|Larry B|Unassigned/);
  });

  it("shows each working employee as a card in the card layer, with reserved columns beside the map", () => {
    const { container } = renderCanvas();
    const stage = container.querySelector(".greenhouse-live-stage")!;
    expect(stage).not.toBeNull();
    // Map area flanked by the two dedicated card columns.
    expect([...stage.children].map((el) => el.className)).toEqual(["greenhouse-card-column", "greenhouse-canvas-viewport", "greenhouse-card-column"]);
    const cards = [...container.querySelectorAll(".employee-card")];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Khen");
    expect(cards[0]).toHaveTextContent("Row 201");
    // An HTML overlay, not part of the map drawing (SVG).
    expect(cards[0].closest(".employee-card-layer")).not.toBeNull();
    expect(cards[0].closest("svg")).toBeNull();
    // Connectors are drawn only to rows in view; jsdom measures the map as 0x0.
    expect(container.querySelectorAll(".employee-card-connector")).toHaveLength(0);
  });

  it("gives every person on the same row their own card", () => {
    const busy = phases.map((p) =>
      p.id !== "p2"
        ? p
        : {
            ...p,
            rows: p.rows.map((r) =>
              r.rowNumber !== 201
                ? r
                : {
                    ...r,
                    employees: ["Khen", "Ana", "Bo"].map((firstName, i) => ({ id: `e${i}`, firstName, lastName: "X", activityName: "Picking" })),
                  }
            ),
          }
    );
    const busyLand = { ...land, phases: busy };
    const { container } = render(
      <GreenhouseLiveCanvas
        land={busyLand}
        phases={busy}
        phaseFilterId={null}
        transform={{ pan: { x: 0, y: 0 }, scale: 4 }}
        onTransformChange={() => {}}
        onViewportSize={() => {}}
        minScale={0.1}
        maxScale={20}
        rotationDegrees={0}
      />
    );
    const cards = [...container.querySelectorAll<HTMLElement>(".employee-card")];
    expect(cards.map((c) => c.querySelector(".employee-card-name")!.textContent)).toEqual(["Khen", "Ana", "Bo"]);
    const tops = cards.filter((c) => c.classList.contains("employee-card-left")).map((c) => parseFloat(c.style.top));
    const tops2 = cards.filter((c) => c.classList.contains("employee-card-right")).map((c) => parseFloat(c.style.top));
    expect(tops.length + tops2.length).toBe(3);
    for (const col of [tops, tops2]) {
      const sorted = [...col].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(54 + 8);
    }
  });

  it("selection-mode canvases have no card columns or cards", () => {
    const { container } = render(
      <GreenhouseLiveCanvas
        land={land}
        phases={phases}
        phaseFilterId={null}
        transform={{ pan: { x: 0, y: 0 }, scale: 4 }}
        onTransformChange={() => {}}
        onViewportSize={() => {}}
        minScale={0.1}
        maxScale={20}
        onRowClick={() => {}}
        selectedRowIds={new Set()}
      />
    );
    expect(container.querySelector(".greenhouse-live-stage")).toBeNull();
    expect(container.querySelector(".greenhouse-card-column")).toBeNull();
    expect(container.querySelector(".employee-card")).toBeNull();
  });

  it("outlines follow the phase selection and rotation", () => {
    const onlyPhase1 = phases.filter((p) => p.id === "p1");
    const phase1Land = { ...land, phases: onlyPhase1 };
    const { container } = render(
      <GreenhouseLiveCanvas
        land={phase1Land}
        phases={onlyPhase1}
        phaseFilterId={null}
        transform={{ pan: { x: 0, y: 0 }, scale: 4 }}
        onTransformChange={() => {}}
        onViewportSize={() => {}}
        minScale={0.1}
        maxScale={20}
        rotationDegrees={90}
        blocks={blocks}
      />
    );
    // Phase 1 only: blocks A and B.
    expect(container.querySelectorAll("rect.greenhouse-live-block-outline")).toHaveLength(2);
    const group = container.querySelector("rect.greenhouse-live-block-outline")!.parentElement!;
    expect(group.getAttribute("transform")).toMatch(/^rotate\(90 /);
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
