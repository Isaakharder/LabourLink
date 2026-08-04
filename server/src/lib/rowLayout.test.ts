// Deterministic checks for lib/rowLayout.ts's placement math. This repo has
// no test framework configured (no vitest/jest, no "test" script pre-dating
// this file) — rather than adding one for a single module, this is a
// plain, dependency-free, assertion-based script. Run it directly via
// `npm run test:row-layout` (see server/package.json). Excluded from the
// production build (see the tsconfig "exclude") so it never ships in dist/;
// still fully type-checked on every run since ts-node compiles whatever
// file it's pointed at regardless of tsconfig excludes.
//
// This file is maintained alongside rowLayout.ts — update it whenever the
// placement/validation behavior changes, the same as any other test.
import {
  generateRowNumbers,
  placeBatchFromSide,
  detectRowOverlap,
  validateRowsInsidePhase,
  computeContinuationOffset,
  generateRowPreview,
  sidesArePerpendicular,
  BatchParams,
  RowRect,
} from "./rowLayout";

let pass = 0;
let fail = 0;

function check(condition: boolean, label: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}

function approxEqual(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------
// generateRowNumbers
// ---------------------------------------------------------------------------

check(JSON.stringify(generateRowNumbers("odd", 1, 15)) === JSON.stringify([1, 3, 5, 7, 9, 11, 13, 15]), "odd 1-15");
check(JSON.stringify(generateRowNumbers("even", 2, 16)) === JSON.stringify([2, 4, 6, 8, 10, 12, 14, 16]), "even 2-16");
check(JSON.stringify(generateRowNumbers("all", 1, 10)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), "all 1-10");
check(generateRowNumbers("all", 10, 5).length === 0, "start > end produces no rows");
// odd mode with EVEN start/end inputs: filters to the odd numbers within
// the range rather than rounding the boundary.
check(JSON.stringify(generateRowNumbers("odd", 2, 16)) === JSON.stringify([3, 5, 7, 9, 11, 13, 15]), "odd mode, even start/end");
check(JSON.stringify(generateRowNumbers("even", 1, 9)) === JSON.stringify([2, 4, 6, 8]), "even mode, odd start/end");
check(generateRowNumbers("odd", 2, 2).length === 0, "odd mode over a single even number produces no rows");

// ---------------------------------------------------------------------------
// sidesArePerpendicular
// ---------------------------------------------------------------------------

check(sidesArePerpendicular("south", "east") === true, "south+east perpendicular");
check(sidesArePerpendicular("south", "west") === true, "south+west perpendicular");
check(sidesArePerpendicular("south", "north") === false, "south+north rejected (opposite)");
check(sidesArePerpendicular("east", "west") === false, "east+west rejected (opposite)");
check(sidesArePerpendicular("north", "north") === false, "north+north rejected (same side)");

// ---------------------------------------------------------------------------
// placeBatchFromSide — the 8 documented start/anchor combinations
// ---------------------------------------------------------------------------

const phase = { eastWestFeet: 100, northSouthFeet: 60 };

function place(startSide: BatchParams["startSide"], anchorSide: BatchParams["anchorSide"], overrides: Partial<BatchParams> = {}) {
  const params: BatchParams = {
    startSide,
    anchorSide,
    rowWidthFt: 4,
    rowLengthFt: 30,
    rowGapFt: 1,
    offsetFt: 0,
    numberingMode: "all",
    startRowNumber: 1,
    endRowNumber: 3,
    ...overrides,
  };
  return placeBatchFromSide(params, phase, generateRowNumbers(params.numberingMode, params.startRowNumber, params.endRowNumber));
}

{
  // South start + East anchor: rows align to the east side (x + length =
  // eastWestFeet), stacked from the south edge (row 1's south edge = phase
  // south boundary) moving north.
  const rows = place("south", "east");
  check(rows[0].orientation === "horizontal", "south+east: horizontal orientation");
  check(approxEqual(rows[0].xFt + rows[0].lengthFt, phase.eastWestFeet), "south+east: row 1 flush against east edge");
  check(approxEqual(rows[0].yFt + rows[0].widthFt, phase.northSouthFeet), "south+east: row 1 flush against south edge");
  check(rows[1].yFt < rows[0].yFt, "south+east: row 2 sits further north (smaller y) than row 1");
}

{
  // South start + West anchor: rows align to the west side, stacked from
  // south moving north.
  const rows = place("south", "west");
  check(approxEqual(rows[0].xFt, 0), "south+west: row 1 flush against west edge (x=0)");
  check(approxEqual(rows[0].yFt + rows[0].widthFt, phase.northSouthFeet), "south+west: row 1 flush against south edge");
}

{
  // North start + East anchor: rows align east, stacked from north moving
  // south.
  const rows = place("north", "east");
  check(approxEqual(rows[0].yFt, 0), "north+east: row 1 flush against north edge (y=0)");
  check(approxEqual(rows[0].xFt + rows[0].lengthFt, phase.eastWestFeet), "north+east: row 1 flush against east edge");
  check(rows[1].yFt > rows[0].yFt, "north+east: row 2 sits further south (larger y) than row 1");
}

{
  // West start + North anchor: rows align north, stacked from west moving
  // east; orientation vertical (length runs north-south).
  const rows = place("west", "north");
  check(rows[0].orientation === "vertical", "west+north: vertical orientation");
  check(approxEqual(rows[0].xFt, 0), "west+north: row 1 flush against west edge");
  check(approxEqual(rows[0].yFt, 0), "west+north: row 1 flush against north edge");
  check(rows[1].xFt > rows[0].xFt, "west+north: row 2 sits further east (larger x) than row 1");
}

{
  // East start + South anchor.
  const rows = place("east", "south");
  check(approxEqual(rows[0].xFt + rows[0].widthFt, phase.eastWestFeet), "east+south: row 1 flush against east edge");
  check(approxEqual(rows[0].yFt + rows[0].lengthFt, phase.northSouthFeet), "east+south: row 1 flush against south edge");
  check(rows[1].xFt < rows[0].xFt, "east+south: row 2 sits further west (smaller x) than row 1");
}

// ---------------------------------------------------------------------------
// Rows exactly touching but not overlapping
// ---------------------------------------------------------------------------

{
  const touching = place("south", "east", { rowGapFt: 0 });
  // rowGapFt=0 means each row's edge exactly meets the next row's edge —
  // this must NOT be reported as an overlap.
  const overlaps = detectRowOverlap(touching, touching);
  check(overlaps.length === 0, "zero-gap adjacent rows are touching, not overlapping");
}

{
  // Force an actual overlap: same width, negative-equivalent gap achieved
  // by manually shifting one row's y into another's span.
  const a: RowRect = { rowNumber: 1, xFt: 0, yFt: 0, widthFt: 10, lengthFt: 10, orientation: "horizontal" };
  const b: RowRect = { rowNumber: 2, xFt: 5, yFt: 5, widthFt: 10, lengthFt: 10, orientation: "horizontal" };
  check(detectRowOverlap([a], [b]).length === 1, "genuinely overlapping rects are detected");
}

// ---------------------------------------------------------------------------
// validateRowsInsidePhase — out of bounds
// ---------------------------------------------------------------------------

{
  const tooLong: RowRect = { rowNumber: 1, xFt: 0, yFt: 0, widthFt: 4, lengthFt: 500, orientation: "horizontal" };
  check(validateRowsInsidePhase([tooLong], phase).length === 1, "a row longer than the phase is out of bounds");

  const fine: RowRect = { rowNumber: 1, xFt: 0, yFt: 0, widthFt: 4, lengthFt: 30, orientation: "horizontal" };
  check(validateRowsInsidePhase([fine], phase).length === 0, "a row within the phase passes bounds check");
}

// ---------------------------------------------------------------------------
// computeContinuationOffset — batch continuation
// ---------------------------------------------------------------------------

{
  // Batch 1: south+east, rows 1-15 odd, length 300, on a much bigger phase.
  const bigPhase = { eastWestFeet: 400, northSouthFeet: 200 };
  const batch1Params: BatchParams = {
    startSide: "south",
    anchorSide: "east",
    rowWidthFt: 4,
    rowLengthFt: 300,
    rowGapFt: 1,
    offsetFt: 0,
    numberingMode: "odd",
    startRowNumber: 1,
    endRowNumber: 15,
  };
  const batch1Numbers = generateRowNumbers("odd", 1, 15);
  const batch1Rows = placeBatchFromSide(batch1Params, bigPhase, batch1Numbers);
  check(batch1Rows.length === 8, "batch 1 places 8 odd rows (1..15)");

  const continuationOffset = computeContinuationOffset(batch1Rows, bigPhase, "south", 1);
  // Batch 1's innermost row (row 15) reaches depth = 8 rows * (4+1) - 1 gap
  // (no trailing gap after the last row) = 8*4 + 7*1 = 39ft from the south
  // edge; continuation should start at 39 + gap(1) = 40ft in.
  check(approxEqual(continuationOffset, 40), `continuation offset is 40ft, got ${continuationOffset}`);

  // Batch 2 continues from there — its first row must not overlap any of
  // batch 1's rows.
  const batch2Params: BatchParams = { ...batch1Params, offsetFt: continuationOffset, numberingMode: "odd", startRowNumber: 17, endRowNumber: 31 };
  const batch2Numbers = generateRowNumbers("odd", 17, 31);
  const batch2Rows = placeBatchFromSide(batch2Params, bigPhase, batch2Numbers);
  check(detectRowOverlap(batch1Rows, batch2Rows).length === 0, "continuation batch does not overlap the prior batch");
  check(!batch1Rows.some((r) => r.rowNumber === 17), "no duplicate row numbers between the two batches (disjoint ranges)");
}

// ---------------------------------------------------------------------------
// Opposite-side batches leaving a central walkway
// ---------------------------------------------------------------------------

{
  const bigPhase = { eastWestFeet: 200, northSouthFeet: 100 };
  const southBatch = placeBatchFromSide(
    { startSide: "south", anchorSide: "east", rowWidthFt: 4, rowLengthFt: 150, rowGapFt: 1, offsetFt: 0, numberingMode: "odd", startRowNumber: 1, endRowNumber: 15 },
    bigPhase,
    generateRowNumbers("odd", 1, 15)
  );
  // North batch, offset by 20ft manual walkway from the north edge, even
  // numbers, same width/length — should land entirely in the northern
  // half with a gap before the south batch's innermost row.
  const northBatch = placeBatchFromSide(
    { startSide: "north", anchorSide: "west", rowWidthFt: 4, rowLengthFt: 150, rowGapFt: 1, offsetFt: 20, numberingMode: "even", startRowNumber: 2, endRowNumber: 16 },
    bigPhase,
    generateRowNumbers("even", 2, 16)
  );
  check(detectRowOverlap(southBatch, northBatch).length === 0, "opposite-side batches with a walkway offset do not overlap");
  const southInnermost = Math.min(...southBatch.map((r) => r.yFt));
  const northInnermost = Math.max(...northBatch.map((r) => r.yFt + r.widthFt));
  check(southInnermost > northInnermost, "a real walkway gap exists between the two batches");
}

// ---------------------------------------------------------------------------
// generateRowPreview — end-to-end validation surfacing
// ---------------------------------------------------------------------------

{
  const badRange = generateRowPreview(
    { startSide: "south", anchorSide: "east", rowWidthFt: 4, rowLengthFt: 30, rowGapFt: 1, offsetFt: 0, numberingMode: "all", startRowNumber: 10, endRowNumber: 5 },
    phase
  );
  check(badRange.errors.length > 0, "start > end surfaces a validation error via generateRowPreview");

  const zeroWidth = generateRowPreview(
    { startSide: "south", anchorSide: "east", rowWidthFt: 0, rowLengthFt: 30, rowGapFt: 1, offsetFt: 0, numberingMode: "all", startRowNumber: 1, endRowNumber: 3 },
    phase
  );
  check(zeroWidth.errors.length > 0, "zero width is rejected");

  const negativeLength = generateRowPreview(
    { startSide: "south", anchorSide: "east", rowWidthFt: 4, rowLengthFt: -10, rowGapFt: 1, offsetFt: 0, numberingMode: "all", startRowNumber: 1, endRowNumber: 3 },
    phase
  );
  check(negativeLength.errors.length > 0, "negative length is rejected");

  const outOfBounds = generateRowPreview(
    { startSide: "south", anchorSide: "east", rowWidthFt: 4, rowLengthFt: 300, rowGapFt: 1, offsetFt: 0, numberingMode: "all", startRowNumber: 1, endRowNumber: 3 },
    phase
  );
  check(outOfBounds.errors.length > 0, "a row longer than the phase surfaces a bounds error");

  const nonPerpendicular = generateRowPreview(
    { startSide: "south", anchorSide: "north", rowWidthFt: 4, rowLengthFt: 30, rowGapFt: 1, offsetFt: 0, numberingMode: "all", startRowNumber: 1, endRowNumber: 3 },
    phase
  );
  check(nonPerpendicular.errors.length > 0, "south start + north anchor (non-perpendicular) is rejected");

  const good = generateRowPreview(
    { startSide: "south", anchorSide: "east", rowWidthFt: 4, rowLengthFt: 30, rowGapFt: 1, offsetFt: 0, numberingMode: "odd", startRowNumber: 1, endRowNumber: 15 },
    phase
  );
  check(good.errors.length === 0 && good.rows.length === 8, "a valid batch produces 8 rows with no errors");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
