import { describe, expect, it } from "vitest";
import { computeEmployeeCards } from "./EmployeeLocationCards";
import { LivePhase, LiveRow } from "../../lib/greenhouseLiveTypes";

// One phase of 10 horizontal rows (100ft long, 3ft wide, 6ft apart), drawn at
// 5px per foot with 50px of space around it.
function row(n: number, employees: string[]): LiveRow {
  return {
    id: `r${n}`, rowNumber: n, xFt: 10, yFt: 5 + (n - 1) * 6, widthFt: 3, lengthFt: 100, orientation: "horizontal",
    state: employees.length ? "blue" : "neutral",
    employees: employees.map((firstName, i) => ({ id: `e${n}${i}`, firstName, lastName: "X" })),
    blockId: null,
  };
}
const phase = (rows: LiveRow[]): LivePhase => ({
  id: "p", name: "P", description: null, northSouthFeet: 65, eastWestFeet: 120, xFeetFromWest: 0, yFeetFromNorth: 0, isActive: true, sortOrder: 1, rows,
});
const land = { northSouthFeet: 65, eastWestFeet: 120 };
const transform = { pan: { x: 50, y: 50 }, scale: 5 };

describe("computeEmployeeCards", () => {
  it("joins a side card to the nearest point on its row (the row's end), not across the row", () => {
    // Row 2 near the left edge of a map whose drawing fills the width.
    const [card] = computeEmployeeCards([phase([row(2, ["Ana"])])], land, transform, 0, { width: 700, height: 425 });
    expect(card.side).toBe("left");
    // Row 2 spans x 100..600, y 105..120 on screen; its left end is x=100.
    expect(card.rowX).toBe(100);
    expect(card.rowY).toBeGreaterThanOrEqual(105);
    expect(card.rowY).toBeLessThanOrEqual(120);
    expect(card.rowVisible).toBe(true);
  });

  it("drops a card below the drawing straight onto its row", () => {
    // Lots of room below the drawing (map 425px drawn in a 900px-tall area).
    const cards = computeEmployeeCards([phase([row(10, ["Ana", "Bo"])])], land, transform, 0, { width: 700, height: 900 });
    for (const c of cards) {
      expect(c.side).toBe("bottom");
      expect(c.rowX).toBeCloseTo(c.edgeX); // vertical connector
      expect(c.rowY).toBe(50 + (5 + 9 * 6 + 3) * 5); // row 10's bottom edge
    }
  });

  it("gives every working person a card, and none for completed or idle rows", () => {
    const rows = [row(1, ["Ana", "Bo"]), row(2, []), { ...row(3, ["Cy"]), state: "green" as const }];
    const cards = computeEmployeeCards([phase(rows)], land, transform, 0, { width: 700, height: 425 });
    expect(cards.map((c) => c.employee.firstName)).toEqual(["Ana", "Bo"]);
  });
});
