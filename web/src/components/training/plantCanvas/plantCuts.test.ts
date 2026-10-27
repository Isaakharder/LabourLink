import { describe, expect, it } from "vitest";
import { PLANT_VIEWBOX, buildPlantModel, type PlantModel, type PlantParts, type Point, type SplitMode } from "./plantGeometry";
import {
  applyCuts,
  cuttableSegments,
  fallTransform,
  piecePoints,
  projectOntoStem,
  transformPoint,
  type Cut,
} from "./plantCuts";

const MODES: SplitMode[] = [2, 3];
const VIEW_BOTTOM = PLANT_VIEWBOX.y + PLANT_VIEWBOX.height;

function distanceToPolyline(p: Point, line: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** Every leaf and bud sits on one of the given stems, and every stem but the
 *  first starts on another — i.e. the parts form one connected structure. */
function expectConnected(parts: PlantParts) {
  for (const leaf of parts.leaves) {
    expect(Math.min(...parts.stems.map((s) => distanceToPolyline(leaf.base, s.points))), leaf.id).toBeLessThan(0.75);
  }
  for (const bud of parts.buds) {
    expect(Math.min(...parts.stems.map((s) => distanceToPolyline(bud.base, s.points))), bud.id).toBeLessThan(0.75);
  }
  for (const stem of parts.stems.slice(1)) {
    const others = parts.stems.filter((s) => s !== stem);
    expect(Math.min(...others.map((s) => distanceToPolyline(stem.points[0], s.points))), stem.id).toBeLessThan(0.75);
  }
}

/** A cut in the middle of the n-th cuttable segment of a stem. */
function cutOn(model: PlantModel, stemId: string, which: "middle" | "last" = "middle"): Cut {
  const segs = cuttableSegments(model).filter((s) => s.stemId === stemId);
  const seg = which === "last" ? segs[segs.length - 1] : segs[Math.floor(segs.length / 2)];
  return { stemId, s: (seg.sFrom + seg.sTo) / 2 };
}

/** A shoot and every shoot above it in the branching graph. */
function withDescendants(model: PlantModel, id: string): string[] {
  const out = [id];
  for (const st of model.stems) if (st.parentId === id) out.push(...withDescendants(model, st.id));
  return out;
}

describe("cutting any shoot in the branching tree", () => {
  for (const mode of MODES) {
    const ids = buildPlantModel(1, mode).stems.filter((s) => s.kind === "leader").map((s) => s.id);
    for (const shootId of ids) {
      it(`removes ${shootId} above the cut and everything growing from it (${mode}-split)`, () => {
        const model = buildPlantModel(1, mode);
        const cut = cutOn(model, shootId);
        const { kept, pieces } = applyCuts(model, [cut]);
        expect(pieces).toHaveLength(1);
        const [piece] = pieces;
        const above = withDescendants(model, shootId).slice(1);

        // Detached: the upper part of the cut shoot plus every descendant
        // shoot, leaf and bud — one connected piece.
        expect(piece.stems.map((s) => s.id).sort()).toEqual([`${shootId}~upper`, ...above].sort());
        const expectedLeaves = model.leaves
          .filter((l) => above.includes(l.parentId) || (l.parentId === shootId && l.attachS > cut.s))
          .map((l) => l.id);
        expect(piece.leaves.map((l) => l.id).sort()).toEqual([...expectedLeaves].sort());
        expect(piece.leaves.some((l) => l.id.includes("-tip-"))).toBe(true); // growing heads go too
        const expectedBuds = model.buds.filter((b) => above.includes(b.parentId) || b.parentId === shootId).map((b) => b.id);
        expect(piece.buds.map((b) => b.id).sort()).toEqual([...expectedBuds].sort());
        expectConnected(piece);

        // Kept: everything else untouched; the cut shoot ends at the cut, flat.
        for (const stem of model.stems.filter((st) => st.id !== shootId && !above.includes(st.id))) {
          expect(kept.stems.find((st) => st.id === stem.id), stem.id).toEqual(stem);
        }
        const stub = kept.stems.find((st) => st.id === shootId)!;
        expect(stub.cutTip).toBe(true);
        expect(stub.points[stub.points.length - 1]).toEqual(piece.pivot);
        expect(kept.leaves.length + piece.leaves.length).toBe(model.leaves.length);
        expectConnected(kept);
      });
    }
  }

  it.each(MODES)("cutting just below a later fork drops the fork, its bud and both child shoots (%i-split)", (mode) => {
    const model = buildPlantModel(1, mode);
    const cut = cutOn(model, "leader-1", "last");
    const { kept, pieces } = applyCuts(model, [cut]);
    const [piece] = pieces;
    expect(piece.stems.map((s) => s.id).sort()).toEqual(["leader-1.1", "leader-1.2", "leader-1~upper"]);
    expect(piece.buds.map((b) => b.id)).toEqual(["bud-leader-1"]);
    // Both leaves of leader-1 stay on the plant (the cut is above leaf 2).
    expect(kept.leaves.filter((l) => l.parentId === "leader-1")).toHaveLength(2);
    expect(kept.stems.some((s) => s.id.startsWith("leader-1."))).toBe(false);
    expectConnected(piece);
  });

  it.each(MODES)("cutting one child shoot leaves its sibling and the fork in place (%i-split)", (mode) => {
    const model = buildPlantModel(1, mode);
    const { kept, pieces } = applyCuts(model, [cutOn(model, "leader-2.1")]);
    expect(pieces[0].stems.map((s) => s.id)).toEqual(["leader-2.1~upper"]);
    expect(kept.stems.find((s) => s.id === "leader-2.2")).toEqual(model.stems.find((s) => s.id === "leader-2.2"));
    expect(kept.buds.some((b) => b.id === "bud-leader-2")).toBe(true);
  });
});

describe("cutting the main stem below the crown", () => {
  it.each(MODES)("drops the crown and every leader together (%i-split)", (mode) => {
    const model = buildPlantModel(1, mode);
    const cut = cutOn(model, "main-stem", "last");
    const mainSegs = cuttableSegments(model).filter((s) => s.stemId === "main-stem");
    expect(cut.s).toBeLessThan(mainSegs[mainSegs.length - 1].sTo + 1);
    const { kept, pieces } = applyCuts(model, [cut]);
    const [piece] = pieces;

    // The whole branching tree above the crown falls together.
    const allShoots = model.stems.filter((s) => s.kind === "leader").map((s) => s.id);
    expect(allShoots.length).toBe(3 * mode);
    expect(piece.stems.map((s) => s.id).sort()).toEqual(["main-stem~upper", ...allShoots].sort());
    expect(piece.buds.map((b) => b.id).sort()).toEqual(model.buds.map((b) => b.id).sort());
    // Every leaf on any leader falls, plus main-stem leaves above the cut.
    for (const leaf of model.leaves) {
      const falls = leaf.parentId !== "main-stem" || leaf.attachS > cut.s;
      expect(piece.leaves.some((l) => l.id === leaf.id), leaf.id).toBe(falls);
      expect(kept.leaves.some((l) => l.id === leaf.id), leaf.id).toBe(!falls);
    }
    expectConnected(piece);

    // The rooted plant stays exactly where it was below the cut.
    expect(kept.stems.map((s) => s.id)).toEqual(["main-stem"]);
    expect(kept.buds).toHaveLength(0);
    const before = model.stems[0].points;
    const after = kept.stems[0].points;
    expect(after.slice(0, -1)).toEqual(before.slice(0, after.length - 1));
    expect(kept.stems[0].cutTip).toBe(true);
  });

  it("a low main-stem cut takes the lower leaves above it too", () => {
    const model = buildPlantModel(1, 2);
    const segs = cuttableSegments(model).filter((s) => s.stemId === "main-stem");
    const cut = { stemId: "main-stem", s: (segs[2].sFrom + segs[2].sTo) / 2 };
    const { kept, pieces } = applyCuts(model, [cut]);
    expect(kept.leaves.every((l) => l.attachS < cut.s)).toBe(true);
    expect(kept.leaves.length).toBe(2);
    expectConnected(pieces[0]);
  });
});

describe("cut sequences and determinism", () => {
  it("applies later cuts to what earlier cuts left", () => {
    const model = buildPlantModel(1, 3);
    const first = cutOn(model, "leader-2");
    const afterFirst = applyCuts(model, [first]).kept;
    const second = cutOn(afterFirst, "main-stem", "last");
    const { kept, pieces } = applyCuts(model, [first, second]);
    expect(pieces).toHaveLength(2);
    // The second piece holds the leader-2 stub, not the part already gone.
    expect(pieces[1].stems.find((s) => s.id === "leader-2")!.cutTip).toBe(true);
    expect(pieces[1].leaves.some((l) => pieces[0].leaves.some((p) => p.id === l.id))).toBe(false);
    expect(kept.stems).toHaveLength(1);
  });

  it("produces identical geometry for the same split and cut", () => {
    for (const mode of MODES) {
      const cut = cutOn(buildPlantModel(1, mode), "leader-1");
      expect(applyCuts(buildPlantModel(1, mode), [cut])).toEqual(applyCuts(buildPlantModel(1, mode), [cut]));
    }
  });

  it("ignores cuts that aren't on a stem", () => {
    const model = buildPlantModel(1, 2);
    expect(applyCuts(model, [{ stemId: "leader-9", s: 10 }]).pieces).toHaveLength(0);
    expect(applyCuts(model, [{ stemId: "leader-1", s: 99999 }]).pieces).toHaveLength(0);
    expect(applyCuts(model, [{ stemId: "leader-1", s: 0 }]).kept).toBe(model);
  });
});

describe("cuttable segments", () => {
  it.each(MODES)("lie strictly between leaf nodes on every stem (%i-split)", (mode) => {
    const model = buildPlantModel(1, mode);
    const segs = cuttableSegments(model);
    for (const stem of model.stems) expect(segs.some((s) => s.stemId === stem.id), stem.id).toBe(true);
    for (const seg of segs) {
      for (const leaf of model.leaves.filter((l) => l.parentId === seg.stemId && l.bladeLength > 0.5 && !l.id.includes("-tip-"))) {
        expect(leaf.attachS <= seg.sFrom || leaf.attachS >= seg.sTo, `${leaf.id} inside ${seg.stemId}`).toBe(true);
      }
    }
  });

  it("maps a pointer position to the exact spot on the stem, not the nearest node", () => {
    const model = buildPlantModel(1, 2);
    const leader = model.stems.find((s) => s.id === "leader-1")!;
    const seg = cuttableSegments(model).filter((s) => s.stemId === "leader-1")[1];
    const target = seg.points[Math.floor(seg.points.length / 3)];
    const s = projectOntoStem(leader, { x: target.x + 5, y: target.y }, seg.sFrom, seg.sTo);
    expect(s).toBeGreaterThan(seg.sFrom);
    expect(s).toBeLessThan(seg.sTo);
    expect(Math.abs(s - (seg.sFrom + (seg.sTo - seg.sFrom) / 3))).toBeLessThan(6);
  });
});

describe("falling", () => {
  it.each(MODES)("starts in place and ends completely below the canvas (%i-split)", (mode) => {
    const model = buildPlantModel(1, mode);
    const cuts = [cutOn(model, "leader-1"), cutOn(applyCuts(model, [cutOn(model, "leader-1")]).kept, "main-stem", "last")];
    for (const piece of applyCuts(model, cuts).pieces) {
      const start = fallTransform(piece, 0);
      expect(start.dx).toBe(0);
      expect(start.dy).toBe(0);
      expect(start.angle).toBe(0);
      // Holds its shape briefly before dropping.
      expect(fallTransform(piece, 0.05).dy).toBe(0);
      // Accelerates: the second half covers more ground than the first.
      const mid = fallTransform(piece, 0.54).dy;
      const end = fallTransform(piece, 1).dy;
      expect(end - mid).toBeGreaterThan(mid);
      // Rotates slightly, not a spin.
      expect(Math.abs(fallTransform(piece, 1).angle)).toBeGreaterThan(10);
      expect(Math.abs(fallTransform(piece, 1).angle)).toBeLessThan(45);
      for (const p of piecePoints(piece)) expect(transformPoint(p, fallTransform(piece, 1)).y).toBeGreaterThan(VIEW_BOTTOM);
    }
  });
});
