// Shared world<->screen transform math for the Greenhouse Layout canvas.
// The canvas keeps all geometry (land/phase x/y/width/height) in real feet
// — "world" coordinates — and applies a single translate+scale transform
// (pan in screen pixels, scale in pixels-per-foot) to place them on screen.
// Both the canvas itself (mouse-wheel zoom) and the editor toolbar (zoom
// buttons, keyboard shortcuts, Fit to screen) need the exact same math, so
// it lives here rather than being duplicated in each.

export interface CanvasTransform {
  pan: { x: number; y: number };
  scale: number; // pixels per foot
}

interface LandSize {
  eastWestFeet: number;
  northSouthFeet: number;
}

// Map-rotation setting for the Greenhouse office/TV pages (see
// greenhouse_displays.rotation_degrees) — a pure viewing transform applied
// on top of the world-feet geometry below; it never changes any stored
// phase/row coordinate. Clockwise steps only, matching the office Rotate
// button's four-state cycle.
export type RotationDegrees = 0 | 90 | 180 | 270;

export function nextRotation(current: RotationDegrees): RotationDegrees {
  return (((current + 90) % 360) as RotationDegrees);
}

// True at 90°/270°, where the rotated content's on-screen bounding box has
// its width and height swapped relative to the land's own
// eastWestFeet/northSouthFeet — every rotation-aware fit/clamp calculation
// below branches on this.
function isSwappedRotation(rotationDegrees: RotationDegrees): boolean {
  return rotationDegrees === 90 || rotationDegrees === 270;
}

// Rescales around a fixed screen point (focalX, focalY, relative to the
// viewport) so the world point currently under that point stays under it
// after the scale changes — the standard "zoom to cursor" formula.
export function zoomAtPoint(
  current: CanvasTransform,
  newScale: number,
  focalX: number,
  focalY: number
): CanvasTransform {
  const worldX = (focalX - current.pan.x) / current.scale;
  const worldY = (focalY - current.pan.y) / current.scale;
  return {
    scale: newScale,
    pan: {
      x: focalX - worldX * newScale,
      y: focalY - worldY * newScale,
    },
  };
}

// Scale/pan that fits the whole land inside a viewport of the given size,
// centered, with a small margin — what "Fit to screen" (and the initial
// view) computes. Rotation is applied around the land's own center (see
// GreenhouseLiveCanvas's inner rotate group), which never moves — so the
// pan that centers the land in the viewport is the same regardless of
// rotation; only the scale calculation needs the rotated bounding box's
// swapped width/height at 90°/270°.
export function computeFitTransform(
  land: LandSize,
  viewportWidth: number,
  viewportHeight: number,
  rotationDegrees: RotationDegrees = 0,
  marginPx = 40
): CanvasTransform {
  const availWidth = Math.max(1, viewportWidth - marginPx * 2);
  const availHeight = Math.max(1, viewportHeight - marginPx * 2);
  const swapped = isSwappedRotation(rotationDegrees);
  const effectiveWidth = swapped ? land.northSouthFeet : land.eastWestFeet;
  const effectiveHeight = swapped ? land.eastWestFeet : land.northSouthFeet;
  const scale = Math.min(availWidth / effectiveWidth, availHeight / effectiveHeight);
  return {
    scale,
    pan: {
      x: viewportWidth / 2 - (land.eastWestFeet / 2) * scale,
      y: viewportHeight / 2 - (land.northSouthFeet / 2) * scale,
    },
  };
}

interface PhaseBounds {
  xFeetFromWest: number;
  yFeetFromNorth: number;
  eastWestFeet: number;
  northSouthFeet: number;
}

// Same clockwise rotation the SVG `rotate(deg, cx, cy)` transform applies
// to the phases/rows group (see GreenhouseLiveCanvas) — used here only to
// find where a phase's corners land in screen-facing space, never to move
// any stored coordinate.
function rotatePoint(x: number, y: number, cx: number, cy: number, rotationDegrees: RotationDegrees) {
  switch (rotationDegrees) {
    case 90:
      return { x: cx - (y - cy), y: cy + (x - cx) };
    case 180:
      return { x: 2 * cx - x, y: 2 * cy - y };
    case 270:
      return { x: cx + (y - cy), y: cy - (x - cx) };
    default:
      return { x, y };
  }
}

// Same idea as computeFitTransform, but fits tightly to the phases'
// combined bounding box instead of the land's full nominal size — for a
// land with a lot of unused margin around/between its phases, this uses
// meaningfully more of the available screen. Falls back to
// computeFitTransform when there's nothing to measure (no phases yet).
// The office "Fit to screen" deliberately keeps using computeFitTransform
// (land-based) — this is only wired into the read-only TV display.
export function computeFitTransformToPhases(
  land: LandSize,
  phases: PhaseBounds[],
  viewportWidth: number,
  viewportHeight: number,
  rotationDegrees: RotationDegrees = 0,
  marginPx = 40
): CanvasTransform {
  if (phases.length === 0) {
    return computeFitTransform(land, viewportWidth, viewportHeight, rotationDegrees, marginPx);
  }

  const cx = land.eastWestFeet / 2;
  const cy = land.northSouthFeet / 2;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of phases) {
    const corners: [number, number][] = [
      [p.xFeetFromWest, p.yFeetFromNorth],
      [p.xFeetFromWest + p.eastWestFeet, p.yFeetFromNorth],
      [p.xFeetFromWest, p.yFeetFromNorth + p.northSouthFeet],
      [p.xFeetFromWest + p.eastWestFeet, p.yFeetFromNorth + p.northSouthFeet],
    ];
    for (const [x, y] of corners) {
      const r = rotatePoint(x, y, cx, cy, rotationDegrees);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x);
      maxY = Math.max(maxY, r.y);
    }
  }

  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);
  const boundsCenterX = (minX + maxX) / 2;
  const boundsCenterY = (minY + maxY) / 2;

  const availWidth = Math.max(1, viewportWidth - marginPx * 2);
  const availHeight = Math.max(1, viewportHeight - marginPx * 2);
  const scale = Math.min(availWidth / boundsWidth, availHeight / boundsHeight);

  return {
    scale,
    pan: {
      x: viewportWidth / 2 - boundsCenterX * scale,
      y: viewportHeight / 2 - boundsCenterY * scale,
    },
  };
}

// Keeps at least `minVisiblePx` of the land's bounding box inside the
// viewport on each axis, so a pan gesture can never lose the canvas
// entirely off-screen. Uses the rotated (width/height-swapped at 90°/270°)
// on-screen bounding box, matching what's actually rendered.
export function clampPan(
  pan: { x: number; y: number },
  scale: number,
  land: LandSize,
  viewportWidth: number,
  viewportHeight: number,
  rotationDegrees: RotationDegrees = 0,
  minVisiblePx = 80
): { x: number; y: number } {
  const swapped = isSwappedRotation(rotationDegrees);
  const landWidthPx = (swapped ? land.northSouthFeet : land.eastWestFeet) * scale;
  const landHeightPx = (swapped ? land.eastWestFeet : land.northSouthFeet) * scale;
  return {
    x: Math.min(Math.max(pan.x, minVisiblePx - landWidthPx), viewportWidth - minVisiblePx),
    y: Math.min(Math.max(pan.y, minVisiblePx - landHeightPx), viewportHeight - minVisiblePx),
  };
}
