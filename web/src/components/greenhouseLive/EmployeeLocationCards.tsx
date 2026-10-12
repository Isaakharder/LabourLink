import { CSSProperties } from "react";
import { LiveEmployee, LivePhase } from "../../lib/greenhouseLiveTypes";
import { CanvasTransform, RotationDegrees, phasesBounds, rotatePoint } from "../../lib/canvasTransform";
import { rowScreenRect } from "../../lib/rowLayout";
import { CardAnchor, PlacedCard, layoutEmployeeCards } from "../../lib/employeeCardLayout";
import { Avatar } from "../employees/Avatar";

// Employee cards for the live map. Every currently-working employee gets one
// card in the free space around the greenhouse drawing — beside, above or
// below it, wherever there is room (see employeeCardLayout.ts) — never on
// the drawing itself, joined to their row by a connector line.

// Full-size card, in screen px — deliberately NOT scaled with the map, so
// cards stay readable at any zoom. Cards only shrink (all together) when
// there's no room for everyone at full size.
export const CARD_WIDTH_PX = 150;
export const CARD_HEIGHT_PX = 54;
const CARD_GAP_PX = 8;
const AREA_PADDING_PX = 8;
const DRAWING_CLEARANCE_PX = 10;
// Width of the reserved column on each side of the map area: room for one
// full-size card plus its padding and clearance (see .greenhouse-card-column).
export const CARD_COLUMN_PX = CARD_WIDTH_PX + AREA_PADDING_PX + DRAWING_CLEARANCE_PX;

export interface EmployeeCard extends PlacedCard {
  employee: LiveEmployee;
  rowNumber: number;
  // Where the connector meets the row: the point on the row nearest the
  // card (so lines stay short and don't cross each other), in the map area.
  rowX: number;
  rowY: number;
  // False when that point is panned out of the map area: the card stays,
  // but has no connector.
  rowVisible: boolean;
}

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y];

// Row points and the drawing's bounds use the same geometry and transform
// math as the map itself (rowScreenRect + phase offsets, rotatePoint,
// pan/scale). No data fetching: `phases` is the live-state payload the
// office/TV pages already poll for row colouring, already phase-filtered.
export function computeEmployeeCards(
  phases: LivePhase[],
  land: { northSouthFeet: number; eastWestFeet: number },
  transform: CanvasTransform,
  rotationDegrees: RotationDegrees,
  map: { width: number; height: number }
): EmployeeCard[] {
  const rotateCx = land.eastWestFeet / 2;
  const rotateCy = land.northSouthFeet / 2;
  const toScreen = (x: number, y: number) => ({ x: transform.pan.x + x * transform.scale, y: transform.pan.y + y * transform.scale });
  // Deterministic phase/row/employee order — the layout's tie-break, so the
  // arrangement never depends on incidental upstream ordering.
  const sortedPhases = [...phases].sort((a, b) => {
    const orderA = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return orderA !== orderB ? orderA - orderB : a.name.localeCompare(b.name);
  });

  type Rect = { left: number; top: number; right: number; bottom: number };
  const working: { key: string; employee: LiveEmployee; rowNumber: number; x: number; y: number; rect: Rect; order: number }[] = [];
  for (const phase of sortedPhases) {
    const rows = [...phase.rows].sort((a, b) => a.rowNumber - b.rowNumber);
    for (const row of rows) {
      // Only currently-working employees get a card — completed (green) and
      // empty rows have no live location to show.
      if (row.state !== "blue" || row.employees.length === 0) continue;
      // The row's on-screen rectangle (rotations are quarter turns, so it
      // stays axis-aligned) and its centre, which the card is lined up with.
      const { width, height } = rowScreenRect(row);
      const x0 = phase.xFeetFromWest + row.xFt;
      const y0 = phase.yFeetFromNorth + row.yFt;
      const a = toScreen(...xy(rotatePoint(x0, y0, rotateCx, rotateCy, rotationDegrees)));
      const b = toScreen(...xy(rotatePoint(x0 + width, y0 + height, rotateCx, rotateCy, rotationDegrees)));
      const rect = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      for (const employee of [...row.employees].sort((a, b) => a.id.localeCompare(b.id))) {
        working.push({ key: `${row.id}:${employee.id}`, employee, rowNumber: row.rowNumber, x, y, rect, order: working.length });
      }
    }
  }
  if (working.length === 0) return [];

  const b = phasesBounds(land, phases, rotationDegrees);
  const topLeft = toScreen(b.minX, b.minY);
  const bottomRight = toScreen(b.maxX, b.maxY);
  // A row panned out of view is laid out from the nearest point in view.
  const clampX = (x: number) => Math.max(0, Math.min(x, map.width));
  const clampY = (y: number) => Math.max(0, Math.min(y, map.height));
  const anchors: CardAnchor[] = working.map((w) => ({ key: w.key, x: clampX(w.x), y: clampY(w.y), order: w.order }));
  const placed = new Map(
    layoutEmployeeCards(anchors, {
      mapWidth: map.width,
      height: map.height,
      drawing: { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y },
      gutter: CARD_COLUMN_PX,
      cardWidth: CARD_WIDTH_PX,
      cardHeight: CARD_HEIGHT_PX,
      gap: CARD_GAP_PX,
      padding: AREA_PADDING_PX,
      clearance: DRAWING_CLEARANCE_PX,
    }).map((p) => [p.key, p])
  );
  return working.map((w) => {
    const p = placed.get(w.key)!;
    const rowX = Math.max(w.rect.left, Math.min(p.edgeX, w.rect.right));
    const rowY = Math.max(w.rect.top, Math.min(p.edgeY, w.rect.bottom));
    return {
      ...p,
      employee: w.employee,
      rowNumber: w.rowNumber,
      rowX,
      rowY,
      rowVisible: rowX >= 0 && rowX <= map.width && rowY >= 0 && rowY <= map.height,
    };
  });
}

// Cards and connectors, drawn in the map area's coordinates. The layer
// overflows the map area into the reserved columns beside it.
export function EmployeeLocationCards({ cards }: { cards: EmployeeCard[] }) {
  return (
    <div className="employee-card-layer" aria-hidden="true">
      <svg className="employee-card-connectors">
        {cards
          .filter((c) => c.rowVisible)
          .map((c) => (
            <g key={c.key} className="employee-card-connector" data-key={c.key}>
              <line className="employee-card-connector-halo" x1={c.edgeX} y1={c.edgeY} x2={c.rowX} y2={c.rowY} />
              <line className="employee-card-connector-line" x1={c.edgeX} y1={c.edgeY} x2={c.rowX} y2={c.rowY} />
              <circle className="employee-card-connector-dot" cx={c.rowX} cy={c.rowY} r={4} />
            </g>
          ))}
      </svg>
      {cards.map((c) => (
        <div
          key={c.key}
          className={`employee-card employee-card-${c.side}`}
          data-key={c.key}
          style={{ left: c.left, top: c.top, width: c.width, height: c.height, "--card-scale": c.scale } as CSSProperties}
        >
          <Avatar photoUrl={c.employee.photoUrl} firstName={c.employee.firstName} lastName={c.employee.lastName} size="small" />
          <div className="employee-card-text">
            <span className="employee-card-name">{c.employee.firstName}</span>
            <span className="employee-card-row">Row {c.rowNumber}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
