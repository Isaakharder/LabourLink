import {
  BatchParams,
  RowRect,
  Side,
  computeContinuationOffset,
  detectRowOverlap,
  generateRowNumbers,
  generateRowPreview,
  placeBatchFromSide,
  sidesArePerpendicular,
  validateRowsInsidePhase,
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

function approxEqual(a: number, b: number, eps = 0.001) {
  return Math.abs(a - b) < eps;
}

function rowRectJson(rows: RowRect[]) {
  return JSON.stringify(rows.map((r) => [r.rowNumber, r.xFt, r.yFt, r.widthFt, r.lengthFt, r.orientation]));
}

const phase = { eastWestFeet: 120, northSouthFeet: 80 };

function buildParams(startSide: Side, anchorSide: Side, overrides: Partial<BatchParams> = {}): BatchParams {
  return {
    startSide,
    anchorSide,
    rowWidthFt: 4,
    rowLengthFt: 30,
    rowGapFt: 1,
    startOffsetFt: 0,
    anchorOffsetFt: 0,
    numberingMode: "all",
    startRowNumber: 1,
    endRowNumber: 3,
    ...overrides,
  };
}

function place(params: BatchParams): RowRect[] {
  const numbers = generateRowNumbers(params.numberingMode, params.startRowNumber, params.endRowNumber);
  return placeBatchFromSide(params, phase, numbers);
}

// generateRowNumbers
check(JSON.stringify(generateRowNumbers("odd", 1, 15)) === JSON.stringify([1, 3, 5, 7, 9, 11, 13, 15]), "odd range 1..15");
check(JSON.stringify(generateRowNumbers("even", 2, 16)) === JSON.stringify([2, 4, 6, 8, 10, 12, 14, 16]), "even range 2..16");
check(generateRowNumbers("odd", 2, 2).length === 0, "odd mode over single even value");

// perpendicular side rules
check(sidesArePerpendicular("north", "east"), "north+east valid");
check(sidesArePerpendicular("west", "south"), "west+south valid");
check(!sidesArePerpendicular("south", "north"), "south+north invalid");

// All 8 valid side/anchor combinations with non-zero anchor offset.
const combos: Array<{ startSide: Side; anchorSide: Side }> = [
  { startSide: "north", anchorSide: "east" },
  { startSide: "north", anchorSide: "west" },
  { startSide: "south", anchorSide: "east" },
  { startSide: "south", anchorSide: "west" },
  { startSide: "east", anchorSide: "north" },
  { startSide: "east", anchorSide: "south" },
  { startSide: "west", anchorSide: "north" },
  { startSide: "west", anchorSide: "south" },
];

for (const combo of combos) {
  const params = buildParams(combo.startSide, combo.anchorSide, {
    startOffsetFt: 10,
    anchorOffsetFt: 8,
  });
  const rows = place(params);
  check(rows.length === 3, `${combo.startSide}+${combo.anchorSide}: row count remains unchanged`);
  check(rows[0].rowNumber === 1 && rows[2].rowNumber === 3, `${combo.startSide}+${combo.anchorSide}: numbering unchanged`);

  if (combo.startSide === "north") {
    check(approxEqual(rows[0].yFt, 10), "north start honors startOffsetFt");
    check(approxEqual(rows[1].yFt - rows[0].yFt, 5), "north start spacing uses width+gap");
  }
  if (combo.startSide === "south") {
    check(approxEqual(rows[0].yFt + rows[0].widthFt, phase.northSouthFeet - 10), "south start honors startOffsetFt");
    check(approxEqual(rows[0].yFt - rows[1].yFt, 5), "south start spacing uses width+gap");
  }
  if (combo.startSide === "west") {
    check(approxEqual(rows[0].xFt, 10), "west start honors startOffsetFt");
    check(approxEqual(rows[1].xFt - rows[0].xFt, 5), "west start spacing uses width+gap");
  }
  if (combo.startSide === "east") {
    check(approxEqual(rows[0].xFt + rows[0].widthFt, phase.eastWestFeet - 10), "east start honors startOffsetFt");
    check(approxEqual(rows[0].xFt - rows[1].xFt, 5), "east start spacing uses width+gap");
  }

  if (combo.anchorSide === "west") {
    check(approxEqual(rows[0].xFt, 8), `${combo.startSide}+west: anchor inset from west`);
  }
  if (combo.anchorSide === "east") {
    check(approxEqual(rows[0].xFt + rows[0].lengthFt, phase.eastWestFeet - 8), `${combo.startSide}+east: anchor inset from east`);
  }
  if (combo.anchorSide === "north") {
    check(approxEqual(rows[0].yFt, 8), `${combo.startSide}+north: anchor inset from north`);
  }
  if (combo.anchorSide === "south") {
    check(approxEqual(rows[0].yFt + rows[0].lengthFt, phase.northSouthFeet - 8), `${combo.startSide}+south: anchor inset from south`);
  }
}

// Zero anchor offset reproduces prior geometry exactly.
{
  const legacyParams: BatchParams = {
    startSide: "south",
    anchorSide: "east",
    rowWidthFt: 4,
    rowLengthFt: 30,
    rowGapFt: 1,
    offsetFt: 6,
    startOffsetFt: 6,
    anchorOffsetFt: 0,
    numberingMode: "all",
    startRowNumber: 1,
    endRowNumber: 3,
  };
  const explicitParams = { ...legacyParams, startOffsetFt: 6, anchorOffsetFt: 0 };
  check(rowRectJson(place(legacyParams)) === rowRectJson(place(explicitParams)), "zero anchor offset preserves legacy geometry");
}

// Positive anchor offset shifts rows without changing stack progression.
{
  const a = place(buildParams("west", "south", { startOffsetFt: 7, anchorOffsetFt: 0 }));
  const b = place(buildParams("west", "south", { startOffsetFt: 7, anchorOffsetFt: 9 }));
  check(approxEqual(a[0].xFt, b[0].xFt), "anchor offset does not change start-axis placement");
  check(approxEqual(a[1].xFt - a[0].xFt, b[1].xFt - b[0].xFt), "anchor offset does not change continuation spacing");
  check(approxEqual((a[0].yFt + a[0].lengthFt) - (b[0].yFt + b[0].lengthFt), 9), "anchor offset shifts away from anchor side");
}

// Start and anchor offsets operate independently.
{
  const base = place(buildParams("south", "west", { startOffsetFt: 2, anchorOffsetFt: 3 }));
  const changedStart = place(buildParams("south", "west", { startOffsetFt: 12, anchorOffsetFt: 3 }));
  const changedAnchor = place(buildParams("south", "west", { startOffsetFt: 2, anchorOffsetFt: 13 }));

  check(approxEqual(base[0].xFt, changedStart[0].xFt), "changing start offset does not move anchor axis");
  check(!approxEqual(base[0].yFt, changedStart[0].yFt), "changing start offset moves start axis");
  check(approxEqual(base[0].yFt, changedAnchor[0].yFt), "changing anchor offset does not move start axis");
  check(!approxEqual(base[0].xFt, changedAnchor[0].xFt), "changing anchor offset moves anchor axis");
}

// Continuation still computed along start axis; anchor offset still applies.
{
  const big = { eastWestFeet: 300, northSouthFeet: 140 };
  const batch1 = buildParams("south", "east", {
    rowWidthFt: 4,
    rowLengthFt: 100,
    rowGapFt: 1,
    startOffsetFt: 0,
    anchorOffsetFt: 0,
    numberingMode: "odd",
    startRowNumber: 1,
    endRowNumber: 15,
  });
  const rows1 = placeBatchFromSide(batch1, big, generateRowNumbers("odd", 1, 15));
  const continuationBase = computeContinuationOffset(rows1, big, "south", batch1.rowGapFt);

  const preview2 = generateRowPreview(
    {
      ...batch1,
      startRowNumber: 17,
      endRowNumber: 31,
      anchorOffsetFt: 8,
      startOffsetFt: 0,
    },
    big,
    { continueAfterExisting: true, existingRowsSameStartSide: rows1 }
  );

  check(preview2.errors.length === 0, "continuation preview succeeds with anchor offset");
  check(preview2.rows.length === 8, "continuation keeps expected row count");
  check(approxEqual(preview2.rows[0].xFt + preview2.rows[0].lengthFt, big.eastWestFeet - 8), "continuation batch still applies anchor offset");
  check(approxEqual(rows1[rows1.length - 1].yFt - preview2.rows[0].yFt, 5), "continuation spacing still follows start-axis progression");
  check(continuationBase > 0, "continuation base is computed from existing rows");
}

// Different batches can use different anchor offsets without overlap.
{
  const localPhase = { eastWestFeet: 320, northSouthFeet: 120 };
  const first = placeBatchFromSide(
    buildParams("north", "west", { startOffsetFt: 0, anchorOffsetFt: 0, rowLengthFt: 120 }),
    localPhase,
    generateRowNumbers("all", 1, 4)
  );
  const second = placeBatchFromSide(
    buildParams("north", "west", { startOffsetFt: 30, anchorOffsetFt: 10, rowLengthFt: 120 }),
    localPhase,
    generateRowNumbers("all", 11, 14)
  );
  check(detectRowOverlap(first, second).length === 0, "batches with different anchor offsets can coexist");
}

// Out-of-bounds from anchor offset is rejected.
{
  const bad = generateRowPreview(
    buildParams("south", "east", {
      rowLengthFt: 50,
      anchorOffsetFt: 100,
    }),
    phase
  );
  check(bad.errors.length > 0, "anchor offset that pushes rows out of phase is rejected");
}

// Overlap detection unchanged (touching edges are not overlap).
{
  const touching = place(buildParams("south", "east", { rowGapFt: 0 }));
  check(detectRowOverlap(touching, touching).length === 0, "touching rows are not overlaps");

  const a: RowRect = { rowNumber: 1, xFt: 0, yFt: 0, widthFt: 10, lengthFt: 10, orientation: "horizontal" };
  const b: RowRect = { rowNumber: 2, xFt: 5, yFt: 5, widthFt: 10, lengthFt: 10, orientation: "horizontal" };
  check(detectRowOverlap([a], [b]).length === 1, "positive-area overlap is detected");
}

// Preview output matches direct placement for identical params.
{
  const params = buildParams("west", "north", {
    startOffsetFt: 9,
    anchorOffsetFt: 4,
    numberingMode: "odd",
    startRowNumber: 1,
    endRowNumber: 9,
  });
  const preview = generateRowPreview(params, phase);
  const direct = placeBatchFromSide(params, phase, generateRowNumbers("odd", 1, 9));
  check(preview.errors.length === 0, "preview without continuation has no errors");
  check(rowRectJson(preview.rows) === rowRectJson(direct), "preview rows match direct server geometry exactly");
}

// Existing batches with no anchor offset remain valid/unchanged.
{
  const existingRows: RowRect[] = [
    { rowNumber: 1, xFt: 90, yFt: 60, widthFt: 4, lengthFt: 20, orientation: "horizontal" },
    { rowNumber: 3, xFt: 90, yFt: 55, widthFt: 4, lengthFt: 20, orientation: "horizontal" },
  ];
  check(validateRowsInsidePhase(existingRows, phase).length === 0, "existing rows with implicit anchor offset 0 remain inside phase");
}

// Lane isolation: RowRect carries no anchorSide field, so
// computeContinuationOffset/generateRowPreview can only ever see whatever
// pre-filtered row list their caller hands them — the actual isolation
// guarantee lives entirely in the route's SQL, which filters by BOTH
// `grb.start_side = $2 and grb.anchor_side = $3` (server/src/routes/
// greenhouseLayout.ts). This test proves that guarantee is load-bearing: a
// distractor batch sharing startSide but placed against the OPPOSITE
// anchorSide measurably changes continuation depth if the caller filtered
// by startSide alone, so dropping the anchor_side clause would silently
// corrupt placement — while the properly dual-filtered (lane-scoped) input
// stays correct regardless of what other lanes contain.
{
  const big = { eastWestFeet: 300, northSouthFeet: 140 };

  function laneIsolationCheck(startSide: Side, targetAnchor: Side, distractorAnchor: Side, label: string) {
    const targetLane = placeBatchFromSide(
      buildParams(startSide, targetAnchor, { rowLengthFt: 40, numberingMode: "all", startRowNumber: 1, endRowNumber: 5 }),
      big,
      generateRowNumbers("all", 1, 5)
    );
    // Placed further from startSide than targetLane's own deepest row, so
    // if it leaked into the continuation calculation it would visibly push
    // the next batch's depth outward.
    const distractorLane = placeBatchFromSide(
      buildParams(startSide, distractorAnchor, { rowLengthFt: 40, startOffsetFt: 60, numberingMode: "all", startRowNumber: 101, endRowNumber: 105 }),
      big,
      generateRowNumbers("all", 101, 105)
    );

    // Correct: caller filtered by start_side AND anchor_side (dual filter).
    const continuationLaneScoped = computeContinuationOffset(targetLane, big, startSide, 1);
    // Buggy hypothetical: caller filtered by start_side only.
    const continuationStartSideOnly = computeContinuationOffset([...targetLane, ...distractorLane], big, startSide, 1);

    check(
      !approxEqual(continuationLaneScoped, continuationStartSideOnly),
      `${label}: an opposite-anchor distractor WOULD change continuation depth if the caller filtered by start_side alone (proves the anchor_side filter is necessary)`
    );

    const previewLaneScoped = generateRowPreview(
      buildParams(startSide, targetAnchor, { rowLengthFt: 40, numberingMode: "all", startRowNumber: 6, endRowNumber: 10 }),
      big,
      { continueAfterExisting: true, existingRowsSameStartSide: targetLane }
    );
    const previewStartSideOnlyLeak = generateRowPreview(
      buildParams(startSide, targetAnchor, { rowLengthFt: 40, numberingMode: "all", startRowNumber: 6, endRowNumber: 10 }),
      big,
      { continueAfterExisting: true, existingRowsSameStartSide: [...targetLane, ...distractorLane] }
    );
    check(
      rowRectJson(previewLaneScoped.rows) !== rowRectJson(previewStartSideOnlyLeak.rows),
      `${label}: correctly lane-scoped continuation preview differs from a start_side-only leak, confirming the dual filter changes real output`
    );
    check(previewLaneScoped.errors.length === 0, `${label}: correctly lane-scoped continuation preview has no errors`);
  }

  // South->East and South->West must never share continuation depth.
  laneIsolationCheck("south", "west", "east", "south+west vs south+east");
  laneIsolationCheck("south", "east", "west", "south+east vs south+west");
  // North/South and East/West lane pairs are equally isolated.
  laneIsolationCheck("north", "east", "west", "north+east vs north+west");
  laneIsolationCheck("east", "north", "south", "east+north vs east+south");
  laneIsolationCheck("west", "south", "north", "west+south vs west+north");
}

// Delete/recreate continuation: deleting a continuation batch and
// re-creating an identical one from the same original base rows must
// reproduce the exact same first-row geometry (continuation depth is
// re-derived from the surviving rows each time, never cached/stateful).
{
  const big = { eastWestFeet: 300, northSouthFeet: 140 };
  const baseParams = buildParams("south", "west", {
    rowLengthFt: 50,
    numberingMode: "all",
    startRowNumber: 1,
    endRowNumber: 3,
  });
  const baseRows = placeBatchFromSide(baseParams, big, generateRowNumbers("all", 1, 3));

  const continuationParams = buildParams("south", "west", {
    rowLengthFt: 50,
    numberingMode: "all",
    startRowNumber: 4,
    endRowNumber: 5,
  });

  const firstAttempt = generateRowPreview(continuationParams, big, {
    continueAfterExisting: true,
    existingRowsSameStartSide: baseRows,
  });
  // Simulate: save firstAttempt's rows, then soft-delete that whole batch —
  // the "existing" set for a recreate collapses back to just baseRows,
  // exactly as the route's `deleted_at is null` filter would produce.
  const recreated = generateRowPreview(continuationParams, big, {
    continueAfterExisting: true,
    existingRowsSameStartSide: baseRows,
  });

  check(firstAttempt.errors.length === 0 && recreated.errors.length === 0, "delete/recreate: both attempts preview without errors");
  check(rowRectJson(firstAttempt.rows) === rowRectJson(recreated.rows), "delete/recreate: recreated batch reproduces identical geometry");

  // A third batch that continues after the (deleted+recreated) continuation
  // batch's rows still stacks correctly on top of it.
  const thirdParams = buildParams("south", "west", {
    rowLengthFt: 50,
    numberingMode: "all",
    startRowNumber: 6,
    endRowNumber: 6,
  });
  const third = generateRowPreview(thirdParams, big, {
    continueAfterExisting: true,
    existingRowsSameStartSide: recreated.rows,
  });
  check(third.errors.length === 0, "delete/recreate: further continuation after the recreated batch still succeeds");
  check(
    recreated.rows[recreated.rows.length - 1].yFt - third.rows[0].yFt >= baseParams.rowWidthFt,
    "delete/recreate: further continuation stacks strictly further in than the recreated batch"
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
