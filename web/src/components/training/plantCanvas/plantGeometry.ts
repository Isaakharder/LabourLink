// Botanical geometry for the pepper-plant training canvas.
//
// Everything here is a pure, deterministic function of two inputs:
//   - growth:    0 (plant just before its crown split) … 1 (split complete,
//                ~30 cm of new growth)
//   - splitMode: how many leaders grow out of the crown (2 or 3)
//
// No randomness and no DOM: the same (growth, splitMode) always yields the
// same model, which is what makes Undo land on the exact starting plant and
// lets tests assert on structure. Per-part variety (size, angle, spacing)
// comes from a fixed hash of each part's id, not Math.random(). Rendering
// lives in PlantCanvas.tsx; outline construction in plantPaths.ts; cutting
// in plantCuts.ts.
//
// Growth above the crown is sympodial, like an unpruned pepper. The crown
// splits into 2 or 3 leaders. Every shoot is one *unit*: it grows a leaf,
// a second leaf higher on the opposite side, then ends in a small bud at a
// fork from which two child shoots continue — each repeating the pattern
// while enough growth distance remains. The shoot tree is generated
// procedurally (SHOOT_PLANS) with stable ids: leader-1 → leader-1.1,
// leader-1.2 → leader-1.1.1 …
//
// Node placement uses an internode-elongation model. A node (leaf or fork)
// is born at its shoot's growing tip; the internode below it keeps
// elongating for a while, so the node drifts away from the tip and settles.
// Growing heads therefore stay compact while mature leaves end up spaced
// along the stem. The original crown leaves are the first nodes of the
// leaders: the same leaves (same ids) slide up from the crown and settle as
// each leader's leaf 1 and leaf 2. Each head carries a small cluster of
// young leaves; at a fork the first child inherits it and the second child
// grows its own from nothing.
//
// Repeated growth: growth 0→1 is the initial crown split; every "Grow 30 cm"
// press adds exactly 1 (1→2, 2→3 …) and moves every live head 30 cm further
// along its path. Both shoots of every fork keep growing — each with its
// own head, leaves, buds and later forks — so an unpruned plant branches
// ever more; only the trainee's cuts stop a shoot. From the first Grow press
// on, one child of a new fork looks dominant (carries the parent's head on,
// nearly straight) and the other a little weaker (thinner, angled out), but
// both grow alike. Every split carries a reproductive point whose stage is
// the number of completed cycles since it formed: bud → flower → small green
// fruit → large green fruit.
//
// Cuts are time-stamped events (`CutEvent`). A cut prunes everything above it
// for good (never regenerated) and freezes the cut shoot and the forks below
// it at that moment, so cut ends never move however long the plant grows on.
//
// Every part records what it's attached to (`parentId`) and where along that
// parent (`attachS`, arc length) — the basis for cutting and future pruning.
//
// Coordinate system: SVG user units, y grows downward, 10 units = 1 cm.
// The viewBox is fixed (PLANT_VIEWBOX) so nothing shifts as the plant grows.
// Angles are SVG degrees: 0 = pointing right, -90 = straight up.
//
// Fine-tuning guide (all in the "Tunable constants" section below):
//   main-stem leaves   MAIN_LEAVES (heights, sides, sizes)
//   crown density      CROWN_LEAVES; which go where: LEADERS[mode][].crown
//   leaf spacing       UNIT_TO_LEAF_1, LEAF_1_TO_LEAF_2, LEAF_2_TO_FORK,
//                      SPACING_VARIATION
//   fork angles        CHILD_OFFSETS, CHILD_OFFSET_VARIATION
//   when forks happen  FORK_MIN_GROWTH, CHILD_DELAY (bud-before-split pause)
//   head compactness   NODE_SETTLE, TIP_CLUSTER
//   leaf width         LEAF_WIDTH_RATIO, LEAF_PROFILE in plantPaths.ts
//   leader curvature   LEADERS[mode][].launch / .wobble, STRAIGHTEN_LENGTH
//   later forks        DOMINANT_OFFSET, LATERAL_OFFSET, LATERAL_WIDTH

export type SplitMode = 2 | 3;

export interface Point {
  x: number;
  y: number;
}

export type PlantPartKind = "mainStem" | "leader" | "leaf" | "bud";

interface PlantPartBase {
  /** Stable id, e.g. "leader-1.2" or "leaf-leader-1.2-1" — the hook for
   *  selection, pruning and shoot removal. */
  id: string;
  kind: PlantPartKind;
}

export interface StemPart extends PlantPartBase {
  kind: "mainStem" | "leader";
  /** Centreline from base to growing tip (or fork). */
  points: Point[];
  baseWidth: number;
  tipWidth: number;
  /** Stem this one grows out of, and where along it. */
  parentId?: string;
  attachS?: number;
  /** Branching depth above the crown: 0 for the crown leaders. */
  generation?: number;
  /** Flat cut face at the base / tip (set by cutting). */
  cutBase?: boolean;
  cutTip?: boolean;
}

export interface LeafPart extends PlantPartBase {
  kind: "leaf";
  /** Stem this leaf is attached to; `base` lies on that stem's centreline. */
  parentId: string;
  /** Arc length along the parent stem where the leaf attaches. */
  attachS: number;
  base: Point;
  /** Petiole direction at the base, SVG degrees. */
  angle: number;
  /** Total arching along the midrib, degrees; turns toward the ground. */
  bend: number;
  /** Extra curl concentrated in the last part of the blade, degrees. */
  tipCurl: number;
  /** Which way the leaf droops: +1 bends clockwise, -1 anticlockwise. */
  side: 1 | -1;
  petioleLength: number;
  bladeLength: number;
  bladeWidth: number;
  /** -1…1: how much wider one half of the blade is than the other. */
  asymmetry: number;
  /** Phase of the slight waviness along the margin (radians). */
  marginPhase: number;
  /** 1 = tightly folded young leaf, 0 = fully open. */
  fold: number;
  /** Paint order relative to the stems (side view: some leaves sit behind). */
  layer: "back" | "front";
}

/** Reproductive point (bud, flower or fruit) at a split or shoot end. */
export interface BudPart extends PlantPartBase {
  kind: "bud";
  parentId: string;
  attachS: number;
  base: Point;
  /** Direction the young bud points (SVG degrees). */
  angle: number;
  pedicelLength: number;
  /** Bud size while it forms; 0 before it exists. */
  radius: number;
  /** Continuous stage: 0 bud · 1 open flower · 2 small green fruit ·
   *  3 large green fruit (stays there). */
  stage: number;
  /** Side of the stem the flower and fruit hang on. */
  side: 1 | -1;
  /** Split generation: 0 = the first crown, 1 = the leaders' forks, … */
  generation: number;
  /** Growth cycle it formed in (0 = the initial split). */
  bornCycle: number;
}

/** A cut, as the growth model needs it: where, and when (growth value). */
export interface CutEvent {
  stemId: string;
  s: number;
  at: number;
}

export interface PlantParts {
  stems: StemPart[];
  leaves: LeafPart[];
  buds: BudPart[];
}

export interface PlantModel extends PlantParts {
  growth: number;
  splitMode: SplitMode;
  /** Point the leaders originate from (top of the main stem). */
  crown: Point;
  /** Growing heads still alive (not cut off), by head id, with the shoot
   *  each currently grows on. */
  heads: Array<{ id: string; shootId: string }>;
}

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

export const UNITS_PER_CM = 10;

export const PLANT_VIEWBOX = { x: 130, y: 130, width: 600, height: 680 } as const;

/** Top of the rockwool block — where the stem leaves the substrate. */
export const GROUND_Y = 700;
/** x of the growth ruler's spine; plant geometry must stay to its right. */
export const RULER_X = 212;
/** Horizontal position of the main stem's base. */
export const STEM_BASE_X = 430;

/** Main stem height at growth 0 (≈22 cm, typical at first crown split). */
const START_STEM_HEIGHT = 22 * UNITS_PER_CM;
/** How far the stem stretches below the crown during the first phase. The
 *  crown cluster rises as a unit, keeping its short internodes. */
const MAIN_STEM_EXTENSION = 3 * UNITS_PER_CM;
const STRETCH_FROM = 12 * UNITS_PER_CM;
const STRETCH_TO = 17.6 * UNITS_PER_CM;
/** New growth the ruler shows and the tallest shoot tip reaches. */
export const NEW_GROWTH = 30 * UNITS_PER_CM;
/** Path growth every live head adds per "Grow 30 cm" press. */
export const CYCLE_GROWTH = NEW_GROWTH;

/** Starting plant height (top of the stem) in SVG y. */
export const START_TOP_Y = GROUND_Y - START_STEM_HEIGHT;
/** Finished plant height (tallest shoot tip) in SVG y. */
export const FINAL_TOP_Y = START_TOP_Y - NEW_GROWTH;

/** Growth phases. */
export const PHASE_STEM_END = 0.35;
const BUD_START = 0.27;
const BUD_END = 0.5;

const MAIN_BASE_WIDTH = 13;
const MAIN_TOP_WIDTH = 8.5;
/** Stem widths by generation: [base, tip]. */
const SHOOT_WIDTHS: Array<[number, number]> = [
  [7.2, 4.8],
  [4.8, 2.8],
  [3.4, 2.4],
];
/** Width factor of the weaker-looking child of a later fork. */
const LATERAL_WIDTH = 0.8;

/** Blade width as a fraction of blade length (pepper ≈ 0.5). */
export const LEAF_WIDTH_RATIO = 0.52;

/** One shoot unit (settled distances along the shoot, units). The two
 *  mature leaves end up LEAF_1_TO_LEAF_2 apart, and the gap from leaf 2 over
 *  the fork to the next unit's leaf 1 is about the same — ≈7 cm throughout. */
const UNIT_TO_LEAF_1 = 34;
const LEAF_1_TO_LEAF_2 = 70;
const LEAF_2_TO_FORK = 36;
/** ± variation applied per shoot to the three distances above. */
const SPACING_VARIATION = 0.24;
/** How far a node keeps rising after it is born at the tip. Smaller =
 *  nodes settle closer to the tip (tighter heads). */
const NODE_SETTLE = 50;
/** Tip advance over which a newly born leaf grows to full size. */
const LEAF_MATURITY_SPAN = 110;
/** Mature blade length (cm) of shoot leaves, by generation. */
const SHOOT_LEAF_BLADE = [7.6, 6.9, 6.2];
/** After a fork forms, its children wait until the parent's internode has
 *  pushed the fork this far below the (virtual) tip — the pause in which
 *  the bud becomes visible before the head divides. Each generation's tip
 *  therefore trails its parent's by this much. */
const CHILD_DELAY = 12;
/** A fork is only generated if at least this much growth would remain for
 *  its children — so no forks are crammed into the top of the canvas. */
const FORK_MIN_GROWTH = 110;
/** Heading change of the two children relative to the parent at a fork. */
const CHILD_OFFSETS: [number, number] = [-25, 23];
const CHILD_OFFSET_VARIATION = 6;
/** Later forks (from the first Grow press on): the dominant-looking child
 *  carries on nearly straight; the other angles out a little more and is a
 *  little thinner. Both are full, growing shoots. */
const DOMINANT_OFFSET = 9;
const LATERAL_OFFSET = 30;
/** Arc length over which a shoot turns from its launch heading toward its
 *  more upright target heading. */
const STRAIGHTEN_LENGTH = 80;
/** Distance over which a leaf or head turns from the parent stem's
 *  direction to its new shoot's as it passes a fork. */
const FORK_BLEND = 30;

/** Crown leaves keep their side as they travel, so each leader is given one
 *  crown leaf per side: `leaf1` (lower) and `leaf2` (higher), with where
 *  each settles (units above the crown). */
interface LeaderSpec {
  launch: number;
  wobble: number;
  phase: number;
  leaf1: { crown: number; settle: number };
  leaf2: { crown: number; settle: number };
}

const LEADERS: Record<SplitMode, LeaderSpec[]> = {
  // Balanced V, like a two-stem greenhouse pepper.
  2: [
    { launch: -24, wobble: 3, phase: 0.4, leaf1: { crown: 3, settle: 34 }, leaf2: { crown: 5, settle: 104 } },
    { launch: 23, wobble: -2.5, phase: 1.5, leaf1: { crown: 4, settle: 52 }, leaf2: { crown: 6, settle: 118 } },
  ],
  // Three leaders from the same crown; the middle one leans slightly so it
  // reads as its own shoot rather than a continuation of the main stem.
  3: [
    { launch: -29, wobble: 2.5, phase: 0.6, leaf1: { crown: 3, settle: 32 }, leaf2: { crown: 5, settle: 100 } },
    { launch: -2, wobble: 3, phase: 2.2, leaf1: { crown: 6, settle: 44 }, leaf2: { crown: 7, settle: 112 } },
    { launch: 30, wobble: -2.5, phase: 1.2, leaf1: { crown: 1, settle: 38 }, leaf2: { crown: 4, settle: 106 } },
  ],
};

const STEP = 4;

// Main-stem leaves below the crown: single, alternating, ~6–7 cm apart.
// `h` = height above the block (cm), `blade` = blade length (cm) at growth
// 0, `gain` = remaining growth during the stem phase.
interface MainLeafSpec {
  h: number;
  side: 1 | -1;
  spread: number;
  bend: number;
  blade: number;
  gain: number;
  layer: "back" | "front";
}

const MAIN_LEAVES: MainLeafSpec[] = [
  { h: 2.4, side: 1, spread: 62, bend: 33, blade: 10.4, gain: 0.02, layer: "front" },
  { h: 9.4, side: -1, spread: 54, bend: 30, blade: 12.0, gain: 0.05, layer: "front" },
  { h: 14.6, side: 1, spread: 46, bend: 27, blade: 11.2, gain: 0.1, layer: "back" },
];

// The crown cluster: medium leaves on very short internodes just below the
// apex, overlapping at different depths. They start tucked upward around
// the head. During the split most of them travel up to become the leaders'
// first two leaves (LEADERS[].leaf1/leaf2); the rest stay at the fork, one
// beneath the split. `foreshorten` < 1 is a leaf angled toward the viewer.
interface CrownLeafSpec {
  h: number;
  side: 1 | -1;
  spreadStart: number;
  spreadEnd: number;
  bladeStart: number;
  bladeEnd: number;
  foldStart: number;
  foreshorten: number;
  layer: "back" | "front";
}

const CROWN_LEAVES: CrownLeafSpec[] = [
  { h: 17.8, side: -1, spreadStart: 38, spreadEnd: 60, bladeStart: 8.6, bladeEnd: 9.4, foldStart: 0, foreshorten: 1, layer: "back" },
  { h: 18.5, side: 1, spreadStart: 33, spreadEnd: 68, bladeStart: 9.0, bladeEnd: 9.8, foldStart: 0, foreshorten: 1, layer: "front" },
  { h: 19.2, side: -1, spreadStart: 25, spreadEnd: 52, bladeStart: 8.0, bladeEnd: 8.6, foldStart: 0.05, foreshorten: 0.72, layer: "front" },
  { h: 19.8, side: 1, spreadStart: 20, spreadEnd: 50, bladeStart: 7.4, bladeEnd: 8.4, foldStart: 0.1, foreshorten: 1, layer: "back" },
  { h: 20.4, side: 1, spreadStart: 12, spreadEnd: 46, bladeStart: 6.4, bladeEnd: 8.0, foldStart: 0.2, foreshorten: 0.8, layer: "front" },
  { h: 21.2, side: -1, spreadStart: 8, spreadEnd: 44, bladeStart: 5.0, bladeEnd: 7.6, foldStart: 0.35, foreshorten: 0.85, layer: "front" },
  { h: 21.8, side: 1, spreadStart: 4, spreadEnd: 42, bladeStart: 3.6, bladeEnd: 7.2, foldStart: 0.55, foreshorten: 1, layer: "front" },
];

// The growing head: small folded young leaves wrapped round each shoot tip.
// `back` = distance behind the tip (units), `blade` in cm.
const TIP_CLUSTER = [
  { back: 0, sideSign: 1, spread: 5, blade: 2.2, fold: 0.82 },
  { back: 2, sideSign: -1, spread: 10, blade: 2.8, fold: 0.74 },
  { back: 4, sideSign: 1, spread: 16, blade: 3.3, fold: 0.64 },
  { back: 6.5, sideSign: -1, spread: 22, blade: 3.8, fold: 0.54 },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth start and finish — used for every sub-phase so growth never jerks. */
export function easeInOut(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

function easeOut(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 2.2);
}

/** Zero rate at both ends — new parts start as nothing, not a speck. */
function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/** Zero rate at 0, then close to linear: t² ramp blended into t. */
function softStart(t: number): number {
  const c = clamp01(t);
  const ramp = 0.1;
  return c < ramp ? (c * c) / (2 * ramp) : c - ramp / 2 + (ramp / 2) * ((c - ramp) / (1 - ramp));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function subPhase(g: number, start: number, end: number): number {
  return clamp01((g - start) / (end - start));
}

/** Deterministic 0…1 value from a string (FNV-1a). Gives each part its own
 *  fixed variation without any randomness between renders. */
export function hash01(key: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** -1…1 variant of hash01. */
function jitter(key: string, salt: number): number {
  return hash01(key, salt) * 2 - 1;
}

function blendAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Node elongation
// ---------------------------------------------------------------------------

interface NodeTiming {
  /** Tip position (along the path from the crown) when the node formed. */
  birth: number;
  /** How far it rises after forming. */
  settle: number;
}

/** Where a node sits (path distance from the crown) once its shoot's tip
 *  has reached `tip`: it starts at the tip and rises a further `settle` as
 *  its internode elongates. Always ≤ tip. */
function nodePosition(node: NodeTiming, tip: number): number {
  return node.birth + node.settle * (1 - Math.exp(-(tip - node.birth) / node.settle));
}

/** Settling distance for crown leaves travelling up a leader: leaf 1
 *  settles quickly, leaf 2 more slowly, so they are in place — one, then
 *  the other — before the leader's tip forms its fork. */
const CROWN_SETTLE = { leaf1: 40, leaf2: 75 };
/** How quickly a crown leaf leaves its starting spot to join its leader's
 *  node trajectory (tip travel, units). */
const CROWN_JOIN = 12;

interface CrownNodeTiming extends NodeTiming {
  depth: number;
}

/** A crown leaf moves like a node of its leader (born at target − settle,
 *  settling at `target`), plus an offset that starts it exactly `depth`
 *  below the crown and fades within a few units of tip growth. */
function crownPosition(node: CrownNodeTiming, tip: number): number {
  if (tip <= 0) return -node.depth;
  const along = nodePosition(node, tip);
  const offset = -(node.depth + nodePosition(node, 0)) * Math.exp(-tip / CROWN_JOIN);
  return Math.min(tip, along + offset);
}

// ---------------------------------------------------------------------------
// Shoot tree plan
// ---------------------------------------------------------------------------

interface LeafNodePlan extends NodeTiming {
  id: string;
  side: 1 | -1;
  /** Set when this node is one of the original crown leaves. */
  crownLeaf?: number;
  /** Start depth below the crown (crown leaves only). */
  depth?: number;
}

interface ForkPlan extends NodeTiming {
  id: string;
  /** Formed after the initial split → dominant-looking + lateral child. */
  late: boolean;
}

interface ShootPlan {
  id: string;
  generation: number;
  parent: ShootPlan | null;
  /** normal: initial-split shoot · dominant: carries the parent's head on
   *  past a later fork · lateral: the other, weaker-looking child of a later
   *  fork (grows exactly like the others, with its own head). */
  role: "normal" | "dominant" | "lateral";
  /** Launch heading and the more upright heading it turns toward. */
  h0: number;
  hTarget: number;
  wobble: number;
  phase: number;
  leaves: LeafNodePlan[];
  /** The terminal bud/fork, if it forms within the planning horizon. */
  fork: ForkPlan | null;
  children: ShootPlan[];
  /** Id prefix of the head-cluster leaves this shoot carries; the first
   *  child inherits it at a fork. */
  headId: string;
  /** True where a head is created (leaders and every fork's second child). */
  ownsHead: boolean;
  /** Settled path distance (from the crown) of this shoot's start. */
  startSettled: number;
}

/** Heading at arc length s along a shoot. A fixed function of s, so a
 *  growing shoot is always the same curve truncated at its tip. */
function shootHeading(plan: ShootPlan, s: number): number {
  const turn = 1 - Math.exp(-s / STRAIGHTEN_LENGTH);
  const wobble = plan.wobble * (Math.sin((Math.PI * s) / 180 + plan.phase) - Math.sin(plan.phase));
  return plan.h0 + (plan.hTarget - plan.h0) * turn + wobble;
}

function sideOf(heading: number): 1 | -1 {
  return heading < -90 ? -1 : 1;
}

/** Builds the shoot tree for a split mode. `budget` is how far heads travel
 *  in the initial split; `horizon` how far they will have travelled by the
 *  end of the current cycle — forks forming later aren't planned yet. The
 *  result for a larger horizon always contains the smaller one unchanged. */
function planShoots(mode: SplitMode, budget: number, horizon: number): ShootPlan[] {
  const vary = (key: string, salt: number) => 1 + SPACING_VARIATION * jitter(key, salt);

  const makeFork = (plan: ShootPlan, settledAt: number): (ForkPlan & { shift: number }) | null => {
    let birth = settledAt - NODE_SETTLE;
    let shift = 0;
    const initialTip = budget - plan.generation * CHILD_DELAY;
    // A fork that would form in the last stretch of the initial split is
    // held until the first Grow press — no forks crammed into the top.
    if (birth > initialTip - FORK_MIN_GROWTH && birth <= initialTip) {
      shift = initialTip + 0.5 - birth;
      birth = initialTip + 0.5;
    }
    if (birth > horizon - plan.generation * CHILD_DELAY) return null;
    return { id: `bud-${plan.id}`, birth, settle: NODE_SETTLE, late: birth > initialTip, shift };
  };

  const grow = (plan: ShootPlan, forkSettledPlanned: number) => {
    const fork = makeFork(plan, forkSettledPlanned);
    plan.fork = fork;
    if (!fork) return;
    const forkSettled = fork.birth + NODE_SETTLE;
    const parentHeading = shootHeading(plan, forkSettled - plan.startSettled);
    const lastSide = plan.leaves[plan.leaves.length - 1].side;
    const side1 = -lastSide as 1 | -1;

    const unit = (id: string, role: ShootPlan["role"], h0: number, hTarget: number, headId: string, ownsHead: boolean) => {
      const l1 = forkSettled + Math.max(12, UNIT_TO_LEAF_1 * vary(id, 22) - fork.shift);
      const l2 = l1 + LEAF_1_TO_LEAF_2 * vary(id, 23);
      const child: ShootPlan = {
        id,
        generation: plan.generation + 1,
        parent: plan,
        role,
        h0,
        hTarget,
        wobble: 2.5 * jitter(id, 25),
        phase: 3 * hash01(id, 26),
        leaves: [
          { id: `leaf-${id}-1`, side: side1, birth: l1 - NODE_SETTLE, settle: NODE_SETTLE },
          { id: `leaf-${id}-2`, side: -side1 as 1 | -1, birth: l2 - NODE_SETTLE, settle: NODE_SETTLE },
        ],
        fork: null,
        children: [],
        headId,
        ownsHead,
        startSettled: forkSettled,
      };
      grow(child, l2 + LEAF_2_TO_FORK * vary(id, 24));
      return child;
    };

    if (!fork.late) {
      // Initial split: two equal shoots, each with its own head.
      plan.children = CHILD_OFFSETS.map((offset, k) => {
        const id = `${plan.id}.${k + 1}`;
        const h0 = parentHeading + offset + CHILD_OFFSET_VARIATION * jitter(id, 21);
        return unit(id, "normal", h0, -90 + 0.45 * (h0 + 90), k === 0 ? plan.headId : id, k !== 0);
      });
      return;
    }

    // Later fork: both children grow on with their own heads. One carries
    // the parent's head and looks dominant; the other angles out, alternating
    // sides up the lineage.
    const lateralSide: 1 | -1 = ((plan.generation % 2 === 0 ? 1 : -1) * sideOf(plan.h0)) as 1 | -1;
    const domId = `${plan.id}.1`;
    const domH0 = parentHeading - lateralSide * DOMINANT_OFFSET + 3 * jitter(domId, 21);
    const latId = `${plan.id}.2`;
    const latH0 = parentHeading + lateralSide * LATERAL_OFFSET + 5 * jitter(latId, 21);
    plan.children = [
      unit(domId, "dominant", domH0, -90 + 0.35 * (domH0 + 90), plan.headId, false),
      unit(latId, "lateral", latH0, -90 + 0.45 * (latH0 + 90), latId, true),
    ];
  };

  return LEADERS[mode].map((spec, li) => {
    const id = `leader-${li + 1}`;
    const crownLeaf = (n: number, target: number, settle: number): LeafNodePlan => ({
      id: `leaf-crown-${n}`,
      side: CROWN_LEAVES[n - 1].side,
      crownLeaf: n,
      depth: START_STEM_HEIGHT - CROWN_LEAVES[n - 1].h * UNITS_PER_CM,
      birth: target - settle,
      settle,
    });
    const plan: ShootPlan = {
      id,
      generation: 0,
      parent: null,
      role: "normal",
      h0: -90 + spec.launch,
      hTarget: -90 + 0.5 * spec.launch,
      wobble: spec.wobble,
      phase: spec.phase,
      leaves: [
        crownLeaf(spec.leaf1.crown, spec.leaf1.settle, CROWN_SETTLE.leaf1),
        crownLeaf(spec.leaf2.crown, spec.leaf2.settle, CROWN_SETTLE.leaf2),
      ],
      fork: null,
      children: [],
      headId: id,
      ownsHead: true,
      startSettled: 0,
    };
    grow(plan, spec.leaf2.settle + LEAF_2_TO_FORK * vary(id, 24));
    return plan;
  });
}

function allShoots(plans: ShootPlan[]): ShootPlan[] {
  const out: ShootPlan[] = [];
  const walk = (p: ShootPlan) => {
    out.push(p);
    p.children.forEach(walk);
  };
  plans.forEach(walk);
  return out;
}

// ---------------------------------------------------------------------------
// Main stem
// ---------------------------------------------------------------------------

/** Share of the stem extension a point at base-height h receives: nothing
 *  low down, a smooth ramp through the upper stem, then all of it for the
 *  crown cluster so its internodes stay short. */
function extensionWeight(baseHeight: number): number {
  return smoothstep((baseHeight - STRETCH_FROM) / (STRETCH_TO - STRETCH_FROM));
}

/** Gentle, fixed curve so the stem doesn't look ruled. */
function stemOffsetX(height: number): number {
  return 5 * Math.sin(height / 72) - 2.4 * Math.sin(height / 31) * (height / 300);
}

function mainStemPoint(baseHeight: number, extension: number): Point {
  const h = baseHeight + extension * extensionWeight(baseHeight);
  return { x: STEM_BASE_X + stemOffsetX(h), y: GROUND_Y - h };
}

function headingAt(points: Point[], index: number): number {
  const a = points[Math.max(0, index - 1)];
  const b = points[Math.min(points.length - 1, index + 1)];
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Cumulative arc length at each polyline point. */
export function arcLengths(points: Point[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}

/** Polyline for a shoot from `origin`, sampled every STEP of arc length. */
function shootPoints(origin: Point, plan: ShootPlan, length: number): Point[] {
  const pts: Point[] = [{ ...origin }];
  let x = origin.x;
  let y = origin.y;
  let s = 0;
  while (s < length) {
    const ds = Math.min(STEP, length - s);
    const h = rad(shootHeading(plan, s + ds / 2));
    x += Math.cos(h) * ds;
    y += Math.sin(h) * ds;
    s += ds;
    pts.push({ x, y });
  }
  return pts;
}

/** Point and heading at arc length s along a polyline sampled every STEP
 *  from its start (shoots are). */
function pointAlong(points: Point[], s: number, fallbackHeading = -90): { point: Point; heading: number } {
  if (points.length < 2) return { point: { ...points[0] }, heading: fallbackHeading };
  const i = Math.min(points.length - 2, Math.max(0, Math.floor(s / STEP)));
  const a = points[i];
  const b = points[i + 1];
  const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const t = clamp01((s - i * STEP) / segLen);
  return {
    point: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) },
    heading: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface LeafInput {
  id: string;
  parentId: string;
  attachS: number;
  base: Point;
  heading: number;
  side: 1 | -1;
  spread: number;
  bend: number;
  blade: number;
  petioleRatio: number;
  fold: number;
  layer: "back" | "front";
  foreshorten?: number;
}

/** Builds a leaf, applying its fixed per-id variation. */
function makeLeaf(input: LeafInput): LeafPart {
  const { id } = input;
  const sizeVar = 1 + 0.08 * jitter(id, 1);
  const angleVar = 6 * jitter(id, 2);
  const blade = input.blade * sizeVar;
  const length = blade * (input.foreshorten ?? 1);
  return {
    id,
    kind: "leaf",
    parentId: input.parentId,
    attachS: input.attachS,
    base: input.base,
    angle: input.heading + input.side * (input.spread + angleVar),
    bend: input.bend * (1 + 0.15 * jitter(id, 3)),
    tipCurl: 6 + 8 * hash01(id, 4),
    side: input.side,
    petioleLength: length * input.petioleRatio,
    bladeLength: length,
    bladeWidth: blade * LEAF_WIDTH_RATIO * (1 + 0.06 * jitter(id, 5)),
    asymmetry: 0.12 * jitter(id, 6),
    marginPhase: hash01(id, 7) * Math.PI * 2,
    fold: input.fold,
    layer: input.layer,
  };
}

/** Per-shoot state at the current moment. */
interface ShootState {
  plan: ShootPlan;
  /** Tip position along the path from the crown (lags by generation). */
  tip: number;
  /** Path distance of this shoot's start (crown or parent fork). */
  start: number;
  length: number;
  /** Has it divided (fork formed)? */
  forked: boolean;
  points: Point[];
  /** Heading at the shoot's start, for blending things that just crossed
   *  into it from the parent. */
  parentHeading: number;
}

/** Leading-tip travel (path distance above the crown) at a growth value. */
function tipAtGrowth(growth: number, budget: number): number {
  if (growth > 1) return budget + CYCLE_GROWTH * (growth - 1);
  const leaderT = subPhase(growth, PHASE_STEM_END, 1);
  return budget * (0.2 * smoothstep(leaderT) + 0.8 * softStart(leaderT));
}

/** Growth cycle a node formed in, from the leading-tip travel at the time. */
function cycleOfTip(tip: number, budget: number): number {
  return tip <= budget + 1e-6 ? 0 : Math.ceil((tip - budget) / CYCLE_GROWTH - 1e-9);
}

function buildModel(growth: number, splitMode: SplitMode, budget: number, cuts: readonly CutEvent[] = []): PlantModel {
  const g01 = Math.min(growth, 1);
  const stemPhase = easeInOut(subPhase(g01, 0, PHASE_STEM_END));
  // The animation clock is already eased, so the leader phase only needs a
  // soft start (no kink at 35%) — a full ease here would compound and keep
  // the leaders hidden until late in the animation.
  const leaderT = subPhase(g01, PHASE_STEM_END, 1);
  const leaderPhase = 0.2 * smoothstep(leaderT) + 0.8 * softStart(leaderT);
  const crownGrow = easeInOut(clamp01(g01 / 0.85));
  const crownSpread = 0.25 * stemPhase + 0.75 * leaderPhase;
  const tip = tipAtGrowth(growth, budget);
  /** Reproductive stage of a point formed in `bornCycle`: one stage per
   *  completed Grow press since, animated during the press. */
  const stageOf = (bornCycle: number) => (growth <= 1 ? 0 : Math.min(3, Math.max(0, growth - 1 - bornCycle)));

  const horizon = growth <= 1 ? budget : budget + CYCLE_GROWTH * Math.ceil(growth - 1 - 1e-9);
  const plans = SHOOT_PLAN_CACHE.get(splitMode, budget, horizon);
  const shoots = allShoots(plans);
  const byId = new Map(shoots.map((p) => [p.id, p]));

  // --- Cuts: prune above, freeze at and below -------------------------------
  const pruned = new Set<string>();
  /** Lowest cut position per stem — anything above it on that stem is gone. */
  const cutBelow = new Map<string, number>();
  const freezeTip = new Map<string, number>();
  const freezeFork = new Map<string, number>();
  const lower = (m: Map<string, number>, id: string, v: number) => m.set(id, Math.min(m.get(id) ?? Infinity, v));
  for (const cut of cuts) {
    if (cut.stemId === "main-stem") {
      shoots.forEach((p) => pruned.add(p.id));
      continue;
    }
    const x = byId.get(cut.stemId);
    if (!x) continue;
    lower(cutBelow, x.id, cut.s);
    const tipThen = tipAtGrowth(cut.at, budget);
    const walk = (p: ShootPlan) => p.children.forEach((c) => (pruned.add(c.id), walk(c)));
    walk(x);
    lower(freezeTip, x.id, tipThen - x.generation * CHILD_DELAY);
    for (let a = x.parent; a; a = a.parent) lower(freezeFork, a.id, tipThen - a.generation * CHILD_DELAY);
  }

  const stems: StemPart[] = [];
  const leaves: LeafPart[] = [];
  const buds: BudPart[] = [];

  // Where each travelling crown leaf sits: below the crown on the main stem
  // (negative) or up its leader (positive).
  const crownPos = new Map<number, { shoot: ShootPlan; r: number }>();
  for (const plan of plans) {
    const leaderTip = Math.min(tip, freezeTip.get(plan.id) ?? Infinity);
    for (const leaf of plan.leaves) {
      crownPos.set(leaf.crownLeaf!, { shoot: plan, r: crownPosition(leaf as CrownNodeTiming, leaderTip) });
    }
  }

  // --- Main stem -----------------------------------------------------------
  const extension = MAIN_STEM_EXTENSION * stemPhase;
  const mainNodeHeights = new Map<string, number>();
  MAIN_LEAVES.forEach((l, i) => mainNodeHeights.set(`leaf-main-${i + 1}`, l.h * UNITS_PER_CM));
  CROWN_LEAVES.forEach((l, i) => {
    const pos = crownPos.get(i + 1);
    const h = pos ? START_STEM_HEIGHT + pos.r : l.h * UNITS_PER_CM;
    if (h < START_STEM_HEIGHT) mainNodeHeights.set(`leaf-crown-${i + 1}`, h);
  });
  const sampleHeights = new Set<number>(mainNodeHeights.values());
  for (let h = 0; h < START_STEM_HEIGHT; h += STEP) sampleHeights.add(h);
  sampleHeights.add(START_STEM_HEIGHT);
  const sortedHeights = [...sampleHeights].sort((a, b) => a - b);
  const mainPoints = sortedHeights.map((h) => mainStemPoint(h, extension));
  const mainArc = arcLengths(mainPoints);
  const mainLength = mainArc[mainArc.length - 1];
  const crown = mainPoints[mainPoints.length - 1];
  const crownHeading = headingAt(mainPoints, mainPoints.length - 1);
  const mainNode = (key: string) => {
    const idx = sortedHeights.indexOf(mainNodeHeights.get(key)!);
    return { point: { ...mainPoints[idx] }, heading: headingAt(mainPoints, idx), s: mainArc[idx] };
  };

  stems.push({ id: "main-stem", kind: "mainStem", points: mainPoints, baseWidth: MAIN_BASE_WIDTH, tipWidth: MAIN_TOP_WIDTH });

  MAIN_LEAVES.forEach((spec, i) => {
    const id = `leaf-main-${i + 1}`;
    const node = mainNode(id);
    leaves.push(
      makeLeaf({
        id,
        parentId: "main-stem",
        attachS: node.s,
        base: node.point,
        heading: node.heading,
        side: spec.side,
        spread: spec.spread,
        bend: spec.bend,
        blade: spec.blade * UNITS_PER_CM * (1 + spec.gain * stemPhase),
        petioleRatio: 0.26,
        fold: 0,
        layer: spec.layer,
      })
    );
  });

  // --- Shoot geometry (parents before children) ----------------------------
  const states = new Map<string, ShootState>();
  for (const plan of shoots) {
    if (pruned.has(plan.id)) continue;
    const parent = plan.parent ? states.get(plan.parent.id)! : null;
    const shootTip = Math.min(tip - plan.generation * CHILD_DELAY, freezeTip.get(plan.id) ?? Infinity);
    let start = 0;
    let origin = crown;
    let parentHeading = crownHeading;
    if (parent) {
      // Starts at the parent's fork, which keeps rising as the parent's last
      // internode elongates (unless a cut above froze it); children only
      // appear once it has risen CHILD_DELAY below the parent's tip.
      const forkTip = Math.min(parent.tip, freezeFork.get(parent.plan.id) ?? Infinity);
      start = parent.forked ? nodePosition(plan.parent!.fork!, forkTip) : Infinity;
      origin = parent.points[parent.points.length - 1];
      parentHeading = pointAlong(parent.points, parent.length, parent.plan.h0).heading;
    }
    const forked = !!plan.fork && shootTip > plan.fork.birth;
    const forkTip = Math.min(shootTip, freezeFork.get(plan.id) ?? Infinity);
    const end = forked ? nodePosition(plan.fork!, forkTip) : shootTip;
    const length = Math.max(0, end - start);
    const points = shootPoints(origin, plan, length);
    states.set(plan.id, { plan, tip: shootTip, start, length, forked: forked && length > 0, points, parentHeading });
  }

  // --- Crown leaves --------------------------------------------------------
  CROWN_LEAVES.forEach((spec, i) => {
    const id = `leaf-crown-${i + 1}`;
    const pos = crownPos.get(i + 1);
    let parentId = "main-stem";
    let attachS: number;
    let base: Point;
    let heading: number;
    if (mainNodeHeights.has(id)) {
      const node = mainNode(id);
      attachS = node.s;
      base = node.point;
      heading = node.heading;
    } else {
      // Up on its leader: follow it, turning from the main stem's direction
      // to the leader's over the first few cm so the leaf doesn't snap round.
      const st = states.get(pos!.shoot.id);
      if (!st) return; // leader cut away
      const r = Math.min(pos!.r, st.length);
      const along = pointAlong(st.points, r, st.plan.h0);
      parentId = st.plan.id;
      attachS = r;
      base = along.point;
      heading = blendAngle(crownHeading, along.heading, smoothstep(r / FORK_BLEND));
    }
    const staying = !pos;
    leaves.push(
      makeLeaf({
        id,
        parentId,
        attachS,
        base,
        heading,
        side: spec.side,
        spread: lerp(spec.spreadStart, spec.spreadEnd, crownSpread),
        bend: lerp(12, 26, crownSpread),
        blade: lerp(spec.bladeStart, spec.bladeEnd, crownGrow) * UNITS_PER_CM,
        petioleRatio: 0.2,
        fold: spec.foldStart * (1 - crownGrow),
        layer: spec.layer,
        foreshorten: lerp(spec.foreshorten, 1, staying ? 0 : crownSpread),
      })
    );
  });

  // --- Crown bud -----------------------------------------------------------
  const budPhase = easeOut(subPhase(g01, BUD_START, BUD_END));
  const budLean = splitMode === 2 ? 4 : 18;
  buds.push({
    id: "bud-crown",
    kind: "bud",
    parentId: "main-stem",
    attachS: mainLength,
    base: { ...crown },
    angle: -90 + budLean * budPhase,
    pedicelLength: 8 * budPhase,
    radius: 4.6 * budPhase,
    stage: stageOf(0),
    side: 1,
    generation: 0,
    bornCycle: 0,
  });

  // --- Shoot stems, leaves, reproductive points ----------------------------
  for (const st of states.values()) {
    const { plan } = st;
    if (st.length <= 0) continue;
    const [genBase, genTip] = SHOOT_WIDTHS[Math.min(plan.generation, SHOOT_WIDTHS.length - 1)];
    const lateral = plan.role === "lateral" ? LATERAL_WIDTH : 1;
    const baseW = genBase * lateral;
    const tipW = genTip * lateral;
    const thickness = 0.3 + 0.7 * smoothstep(st.length / 140);
    stems.push({
      id: plan.id,
      kind: "leader",
      points: st.points,
      baseWidth: baseW * thickness,
      tipWidth: Math.min(tipW, baseW * thickness),
      parentId: plan.parent ? plan.parent.id : "main-stem",
      attachS: plan.parent ? states.get(plan.parent.id)!.length : mainLength,
      generation: plan.generation,
    });

    // Mature leaves (crown-origin leaves were placed above).
    for (const leaf of plan.leaves) {
      if (leaf.crownLeaf !== undefined || st.tip <= leaf.birth) continue;
      const r = Math.min(nodePosition(leaf, st.tip) - st.start, st.length);
      // A leaf can't be older than the stem it grows on is long — so a leaf
      // whose node formed just before its shoot emerged still starts at 0.
      const age = smoothstep(Math.min(st.tip - leaf.birth, st.length) / LEAF_MATURITY_SPAN);
      const { point, heading } = pointAlong(st.points, Math.max(0, r), plan.h0);
      const outer = leaf.side === sideOf(plan.h0);
      const blade = SHOOT_LEAF_BLADE[Math.min(plan.generation, SHOOT_LEAF_BLADE.length - 1)] * (plan.role === "lateral" ? 0.92 : 1);
      leaves.push(
        makeLeaf({
          id: leaf.id,
          parentId: plan.id,
          attachS: Math.max(0, r),
          base: point,
          heading,
          side: leaf.side,
          spread: (outer ? 52 : 40) * (0.3 + 0.7 * age),
          bend: 24 * age,
          blade: blade * UNITS_PER_CM * age,
          petioleRatio: 0.24,
          fold: 1 - age,
          layer: outer ? "front" : "back",
        })
      );
    }

    // Reproductive point where this shoot divides.
    if (st.forked && plan.fork) {
      const end = pointAlong(st.points, st.length, plan.h0);
      const b = easeOut((st.tip - plan.fork.birth) / 40);
      const bornCycle = cycleOfTip(plan.fork.birth + plan.generation * CHILD_DELAY, budget);
      buds.push({
        id: plan.fork.id,
        kind: "bud",
        parentId: plan.id,
        attachS: st.length,
        base: end.point,
        angle: end.heading + 8 * jitter(plan.fork.id, 31),
        pedicelLength: 6 * b,
        radius: 3.6 * b,
        stage: stageOf(bornCycle),
        side: hash01(plan.fork.id, 32) < 0.5 ? -1 : 1,
        generation: plan.generation + 1,
        bornCycle,
      });
    }
  }

  // --- Growing heads -------------------------------------------------------
  // Follow each head down its lineage: at a fork the first child takes it
  // over once that child has started; the head turns from the parent's
  // direction to the child's as it goes.
  const heads: PlantModel["heads"] = [];
  for (const owner of shoots.filter((p) => p.ownsHead && states.has(p.id))) {
    let st = states.get(owner.id)!;
    if (st.length <= 0) continue;
    while (st.forked && st.plan.children.length) {
      const next = states.get(st.plan.children[0].id);
      if (!next || next.length <= 0) break;
      st = next;
    }
    // A head on the part of a shoot above a cut went with the cut.
    const alive = !(st.length > (cutBelow.get(st.plan.id) ?? Infinity));
    if (alive) heads.push({ id: owner.headId, shootId: st.plan.id });
    const ownSt = states.get(owner.id)!;
    const scale = owner.generation === 0 ? smoothstep(tip / 60) : smoothstep(ownSt.length / 60);
    // Fixed per head, so its leaves don't mirror when it changes shoot.
    const outward = sideOf(owner.h0);
    TIP_CLUSTER.forEach((t, k) => {
      // Measure back from the tip along the lineage: a leaf further back
      // than a just-started child sits on the parent below the fork, so
      // nothing jumps when the head passes over the fork.
      let on = st;
      let back = t.back;
      while (back > on.length && on.plan.parent && on.plan.id !== owner.id) {
        back -= on.length;
        on = states.get(on.plan.parent.id)!;
      }
      const at = Math.max(0, on.length - back);
      const along = pointAlong(on.points, at, on.plan.h0);
      const turn = on.plan.parent ? smoothstep(at / FORK_BLEND) : 1;
      leaves.push(
        makeLeaf({
          id: `leaf-${owner.headId}-tip-${k + 1}`,
          parentId: on.plan.id,
          attachS: at,
          base: along.point,
          heading: blendAngle(on.parentHeading, along.heading, turn),
          side: (t.sideSign * outward) as 1 | -1,
          spread: t.spread,
          bend: 8,
          blade: t.blade * UNITS_PER_CM * scale,
          petioleRatio: 0.12,
          fold: t.fold,
          layer: "front",
        })
      );
    });
  }

  return { growth, splitMode, stems, leaves, buds, crown, heads };
}

/** Plans depend on the budget and horizon; cache them. */
const SHOOT_PLAN_CACHE = {
  store: new Map<string, ShootPlan[]>(),
  get(mode: SplitMode, budget: number, horizon: number): ShootPlan[] {
    const key = `${mode}:${budget}:${horizon}`;
    let plans = this.store.get(key);
    if (!plans) {
      plans = planShoots(mode, budget, horizon);
      if (this.store.size > 64) this.store.clear();
      this.store.set(key, plans);
    }
    return plans;
  },
};

/** Highest point reached by any stem (smallest SVG y). */
export function stemTopY(model: PlantParts): number {
  let top = Infinity;
  for (const stem of model.stems) for (const p of stem.points) top = Math.min(top, p.y);
  return top;
}

/** Growth budget per mode: how far the leading tips travel in the initial
 *  split, chosen so its tallest tip ends exactly NEW_GROWTH above the
 *  starting stem top. */
function solveBudget(mode: SplitMode): number {
  let lo = 100;
  let hi = 800;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (stemTopY(buildModel(1, mode, mid)) > FINAL_TOP_Y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const BUDGET: Record<SplitMode, number> = { 2: solveBudget(2), 3: solveBudget(3) };

/** The plant at a growth value: 0…1 is the initial split, each further 1 is
 *  one "Grow 30 cm" cycle. `cuts` (with when they were made) prune and
 *  freeze as described at the top of this file. */
export function buildPlantModel(growthInput: number, splitMode: SplitMode, cuts: readonly CutEvent[] = []): PlantModel {
  return buildModel(Math.max(0, growthInput), splitMode, BUDGET[splitMode], cuts);
}

/** Head ids alive at a growth value (with cuts): one per growing tip. */
export function activeHeadIds(growth: number, mode: SplitMode, cuts: readonly CutEvent[] = []): string[] {
  return buildPlantModel(growth, mode, cuts).heads.map((h) => h.id);
}

/** Every planned shoot up to a growth value, with its parent, role and
 *  whether it divides within that horizon (for tests and tuning). */
export function shootTree(
  mode: SplitMode,
  growth = 1
): Array<{ id: string; parentId: string; generation: number; forks: boolean; role: string }> {
  const horizon = growth <= 1 ? BUDGET[mode] : BUDGET[mode] + CYCLE_GROWTH * Math.ceil(growth - 1 - 1e-9);
  return allShoots(SHOOT_PLAN_CACHE.get(mode, BUDGET[mode], horizon)).map((p) => ({
    id: p.id,
    parentId: p.parent ? p.parent.id : "main-stem",
    generation: p.generation,
    forks: !!p.fork,
    role: p.role,
  }));
}
