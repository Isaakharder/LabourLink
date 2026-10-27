import { describe, expect, it } from "vitest";
import {
  FINAL_TOP_Y,
  PLANT_VIEWBOX,
  PHASE_STEM_END,
  RULER_X,
  START_TOP_Y,
  arcLengths,
  buildPlantModel,
  shootTree,
  stemTopY,
  type LeafPart,
  type PlantModel,
  type Point,
  type SplitMode,
  type StemPart,
} from "./plantGeometry";
import { leafOutlinePoints } from "./plantPaths";

const MODES: SplitMode[] = [2, 3];
const SAMPLES = Array.from({ length: 41 }, (_, i) => i / 40);
/** Mature (non-head) leaf counts of the previous, pre-sympodial version. */
const PREVIOUS_MATURE: Record<SplitMode, number> = { 2: 30, 3: 40 };

function distanceToPolyline(p: Point, line: Point[]): number {
  if (line.length === 1) return Math.hypot(p.x - line[0].x, p.y - line[0].y);
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

const shoots = (m: PlantModel) => m.stems.filter((s) => s.kind === "leader");
const primary = (m: PlantModel) => m.stems.filter((s) => s.parentId === "main-stem");
const lengthOf = (s: StemPart) => arcLengths(s.points)[s.points.length - 1];
const isHead = (l: LeafPart) => l.id.includes("-tip-");
const mature = (m: PlantModel) => m.leaves.filter((l) => !isHead(l) && l.bladeLength > 30 && l.fold < 0.3);

/** Path distance from the crown to the start of each shoot. */
function shootStarts(m: PlantModel): Map<string, number> {
  const starts = new Map<string, number>();
  for (const st of shoots(m)) {
    const parent = st.parentId === "main-stem" ? null : m.stems.find((s) => s.id === st.parentId)!;
    starts.set(st.id, parent ? starts.get(parent.id)! + lengthOf(parent) : 0);
  }
  return starts;
}

/** Every crown-to-tip lineage, as a list of shoot ids. */
function lineages(m: PlantModel): string[][] {
  const out: string[][] = [];
  const walk = (id: string, path: string[]) => {
    const kids = shoots(m).filter((s) => s.parentId === id);
    if (!kids.length) out.push([...path, id]);
    for (const k of kids) walk(k.id, [...path, id]);
  };
  for (const p of primary(m)) walk(p.id, []);
  return out;
}

describe("starting plant", () => {
  it("is identical whichever split will be chosen", () => {
    const two = buildPlantModel(0, 2);
    const three = buildPlantModel(0, 3);
    expect({ ...two, splitMode: 0 }).toEqual({ ...three, splitMode: 0 });
  });

  it("has one main stem, a leafy crown, no shoots and no visible bud", () => {
    const model = buildPlantModel(0, 2);
    expect(model.stems.map((s) => s.id)).toEqual(["main-stem"]);
    expect(model.leaves.length).toBeGreaterThanOrEqual(9);
    expect(model.buds[0].radius).toBe(0);
    expect(stemTopY(model)).toBeCloseTo(START_TOP_Y, 5);
  });
});

describe("determinism", () => {
  it.each(MODES)("builds the same %i-split model every time", (mode) => {
    for (const g of [0, 0.2, 0.35, 0.61, 0.83, 1]) {
      expect(buildPlantModel(g, mode)).toEqual(buildPlantModel(g, mode));
    }
  });

  it("clamps negative growth to the starting plant", () => {
    expect(buildPlantModel(-1, 2)).toEqual(buildPlantModel(0, 2));
  });
});

describe("main stem", () => {
  it.each([0, 1])("has single, alternating, well-spaced leaves below the crown (growth %s)", (g) => {
    const model = buildPlantModel(g, 2);
    const lower = model.leaves.filter((l) => l.id.startsWith("leaf-main-")).sort((a, b) => a.attachS - b.attachS);
    expect(lower.length).toBeGreaterThanOrEqual(3);
    expect(lower.length).toBeLessThanOrEqual(4); // previously 8
    for (let i = 1; i < lower.length; i++) {
      expect(lower[i].side).toBe(-lower[i - 1].side);
      const gap = lower[i].attachS - lower[i - 1].attachS;
      expect(gap).toBeGreaterThanOrEqual(50);
      expect(gap).toBeLessThanOrEqual(100);
    }
  });
});

describe("first crown split", () => {
  it("grows no shoots during the stem phase", () => {
    expect(shoots(buildPlantModel(PHASE_STEM_END, 2))).toHaveLength(0);
    expect(shoots(buildPlantModel(PHASE_STEM_END, 3))).toHaveLength(0);
  });

  it.each(MODES)("starts exactly %i leaders, all from the crown, at every moment", (mode) => {
    expect(primary(buildPlantModel(1, mode))).toHaveLength(mode);
    for (const g of SAMPLES) {
      const model = buildPlantModel(g, mode);
      for (const leader of primary(model)) expect(leader.points[0]).toEqual(model.crown);
    }
  });

  it.each(MODES)("finishes the %i-split ~30 cm taller than the starting plant", (mode) => {
    expect(stemTopY(buildPlantModel(1, mode))).toBeCloseTo(FINAL_TOP_Y, 0);
    expect(START_TOP_Y - FINAL_TOP_Y).toBe(300);
  });

  it("gives the 2-split two balanced leaders", () => {
    const model = buildPlantModel(1, 2);
    const [left, right] = primary(model).map((l) => l.points[l.points.length - 1]);
    expect(left.x).toBeLessThan(model.crown.x);
    expect(right.x).toBeGreaterThan(model.crown.x);
    expect(Math.abs(model.crown.x - left.x - (right.x - model.crown.x))).toBeLessThan(30);
  });

  it("gives the 3-split three distinct leaders from the same crown", () => {
    const model = buildPlantModel(1, 3);
    const ends = primary(model)
      .map((l) => l.points[l.points.length - 1].x)
      .sort((a, b) => a - b);
    expect(ends[1] - ends[0]).toBeGreaterThan(30);
    expect(ends[2] - ends[1]).toBeGreaterThan(30);
  });
});

describe("unpruned sympodial growth", () => {
  it.each(MODES)("divides every %i-split leader after its second mature leaf, with a bud at the fork", (mode) => {
    const model = buildPlantModel(1, mode);
    for (const leader of primary(model)) {
      const children = shoots(model).filter((s) => s.parentId === leader.id);
      expect(children, leader.id).toHaveLength(2);
      const below = model.leaves.filter((l) => l.parentId === leader.id && !isHead(l));
      expect(below, leader.id).toHaveLength(2);
      expect(below[0].side).toBe(-below[1].side);
      const bud = model.buds.find((b) => b.id === `bud-${leader.id}`)!;
      expect(bud.parentId).toBe(leader.id);
      expect(bud.attachS).toBeCloseTo(lengthOf(leader), 6);
      expect(bud.radius).toBeGreaterThan(2);
      expect(bud.radius).toBeLessThan(5);
      // Clearly visible: both children have grown well past the fork.
      for (const child of children) expect(lengthOf(child)).toBeGreaterThan(90);
    }
  });

  it.each(MODES)("divides every %i-split shoot that forks only after two leaves", (mode) => {
    const model = buildPlantModel(1, mode);
    const tree = shootTree(mode);
    expect(tree.filter((t) => t.generation === 0)).toHaveLength(mode);
    for (const shoot of tree.filter((t) => t.forks)) {
      expect(tree.filter((t) => t.parentId === shoot.id)).toHaveLength(2);
      const leaves = model.leaves.filter((l) => l.parentId === shoot.id && !isHead(l));
      expect(leaves, shoot.id).toHaveLength(2);
      expect(model.buds.some((b) => b.id === `bud-${shoot.id}`)).toBe(true);
    }
    // Only forks that fit: no grandchild is crammed in at the very top.
    for (const st of shoots(model)) {
      const kids = shoots(model).filter((s) => s.parentId === st.id);
      for (const k of kids) expect(lengthOf(k)).toBeGreaterThan(60);
    }
  });

  it.each(MODES)("uses procedural ids for the %i-split shoot tree", (mode) => {
    const ids = shootTree(mode).map((t) => t.id);
    const expected = Array.from({ length: mode }, (_, i) => [`leader-${i + 1}`, `leader-${i + 1}.1`, `leader-${i + 1}.2`]).flat();
    expect(ids).toEqual(expected);
  });

  it.each(MODES)("roughly halves the mature foliage of the %i-split", (mode) => {
    const count = mature(buildPlantModel(1, mode)).length;
    expect(count).toBeLessThanOrEqual(Math.round(PREVIOUS_MATURE[mode] * 0.62));
    expect(count).toBeGreaterThanOrEqual(Math.round(PREVIOUS_MATURE[mode] * 0.4));
  });

  it.each(MODES)("has one leaf per node — no small companion beside a %i-split mature leaf", (mode) => {
    const model = buildPlantModel(1, mode);
    for (const leaf of mature(model).filter((l) => l.parentId !== "main-stem")) {
      const neighbours = model.leaves.filter(
        (o) => o !== leaf && !isHead(o) && o.parentId === leaf.parentId && Math.abs(o.attachS - leaf.attachS) < 15
      );
      expect(neighbours.map((n) => n.id), leaf.id).toEqual([]);
    }
  });

  it.each(MODES)("alternates and spaces mature leaves 5–10 cm apart along every %i-split lineage", (mode) => {
    const model = buildPlantModel(1, mode);
    const starts = shootStarts(model);
    const allGaps: number[] = [];
    for (const lineage of lineages(model)) {
      const along = mature(model)
        .filter((l) => lineage.includes(l.parentId))
        .map((l) => ({ l, at: starts.get(l.parentId)! + l.attachS }))
        .sort((a, b) => a.at - b.at);
      expect(along.length, lineage.join(">")).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < along.length; i++) {
        expect(along[i].l.side, lineage.join(">")).toBe(-along[i - 1].l.side);
        const gap = along[i].at - along[i - 1].at;
        expect(gap, `${along[i - 1].l.id} → ${along[i].l.id}`).toBeGreaterThanOrEqual(45);
        expect(gap, `${along[i - 1].l.id} → ${along[i].l.id}`).toBeLessThanOrEqual(100);
      }
      allGaps.push(...along.slice(1).map((a, i) => a.at - along[i].at));
    }
    // Not mechanically uniform across the plant.
    expect(Math.max(...allGaps) - Math.min(...allGaps)).toBeGreaterThan(10);
  });

  it.each(MODES)("keeps a compact young head on every active %i-split shoot throughout growth", (mode) => {
    for (const g of SAMPLES) {
      const model = buildPlantModel(g, mode);
      for (const st of shoots(model)) {
        const len = lengthOf(st);
        const forkedAndPassedOn = shoots(model).some((c) => c.parentId === st.id && c.points.length > 1);
        if (forkedAndPassedOn || len < 60) continue;
        const head = model.leaves.filter((l) => l.parentId === st.id && isHead(l) && l.attachS >= len - 12);
        expect(head.length, `${st.id} at ${g}`).toBe(4);
        for (const leaf of head) {
          expect(leaf.fold).toBeGreaterThan(0.4); // folded, drawn paler
          expect(leaf.bladeLength).toBeLessThan(45);
        }
      }
    }
  });

  it.each(MODES)("finishes the %i-split with a separate head on each of its 2×%i shoots", (mode) => {
    const model = buildPlantModel(1, mode);
    const tips = shoots(model).filter((s) => !shoots(model).some((c) => c.parentId === s.id));
    expect(tips).toHaveLength(2 * mode);
    for (const t of tips) {
      expect(model.leaves.filter((l) => l.parentId === t.id && isHead(l))).toHaveLength(4);
    }
  });

  it("keeps every part's id once it exists — nothing is removed and replaced", () => {
    for (const mode of MODES) {
      const seen = new Set<string>();
      for (let i = 0; i <= 200; i++) {
        const model = buildPlantModel(i / 200, mode);
        const ids = new Set([...model.stems, ...model.leaves, ...model.buds].map((p) => p.id));
        for (const id of seen) expect(ids.has(id), `${id} vanished at ${i / 200}`).toBe(true);
        ids.forEach((id) => seen.add(id));
      }
    }
  });
});

describe("crown cluster", () => {
  const crownLeaves = (m: PlantModel) => m.leaves.filter((l) => l.id.startsWith("leaf-crown-"));

  it("already looks full before either split: 6–8 clustered leaves at the head", () => {
    const model = buildPlantModel(0, 2);
    const cluster = crownLeaves(model);
    expect(cluster.length).toBeGreaterThanOrEqual(6);
    expect(cluster.length).toBeLessThanOrEqual(8);
    for (const leaf of cluster) expect(model.crown.y - leaf.base.y).toBeGreaterThan(-45);
    expect(new Set(cluster.map((l) => l.bladeLength.toFixed(1))).size).toBe(cluster.length);
    expect(new Set(cluster.map((l) => l.angle.toFixed(1))).size).toBe(cluster.length);
  });

  it.each(MODES)("sends two crown leaves up each %i-split leader as its leaf 1 and leaf 2", (mode) => {
    const model = buildPlantModel(1, mode);
    for (const leader of primary(model)) {
      const own = crownLeaves(model).filter((l) => l.parentId === leader.id);
      expect(own, leader.id).toHaveLength(2);
    }
    const near = model.leaves.filter((l) => Math.hypot(l.base.x - model.crown.x, l.base.y - model.crown.y) < 45);
    expect(near.length).toBeLessThanOrEqual(5); // no ball of leaves left at the fork
  });
});

describe("crown bud", () => {
  it("forms progressively and stays small", () => {
    const radii = SAMPLES.map((g) => buildPlantModel(g, 2).buds[0].radius);
    expect(radii[0]).toBe(0);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1]);
    const final = buildPlantModel(1, 3).buds[0];
    expect(final.radius).toBeGreaterThan(3);
    expect(final.radius).toBeLessThanOrEqual(6);
  });
});

describe("continuity", () => {
  it("never detaches a leaf or bud from its stem", () => {
    for (const mode of MODES) {
      for (const g of SAMPLES) {
        const model = buildPlantModel(g, mode);
        const stems = new Map(model.stems.map((s) => [s.id, s.points]));
        for (const part of [...model.leaves, ...model.buds]) {
          const parent = stems.get(part.parentId);
          expect(parent, `${part.id} parent ${part.parentId}`).toBeDefined();
          expect(distanceToPolyline(part.base, parent!), `${part.id} at ${g}`).toBeLessThan(0.75);
        }
        // Every shoot starts on its parent.
        for (const st of shoots(model)) {
          expect(distanceToPolyline(st.points[0], stems.get(st.parentId!)!), st.id).toBeLessThan(0.75);
        }
      }
    }
  });

  it("grows continuously — nothing pops in, jumps or snaps round", () => {
    for (const mode of MODES) {
      let previous = new Map(buildPlantModel(0, mode).leaves.map((l) => [l.id, l]));
      for (let i = 1; i <= 400; i++) {
        const model = buildPlantModel(i / 400, mode);
        for (const leaf of model.leaves) {
          const before = previous.get(leaf.id);
          if (!before) {
            expect(leaf.bladeLength, `${leaf.id} first appears`).toBeLessThan(0.5);
            continue;
          }
          expect(Math.abs(leaf.bladeLength - before.bladeLength), `${leaf.id} size at ${i / 400}`).toBeLessThan(5);
          expect(Math.hypot(leaf.base.x - before.base.x, leaf.base.y - before.base.y), `${leaf.id} moved at ${i / 400}`).toBeLessThan(6);
          const turn = Math.abs(((leaf.angle - before.angle + 540) % 360) - 180);
          expect(turn, `${leaf.id} turned at ${i / 400}`).toBeLessThan(6);
        }
        previous = new Map(model.leaves.map((l) => [l.id, l]));
      }
    }
  });

  it("grows new shoots and buds from nothing", () => {
    for (const mode of MODES) {
      const seenStem = new Set<string>();
      const seenBud = new Set<string>();
      for (let i = 0; i <= 400; i++) {
        const model = buildPlantModel(i / 400, mode);
        for (const st of shoots(model)) {
          if (!seenStem.has(st.id)) expect(lengthOf(st), `${st.id} first appears`).toBeLessThan(5);
          seenStem.add(st.id);
        }
        for (const b of model.buds) {
          if (!seenBud.has(b.id)) expect(b.radius, `${b.id} first appears`).toBeLessThan(0.6);
          seenBud.add(b.id);
        }
      }
    }
  });

  it.each(MODES)("develops each %i-split leader in order: leaf 1, leaf 2, bud, then the fork", (mode) => {
    const first = (pred: (m: PlantModel) => boolean) => {
      for (let i = 0; i <= 400; i++) if (pred(buildPlantModel(i / 400, mode))) return i;
      return Infinity;
    };
    for (const leader of primary(buildPlantModel(1, mode))) {
      const [leaf1, leaf2] = buildPlantModel(1, mode)
        .leaves.filter((l) => l.parentId === leader.id && !isHead(l))
        .sort((a, b) => a.attachS - b.attachS);
      const onLeader = (id: string, minS: number) => (m: PlantModel) => {
        const l = m.leaves.find((x) => x.id === id)!;
        return l.parentId === leader.id && l.attachS > minS;
      };
      const t1 = first(onLeader(leaf1.id, 15));
      const t2 = first(onLeader(leaf2.id, 50));
      const tBud = first((m) => (m.buds.find((b) => b.id === `bud-${leader.id}`)?.radius ?? 0) > 1);
      const tFork = first((m) => m.stems.some((s) => s.parentId === leader.id && lengthOf(s) > 4));
      expect(t1, leader.id).toBeLessThan(t2);
      expect(t2, leader.id).toBeLessThan(tBud);
      expect(tBud, leader.id).toBeLessThan(tFork);
    }
  });

  it("shows the bud at a fork before the head divides", () => {
    for (const mode of MODES) {
      for (const leader of ["leader-1", "leader-2"]) {
        let budFirst = -1;
        let childFirst = -1;
        for (let i = 0; i <= 400; i++) {
          const model = buildPlantModel(i / 400, mode);
          if (budFirst < 0 && model.buds.some((b) => b.id === `bud-${leader}` && b.radius > 1)) budFirst = i;
          if (childFirst < 0 && model.stems.some((s) => s.parentId === leader && lengthOf(s) > 4)) childFirst = i;
        }
        expect(budFirst).toBeGreaterThan(0);
        expect(childFirst).toBeGreaterThan(budFirst);
      }
    }
  });
});

describe("layout", () => {
  it("keeps the whole plant inside the viewBox and clear of the ruler", () => {
    const minX = RULER_X + 30;
    const maxX = PLANT_VIEWBOX.x + PLANT_VIEWBOX.width;
    const minY = PLANT_VIEWBOX.y;
    for (const mode of MODES) {
      for (const g of SAMPLES) {
        const model = buildPlantModel(g, mode);
        const points = [...model.stems.flatMap((s) => s.points), ...model.leaves.flatMap((l) => leafOutlinePoints(l))];
        for (const p of points) {
          expect(p.x).toBeGreaterThan(minX);
          expect(p.x).toBeLessThan(maxX);
          expect(p.y).toBeGreaterThan(minY);
        }
      }
    }
  });

  it("never moves the stem base, so the plant doesn't shift when growth begins", () => {
    const base = (g: number, m: SplitMode) => buildPlantModel(g, m).stems[0].points[0];
    for (const g of SAMPLES) {
      expect(base(g, 2)).toEqual(base(0, 2));
      expect(base(g, 3)).toEqual(base(0, 2));
    }
  });
});
