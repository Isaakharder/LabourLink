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
// view) computes.
export function computeFitTransform(
  land: LandSize,
  viewportWidth: number,
  viewportHeight: number,
  marginPx = 40
): CanvasTransform {
  const availWidth = Math.max(1, viewportWidth - marginPx * 2);
  const availHeight = Math.max(1, viewportHeight - marginPx * 2);
  const scale = Math.min(availWidth / land.eastWestFeet, availHeight / land.northSouthFeet);
  return {
    scale,
    pan: {
      x: (viewportWidth - land.eastWestFeet * scale) / 2,
      y: (viewportHeight - land.northSouthFeet * scale) / 2,
    },
  };
}

// Keeps at least `minVisiblePx` of the land's bounding box inside the
// viewport on each axis, so a pan gesture can never lose the canvas
// entirely off-screen.
export function clampPan(
  pan: { x: number; y: number },
  scale: number,
  land: LandSize,
  viewportWidth: number,
  viewportHeight: number,
  minVisiblePx = 80
): { x: number; y: number } {
  const landWidthPx = land.eastWestFeet * scale;
  const landHeightPx = land.northSouthFeet * scale;
  return {
    x: Math.min(Math.max(pan.x, minVisiblePx - landWidthPx), viewportWidth - minVisiblePx),
    y: Math.min(Math.max(pan.y, minVisiblePx - landHeightPx), viewportHeight - minVisiblePx),
  };
}
