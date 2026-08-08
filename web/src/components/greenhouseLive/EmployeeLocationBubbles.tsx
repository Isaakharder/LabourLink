import { LiveEmployee, LivePhase, LiveRow } from "../../lib/greenhouseLiveTypes";
import { CanvasTransform, RotationDegrees, rotatePoint } from "../../lib/canvasTransform";
import { rowScreenRect } from "../../lib/rowLayout";
import { Avatar } from "../employees/Avatar";

interface EmployeeLocationBubblesProps {
  // Already phase-filtered (GreenhouseLiveCanvas's own visiblePhases) so a
  // bubble never appears for a row hidden by the phase filter.
  phases: LivePhase[];
  land: { northSouthFeet: number; eastWestFeet: number };
  transform: CanvasTransform;
  rotationDegrees: RotationDegrees;
}

// Fixed screen-pixel bubble size — deliberately NOT scaled by transform.scale
// so bubbles stay a readable size at any map zoom level (rows themselves do
// scale; bubbles are an HTML overlay on top, same technique as the compass).
const BUBBLE_WIDTH_PX = 64;
const BUBBLE_HEIGHT_PX = 70;
// Horizontal spacing between multiple employees' bubbles on the same row.
const SLOT_SPACING_PX = 58;
// Gap between the bubble's bottom tip and the row anchor point the pointer
// line is drawn to.
const POINTER_GAP_PX = 14;
// Simple deterministic collision avoidance: if a bubble's box would overlap
// an already-placed one, nudge it straight up by this much and check again,
// up to a small number of times — not a general layout engine, just enough
// to keep nearby-row bubbles from stacking directly on top of each other.
const COLLISION_STEP_PX = BUBBLE_HEIGHT_PX * 0.6;
const COLLISION_MARGIN_PX = 6;
const MAX_COLLISION_ATTEMPTS = 6;

interface Placed {
  key: string;
  employee: LiveEmployee;
  rowNumber: number;
  // Pointer tip — the exact row-center screen point the leader line ends at.
  tipX: number;
  tipY: number;
  // Bubble body's final on-screen box (top-left anchored, width fixed).
  boxLeft: number;
  boxTop: number;
}

function rectsOverlap(
  a: { left: number; top: number },
  b: { left: number; top: number },
  margin: number
): boolean {
  const aRight = a.left + BUBBLE_WIDTH_PX;
  const aBottom = a.top + BUBBLE_HEIGHT_PX;
  const bRight = b.left + BUBBLE_WIDTH_PX;
  const bBottom = b.top + BUBBLE_HEIGHT_PX;
  return a.left < bRight + margin && aRight > b.left - margin && a.top < bBottom + margin && aBottom > b.top - margin;
}

// Read-only overlay: computes every currently-working employee's bubble
// position straight from the same row/phase geometry the rows themselves are
// drawn from (rowScreenRect + phase offsets), rotated/panned/scaled with the
// exact same math as the SVG transform stack (rotatePoint + transform.pan/
// scale), then rendered as plain absolutely-positioned HTML — not SVG — so
// bubble/text size stays fixed regardless of zoom. No data fetching of its
// own: `phases` is the same live-state payload the office/TV pages already
// poll for row coloring.
export function EmployeeLocationBubbles({ phases, land, transform, rotationDegrees }: EmployeeLocationBubblesProps) {
  const rotateCx = land.eastWestFeet / 2;
  const rotateCy = land.northSouthFeet / 2;

  // Deterministic phase/row order (already the query's own sort order, but
  // sorted explicitly here so bubble layout never depends on incidental
  // upstream ordering).
  const sortedPhases = [...phases].sort((a, b) => {
    const orderA = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return orderA !== orderB ? orderA - orderB : a.name.localeCompare(b.name);
  });

  interface Candidate {
    key: string;
    employee: LiveEmployee;
    rowNumber: number;
    tipX: number;
    tipY: number;
    slotOffsetX: number;
  }

  const candidates: Candidate[] = [];

  for (const phase of sortedPhases) {
    const rows: LiveRow[] = [...phase.rows].sort((a, b) => a.rowNumber - b.rowNumber);
    for (const row of rows) {
      // Only currently-working employees get a bubble — completed (green)
      // and empty (neutral) rows have no live location to show.
      if (row.state !== "blue" || row.employees.length === 0) continue;

      const { width, height } = rowScreenRect(row);
      const rowCenterX = phase.xFeetFromWest + row.xFt + width / 2;
      const rowCenterY = phase.yFeetFromNorth + row.yFt + height / 2;
      const rotated = rotatePoint(rowCenterX, rowCenterY, rotateCx, rotateCy, rotationDegrees);
      const tipX = transform.pan.x + rotated.x * transform.scale;
      const tipY = transform.pan.y + rotated.y * transform.scale;

      // Multiple employees on the same row: fan their bubbles out
      // horizontally around the row's own anchor, sorted by employee id for
      // a stable arrangement across polls.
      const employees = [...row.employees].sort((a, b) => a.id.localeCompare(b.id));
      const n = employees.length;
      employees.forEach((employee, i) => {
        const slotOffsetX = (i - (n - 1) / 2) * SLOT_SPACING_PX;
        candidates.push({
          key: `${row.id}:${employee.id}`,
          employee,
          rowNumber: row.rowNumber,
          tipX,
          tipY,
          slotOffsetX,
        });
      });
    }
  }

  const placed: Placed[] = [];
  for (const c of candidates) {
    const boxLeft = c.tipX + c.slotOffsetX - BUBBLE_WIDTH_PX / 2;
    let boxTop = c.tipY - POINTER_GAP_PX - BUBBLE_HEIGHT_PX;

    let attempts = 0;
    while (
      attempts < MAX_COLLISION_ATTEMPTS &&
      placed.some((p) => rectsOverlap({ left: boxLeft, top: boxTop }, { left: p.boxLeft, top: p.boxTop }, COLLISION_MARGIN_PX))
    ) {
      boxTop -= COLLISION_STEP_PX;
      attempts++;
    }

    placed.push({
      key: c.key,
      employee: c.employee,
      rowNumber: c.rowNumber,
      tipX: c.tipX,
      tipY: c.tipY,
      boxLeft,
      boxTop,
    });
  }

  return (
    <div className="greenhouse-bubble-layer" aria-hidden="true">
      {placed.map((p) => {
        const bubbleCenterX = p.boxLeft + BUBBLE_WIDTH_PX / 2;
        const bubbleBottomY = p.boxTop + BUBBLE_HEIGHT_PX;
        const dx = p.tipX - bubbleCenterX;
        const dy = p.tipY - bubbleBottomY;
        const length = Math.hypot(dx, dy);
        const angleDeg = (Math.atan2(dx, dy) * 180) / Math.PI;

        return (
          <div key={p.key}>
            <div
              className="employee-bubble-pointer"
              style={{
                left: bubbleCenterX,
                top: bubbleBottomY,
                height: length,
                transform: `translateX(-50%) rotate(${angleDeg}deg)`,
              }}
            />
            <div className="employee-bubble" style={{ left: p.boxLeft, top: p.boxTop, width: BUBBLE_WIDTH_PX }}>
              <div className="employee-bubble-photo">
                <Avatar photoUrl={p.employee.photoUrl} firstName={p.employee.firstName} lastName={p.employee.lastName} size="small" />
              </div>
              <div className="employee-bubble-band">
                <span className="employee-bubble-name">{p.employee.firstName}</span>
                <span className="employee-bubble-row">Row {p.rowNumber}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
