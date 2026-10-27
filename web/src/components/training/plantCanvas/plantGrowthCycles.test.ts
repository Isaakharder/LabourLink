import { describe, expect, it } from "vitest";
import {
  activeHeadIds,
  arcLengths,
  buildPlantModel,
  shootTree,
  stemTopY,
  type CutEvent,
  type PlantModel,
  type Point,
  type SplitMode,
  type StemPart,
} from "./plantGeometry";
import { applyCuts, cuttableSegments, fallTransform, headsIn, piecePoints, transformPoint, type CutRecord } from "./plantCuts";
import { PLANT_VIEWBOX } from "./plantGeometry";

const MODES: SplitMode[] = [2, 3];
const lengthOf = (s: StemPart) => arcLengths(s.points)[s.points.length - 1];

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

/** Path distance from the crown to each head's tip. */
function headPositions(m: PlantModel): Map<string, number> {
  const starts = new Map<string, number>();
  for (const st of m.stems.filter((s) => s.kind === "leader")) {
    const parent = st.parentId === "main-stem" ? null : m.stems.find((s) => s.id === st.parentId)!;
    starts.set(st.id, parent ? starts.get(parent.id)! + lengthOf(parent) : 0);
  }
  const out = new Map<string, number>();
  for (const h of m.heads) {
    const tip = m.leaves.find((l) => l.id === `leaf-${h.id}-tip-1`);
    if (tip) out.set(h.id, starts.get(tip.parentId)! + tip.attachS);
  }
  return out;
}

/** The plant as drawn: model with cuts applied. */
function drawn(growth: number, mode: SplitMode, cuts: CutEvent[] = []) {
  const model = buildPlantModel(growth, mode, cuts);
  return { model, kept: applyCuts(model, cuts).kept };
}

/** A cut in the middle of a stem's n-th cuttable segment, made at `at`. */
function cutAt(at: number, mode: SplitMode, cuts: CutEvent[], stemId: string, which: number | "last" = 0): CutEvent {
  const { kept } = drawn(at, mode, cuts);
  const segs = cuttableSegments(kept).filter((s) => s.stemId === stemId);
  const seg = which === "last" ? segs[segs.length - 1] : segs[which];
  return { stemId, s: (seg.sFrom + seg.sTo) / 2, at };
}

/** What a trainee keeping a V/3-stem system does between presses: cut every
 *  second (".2") shoot still growing, at its first segment, so only the
 *  selected leaders continue. Returns the extended cut list. */
function pruneLaterals(at: number, mode: SplitMode, cuts: CutEvent[]): CutEvent[] {
  const next = [...cuts];
  for (;;) {
    const { kept } = drawn(at, mode, next);
    const target = kept.stems.find((s) => /\.2$/.test(s.id) && !s.cutTip && cuttableSegments(kept).some((g) => g.stemId === s.id));
    if (!target) return next;
    next.push(cutAt(at, mode, next, target.id, 0));
  }
}

/** Snapshot record for a cut, the way the trainer stores it. */
function record(mode: SplitMode, previous: CutRecord[], cut: CutEvent): CutRecord {
  const model = buildPlantModel(cut.at, mode, previous);
  const fresh = { stemId: cut.stemId, s: cut.s };
  const piece = applyCuts(model, [...previous, fresh]).pieces.find((p) => p.cut === fresh)!;
  return { ...cut, piece };
}

describe("Grow 30 cm — unpruned", () => {
  it.each(MODES)("makes both children of every fork active, growing tips (%i-split)", (mode) => {
    const m = buildPlantModel(3, mode);
    const carried = new Set(m.heads.map((h) => h.shootId));
    for (const st of m.stems.filter((s) => s.kind === "leader")) {
      const kids = m.stems.filter((s) => s.parentId === st.id);
      if (!kids.length) continue;
      expect(kids, st.id).toHaveLength(2);
      // Each child is either still growing (carries a head) or has itself
      // forked into children that do — nothing stops on its own.
      for (const kid of kids) {
        const live = (id: string): boolean => carried.has(id) || m.stems.some((s) => s.parentId === id && live(s.id));
        expect(live(kid.id), kid.id).toBe(true);
      }
    }
    const tree = shootTree(mode, 3);
    expect(tree.some((t) => t.role === "lateral")).toBe(true);
  });

  it.each(MODES)("increases the number of growing tips with every unpruned press (%i-split)", (mode) => {
    const counts = [1, 2, 3, 4].map((g) => buildPlantModel(g, mode).heads.length);
    expect(counts[0]).toBe(2 * mode);
    for (let k = 1; k < counts.length; k++) expect(counts[k], `press ${k}`).toBeGreaterThan(counts[k - 1] * 2);
  });

  it.each(MODES)("adds ~30 cm to every growing head on each of three unpruned presses (%i-split)", (mode) => {
    for (let k = 1; k <= 3; k++) {
      const before = headPositions(buildPlantModel(k, mode));
      const after = headPositions(buildPlantModel(k + 1, mode));
      for (const [id, pos] of before) {
        // A head present before the press is still there, ~30 cm further on.
        expect(after.has(id), `${id} press ${k}`).toBe(true);
        const gained = after.get(id)! - pos;
        expect(gained, `${id} press ${k}`).toBeGreaterThan(250);
        expect(gained, `${id} press ${k}`).toBeLessThan(310);
      }
      // New heads come only from new forks (one per fork's second child).
      for (const id of after.keys()) if (!before.has(id)) expect(id).toMatch(/\.2$/);
    }
  });

  it.each(MODES)("keeps a weaker-looking lateral child growing like any other (%i-split)", (mode) => {
    const lateral = "leader-1.1.2";
    const len = (g: number) => lengthOf(buildPlantModel(g, mode).stems.find((s) => s.id === lateral)!);
    const pos = (g: number) => headPositions(buildPlantModel(g, mode)).get(lateral)!;
    expect(buildPlantModel(2, mode).stems.find((s) => s.id === lateral)).toBeDefined();
    expect(pos(3) - pos(2)).toBeGreaterThan(250);
    expect(pos(4) - pos(3)).toBeGreaterThan(250);
    // It looks weaker (thinner) than its dominant sibling but forks too.
    const m = buildPlantModel(3, mode);
    const dom = m.stems.find((s) => s.id === "leader-1.1.1")!;
    const lat = m.stems.find((s) => s.id === lateral)!;
    expect(lat.baseWidth).toBeLessThan(dom.baseWidth);
    expect(m.stems.some((s) => s.parentId === lateral)).toBe(true);
    expect(len(4)).toBeGreaterThan(len(2));
  });

  it.each(MODES)("repeats leaf, opposite leaf, bud, split on every lineage (%i-split)", (mode) => {
    const m = buildPlantModel(3, mode);
    for (const st of m.stems.filter((s) => s.kind === "leader")) {
      if (!m.stems.some((s) => s.parentId === st.id)) continue;
      expect(m.buds.filter((b) => b.parentId === st.id).map((b) => b.id), st.id).toEqual([`bud-${st.id}`]);
      const own = m.leaves.filter((l) => l.parentId === st.id && !l.id.includes("-tip-"));
      expect(own, st.id).toHaveLength(2);
      expect(own[0].side).toBe(-own[1].side);
    }
  });

  it.each(MODES)("grows smoothly through two unpruned presses: nothing pops, jumps or detaches (%i-split)", (mode) => {
    let previous = new Map(buildPlantModel(1, mode).leaves.map((l) => [l.id, l]));
    const seenBuds = new Set(buildPlantModel(1, mode).buds.map((b) => b.id));
    for (let i = 1; i <= 200; i++) {
      const g = 1 + i / 100;
      const m = buildPlantModel(g, mode);
      const stems = new Map(m.stems.map((s) => [s.id, s.points]));
      for (const leaf of m.leaves) {
        expect(distanceToPolyline(leaf.base, stems.get(leaf.parentId)!), `${leaf.id} at ${g}`).toBeLessThan(0.75);
        const before = previous.get(leaf.id);
        if (!before) {
          expect(leaf.bladeLength, `${leaf.id} appears at ${g}`).toBeLessThan(2);
          continue;
        }
        expect(Math.hypot(leaf.base.x - before.base.x, leaf.base.y - before.base.y), `${leaf.id} at ${g}`).toBeLessThan(25);
      }
      for (const b of m.buds) {
        expect(distanceToPolyline(b.base, stems.get(b.parentId)!), `${b.id} at ${g}`).toBeLessThan(0.75);
        if (!seenBuds.has(b.id)) expect(b.radius, `${b.id} appears`).toBeLessThan(0.8);
        seenBuds.add(b.id);
      }
      previous = new Map(m.leaves.map((l) => [l.id, l]));
    }
  });

  it("builds a fully unpruned plant through four presses in reasonable time", () => {
    for (const mode of MODES) {
      const t0 = performance.now();
      const m = buildPlantModel(5, mode);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(m.heads.length).toBeGreaterThan(1000);
    }
  });
});

describe("Grow 30 cm — manually trained", () => {
  it.each(MODES)("keeps only the selected leaders growing through five presses (%i-split)", (mode) => {
    const leaders = Array.from({ length: mode }, (_, i) => `leader-${i + 1}`);
    let cuts = pruneLaterals(1, mode, []);
    for (let k = 1; k <= 5; k++) {
      const before = headPositions(drawn(k, mode, cuts).model);
      const after = headPositions(drawn(k + 1, mode, cuts).model);
      // Every head that survived pruning grew its ~30 cm.
      for (const [id, pos] of before) expect(after.get(id)! - pos, `${id} press ${k}`).toBeGreaterThan(250);
      cuts = pruneLaterals(k + 1, mode, cuts);
      const { model, kept } = drawn(k + 1, mode, cuts);
      for (const h of model.heads) {
        if (leaders.includes(h.id)) continue;
        // Anything else still growing is a lateral that only just emerged —
        // too short to have a cut target yet; the next prune takes it.
        const stem = kept.stems.find((s) => s.id === h.shootId)!;
        expect(lengthOf(stem), `${h.id} after press ${k}`).toBeLessThan(10);
      }
      expect(model.heads.filter((h) => leaders.includes(h.id))).toHaveLength(mode);
    }
  });

  it("replays the same trained sequence to identical geometry", () => {
    const run = () => {
      let cuts = pruneLaterals(1, 3, []);
      for (let k = 2; k <= 4; k++) cuts = pruneLaterals(k, 3, cuts);
      return drawn(4, 3, cuts).kept;
    };
    expect(run()).toEqual(run());
  });
});

describe("reproductive development", () => {
  const stages = (m: PlantModel) => new Map(m.buds.map((b) => [b.id, b.stage]));

  it.each(MODES)("advances every existing point exactly one stage per press (%i-split)", (mode) => {
    for (let k = 1; k <= 5; k++) {
      const before = stages(buildPlantModel(k, mode));
      const after = stages(buildPlantModel(k + 1, mode));
      for (const [id, s] of before) {
        expect(Number.isInteger(s), id).toBe(true);
        expect(after.get(id), `${id} press ${k}`).toBe(Math.min(3, s + 1));
      }
    }
  });

  it.each(MODES)("starts every new split as a bud that stays a bud until the next press (%i-split)", (mode) => {
    for (let k = 1; k <= 5; k++) {
      const before = stages(buildPlantModel(k, mode));
      const after = buildPlantModel(k + 1, mode);
      const created = after.buds.filter((b) => !before.has(b.id));
      expect(created.length, `press ${k}`).toBeGreaterThan(0);
      for (const b of created) {
        expect(b.stage, b.id).toBe(0);
        expect(b.bornCycle).toBe(k);
      }
    }
  });

  it("goes bud → flower → small green fruit → large green fruit and stays large", () => {
    const at = (g: number) => buildPlantModel(g, 2).buds.find((b) => b.id === "bud-leader-1")!.stage;
    expect([at(1), at(2), at(3), at(4), at(5), at(6)]).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it.each(MODES)("shows all four stages on one plant after three presses (%i-split)", (mode) => {
    const present = new Set(buildPlantModel(4, mode).buds.map((b) => b.stage));
    expect([...present].sort()).toEqual([0, 1, 2, 3]);
  });

  it("changes stage gradually during a press — no visible pop", () => {
    for (let i = 1; i <= 100; i++) {
      const a = buildPlantModel(2 + (i - 1) / 100, 2);
      const b = buildPlantModel(2 + i / 100, 2);
      for (const bud of b.buds) {
        const prev = a.buds.find((x) => x.id === bud.id);
        if (prev) expect(Math.abs(bud.stage - prev.stage)).toBeLessThanOrEqual(0.0101);
      }
    }
  });

  it.each(MODES)("keeps every reproductive id once it exists (%i-split)", (mode) => {
    const seen = new Set<string>();
    for (let i = 0; i <= 400; i++) {
      const ids = new Set(buildPlantModel(i / 100, mode).buds.map((b) => b.id));
      for (const id of seen) expect(ids.has(id), `${id} vanished at ${i / 100}`).toBe(true);
      ids.forEach((id) => seen.add(id));
    }
  });

  it("gives each split a generation, deeper splits higher up", () => {
    const m = buildPlantModel(4, 2);
    const crown = m.buds.find((b) => b.id === "bud-crown")!;
    expect(crown.generation).toBe(0);
    expect(m.buds.find((b) => b.id === "bud-leader-1")!.generation).toBe(1);
    expect(m.buds.find((b) => b.id === "bud-leader-1.1")!.generation).toBe(2);
    const forks = m.buds;
    expect(Math.max(...forks.map((b) => b.generation))).toBeGreaterThan(5);
  });
});

describe("pruning across growth cycles", () => {
  it.each(MODES)("keeps cut ends exactly in place and never regrows what was removed (%i-split)", (mode) => {
    const cut = cutAt(1, mode, [], "leader-1.2", 1);
    const stub = drawn(1, mode, [cut]).kept.stems.find((s) => s.id === "leader-1.2")!;
    for (let k = 2; k <= 6; k++) {
      const { model, kept } = drawn(k, mode, [cut]);
      expect(kept.stems.find((s) => s.id === "leader-1.2"), `press ${k - 1}`).toEqual(stub);
      expect(model.stems.some((s) => s.id.startsWith("leader-1.2."))).toBe(false);
      expect(model.heads.some((h) => h.id === "leader-1.2")).toBe(false);
      // Only intact heads grew (the cut child's head is gone for good).
      expect(model.heads.every((h) => !h.id.startsWith("leader-1.2"))).toBe(true);
    }
  });

  it.each(MODES)("lets surviving heads keep growing beside a cut neighbour (%i-split)", (mode) => {
    const cut = cutAt(1, mode, [], "leader-1.1", 0);
    expect(headPositions(buildPlantModel(1, mode)).has("leader-1")).toBe(true); // leader-1's head was on leader-1.1 …
    let before = headPositions(drawn(1, mode, [cut]).model);
    expect(before.has("leader-1")).toBe(false);
    for (let k = 2; k <= 4; k++) {
      const after = headPositions(drawn(k, mode, [cut]).model);
      expect(after.has("leader-1")).toBe(false); // … and is gone
      for (const [id, pos] of after) {
        if (before.has(id)) expect(pos - before.get(id)!, id).toBeGreaterThan(250);
      }
      before = after;
    }
  });

  it("cutting the lateral child stops only that child; its dominant sibling grows on", () => {
    const mode = 2;
    const cut = cutAt(2, mode, [], "leader-1.1.2", 0);
    const before = headPositions(drawn(2, mode, [cut]).model);
    const after = headPositions(drawn(3, mode, [cut]).model);
    expect([...after.keys()].some((id) => id.startsWith("leader-1.1.2"))).toBe(false);
    expect(drawn(3, mode, [cut]).model.stems.some((s) => s.id.startsWith("leader-1.1.2."))).toBe(false);
    expect(after.get("leader-1")! - before.get("leader-1")!).toBeGreaterThan(250); // carried on leader-1.1.1…
  });

  it("cutting the dominant child lets the lateral child continue", () => {
    const mode = 2;
    const cut = cutAt(2, mode, [], "leader-1.1.1", 0);
    const before = headPositions(drawn(2, mode, [cut]).model);
    const after = headPositions(drawn(3, mode, [cut]).model);
    expect(after.has("leader-1")).toBe(false); // that head rode the dominant child
    expect(after.get("leader-1.1.2")! - before.get("leader-1.1.2")!).toBeGreaterThan(250);
    expect(drawn(3, mode, [cut]).model.stems.some((s) => s.parentId === "leader-1.1.2")).toBe(true);
  });

  it.each(MODES)("progresses fruit on dominant and lateral children alike (%i-split)", (mode) => {
    const at = (g: number, id: string) => buildPlantModel(g, mode).buds.find((b) => b.id === id)?.stage;
    for (const id of ["bud-leader-1.1.1", "bud-leader-1.1.2"]) {
      const born = [2, 3, 4, 5].find((g) => at(g, id) !== undefined)!;
      const seq = [0, 1, 2, 3, 4].map((k) => at(born + k, id));
      expect(seq, id).toEqual([0, 1, 2, 3, 3]);
    }
  });

  it("stops all growth once every head is cut", () => {
    const mode = 2;
    const cut = cutAt(1, mode, [], "main-stem", "last");
    const rec = record(mode, [], cut);
    expect(headsIn(rec.piece).sort()).toEqual([...activeHeadIds(1, mode)].sort());
    expect(activeHeadIds(3, mode, [cut])).toEqual([]);
    const later = drawn(3, mode, [cut]);
    expect(later.kept.stems.map((s) => s.id)).toEqual(["main-stem"]);
    expect(later.kept).toEqual({ ...drawn(1, mode, [cut]).kept, growth: 3 });
  });

  it.each(MODES)("drops fruit above a cut with the piece and keeps fruit below it (%i-split)", (mode) => {
    const at = 4;
    const cut = cutAt(at, mode, [], "leader-1", "last"); // just below leader-1's fork
    const rec = record(mode, [], cut);
    const fallen = rec.piece.buds.map((b) => b.id);
    expect(fallen).toContain("bud-leader-1");
    expect(rec.piece.buds.find((b) => b.id === "bud-leader-1")!.stage).toBe(3); // a large fruit
    expect(fallen.every((id) => id === "bud-leader-1" || id.startsWith("bud-leader-1."))).toBe(true);
    const { kept } = drawn(at, mode, [cut]);
    expect(kept.buds.some((b) => b.id === "bud-crown")).toBe(true); // fruit below the cut stays
    expect(kept.buds.some((b) => b.id.startsWith("bud-leader-1"))).toBe(false);
    expect(kept.buds.some((b) => b.id === "bud-leader-2")).toBe(true);
    // The falling piece, fruit included, leaves the canvas completely.
    const bottom = PLANT_VIEWBOX.y + PLANT_VIEWBOX.height;
    for (const p of piecePoints(rec.piece)) expect(transformPoint(p, fallTransform(rec.piece, 1)).y).toBeGreaterThan(bottom);
  });

  it("removes only a child branch and its descendants when that branch is cut", () => {
    const mode = 3;
    const cut = cutAt(3, mode, [], "leader-2.1.1", 0);
    const tipsBefore = activeHeadIds(3, mode);
    const tipsAfter = activeHeadIds(3, mode, [cut]);
    const removed = tipsBefore.filter((id) => !tipsAfter.includes(id));
    // Exactly the tips that were above the cut went with it.
    expect(removed.length).toBeGreaterThan(0);
    expect(tipsAfter.length).toBe(tipsBefore.length - removed.length);
    const rec = record(mode, [], cut);
    expect(rec.piece.stems.every((s) => s.id === "leader-2.1.1~upper" || s.id.startsWith("leader-2.1.1."))).toBe(true);
    const { kept } = drawn(3, mode, [cut]);
    expect(kept.stems.some((s) => s.id === "leader-2.1.2")).toBe(true);
    expect(kept.buds.some((b) => b.id === "bud-leader-2.1")).toBe(true);
  });

  it("replays the same split, grows and cuts to identical geometry and stages", () => {
    const run = () => {
      const mode = 3 as SplitMode;
      const cuts: CutEvent[] = [];
      cuts.push(cutAt(1, mode, cuts, "leader-3.2", 1));
      cuts.push(cutAt(3, mode, cuts, "leader-1", "last"));
      return drawn(5, mode, cuts).kept;
    };
    expect(run()).toEqual(run());
  });
});
