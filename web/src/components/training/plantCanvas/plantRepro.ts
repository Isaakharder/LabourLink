// Shapes for a reproductive point at each stage of its continuous `stage`:
//   0 bud → 1 open flower → 2 small green fruit → 3 large green bell pepper.
// Pure geometry (SVG path strings and points), no React. Everything stays
// anchored to the bud's base on its stem; the pedicel swings from pointing
// up/outward (bud) to sideways (flower, nodding outward) to hanging (fruit),
// so transitions animate without anything being swapped in.

import { hash01, type BudPart, type Point } from "./plantGeometry";

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
const pt = (p: Point) => `${fmt(p.x)} ${fmt(p.y)}`;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smooth(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function blendAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}
function dir(deg: number): Point {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}
const add = (p: Point, v: Point, k = 1): Point => ({ x: p.x + v.x * k, y: p.y + v.y * k });

/** Large-fruit size (units; 10 = 1 cm). Kept modest so fruit doesn't hide
 *  the branch structure needed for pruning practice. */
export const FRUIT_WIDTH = 40;
export const FRUIT_HEIGHT = 46;

export interface ReproShape {
  pedicel: string;
  pedicelWidth: number;
  calyx: string;
  bud: { cx: number; cy: number; rx: number; ry: number; rotate: number; opacity: number } | null;
  petals: { d: string; opacity: number } | null;
  centre: { cx: number; cy: number; r: number; opacity: number } | null;
  anthers: string;
  fruit: { body: string; highlight: string; grooves: string; ridge: number } | null;
  /** Every outline point, for bounds (falling, canvas size). */
  outline: Point[];
}

/** Smooth closed path through points (Catmull-Rom → cubic Bézier). */
function closedSmooth(points: Point[]): string {
  const n = points.length;
  let d = `M${pt(points[0])}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return d + "Z";
}

/** Fruit outline in local coords (x across, y down the hanging axis from
 *  the calyx): a narrow pod when `blocky` = 0, a lobed bell at 1. */
function fruitLocal(w: number, h: number, blocky: number): Point[] {
  // Right half, top (at the calyx) to bottom centre; mirrored for the left.
  const pod = [
    [0.3, 0.02],
    [0.48, 0.16],
    [0.5, 0.42],
    [0.42, 0.7],
    [0.26, 0.9],
    [0.1, 0.99],
    [0.04, 1.0],
  ];
  const bell = [
    [0.2, 0.0],
    [0.45, 0.08],
    [0.5, 0.3],
    [0.47, 0.62],
    [0.4, 0.86],
    [0.29, 0.99],
    [0.12, 0.9],
  ];
  const right = pod.map(([px, py], i) => ({ x: lerp(px, bell[i][0], blocky) * w, y: lerp(py, bell[i][1], blocky) * h }));
  const bottomMid = { x: 0, y: lerp(1.0, 0.97, blocky) * h };
  const left = [...right].reverse().map((p) => ({ x: -p.x, y: p.y }));
  return [{ x: 0, y: lerp(0.02, 0.06, blocky) * h }, ...right, bottomMid, ...left];
}

function toWorld(origin: Point, axisDeg: number, local: Point): Point {
  const down = dir(axisDeg);
  const across = { x: -down.y, y: down.x };
  return { x: origin.x + across.x * local.x + down.x * local.y, y: origin.y + across.y * local.x + down.y * local.y };
}

export function reproShape(bud: BudPart): ReproShape | null {
  if (bud.radius <= 0.05) return null;
  const s = bud.stage;
  const R = bud.radius;
  const open = smooth(s); // bud → flower
  const set = smooth(s - 1); // flower → small fruit
  const swell = smooth(s - 2); // small → large fruit
  const petalFade = smooth((s - 1) / 0.55);

  // Pedicel: from the stem, first up/outward, then swinging out sideways
  // and down as the flower nods and the fruit gains weight.
  const outward = bud.side > 0 ? -18 : -162;
  const stalkDir = blendAngle(bud.angle, outward, Math.max(open, set));
  const length = bud.pedicelLength * (1 + 0.7 * open) + 7 * set + 15 * swell;
  const calyxAt = add(bud.base, dir(stalkDir), length);
  const control = add(bud.base, dir(blendAngle(bud.angle, outward, 0.5 * open)), length * 0.55);
  // Axis the bud / flower / fruit hangs along.
  const flowerAxis = bud.side > 0 ? 35 : 145;
  const axis = blendAngle(blendAngle(bud.angle, flowerAxis, open), 90, set);

  const outline: Point[] = [bud.base, calyxAt];

  // Closed bud, shrinking into the opening flower.
  let budShape: ReproShape["bud"] = null;
  if (open < 1) {
    const c = add(calyxAt, dir(axis), R * 0.85);
    budShape = { cx: c.x, cy: c.y, rx: R * 0.8 * (1 - 0.5 * open), ry: R * (1 - 0.4 * open), rotate: axis + 90, opacity: 1 - open };
    outline.push({ x: c.x - R, y: c.y - R }, { x: c.x + R, y: c.y + R });
  }

  // Open flower: 5–7 white petals in a nodding cup, pale-yellow centre.
  let petals: ReproShape["petals"] = null;
  let centre: ReproShape["centre"] = null;
  let anthers = "";
  const petalOpacity = open * (1 - petalFade);
  if (petalOpacity > 0.01) {
    const count = 5 + Math.floor(hash01(bud.id, 41) * 3);
    const spin = hash01(bud.id, 42) * 60;
    const fc = add(add(calyxAt, dir(axis), 3), { x: 0, y: 1 }, 4 * petalFade);
    const len = 10 * open;
    let d = "";
    for (let k = 0; k < count; k++) {
      const theta = ((k * 360) / count + spin) * (Math.PI / 180);
      // Petal direction in flower-local coords, squashed along the axis to
      // read as a cup seen from the side.
      const local = { x: Math.cos(theta), y: Math.sin(theta) * 0.6 + 0.25 };
      const tip = toWorld(fc, axis, { x: local.x * len, y: local.y * len });
      const v = { x: tip.x - fc.x, y: tip.y - fc.y };
      const n = { x: -v.y * 0.36, y: v.x * 0.36 };
      const mid = add(fc, v, 0.55);
      d += `M${pt(fc)}Q${pt(add(mid, n))} ${pt(tip)}Q${pt(add(mid, n, -1))} ${pt(fc)}Z`;
      outline.push(tip);
    }
    petals = { d, opacity: petalOpacity };
    centre = { cx: fc.x, cy: fc.y, r: 2.6 * open, opacity: petalOpacity };
    for (let k = 0; k < 5; k++) {
      const a = (k * 72 + spin) * (Math.PI / 180);
      const p = { x: fc.x + Math.cos(a) * 1.7 * open, y: fc.y + Math.sin(a) * 1.7 * open };
      anthers += `M${pt(p)}m-0.7 0a0.7 0.7 0 1 0 1.4 0a0.7 0.7 0 1 0 -1.4 0`;
    }
  }

  // Fruit: sets as a narrow pod, swells into a lobed bell pepper.
  let fruit: ReproShape["fruit"] = null;
  if (set > 0.001) {
    const w = lerp(0, 7, set) + (FRUIT_WIDTH - 7) * swell;
    const h = lerp(0, 16, set) + (FRUIT_HEIGHT - 16) * swell;
    const local = fruitLocal(w, h, swell);
    const world = local.map((p) => toWorld(calyxAt, axis, p));
    outline.push(...world);
    const hl = [
      { x: -0.33 * w, y: 0.2 * h },
      { x: -0.25 * w, y: 0.16 * h },
      { x: -0.22 * w, y: 0.55 * h },
      { x: -0.3 * w, y: 0.6 * h },
    ].map((p) => toWorld(calyxAt, axis, p));
    const grooves = [-1, 1]
      .map((sgn) => {
        const a = toWorld(calyxAt, axis, { x: sgn * 0.13 * w, y: 0.1 * h });
        const m = toWorld(calyxAt, axis, { x: sgn * 0.2 * w, y: 0.5 * h });
        const b = toWorld(calyxAt, axis, { x: sgn * 0.12 * w, y: 0.88 * h });
        return `M${pt(a)}Q${pt(m)} ${pt(b)}`;
      })
      .join("");
    fruit = { body: closedSmooth(world), highlight: closedSmooth(hl), grooves, ridge: swell };
  }

  // Calyx: green sepals clasping the bud, flower or fruit top.
  const calyxWidth = lerp(R * 1.9, 9, open) + 5 * set + 9 * swell;
  const calyxLength = lerp(R * 0.8, 3.2, open) + 1.5 * set + 2 * swell;
  const down = dir(axis);
  const across = { x: -down.y, y: down.x };
  const sepals = 5;
  let calyx = `M${pt(add(calyxAt, across, -calyxWidth / 2))}`;
  for (let k = 0; k < sepals; k++) {
    const x0 = -calyxWidth / 2 + (k * calyxWidth) / sepals;
    const xm = x0 + calyxWidth / sepals / 2;
    const x1 = x0 + calyxWidth / sepals;
    // Rounded lobes; the outer ones curl further down over the shoulders.
    const reach = calyxLength * (0.8 + 0.3 * Math.abs(xm / (calyxWidth / 2)));
    const tip = add(add(calyxAt, across, xm), down, reach);
    calyx += `Q${pt(add(add(calyxAt, across, x0), down, reach))} ${pt(tip)}`;
    calyx += `Q${pt(add(add(calyxAt, across, x1), down, reach))} ${pt(add(calyxAt, across, x1))}`;
  }
  calyx += `Q${pt(add(calyxAt, down, -calyxLength * 0.9))} ${pt(add(calyxAt, across, -calyxWidth / 2))}Z`;

  return {
    pedicel: `M${pt(bud.base)}Q${pt(control)} ${pt(calyxAt)}`,
    pedicelWidth: 1.3 + 1.2 * set + 1.4 * swell,
    calyx,
    bud: budShape,
    petals,
    centre,
    anthers,
    fruit,
    outline,
  };
}

/** Bounds points of a reproductive point (empty before it forms). */
export function reproOutlinePoints(bud: BudPart): Point[] {
  return reproShape(bud)?.outline ?? [];
}
