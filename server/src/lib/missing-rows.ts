/**
 * Pure logic for detecting missing physical row slots within a block.
 *
 * A "slot" is a position in the regular step grid implied by the block's
 * row_width_ft + row_spacing_ft. When a row is deleted the physical slot
 * remains empty; this module finds those gaps.
 *
 * No database access — usable in tests without any DB.
 */

import { EPS } from '../../../shared/greenhouse-geometry';

export interface StoredRow {
  row_number: number;
  x_ft: number;
  y_ft: number;
  width_ft: number;
  length_ft: number;
  orientation: string;
}

export interface BlockParams {
  anchor_side: string;
  orientation: string;
  row_width_ft: number;
  row_length_ft: number;
  row_spacing_ft: number;
}

export interface MissingSlot {
  /** Exact top-left x coordinate of the missing slot (same as blockRowRect would compute). */
  xFt: number;
  /** Exact top-left y coordinate. */
  yFt: number;
  widthFt: number;
  lengthFt: number;
  orientation: string;
  /**
   * Row number inferred from surrounding rows when the row_number gap between
   * neighbours exactly matches the number of missing physical slots. Null otherwise.
   */
  inferredRowNumber: number | null;
  /** row_numbers of the two surrounding rows, in slot order. */
  neighborRowNumbers: [number, number];
}

/**
 * Detect empty slots in `rows` given a block's geometry.
 *
 * Rows are sorted by their depth coordinate (y for EW orientation, x for NS)
 * in the direction that corresponds to increasing slot index, then consecutive
 * pairs are checked for a gap larger than one step.
 */
export function detectMissingSlots(
  block: BlockParams,
  rows: StoredRow[],
): MissingSlot[] {
  if (rows.length < 2) return [];

  const step = block.row_width_ft + block.row_spacing_ft;
  if (step < EPS) return [];

  // For EW orientation the depth axis is Y; for NS it is X.
  const isNS        = block.orientation === 'north_south';
  // South and east anchors number from the wall inward, so depth coord decreases
  // as slot index increases (sort descending = slot order).
  const isDescending = block.anchor_side === 'south' || block.anchor_side === 'east';

  const getDepth = (r: StoredRow) => isNS ? r.x_ft : r.y_ft;
  const getAlong = (r: StoredRow) => isNS ? r.y_ft : r.x_ft;

  const sorted = [...rows].sort((a, b) => {
    const diff = getDepth(a) - getDepth(b);
    return isDescending ? -diff : diff;
  });

  const missing: MissingSlot[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const rowA = sorted[i];
    const rowB = sorted[i + 1];

    const depthA   = getDepth(rowA);
    const depthB   = getDepth(rowB);
    const gap      = Math.abs(depthB - depthA);
    const nSlots   = Math.round(gap / step);
    const nMissing = nSlots - 1;

    if (nMissing < 1) continue;

    const rnA    = rowA.row_number;
    const rnB    = rowB.row_number;
    const rnGap  = rnB - rnA - 1; // ≥ 0 when row numbers increase with slot order
    const along  = getAlong(rowA); // same for all rows in a uniform block

    for (let j = 1; j <= nMissing; j++) {
      const depthCoord = isDescending
        ? depthA - j * step  // moving away from south/east wall
        : depthA + j * step; // moving away from north/west wall

      const inferredRowNumber =
        rnGap === nMissing && rnGap > 0 ? rnA + j : null;

      missing.push({
        xFt:        isNS ? depthCoord : along,
        yFt:        isNS ? along      : depthCoord,
        widthFt:    block.row_width_ft,
        lengthFt:   block.row_length_ft,
        orientation: block.orientation,
        inferredRowNumber,
        neighborRowNumbers: [rnA, rnB],
      });
    }
  }

  return missing;
}
