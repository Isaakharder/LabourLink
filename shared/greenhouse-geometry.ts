/**
 * Canonical geometry for greenhouse row blocks and walkways.
 *
 * Imported directly by the server (server/src/routes/greenhouse-maps.ts).
 * Imported via adapter by the web frontend (web/src/lib/greenhouse-geometry.ts).
 *
 * All coordinates use feet with origin at compartment grid top-left.
 * Y increases southward. X increases eastward.
 */

export interface CompGeom {
  x_ft: number;
  y_ft: number;
  east_west_ft: number;
  north_south_ft: number;
}

export interface BlockGeom {
  orientation: string;       // 'north_south' | 'east_west'
  anchor_side: string;       // 'north' | 'south' | 'east' | 'west'
  offset_ft: number;         // distance inward from anchor wall to first row
  row_width_ft: number;      // depth of each row (perpendicular to orientation)
  row_length_ft: number;     // length of each row (along orientation direction)
  row_spacing_ft: number;    // gap between consecutive rows
  along_wall_start: string;  // 'near' | 'far' | 'centered' | 'custom'
  along_wall_offset_ft: number;
}

export interface WkGeom {
  orientation: string;
  width_ft: number;
  offset_from_side: string;
  offset_ft: number;
}

export interface Rect { x: number; y: number; w: number; h: number; }

export const EPS = 1e-4;

/**
 * Along-wall base coordinate for a block.
 * For east_west blocks: alongX = X where the row starts (E↔W direction).
 * For north_south blocks: alongY = Y where the row starts (N↕S direction).
 * The unused axis is a placeholder (overridden by blockRowRect per-row).
 */
export function alongWallBase(
  comp: CompGeom,
  block: BlockGeom,
): { alongX: number; alongY: number } {
  const start = block.along_wall_start ?? 'near';
  const off   = block.along_wall_offset_ft ?? 0;
  let alongX: number;
  let alongY: number;

  if (block.orientation === 'north_south') {
    if (start === 'far')
      alongY = comp.y_ft + comp.north_south_ft - block.row_length_ft - off;
    else if (start === 'centered')
      alongY = comp.y_ft + (comp.north_south_ft - block.row_length_ft) / 2;
    else
      alongY = comp.y_ft + off; // 'near' or 'custom'
    alongX = comp.x_ft; // placeholder — overridden in blockRowRect
  } else {
    if (start === 'far')
      alongX = comp.x_ft + comp.east_west_ft - block.row_length_ft - off;
    else if (start === 'centered')
      alongX = comp.x_ft + (comp.east_west_ft - block.row_length_ft) / 2;
    else
      alongX = comp.x_ft + off; // 'near' or 'custom'
    alongY = comp.y_ft; // placeholder — overridden in blockRowRect
  }

  return { alongX, alongY };
}

/** Rectangle for row at index `idx` within a block. */
export function blockRowRect(comp: CompGeom, block: BlockGeom, idx: number): Rect {
  const step = block.row_width_ft + block.row_spacing_ft;
  const { alongX, alongY } = alongWallBase(comp, block);

  if (block.orientation === 'north_south') {
    if (block.anchor_side === 'east')
      return { x: comp.x_ft + comp.east_west_ft - block.offset_ft - block.row_width_ft - idx * step, y: alongY, w: block.row_width_ft, h: block.row_length_ft };
    // west anchor
    return { x: comp.x_ft + block.offset_ft + idx * step, y: alongY, w: block.row_width_ft, h: block.row_length_ft };
  }

  // east_west orientation
  if (block.anchor_side === 'north')
    return { x: alongX, y: comp.y_ft + block.offset_ft + idx * step, w: block.row_length_ft, h: block.row_width_ft };
  // south anchor
  return { x: alongX, y: comp.y_ft + comp.north_south_ft - block.offset_ft - block.row_width_ft - idx * step, w: block.row_length_ft, h: block.row_width_ft };
}

/** Bounding box of a block with `rowCount` rows. Returns null if rowCount === 0. */
export function blockBBox(comp: CompGeom, block: BlockGeom, rowCount: number): Rect | null {
  if (rowCount === 0) return null;
  const first = blockRowRect(comp, block, 0);
  const last  = blockRowRect(comp, block, rowCount - 1);
  const x = Math.min(first.x, last.x);
  const y = Math.min(first.y, last.y);
  return {
    x, y,
    w: Math.max(first.x + first.w, last.x + last.w) - x,
    h: Math.max(first.y + first.h, last.y + last.h) - y,
  };
}

/**
 * Along-wall span [min, max] of a block.
 *
 * For east_west orientation (rows run E↔W, stacked N↕S):
 *   → X range along the E↔W wall.
 * For north_south orientation (rows run N↕S, stacked E↔W):
 *   → Y range along the N↕S wall.
 *
 * Used by 'continue' placement to find which existing blocks overlap
 * with a new block's along-wall position before inheriting their depth.
 */
export function blockAlongWallSpan(comp: CompGeom, block: BlockGeom): [number, number] {
  const { alongX, alongY } = alongWallBase(comp, block);
  if (block.orientation === 'east_west') {
    return [alongX, alongX + block.row_length_ft];
  }
  return [alongY, alongY + block.row_length_ft];
}

/**
 * Total depth inward from the anchor wall that a block with `rowCount` rows occupies.
 * Measured from the anchor wall face (excluding the initial offset_ft gap).
 *
 * Returns 0 when rowCount === 0.
 */
export function blockOccupiedDepth(block: BlockGeom, rowCount: number): number {
  if (rowCount === 0) return 0;
  const step = block.row_width_ft + block.row_spacing_ft;
  return block.offset_ft + block.row_width_ft + (rowCount - 1) * step;
}

/** Returns true if [a0, a1) and [b0, b1) overlap by more than EPS. */
export function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] - EPS && b[0] < a[1] - EPS;
}

/** Returns true if two rectangles overlap (touching edges do not count). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x + a.w > b.x + EPS && b.x + b.w > a.x + EPS &&
    a.y + a.h > b.y + EPS && b.y + b.h > a.y + EPS
  );
}

/** Rectangle for a walkway within a compartment. */
export function walkwayRect(comp: CompGeom, wk: WkGeom): Rect {
  if (wk.orientation === 'north_south') {
    let x: number;
    if      (wk.offset_from_side === 'centered') x = comp.x_ft + (comp.east_west_ft - wk.width_ft) / 2;
    else if (wk.offset_from_side === 'east')     x = comp.x_ft + comp.east_west_ft - wk.offset_ft - wk.width_ft;
    else                                         x = comp.x_ft + wk.offset_ft;
    return { x, y: comp.y_ft, w: wk.width_ft, h: comp.north_south_ft };
  }
  let y: number;
  if      (wk.offset_from_side === 'centered') y = comp.y_ft + (comp.north_south_ft - wk.width_ft) / 2;
  else if (wk.offset_from_side === 'south')    y = comp.y_ft + comp.north_south_ft - wk.offset_ft - wk.width_ft;
  else                                         y = comp.y_ft + wk.offset_ft;
  return { x: comp.x_ft, y, w: comp.east_west_ft, h: wk.width_ft };
}
