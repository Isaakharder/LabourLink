// Pure SVG path builders for the plant model. No React, no DOM — given a
// part from plantGeometry.ts, return the path strings that draw it.

import type { BudPart, LeafPart, Point, StemPart } from "./plantGeometry";

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
const pt = (p: Point) => `${fmt(p.x)} ${fmt(p.y)}`;

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Smooth path through points (Catmull-Rom → cubic Bézier). */
function smoothThrough(points: Point[], move = true): string {
  if (points.length === 0) return "";
  let d = move ? `M${pt(points[0])}` : `L${pt(points[0])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return d;
}

/** Unit normal to the left of travel direction at each point. */
function normals(points: Point[]): Point[] {
  return points.map((_, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dy / len, y: -dx / len };
  });
}

// ---------------------------------------------------------------------------
// Stems
// ---------------------------------------------------------------------------

export interface StemPaths {
  body: string;
  highlight: string;
}

export interface CutFace {
  center: Point;
  /** Stem direction at the face, degrees. */
  angle: number;
  halfWidth: number;
}

/** Cut faces at a stem's flat ends (only present after cutting). */
export function cutFaces(stem: StemPart): CutFace[] {
  const pts = stem.points;
  const n = pts.length - 1;
  if (n < 1) return [];
  const heading = (a: Point, b: Point) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const faces: CutFace[] = [];
  if (stem.cutTip) faces.push({ center: pts[n], angle: heading(pts[n - 1], pts[n]), halfWidth: stem.tipWidth / 2 });
  if (stem.cutBase) faces.push({ center: pts[0], angle: heading(pts[0], pts[1]), halfWidth: stem.baseWidth / 2 });
  return faces;
}

export function stemPaths(stem: StemPart): StemPaths {
  const pts = stem.points;
  if (pts.length < 2) return { body: "", highlight: "" };
  const ns = normals(pts);
  const n = pts.length - 1;
  const halfWidth = (i: number) => {
    const t = i / n;
    return (stem.baseWidth + (stem.tipWidth - stem.baseWidth) * t) / 2;
  };
  const left = pts.map((p, i) => ({ x: p.x + ns[i].x * halfWidth(i), y: p.y + ns[i].y * halfWidth(i) }));
  const right = pts.map((p, i) => ({ x: p.x - ns[i].x * halfWidth(i), y: p.y - ns[i].y * halfWidth(i) }));
  const tip = pts[n];
  const tipCap = { x: tip.x - ns[n].y * halfWidth(n), y: tip.y + ns[n].x * halfWidth(n) };
  // A growing tip is rounded; a cut tip is flat (its face is drawn
  // separately). The base is always flat.
  const body =
    smoothThrough(left) +
    (stem.cutTip ? `L${pt(right[n])}` : `Q${pt(tipCap)} ${pt(right[n])}`) +
    smoothThrough([...right].reverse(), false) +
    "Z";
  const highlight = smoothThrough(pts.map((p, i) => ({ x: p.x + ns[i].x * halfWidth(i) * 0.4, y: p.y + ns[i].y * halfWidth(i) * 0.4 })));
  return { body, highlight };
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

export interface LeafPaths {
  petiole: string;
  /** Half of the blade on the leaf's upper (light-catching) side. */
  upperHalf: string;
  /** Opposite half — painted darker to read as the fold / underside. */
  lowerHalf: string;
  midrib: string;
  veins: string;
}

const LEAF_SAMPLES = 24;
const PETIOLE_STEPS = 6;

/** Blade half-width profile t^a·(1-t)^b, normalised to peak 1. Lower `a`
 *  rounds the base; `b` near 1 gives a fine, drawn-out point. Pepper leaves
 *  are broadest a little below the middle (peak ≈ a / (a + b)). */
export const LEAF_PROFILE = { a: 0.72, b: 1.05 } as const;

function bladeProfile(t: number): number {
  const { a, b } = LEAF_PROFILE;
  const peakT = a / (a + b);
  const peak = Math.pow(peakT, a) * Math.pow(1 - peakT, b);
  return (Math.pow(t, a) * Math.pow(1 - t, b)) / peak;
}

interface LeafOutline {
  petioleEnd: Point;
  mid: Point[];
  upper: Point[];
  lower: Point[];
}

/** Walks the midrib once (petiole, then blade), offsetting each blade
 *  sample by the half-width profile on both sides. */
function leafOutline(leaf: LeafPart): LeafOutline {
  const total = leaf.petioleLength + leaf.bladeLength || 1;
  const headingAt = (s: number) => {
    const u = s / total;
    return leaf.angle + leaf.side * (leaf.bend * Math.pow(u, 1.3) + leaf.tipCurl * Math.pow(u, 4));
  };
  let x = leaf.base.x;
  let y = leaf.base.y;
  let s = 0;
  const walk = (ds: number) => {
    const h = rad(headingAt(s + ds / 2));
    x += Math.cos(h) * ds;
    y += Math.sin(h) * ds;
    s += ds;
  };
  for (let i = 0; i < PETIOLE_STEPS; i++) walk(leaf.petioleLength / PETIOLE_STEPS);
  const petioleEnd = { x, y };

  const halfW = (leaf.bladeWidth / 2) * (1 - 0.72 * leaf.fold);
  const mid: Point[] = [];
  const upper: Point[] = [];
  const lower: Point[] = [];
  const ds = leaf.bladeLength / LEAF_SAMPLES;
  for (let i = 0; i <= LEAF_SAMPLES; i++) {
    if (i > 0) walk(ds);
    const t = i / LEAF_SAMPLES;
    const h = rad(headingAt(s));
    const nx = Math.sin(h);
    const ny = -Math.cos(h);
    // Slight, fixed waviness so margins aren't machine-smooth.
    const wave = 1 + 0.035 * Math.sin(t * 9 + leaf.marginPhase) * (1 - leaf.fold);
    const w = halfW * bladeProfile(t) * wave;
    const wu = w * (1 + leaf.asymmetry);
    const wl = w * (1 - leaf.asymmetry);
    mid.push({ x, y });
    upper.push({ x: x + nx * wu, y: y + ny * wu });
    lower.push({ x: x - nx * wl, y: y - ny * wl });
  }
  return { petioleEnd, mid, upper, lower };
}

export function leafPaths(leaf: LeafPart): LeafPaths {
  const empty = { petiole: "", upperHalf: "", lowerHalf: "", midrib: "", veins: "" };
  if (leaf.bladeLength <= 0.05) return empty;
  const { petioleEnd, mid, upper, lower } = leafOutline(leaf);

  const midReversed = [...mid].reverse();
  const upperHalf = smoothThrough(upper) + smoothThrough(midReversed, false) + "Z";
  const lowerHalf = smoothThrough(lower) + smoothThrough(midReversed, false) + "Z";

  // Restrained venation: 5 pairs of laterals leaving the midrib toward the
  // tip and curving out to run alongside the margin.
  let veins = "";
  if (leaf.fold < 0.6) {
    for (let k = 0; k < 5; k++) {
      const i0 = Math.round((0.1 + k * 0.155) * LEAF_SAMPLES);
      const iMid = Math.min(LEAF_SAMPLES - 1, i0 + 2);
      const iEnd = Math.min(LEAF_SAMPLES - 1, i0 + 4);
      for (const edge of [upper, lower]) {
        const ctrl = {
          x: mid[iMid].x + (edge[iMid].x - mid[iMid].x) * 0.42,
          y: mid[iMid].y + (edge[iMid].y - mid[iMid].y) * 0.42,
        };
        const to = {
          x: mid[iEnd].x + (edge[iEnd].x - mid[iEnd].x) * 0.8,
          y: mid[iEnd].y + (edge[iEnd].y - mid[iEnd].y) * 0.8,
        };
        veins += `M${pt(mid[i0])}Q${pt(ctrl)} ${pt(to)}`;
      }
    }
  }

  return {
    petiole: `M${pt(leaf.base)}L${pt(petioleEnd)}`,
    upperHalf,
    lowerHalf,
    midrib: smoothThrough(mid.slice(0, Math.round(LEAF_SAMPLES * 0.86))),
    veins,
  };
}

/** Every outline point of a leaf (for bounds checks in tests and layout). */
export function leafOutlinePoints(leaf: LeafPart): Point[] {
  const { mid, upper, lower } = leafOutline(leaf);
  return [leaf.base, ...mid, ...upper, ...lower];
}

// ---------------------------------------------------------------------------
// Bud
// ---------------------------------------------------------------------------

export interface BudPaths {
  pedicel: string;
  center: Point;
  /** Small calyx cup under the bud. */
  calyx: string;
}

export function budPaths(bud: BudPart): BudPaths {
  const h = rad(bud.angle);
  const end = {
    x: bud.base.x + Math.cos(h) * bud.pedicelLength,
    y: bud.base.y + Math.sin(h) * bud.pedicelLength,
  };
  const center = {
    x: end.x + Math.cos(h) * bud.radius * 0.85,
    y: end.y + Math.sin(h) * bud.radius * 0.85,
  };
  const nx = Math.sin(h);
  const ny = -Math.cos(h);
  const r = bud.radius;
  const c1 = { x: end.x + nx * r * 0.95, y: end.y + ny * r * 0.95 };
  const c2 = { x: end.x - nx * r * 0.95, y: end.y - ny * r * 0.95 };
  const lip = { x: end.x + Math.cos(h) * r * 0.75, y: end.y + Math.sin(h) * r * 0.75 };
  const calyx =
    `M${pt(c1)}Q${pt({ x: lip.x + nx * r * 1.05, y: lip.y + ny * r * 1.05 })} ${pt(lip)}` +
    `Q${pt({ x: lip.x - nx * r * 1.05, y: lip.y - ny * r * 1.05 })} ${pt(c2)}` +
    `Q${pt({ x: end.x - Math.cos(h) * r * 0.25, y: end.y - Math.sin(h) * r * 0.25 })} ${pt(c1)}Z`;
  return { pedicel: `M${pt(bud.base)}L${pt(end)}`, center, calyx };
}
