/**
 * Frontend adapter for shared/greenhouse-geometry.ts.
 *
 * Translates between the camelCase API types used by React components and the
 * snake_case types used by the canonical shared geometry module.  All actual
 * geometry calculations live in the shared module — this file contains only
 * field-name mapping (zero geometry logic).
 */

import {
  blockRowRect as _blockRowRect,
  blockBBox    as _blockBBox,
  blockAlongWallSpan as _blockAlongWallSpan,
  walkwayRect  as _walkwayRect,
  blockOccupiedDepth,
  rangesOverlap,
  type CompGeom,
  type BlockGeom,
  type Rect,
} from '@shared/greenhouse-geometry';

export { blockOccupiedDepth, rangesOverlap };
export type { Rect, CompGeom, BlockGeom };

// ── Stored-coordinate helpers (use physical coords saved per row) ──────────────
// These replace index-based geometry calls once rows have fixed x_ft/y_ft.

type StoredRow = { xFt: number; yFt: number; widthFt: number; lengthFt: number; orientation: string };
type CompDims  = { xFt: number; yFt: number; eastWestFt: number; northSouthFt: number };

/** Rectangle from a row's stored physical coordinates. */
export function rowToRect(row: StoredRow): Rect {
  const isEW = row.orientation === 'east_west';
  return {
    x: row.xFt,
    y: row.yFt,
    w: isEW ? row.lengthFt : row.widthFt,
    h: isEW ? row.widthFt  : row.lengthFt,
  };
}

/** Union bounding box of existing rows using stored coords (handles gaps from deletions). */
export function blockBBoxFromRows(rows: StoredRow[]): Rect | null {
  if (!rows.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const row of rows) {
    const r = rowToRect(row);
    if (r.x         < minX) minX = r.x;
    if (r.y         < minY) minY = r.y;
    if (r.x + r.w   > maxX) maxX = r.x + r.w;
    if (r.y + r.h   > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Actual depth occupied from the anchor wall, measured from stored row coordinates.
 * Correct even after row deletions (gaps don't affect the extent of remaining rows).
 */
export function blockActualDepth(
  anchorSide: string,
  rows: StoredRow[],
  comp: CompDims,
): number {
  if (!rows.length) return 0;
  switch (anchorSide) {
    case 'south': return (comp.yFt + comp.northSouthFt) - Math.min(...rows.map(r => r.yFt));
    case 'north': return Math.max(...rows.map(r => r.yFt + r.widthFt)) - comp.yFt;
    case 'east':  return (comp.xFt + comp.eastWestFt)  - Math.min(...rows.map(r => r.xFt));
    case 'west':  return Math.max(...rows.map(r => r.xFt + r.widthFt)) - comp.xFt;
    default:      return 0;
  }
}

// ── Adapter arg shapes (camelCase, matching API types) ─────────────────────────

type CompArg = { xFt: number; yFt: number; eastWestFt: number; northSouthFt: number };

type BlockArg = {
  orientation: string;
  anchorSide: string;
  offsetFt: number;
  rowWidthFt: number;
  rowLengthFt: number;
  rowSpacingFt: number;
  alongWallStart: string;
  alongWallOffsetFt: number;
};

type WkArg = { orientation: string; widthFt: number; offsetFromSide: string; offsetFt: number };

// ── Private converters ─────────────────────────────────────────────────────────

function toCompGeom(c: CompArg): CompGeom {
  return { x_ft: c.xFt, y_ft: c.yFt, east_west_ft: c.eastWestFt, north_south_ft: c.northSouthFt };
}

function toBlockGeom(b: BlockArg): BlockGeom {
  return {
    orientation:          b.orientation,
    anchor_side:          b.anchorSide,
    offset_ft:            b.offsetFt,
    row_width_ft:         b.rowWidthFt,
    row_length_ft:        b.rowLengthFt,
    row_spacing_ft:       b.rowSpacingFt,
    along_wall_start:     b.alongWallStart,
    along_wall_offset_ft: b.alongWallOffsetFt,
  };
}

// ── Public API (same signatures as canvas / panel expect) ─────────────────────

/** Rectangle for row at index `idx` within a block. */
export function blockRowRect(comp: CompArg, block: BlockArg, idx: number): Rect {
  return _blockRowRect(toCompGeom(comp), toBlockGeom(block), idx);
}

/**
 * Bounding box of all rows in a block.
 * Accepts any object with a `.rows` array whose length gives the row count.
 */
export function blockBBox(
  comp: CompArg,
  block: BlockArg & { rows: unknown[] },
): Rect | null {
  return _blockBBox(toCompGeom(comp), toBlockGeom(block), block.rows.length);
}

/**
 * Along-wall span [min, max] of a block.
 * For east_west: X range. For north_south: Y range.
 */
export function blockAlongWallSpan(comp: CompArg, block: BlockArg): [number, number] {
  return _blockAlongWallSpan(toCompGeom(comp), toBlockGeom(block));
}

/** Rectangle for a walkway within a compartment. */
export function walkwayRect(comp: CompArg, wk: WkArg): Rect {
  return _walkwayRect(toCompGeom(comp), {
    orientation:      wk.orientation,
    width_ft:         wk.widthFt,
    offset_from_side: wk.offsetFromSide,
    offset_ft:        wk.offsetFt,
  });
}
