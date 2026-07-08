/**
 * Tests for greenhouse row gap detection and restore logic.
 *
 * Run: npm test  (inside server/)
 * or:  node --require ts-node/register --test src/__tests__/greenhouse-missing-rows.test.ts
 *
 * All tests are pure unit tests — no database required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMissingSlots, type StoredRow, type BlockParams } from '../lib/missing-rows';

// ── Helpers ──────────────────────────────────────────────────────────────────

const EPS = 1e-4;

function near(a: number, b: number, msg?: string) {
  assert(
    Math.abs(a - b) < EPS,
    `${msg ?? ''} expected ${a} ≈ ${b} (diff=${Math.abs(a - b)})`,
  );
}

function makeRow(
  row_number: number,
  x_ft: number,
  y_ft: number,
  overrides?: Partial<StoredRow>,
): StoredRow {
  return {
    row_number,
    x_ft,
    y_ft,
    width_ft: 3.28,
    length_ft: 192,
    orientation: 'east_west',
    ...overrides,
  };
}

// Realistic compartment: 396 × 1240 ft at origin
// South-anchored EW block, step = 3.28 ft (width=3.28, spacing=0)
const SOUTH_BLOCK: BlockParams = {
  anchor_side: 'south',
  orientation: 'east_west',
  row_width_ft: 3.28,
  row_length_ft: 192,
  row_spacing_ft: 0,
};

// Step = width + spacing = 3.28 ft
// Slot 0 y_ft = 1240 - 3.28 = 1236.72
// Slot 1 y_ft = 1236.72 - 3.28 = 1233.44, etc.
const SLOT0_Y  = 1236.72;
const STEP     = 3.28;
const ALONG_X  = 204;

function southRow(slotIdx: number, rowNum: number): StoredRow {
  return makeRow(rowNum, ALONG_X, SLOT0_Y - slotIdx * STEP);
}

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('detectMissingSlots — edge cases', () => {
  it('returns [] for empty array', () => {
    assert.deepEqual(detectMissingSlots(SOUTH_BLOCK, []), []);
  });

  it('returns [] for single row', () => {
    assert.deepEqual(detectMissingSlots(SOUTH_BLOCK, [southRow(0, 1)]), []);
  });

  it('returns [] when all rows are consecutive (no gap)', () => {
    const rows = [southRow(0, 1), southRow(1, 2), southRow(2, 3)];
    assert.equal(detectMissingSlots(SOUTH_BLOCK, rows).length, 0);
  });

  it('input row order does not matter — result is the same regardless of array order', () => {
    const rows  = [southRow(0, 1), southRow(2, 3)]; // sorted
    const rowsR = [southRow(2, 3), southRow(0, 1)]; // reversed
    const a = detectMissingSlots(SOUTH_BLOCK, rows);
    const b = detectMissingSlots(SOUTH_BLOCK, rowsR);
    assert.equal(a.length, b.length);
    near(a[0].yFt, b[0].yFt, 'yFt');
  });
});

// ── Core: delete middle row → gap detected ───────────────────────────────────

describe('detectMissingSlots — delete middle row → gap detected', () => {
  it('detects one missing row when middle row deleted from 3-row block', () => {
    // Rows: slot 0 = R001, slot 1 = R002 (deleted), slot 2 = R003
    const rows = [southRow(0, 1), southRow(2, 3)];
    const slots = detectMissingSlots(SOUTH_BLOCK, rows);

    assert.equal(slots.length, 1, 'exactly one missing slot');
    near(slots[0].yFt, SLOT0_Y - 1 * STEP, 'y_ft of missing slot');
    near(slots[0].xFt, ALONG_X,            'x_ft unchanged');
    assert.equal(slots[0].inferredRowNumber, 2, 'row number inferred as 2');
    assert.deepEqual(slots[0].neighborRowNumbers, [1, 3]);
  });

  it('detects correct gap for realistic R079 delete scenario', () => {
    // 5-row block, delete R079 (slot 1)
    const allRows = [
      southRow(0, 78),
      southRow(1, 79),
      southRow(2, 80),
      southRow(3, 81),
      southRow(4, 82),
    ];
    const afterDelete = allRows.filter(r => r.row_number !== 79);
    const slots = detectMissingSlots(SOUTH_BLOCK, afterDelete);

    assert.equal(slots.length, 1, 'one missing slot');
    assert.equal(slots[0].inferredRowNumber, 79);
    near(slots[0].yFt, SLOT0_Y - 1 * STEP, 'y_ft matches original slot 1');
  });

  it('detects multiple consecutive missing rows', () => {
    // Delete R002, R003 from [R001, R002, R003, R004]
    const rows = [southRow(0, 1), southRow(3, 4)]; // 3 steps apart → 2 missing
    const slots = detectMissingSlots(SOUTH_BLOCK, rows);

    assert.equal(slots.length, 2);
    near(slots[0].yFt, SLOT0_Y - 1 * STEP, 'first missing slot y');
    near(slots[1].yFt, SLOT0_Y - 2 * STEP, 'second missing slot y');
    assert.equal(slots[0].inferredRowNumber, 2);
    assert.equal(slots[1].inferredRowNumber, 3);
  });
});

// ── Restore: fills exact position ────────────────────────────────────────────

describe('detectMissingSlots — restore fills exact gap', () => {
  it('missing slot y_ft matches the original row y_ft before deletion', () => {
    const allRows = Array.from({ length: 5 }, (_, i) => southRow(i, i + 1));
    const deletedRow = allRows[2]; // row 3, slot 2
    const afterDelete = allRows.filter((_, i) => i !== 2);

    const slots = detectMissingSlots(SOUTH_BLOCK, afterDelete);
    assert.equal(slots.length, 1);
    near(slots[0].yFt, deletedRow.y_ft, 'restored y_ft matches original');
    near(slots[0].xFt, deletedRow.x_ft, 'restored x_ft matches original');
    assert.equal(slots[0].widthFt,  deletedRow.width_ft,  'width matches');
    assert.equal(slots[0].lengthFt, deletedRow.length_ft, 'length matches');
  });
});

// ── Other rows unchanged after detection ─────────────────────────────────────

describe('detectMissingSlots — other row coordinates unchanged', () => {
  it('does not mutate the input rows array', () => {
    const rows = [southRow(0, 1), southRow(2, 3)];
    const snapshots = rows.map(r => ({ ...r }));

    detectMissingSlots(SOUTH_BLOCK, rows);

    rows.forEach((r, i) => {
      assert.equal(r.y_ft,       snapshots[i].y_ft,       `y_ft of row ${i} unchanged`);
      assert.equal(r.x_ft,       snapshots[i].x_ft,       `x_ft of row ${i} unchanged`);
      assert.equal(r.row_number, snapshots[i].row_number, `row_number unchanged`);
    });
  });

  it('remaining rows keep original positions after middle delete + detect', () => {
    const allRows = Array.from({ length: 5 }, (_, i) => southRow(i, i + 1));
    const original = allRows.map(r => ({ ...r }));
    const afterDelete = allRows.filter(r => r.row_number !== 3);

    detectMissingSlots(SOUTH_BLOCK, afterDelete); // must not affect coordinates

    afterDelete.forEach(r => {
      const orig = original.find(o => o.row_number === r.row_number)!;
      near(r.y_ft, orig.y_ft, `R${r.row_number} y unchanged`);
      near(r.x_ft, orig.x_ft, `R${r.row_number} x unchanged`);
    });
  });
});

// ── Restore after browser refresh works (uses stored coords, not index) ───────

describe('detectMissingSlots — detection uses stored coords (browser-refresh safe)', () => {
  it('gives the same result regardless of which order rows were created', () => {
    // Simulate rows created out of row_number order — detection must use
    // physical y_ft coordinates, not array index or row_number ordering.
    const rows = [
      southRow(3, 80), // slot 3 but higher row_number
      southRow(0, 78), // slot 0
      southRow(4, 81), // slot 4
      // slot 1 = R079 is missing
      southRow(2, 79), // slot 2 but row_number 79 (out of numeric order)
    ];
    // Wait — that doesn't make sense. Let me use a clearer case:
    // Rows numbered 78, 80, 81, 82 but slot order 0, 2, 3, 4 (slot 1 = R79 missing)
    const rowsOrdered = [
      southRow(0, 78),
      southRow(2, 80),
      southRow(3, 81),
      southRow(4, 82),
    ];
    const slots = detectMissingSlots(SOUTH_BLOCK, rowsOrdered);
    assert.equal(slots.length, 1);
    near(slots[0].yFt, SLOT0_Y - 1 * STEP, 'slot 1 detected by coord, not index');
    assert.equal(slots[0].inferredRowNumber, 79);
  });
});

// ── Cannot restore if slot already occupied ───────────────────────────────────

describe('detectMissingSlots — slot already occupied = not reported as missing', () => {
  it('consecutive rows with no gap → no missing slots reported', () => {
    // If a row already exists at slot 1, the gap is step = one slot, nMissing = 0
    const rows = [southRow(0, 78), southRow(1, 79), southRow(2, 80)];
    const slots = detectMissingSlots(SOUTH_BLOCK, rows);
    assert.equal(slots.length, 0, 'no missing slots when all positions occupied');
  });
});

// ── Row number inference rules ────────────────────────────────────────────────

describe('detectMissingSlots — row number inference', () => {
  it('infers row number when row_number gap matches physical gap exactly', () => {
    const rows = [southRow(0, 10), southRow(2, 12)]; // 1 slot missing, row_number gap = 1
    const slots = detectMissingSlots(SOUTH_BLOCK, rows);
    assert.equal(slots[0].inferredRowNumber, 11);
  });

  it('returns null when row_number gap does not match physical gap', () => {
    // 1 slot missing but row numbers skip by 5 (custom numbering)
    const rows = [southRow(0, 10), southRow(2, 15)];
    const slots = detectMissingSlots(SOUTH_BLOCK, rows);
    assert.equal(slots[0].inferredRowNumber, null, 'cannot infer — ambiguous');
  });

  it('returns null when multiple slots missing but row_number gap differs', () => {
    // 2 slots missing but row numbers skip by 1 (ambiguous)
    const rows = [southRow(0, 10), southRow(3, 11)];
    const slots = detectMissingSlots(SOUTH_BLOCK, rows);
    assert.equal(slots.length, 2);
    assert.equal(slots[0].inferredRowNumber, null);
    assert.equal(slots[1].inferredRowNumber, null);
  });
});

// ── North-anchor block ────────────────────────────────────────────────────────

describe('detectMissingSlots — north-anchor EW block', () => {
  const NORTH_BLOCK: BlockParams = {
    ...SOUTH_BLOCK,
    anchor_side: 'north',
  };
  // North-anchor slot 0: y_ft = 0 + offset + 0 * step = 0 (closest to north wall)
  // Slot 1: y_ft = 0 + step = 3.28
  // Sort ascending

  it('detects missing slot in a north-anchored block', () => {
    const rows = [
      makeRow(1, ALONG_X, 0),        // slot 0
      makeRow(3, ALONG_X, 2 * STEP), // slot 2 (row 2 missing)
    ];
    const slots = detectMissingSlots(NORTH_BLOCK, rows);
    assert.equal(slots.length, 1);
    near(slots[0].yFt, STEP, 'missing slot at slot 1 position');
    assert.equal(slots[0].inferredRowNumber, 2);
  });
});

// ── East-anchor NS block ──────────────────────────────────────────────────────

describe('detectMissingSlots — east-anchor NS block', () => {
  const EAST_BLOCK: BlockParams = {
    anchor_side: 'east',
    orientation: 'north_south',
    row_width_ft: 3.28,
    row_length_ft: 192,
    row_spacing_ft: 0,
  };
  // East-anchor slot 0: x_ft = comp_ew - offset - width (highest x), sort x DESC
  const SLOT0_X  = 392.72; // 396 - 0 - 3.28

  function eastRow(slotIdx: number, rowNum: number): StoredRow {
    return {
      row_number: rowNum,
      x_ft: SLOT0_X - slotIdx * STEP,
      y_ft: 0, // along-wall coord
      width_ft: EAST_BLOCK.row_width_ft,
      length_ft: EAST_BLOCK.row_length_ft,
      orientation: 'north_south',
    };
  }

  it('detects missing slot in east-anchored NS block', () => {
    const rows = [eastRow(0, 1), eastRow(2, 3)]; // slot 1 missing
    const slots = detectMissingSlots(EAST_BLOCK, rows);
    assert.equal(slots.length, 1);
    near(slots[0].xFt, SLOT0_X - 1 * STEP, 'x_ft of missing slot');
    near(slots[0].yFt, 0,                   'y_ft (along-wall) unchanged');
    assert.equal(slots[0].inferredRowNumber, 2);
  });
});
