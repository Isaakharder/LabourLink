// Deterministic greenhouse row placement math — client mirror of
// server/src/lib/rowLayout.ts (kept in sync by hand; this app has no shared
// package between server/ and web/, same reasoning as lib/timezone.ts).
// Used here purely for the row builder's live preview — the server
// recomputes every row's geometry itself from the same batch parameters
// before ever writing anything, so a stale or diverged copy of this file
// could show a misleading preview but can never cause bad data to persist.
//
// ---------------------------------------------------------------------------
// Side/anchor mapping (the deterministic placement contract)
// ---------------------------------------------------------------------------
// All coordinates below are PHASE-RELATIVE feet from the phase's own
// north-west corner: x increases eastward, y increases southward — the
// same axis convention greenhouse_phases already uses relative to its land
// (x_feet_from_west/y_feet_from_north).
//
// `startSide` is the edge rows are stacked outward from (row 1 sits
// nearest that edge; each subsequent row number moves one step further
// in). `anchorSide` is the edge each individual row's own length is
// flush against; the row extends away from that edge for `rowLengthFt`.
// startSide and anchorSide must always fall on perpendicular axes — North
// or South only ever pairs with East or West, and vice versa — pairing a
// side with itself or its opposite (e.g. South+North) has no defined
// meaning and is rejected.
//
//   startSide  anchorSide  stacking axis    row extends
//   ---------  ----------  ---------------  --------------------------------
//   south      east        Y, from south    from east edge, westward
//   south      west        Y, from south    from west edge, eastward
//   north      east        Y, from north    from east edge, westward
//   north      west        Y, from north    from west edge, eastward
//   east       north       X, from east     from north edge, southward
//   east       south       X, from east     from south edge, northward
//   west       north       X, from west     from north edge, southward
//   west       south       X, from west     from south edge, northward
//
// A south/north start stacks rows along Y (each row is a horizontal strip,
// `rowWidthFt` tall, `rowLengthFt` wide); an east/west start stacks along X
// (each row is a vertical strip, `rowWidthFt` wide, `rowLengthFt` tall).
// `orientation` records which: 'horizontal' for south/north-started
// batches, 'vertical' for east/west-started ones.

export type Side = "north" | "south" | "east" | "west";
export type NumberingMode = "all" | "odd" | "even";
export type Orientation = "horizontal" | "vertical";

export interface PhaseSize {
  eastWestFeet: number;
  northSouthFeet: number;
}

export interface RowRect {
  rowNumber: number;
  xFt: number;
  yFt: number;
  widthFt: number;
  lengthFt: number;
  orientation: Orientation;
}

// Screen/SVG width+height for a row rect — orientation determines which of
// widthFt/lengthFt maps to which rendered dimension. Used by the read-only
// live map's GreenhouseLiveCanvas (LandCanvas keeps its own local copy of
// this same small calculation).
export function rowScreenRect(row: { widthFt: number; lengthFt: number; orientation: string }) {
  const w = row.orientation === "horizontal" ? row.lengthFt : row.widthFt;
  const h = row.orientation === "horizontal" ? row.widthFt : row.lengthFt;
  return { width: w, height: h };
}

export interface BatchParams {
  startSide: Side;
  anchorSide: Side;
  rowWidthFt: number;
  rowLengthFt: number;
  rowGapFt: number;
  offsetFt: number;
  numberingMode: NumberingMode;
  startRowNumber: number;
  endRowNumber: number;
}

// Tolerance for floating-point drift when comparing an edge against a
// boundary or testing for overlap — same value/rationale as
// PhasePositionEditor's EPSILON.
const EPSILON = 0.001;

export function isValidSide(v: unknown): v is Side {
  return v === "north" || v === "south" || v === "east" || v === "west";
}

export function isValidNumberingMode(v: unknown): v is NumberingMode {
  return v === "all" || v === "odd" || v === "even";
}

// Perpendicular-axis pairing required by the mapping table above.
export function sidesArePerpendicular(startSide: Side, anchorSide: Side): boolean {
  const startAxisNS = startSide === "north" || startSide === "south";
  const anchorAxisNS = anchorSide === "north" || anchorSide === "south";
  return startAxisNS !== anchorAxisNS;
}

export function orientationForStartSide(startSide: Side): Orientation {
  return startSide === "north" || startSide === "south" ? "horizontal" : "vertical";
}

// Every integer in [startRowNumber, endRowNumber], filtered to the parity
// numberingMode asks for. Deliberately filters rather than "rounding" a
// start/end that doesn't match the mode's parity (e.g. numberingMode
// 'odd', startRowNumber 2, endRowNumber 16 -> 3,5,...,15) — filtering is
// the one interpretation that never silently drops or invents a boundary
// value.
export function generateRowNumbers(
  numberingMode: NumberingMode,
  startRowNumber: number,
  endRowNumber: number
): number[] {
  if (!Number.isInteger(startRowNumber) || !Number.isInteger(endRowNumber)) return [];
  if (startRowNumber < 1 || endRowNumber < startRowNumber) return [];
  const out: number[] = [];
  for (let n = startRowNumber; n <= endRowNumber; n++) {
    if (numberingMode === "all" || (numberingMode === "odd") === (n % 2 !== 0)) out.push(n);
  }
  return out;
}

// Places one batch's rows along its startSide/anchorSide, in the same
// order as `rowNumbers` (index i = stack position i, 0 = nearest
// startSide). Pure function of the batch parameters and phase size only —
// never reads or mutates any other row.
export function placeBatchFromSide(params: BatchParams, phase: PhaseSize, rowNumbers: number[]): RowRect[] {
  const { startSide, anchorSide, rowWidthFt, rowLengthFt, rowGapFt, offsetFt } = params;
  const orientation = orientationForStartSide(startSide);
  const pitch = rowWidthFt + rowGapFt;

  return rowNumbers.map((rowNumber, i) => {
    // Stacking coordinate: the position along the startSide's axis of the
    // row's edge nearest that side, then its far edge is +widthFt further
    // "in." South/east stack from the far (max) boundary inward
    // (decreasing); north/west stack from 0 outward (increasing).
    let xFt: number;
    let yFt: number;

    if (startSide === "south") {
      yFt = phase.northSouthFeet - offsetFt - (i + 1) * rowWidthFt - i * rowGapFt;
    } else if (startSide === "north") {
      yFt = offsetFt + i * pitch;
    } else if (startSide === "east") {
      xFt = phase.eastWestFeet - offsetFt - (i + 1) * rowWidthFt - i * rowGapFt;
    } else {
      xFt = offsetFt + i * pitch;
    }

    if (orientation === "horizontal") {
      // south/north start -> stacked on y (computed above); x comes from
      // the anchor side, flush against it for the row's full length.
      xFt = anchorSide === "east" ? phase.eastWestFeet - rowLengthFt : 0;
    } else {
      // east/west start -> stacked on x (computed above); y from anchor.
      yFt = anchorSide === "south" ? phase.northSouthFeet - rowLengthFt : 0;
    }

    return {
      rowNumber,
      xFt: xFt!,
      yFt: yFt!,
      widthFt: rowWidthFt,
      lengthFt: rowLengthFt,
      orientation,
    };
  });
}

function rowBounds(row: RowRect) {
  const w = row.orientation === "horizontal" ? row.lengthFt : row.widthFt;
  const h = row.orientation === "horizontal" ? row.widthFt : row.lengthFt;
  return { x0: row.xFt, y0: row.yFt, x1: row.xFt + w, y1: row.yFt + h };
}

// Rows whose bounding box isn't fully within [0, phase.eastWestFeet] x
// [0, phase.northSouthFeet] (within EPSILON) — empty means all rows fit.
export function validateRowsInsidePhase(rows: RowRect[], phase: PhaseSize): RowRect[] {
  return rows.filter((r) => {
    const b = rowBounds(r);
    return b.x0 < -EPSILON || b.y0 < -EPSILON || b.x1 > phase.eastWestFeet + EPSILON || b.y1 > phase.northSouthFeet + EPSILON;
  });
}

// Pairs of rows whose bounding boxes overlap by a positive area — rows
// that merely touch at a shared edge (overlap area exactly 0) are NOT
// reported, matching the existing phase-overlap check's
// `overlapX > 0 && overlapY > 0` convention.
export function detectRowOverlap(rowsA: RowRect[], rowsB: RowRect[]): [RowRect, RowRect][] {
  const pairs: [RowRect, RowRect][] = [];
  for (const a of rowsA) {
    const ba = rowBounds(a);
    for (const b of rowsB) {
      if (a === b) continue;
      const bb = rowBounds(b);
      const overlapX = Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0);
      const overlapY = Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0);
      if (overlapX > EPSILON && overlapY > EPSILON) pairs.push([a, b]);
    }
  }
  return pairs;
}

// How far stacking has already progressed inward from `startSide`, given
// the existing rows that were themselves placed from that same phase +
// start side (caller's responsibility to pre-filter by joining each row's
// batch — a row's orientation alone doesn't distinguish "started from
// south" from "started from north"). Returns 0 if there's nothing to
// continue from, so continuation degrades gracefully to a fresh start.
export function computeContinuationOffset(
  existingRowsSameStartSide: RowRect[],
  phase: PhaseSize,
  startSide: Side,
  rowGapFt: number
): number {
  if (existingRowsSameStartSide.length === 0) return 0;
  let maxDepth = 0;
  for (const r of existingRowsSameStartSide) {
    const b = rowBounds(r);
    let depth: number;
    if (startSide === "south") depth = phase.northSouthFeet - b.y0;
    else if (startSide === "north") depth = b.y1;
    else if (startSide === "east") depth = phase.eastWestFeet - b.x0;
    else depth = b.x1;
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth + rowGapFt;
}

export interface RowPreviewResult {
  rows: RowRect[];
  rowNumbers: number[];
  errors: string[];
}

// Top-level orchestrator: validates the batch's own parameters, generates
// row numbers, resolves continuation (if requested), places the rows, and
// checks bounds + self-overlap. Does NOT check overlap against other
// existing rows in the phase — that depends on data (all other active
// rows) the caller has to fetch, so it stays a separate detectRowOverlap
// call against this result's `rows`.
export function generateRowPreview(
  params: BatchParams,
  phase: PhaseSize,
  options: { continueAfterExisting?: boolean; existingRowsSameStartSide?: RowRect[] } = {}
): RowPreviewResult {
  const errors: string[] = [];

  if (!isValidSide(params.startSide) || !isValidSide(params.anchorSide)) {
    errors.push("Start side and anchor side must each be one of north, south, east, or west.");
  } else if (!sidesArePerpendicular(params.startSide, params.anchorSide)) {
    errors.push("Anchor side must be perpendicular to the start side (e.g. South start pairs with East or West, not North or South).");
  }
  if (!isValidNumberingMode(params.numberingMode)) {
    errors.push("Numbering mode must be all, odd, or even.");
  }
  if (!Number.isFinite(params.rowWidthFt) || params.rowWidthFt <= 0) {
    errors.push("Row width must be a number greater than 0.");
  }
  if (!Number.isFinite(params.rowLengthFt) || params.rowLengthFt <= 0) {
    errors.push("Row length must be a number greater than 0.");
  }
  if (!Number.isFinite(params.rowGapFt) || params.rowGapFt < 0) {
    errors.push("Row gap must be a number of 0 or greater.");
  }
  if (!Number.isFinite(params.offsetFt) || params.offsetFt < 0) {
    errors.push("Offset must be a number of 0 or greater.");
  }
  if (!Number.isInteger(params.startRowNumber) || params.startRowNumber < 1) {
    errors.push("Start row number must be a whole number of 1 or greater.");
  }
  if (!Number.isInteger(params.endRowNumber) || params.endRowNumber < 1) {
    errors.push("End row number must be a whole number of 1 or greater.");
  }
  if (Number.isInteger(params.startRowNumber) && Number.isInteger(params.endRowNumber) && params.endRowNumber < params.startRowNumber) {
    errors.push("End row number must be greater than or equal to the start row number.");
  }
  if (errors.length > 0) return { rows: [], rowNumbers: [], errors };

  const rowNumbers = generateRowNumbers(params.numberingMode, params.startRowNumber, params.endRowNumber);
  if (rowNumbers.length === 0) {
    errors.push("This numbering mode and range produce no rows (e.g. an odd-only range with no odd numbers in it).");
    return { rows: [], rowNumbers: [], errors };
  }

  let effectiveParams = params;
  if (options.continueAfterExisting) {
    const continuationBase = computeContinuationOffset(
      options.existingRowsSameStartSide ?? [],
      phase,
      params.startSide,
      params.rowGapFt
    );
    // The batch's own offsetFt is additive on top of the auto-computed
    // continuation point — e.g. leaving extra breathing room after Batch 1
    // before Batch 2's first row, on top of just the row gap.
    effectiveParams = { ...params, offsetFt: continuationBase + params.offsetFt };
  }

  const rows = placeBatchFromSide(effectiveParams, phase, rowNumbers);

  const outOfBounds = validateRowsInsidePhase(rows, phase);
  if (outOfBounds.length > 0) {
    errors.push(
      `${outOfBounds.length} row(s) (e.g. row ${outOfBounds[0].rowNumber}) would fall outside the phase boundary.`
    );
  }

  const selfOverlaps = detectRowOverlap(rows, rows);
  if (selfOverlaps.length > 0) {
    const [a, b] = selfOverlaps[0];
    errors.push(`Row ${a.rowNumber} overlaps row ${b.rowNumber} within this batch — increase the gap or narrow the range.`);
  }

  return { rows, rowNumbers, errors };
}
