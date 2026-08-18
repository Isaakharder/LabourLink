import { LiveBlockSummary, LivePhase } from "../../lib/greenhouseLiveTypes";
import { CanvasTransform, RotationDegrees, rotatePoint } from "../../lib/canvasTransform";
import { rowScreenRect } from "../../lib/rowLayout";

interface BlockClusterLabelsProps {
  // Already phase-filtered (GreenhouseLiveCanvas's own visiblePhases), same
  // convention as EmployeeLocationBubbles.
  phases: LivePhase[];
  land: { northSouthFeet: number; eastWestFeet: number };
  transform: CanvasTransform;
  rotationDegrees: RotationDegrees;
  blocks: LiveBlockSummary[];
}

// Fixed screen-pixel label size — deliberately NOT scaled by transform.scale.
// World-feet-sized SVG text (the first version of this component) shrinks to
// a few px on a real, large greenhouse at fit-to-screen zoom and becomes
// unreadable; an HTML overlay sized in real CSS px, positioned from the same
// projected screen coordinates as EmployeeLocationBubbles, stays legible at
// any zoom level instead.
const LABEL_GAP_PX = 6;
// Rough width/height estimate for collision avoidance below — matches the
// pill's actual CSS (0.7rem/600 weight, 8px horizontal padding, 1px border
// each side) closely enough to space neighbours apart; the pill itself still
// sizes to its real text via CSS (white-space: nowrap), this is only used to
// decide whether two labels would overlap.
const CHAR_WIDTH_PX = 6.5;
const PILL_PADDING_PX = 20;
const PILL_HEIGHT_PX = 22;
const COLLISION_STEP_PX = PILL_HEIGHT_PX + 4;
const COLLISION_MARGIN_PX = 4;
const MAX_COLLISION_ATTEMPTS = 8;

function boxesOverlap(
  a: { left: number; top: number; width: number },
  b: { left: number; top: number; width: number },
  margin: number
): boolean {
  const aRight = a.left + a.width;
  const bRight = b.left + b.width;
  return (
    a.left < bRight + margin &&
    aRight > b.left - margin &&
    a.top < b.top + PILL_HEIGHT_PX + margin &&
    a.top + PILL_HEIGHT_PX > b.top - margin
  );
}

// One label per (block, phase) it has rows in — never one label per block
// overall, which for a block with disconnected sections (two phases, or two
// non-adjacent clusters separated by a walkway) would either force a single
// label to sit oddly far from one of its sections or require a bounding box
// spanning unrelated rows in between.
interface BlockCluster {
  key: string;
  blockId: string;
  minXFt: number;
  maxXFt: number;
  minYFt: number;
  maxYFt: number;
}

function computeBlockClusters(phases: LivePhase[]): BlockCluster[] {
  const byKey = new Map<string, BlockCluster>();
  for (const phase of phases) {
    for (const row of phase.rows) {
      if (!row.blockId) continue;
      const { width, height } = rowScreenRect(row);
      const x0 = phase.xFeetFromWest + row.xFt;
      const x1 = x0 + width;
      const y0 = phase.yFeetFromNorth + row.yFt;
      const y1 = y0 + height;
      const key = `${row.blockId}:${phase.id}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { key, blockId: row.blockId, minXFt: x0, maxXFt: x1, minYFt: y0, maxYFt: y1 });
      } else {
        existing.minXFt = Math.min(existing.minXFt, x0);
        existing.maxXFt = Math.max(existing.maxXFt, x1);
        existing.minYFt = Math.min(existing.minYFt, y0);
        existing.maxYFt = Math.max(existing.maxYFt, y1);
      }
    }
  }
  return Array.from(byKey.values());
}

interface Candidate {
  key: string;
  text: string;
  screenX: number;
  screenY: number;
  widthPx: number;
}

interface Placed extends Candidate {
  boxLeft: number;
  boxTop: number;
}

// Read-only overlay: one small pill per (block, phase) cluster, positioned
// just above its own topmost row's screen position — computed with the exact
// same rotatePoint + transform.pan/scale projection EmployeeLocationBubbles
// uses, so the pill tracks the rows underneath it through every pan/zoom/
// rotation exactly like the bubbles do. All four corners of the cluster's
// (unrotated, world-feet) bounding box are projected individually and the
// screen-space bounding box of those four points is used — a single
// "topmost" corner picked before rotation would end up on the wrong screen
// edge whenever rotationDegrees is 90 or 270, since "north" no longer faces
// up on screen.
//
// Adjacent blocks that are each only a few rows wide (e.g. a bank of six
// narrow blocks side by side) can have cluster labels that would otherwise
// sit directly on top of one another — the same deterministic
// nudge-straight-up-until-clear collision avoidance EmployeeLocationBubbles
// already uses for stacked employee bubbles, applied left-to-right here so
// the stagger order is stable across polls instead of depending on incidental
// block/row ordering.
export function BlockClusterLabels({ phases, land, transform, rotationDegrees, blocks }: BlockClusterLabelsProps) {
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const rotateCx = land.eastWestFeet / 2;
  const rotateCy = land.northSouthFeet / 2;

  const clusters = computeBlockClusters(phases);

  const candidates: Candidate[] = [];
  for (const cluster of clusters) {
    const block = blockById.get(cluster.blockId);
    if (!block) continue;

    const corners = [
      [cluster.minXFt, cluster.minYFt],
      [cluster.maxXFt, cluster.minYFt],
      [cluster.minXFt, cluster.maxYFt],
      [cluster.maxXFt, cluster.maxYFt],
    ].map(([x, y]) => rotatePoint(x, y, rotateCx, rotateCy, rotationDegrees));
    const screenXs = corners.map((c) => transform.pan.x + c.x * transform.scale);
    const screenYs = corners.map((c) => transform.pan.y + c.y * transform.scale);
    const screenX = (Math.min(...screenXs) + Math.max(...screenXs)) / 2;
    const screenY = Math.min(...screenYs);

    const employeeName = block.employeeFirstName
      ? `${block.employeeFirstName} ${block.employeeLastName ?? ""}`.trim()
      : "Unassigned";
    const text = `${block.name} — ${employeeName}`;

    candidates.push({
      key: cluster.key,
      text,
      screenX,
      screenY,
      widthPx: text.length * CHAR_WIDTH_PX + PILL_PADDING_PX,
    });
  }
  candidates.sort((a, b) => a.screenX - b.screenX || a.key.localeCompare(b.key));

  const placed: Placed[] = [];
  for (const c of candidates) {
    const boxLeft = c.screenX - c.widthPx / 2;
    let boxTop = c.screenY - LABEL_GAP_PX - PILL_HEIGHT_PX;

    let attempts = 0;
    while (
      attempts < MAX_COLLISION_ATTEMPTS &&
      placed.some((p) =>
        boxesOverlap({ left: boxLeft, top: boxTop, width: c.widthPx }, { left: p.boxLeft, top: p.boxTop, width: p.widthPx }, COLLISION_MARGIN_PX)
      )
    ) {
      boxTop -= COLLISION_STEP_PX;
      attempts++;
    }

    placed.push({ ...c, boxLeft, boxTop });
  }

  return (
    <div className="greenhouse-block-label-layer" aria-hidden="true">
      {placed.map((p) => (
        <div
          key={p.key}
          className="greenhouse-live-block-label-pill"
          style={{ left: p.screenX, top: p.boxTop, transform: "translateX(-50%)" }}
        >
          {p.text}
        </div>
      ))}
    </div>
  );
}
