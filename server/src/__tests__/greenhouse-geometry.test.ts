/**
 * Automated geometry tests for shared/greenhouse-geometry.ts
 *
 * Run: npm test  (inside server/)
 * or:  node --require ts-node/register --test src/__tests__/greenhouse-geometry.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  blockRowRect,
  blockBBox,
  blockAlongWallSpan,
  blockOccupiedDepth,
  rangesOverlap,
  rectsOverlap,
  type CompGeom,
  type BlockGeom,
} from '../../../shared/greenhouse-geometry';

// ── Helpers ──────────────────────────────────────────────────────────────────

const EPS = 1e-4;

function near(a: number, b: number, msg?: string) {
  assert(Math.abs(a - b) < EPS, `${msg ?? ''} expected ${a} ≈ ${b}`);
}

// 396 × 1240 compartment at origin (matches the real example from the bug report)
const COMP: CompGeom = { x_ft: 0, y_ft: 0, east_west_ft: 396, north_south_ft: 1240 };

// ── blockOccupiedDepth ───────────────────────────────────────────────────────

describe('blockOccupiedDepth', () => {
  it('returns 0 for 0 rows', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 10, row_width_ft: 5, row_length_ft: 100,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    near(blockOccupiedDepth(b, 0), 0, 'zero rows');
  });

  it('accounts for offset_ft, width, spacing, and count', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 2, row_width_ft: 5, row_length_ft: 100,
      row_spacing_ft: 1, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    // 2 + 5 + (3-1)*6 = 2 + 5 + 12 = 19
    near(blockOccupiedDepth(b, 3), 19, '3 rows width=5 spacing=1 offset=2');
  });
});

// ── blockAlongWallSpan ───────────────────────────────────────────────────────

describe('blockAlongWallSpan', () => {
  it('east_west / near → X span from West end', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const [lo, hi] = blockAlongWallSpan(COMP, b);
    near(lo, 0, 'lo');
    near(hi, 192, 'hi');
  });

  it('east_west / far → X span from East end', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'far', along_wall_offset_ft: 0,
    };
    const [lo, hi] = blockAlongWallSpan(COMP, b);
    // far → x = 0 + 396 - 192 - 0 = 204
    near(lo, 204, 'lo');
    near(hi, 396, 'hi');
  });

  it('east_west / centered', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'centered', along_wall_offset_ft: 0,
    };
    const [lo, hi] = blockAlongWallSpan(COMP, b);
    near(lo, (396 - 192) / 2, 'lo');
    near(hi, (396 - 192) / 2 + 192, 'hi');
  });

  it('north_south / near → Y span from North end', () => {
    const b: BlockGeom = {
      orientation: 'north_south', anchor_side: 'east',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 300,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const [lo, hi] = blockAlongWallSpan(COMP, b);
    near(lo, 0, 'lo');
    near(hi, 300, 'hi');
  });
});

// ── rangesOverlap ────────────────────────────────────────────────────────────

describe('rangesOverlap', () => {
  it('overlapping ranges → true', () => {
    assert(rangesOverlap([0, 200], [100, 300]));
  });
  it('non-overlapping ranges → false', () => {
    assert(!rangesOverlap([0, 100], [200, 300]));
  });
  it('touching edges (exactly) → false', () => {
    assert(!rangesOverlap([0, 100], [100, 200]));
  });
  it('one inside other → true', () => {
    assert(rangesOverlap([0, 300], [50, 150]));
  });
});

// ── blockRowRect: south anchor east_west ────────────────────────────────────

describe('blockRowRect south anchor / east_west', () => {
  it('first row abuts south wall when offset_ft=0', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5.28, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const r = blockRowRect(COMP, b, 0);
    // South = y=1240. First row: y = 1240 - 0 - 5.28 = 1234.72
    near(r.y + r.h, 1240, 'south edge of row 0 at south wall');
    near(r.x, 0, 'west-end start');
    near(r.w, 192, 'row length');
    near(r.h, 5.28, 'row width');
  });

  it('rows stack northward (decreasing Y)', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 100,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const r0 = blockRowRect(COMP, b, 0);
    const r1 = blockRowRect(COMP, b, 1);
    assert(r1.y < r0.y, 'row 1 is north of row 0');
    near(r0.y - r1.y, 5, 'step = row_width_ft with no spacing');
  });
});

// ── After-Existing: 2D overlap filtering ────────────────────────────────────

describe('After Existing — along-wall span filtering', () => {
  /**
   * Compartment 396 × 1240.
   * Existing block: south anchor, west-end (X=0..192), 110 rows (5.28 wide, 0 spacing, 0 offset)
   *   → occupied depth = 5.28 * 110 = 580.8 ft from south
   *
   * Scenario A: new block also at west end → same X span → must continue after existing.
   * Scenario B: new block at east end (X=204..396) → no X span overlap → starts at 0.
   */

  const existingB: BlockGeom = {
    orientation: 'east_west', anchor_side: 'south',
    offset_ft: 0, row_width_ft: 5.28, row_length_ft: 192,
    row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
  };
  const existingRowCount = 110;
  const existingDepth = blockOccupiedDepth(existingB, existingRowCount);

  it('existing depth computed correctly (real example)', () => {
    // 0 + 5.28 + (110-1)*5.28 = 5.28*110 = 580.8
    near(existingDepth, 5.28 * 110);
  });

  it('West-end new block OVERLAPS existing West-end block → continuation picks up existing depth', () => {
    const newB: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5.28, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const existingSpan = blockAlongWallSpan(COMP, existingB); // [0, 192]
    const newSpan      = blockAlongWallSpan(COMP, newB);      // [0, 192]
    assert(rangesOverlap(existingSpan, newSpan), 'spans must overlap');
    // So continuation offset = existingDepth
    near(existingDepth, 5.28 * 110);
  });

  it('East-end new block does NOT overlap West-end existing block → starts at 0', () => {
    const newB: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5.28, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'far', along_wall_offset_ft: 0,
    };
    const existingSpan = blockAlongWallSpan(COMP, existingB); // [0, 192]
    const newSpan      = blockAlongWallSpan(COMP, newB);      // [204, 396]
    assert(!rangesOverlap(existingSpan, newSpan), 'spans must NOT overlap');
    // No overlapping blocks → continuation offset = 0
  });

  it('partially-overlapping block IS considered', () => {
    // Existing block at X=100..292
    const midB: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 10, row_width_ft: 5, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'custom', along_wall_offset_ft: 100,
    };
    // New block at X=0..192 — overlaps with X=100..192
    const newB: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 192,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const midSpan = blockAlongWallSpan(COMP, midB); // [100, 292]
    const newSpan = blockAlongWallSpan(COMP, newB); // [0, 192]
    assert(rangesOverlap(midSpan, newSpan), 'partial overlap triggers continuation');
  });

  it('two adjacent non-overlapping East+West blocks do not affect each other', () => {
    const westB: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 190,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const eastB: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 50, row_width_ft: 5, row_length_ft: 190,
      row_spacing_ft: 0, along_wall_start: 'far', along_wall_offset_ft: 0,
    };
    const westSpan = blockAlongWallSpan(COMP, westB); // [0, 190]
    const eastSpan = blockAlongWallSpan(COMP, eastB); // [206, 396]
    assert(!rangesOverlap(westSpan, eastSpan));
  });
});

// ── North anchor continuation ────────────────────────────────────────────────

describe('North anchor continuation', () => {
  it('rows stack southward from north wall', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'north',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 100,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const r0 = blockRowRect(COMP, b, 0);
    const r1 = blockRowRect(COMP, b, 1);
    near(r0.y, 0, 'first row starts at north wall');
    assert(r1.y > r0.y, 'subsequent rows go south');
    near(r1.y - r0.y, 5, 'step = row_width_ft');
  });

  it('blockOccupiedDepth for north anchor mirrors south math', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'north',
      offset_ft: 5, row_width_ft: 3, row_length_ft: 100,
      row_spacing_ft: 2, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    // 5 + 3 + (4-1)*(3+2) = 5+3+15 = 23
    near(blockOccupiedDepth(b, 4), 23);
  });
});

// ── East anchor continuation (north_south orientation) ───────────────────────

describe('East anchor continuation (north_south rows)', () => {
  it('rows stack westward from east wall', () => {
    const b: BlockGeom = {
      orientation: 'north_south', anchor_side: 'east',
      offset_ft: 0, row_width_ft: 4, row_length_ft: 300,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const r0 = blockRowRect(COMP, b, 0);
    const r1 = blockRowRect(COMP, b, 1);
    near(r0.x + r0.w, 396, 'first row abuts east wall');
    assert(r1.x < r0.x, 'subsequent rows go west');
  });
});

// ── West anchor continuation (north_south orientation) ───────────────────────

describe('West anchor continuation (north_south rows)', () => {
  it('rows stack eastward from west wall', () => {
    const b: BlockGeom = {
      orientation: 'north_south', anchor_side: 'west',
      offset_ft: 0, row_width_ft: 4, row_length_ft: 300,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const r0 = blockRowRect(COMP, b, 0);
    const r1 = blockRowRect(COMP, b, 1);
    near(r0.x, 0, 'first row starts at west wall');
    assert(r1.x > r0.x, 'subsequent rows go east');
  });
});

// ── Bounds validation uses final translated coordinates ──────────────────────

describe('Bounds validation uses final translated coordinates', () => {
  it('blockRowRect for non-zero compartment origin uses absolute coords', () => {
    const comp: CompGeom = { x_ft: 100, y_ft: 200, east_west_ft: 396, north_south_ft: 1240 };
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 100,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const r = blockRowRect(comp, b, 0);
    // South edge of row 0 at y = 200 + 1240 = 1440
    near(r.y + r.h, 1440, 'south edge uses translated y');
    near(r.x, 100, 'west edge uses translated x');
  });

  it('rectsOverlap works on translated coords', () => {
    const a = { x: 100, y: 200, w: 50, h: 30 };
    const b = { x: 130, y: 210, w: 50, h: 30 };
    assert(rectsOverlap(a, b));
    const c = { x: 200, y: 300, w: 50, h: 30 };
    assert(!rectsOverlap(a, c));
  });
});

// ── blockBBox ────────────────────────────────────────────────────────────────

describe('blockBBox', () => {
  it('returns null for 0 rows', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 100,
      row_spacing_ft: 0, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    assert.equal(blockBBox(COMP, b, 0), null);
  });

  it('bbox of single south-anchored east_west block', () => {
    const b: BlockGeom = {
      orientation: 'east_west', anchor_side: 'south',
      offset_ft: 0, row_width_ft: 5, row_length_ft: 100,
      row_spacing_ft: 2, along_wall_start: 'near', along_wall_offset_ft: 0,
    };
    const box = blockBBox(COMP, b, 3)!;
    // 3 rows, width=5, spacing=2 → step=7, total depth = 5 + 2*7 = 19
    near(box.w, 100, 'bbox width = row length');
    near(box.h, 19, 'bbox height = total depth');
    near(box.x, 0);
    near(box.y + box.h, 1240, 'bottom of bbox at south wall');
  });
});
