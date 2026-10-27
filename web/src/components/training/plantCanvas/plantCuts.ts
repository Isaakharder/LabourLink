// Stem cutting for the training canvas. Pure functions over the plant model:
// no DOM, no randomness, nothing saved anywhere.
//
// A cut is (stemId, s): an exact arc-length position along one stem. The stem
// is split there; everything attached to it above s — leaves, buds, child
// stems — and everything attached to those, recursively, becomes one
// detached piece. The rooted remainder keeps a flat cut end.

import {
  PLANT_VIEWBOX,
  arcLengths,
  type BudPart,
  type CutEvent,
  type LeafPart,
  type PlantModel,
  type PlantParts,
  type Point,
  type StemPart,
} from "./plantGeometry";
import { leafOutlinePoints } from "./plantPaths";
import { reproOutlinePoints } from "./plantRepro";

export interface Cut {
  stemId: string;
  s: number;
}

/** A cut as the trainer keeps it: where and when, plus a snapshot of what
 *  fell (so it can be drawn falling — and rewound on Undo — exactly as it
 *  was, however the rest of the plant grows on afterwards). */
export interface CutRecord extends CutEvent {
  piece: DetachedPiece;
}

export interface DetachedPiece extends PlantParts {
  cut: Cut;
  /** Where the piece was severed — the centre of its rotation as it falls. */
  pivot: Point;
}

export interface CutResult {
  kept: PlantModel;
  pieces: DetachedPiece[];
}

/** Keeps cuts clear of leaf nodes: a cut lands on stem, not in a leaf base. */
export const NODE_MARGIN = 4;

function stemLength(stem: StemPart): number {
  const arc = arcLengths(stem.points);
  return arc[arc.length - 1];
}

/** Splits a polyline at arc length s; both halves include the cut point. */
export function splitPolyline(points: Point[], s: number): [Point[], Point[]] {
  const arc = arcLengths(points);
  let i = 1;
  while (i < points.length - 1 && arc[i] < s) i++;
  const a = points[i - 1];
  const b = points[i];
  const seg = arc[i] - arc[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (s - arc[i - 1]) / seg));
  const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  return [[...points.slice(0, i), p], [p, ...points.slice(i)]];
}

function widthAt(stem: StemPart, s: number, length: number): number {
  return stem.baseWidth + (stem.tipWidth - stem.baseWidth) * (s / (length || 1));
}

function applyCut(model: PlantModel, cut: Cut): { kept: PlantModel; piece: DetachedPiece | null } {
  const stem = model.stems.find((st) => st.id === cut.stemId);
  if (!stem) return { kept: model, piece: null };
  const length = stemLength(stem);
  if (!(cut.s > 0) || cut.s >= length) return { kept: model, piece: null };

  // Stems that fall whole: attached to the cut stem above the cut, or to a
  // stem that is itself falling.
  const falling = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const st of model.stems) {
      if (falling.has(st.id) || !st.parentId) continue;
      const above = st.parentId === cut.stemId && (st.attachS ?? 0) > cut.s;
      if (above || falling.has(st.parentId)) {
        falling.add(st.id);
        grew = true;
      }
    }
  }
  const detaches = (part: LeafPart | BudPart) =>
    falling.has(part.parentId) || (part.parentId === cut.stemId && part.attachS > cut.s);

  const [lower, upper] = splitPolyline(stem.points, cut.s);
  const w = widthAt(stem, cut.s, length);
  const keptStem: StemPart = { ...stem, points: lower, tipWidth: w, cutTip: true };
  const upperStem: StemPart = {
    ...stem,
    id: `${stem.id}~upper`,
    points: upper,
    baseWidth: w,
    cutBase: true,
    parentId: undefined,
    attachS: undefined,
  };

  const kept: PlantModel = {
    ...model,
    stems: model.stems.filter((st) => !falling.has(st.id)).map((st) => (st.id === stem.id ? keptStem : st)),
    leaves: model.leaves.filter((l) => !detaches(l)),
    buds: model.buds.filter((b) => !detaches(b)),
  };
  const piece: DetachedPiece = {
    cut,
    pivot: lower[lower.length - 1],
    stems: [upperStem, ...model.stems.filter((st) => falling.has(st.id))],
    leaves: model.leaves.filter(detaches),
    buds: model.buds.filter(detaches),
  };
  return { kept, piece };
}

/** Applies cuts in order; each later cut acts on what earlier cuts left. */
export function applyCuts(model: PlantModel, cuts: Cut[]): CutResult {
  let kept = model;
  const pieces: DetachedPiece[] = [];
  for (const cut of cuts) {
    const result = applyCut(kept, cut);
    kept = result.kept;
    if (result.piece) pieces.push(result.piece);
  }
  return { kept, pieces };
}

// ---------------------------------------------------------------------------
// Where a cut may be made
// ---------------------------------------------------------------------------

export interface StemSegment {
  stemId: string;
  /** Cuttable arc-length range on that stem (between two leaf nodes). */
  sFrom: number;
  sTo: number;
  points: Point[];
}

/** Every stretch of stem between neighbouring leaf nodes (and between the
 *  rockwool and the first node, or the last node and a growing tip),
 *  trimmed clear of the nodes themselves. */
export function cuttableSegments(model: PlantModel): StemSegment[] {
  const out: StemSegment[] = [];
  for (const stem of model.stems) {
    const length = stemLength(stem);
    const marks = [0, length];
    // Mature-leaf nodes bound the segments. The young head leaves don't, so
    // even a shoot that has only just emerged can be pinched out.
    for (const l of model.leaves) {
      if (l.parentId === stem.id && l.bladeLength > 0.5 && !l.id.includes("-tip-")) marks.push(l.attachS);
    }
    for (const b of model.buds) if (b.parentId === stem.id) marks.push(b.attachS);
    for (const st of model.stems) if (st.parentId === stem.id && st.attachS !== undefined) marks.push(st.attachS);
    marks.sort((a, b) => a - b);
    for (let i = 1; i < marks.length; i++) {
      const sFrom = marks[i - 1] + (i === 1 ? 0 : NODE_MARGIN);
      const sTo = marks[i] - NODE_MARGIN;
      if (sTo - sFrom < 3) continue;
      const [, fromOn] = splitPolyline(stem.points, Math.max(sFrom, 1e-6));
      const [segment] = splitPolyline(fromOn, sTo - sFrom);
      out.push({ stemId: stem.id, sFrom: Math.max(sFrom, 0.5), sTo, points: segment });
    }
  }
  return out;
}

/** Arc length on `stem` of the point nearest `p`, limited to [sFrom, sTo]. */
export function projectOntoStem(stem: StemPart, p: Point, sFrom: number, sTo: number): number {
  const arc = arcLengths(stem.points);
  let bestS = (sFrom + sTo) / 2;
  let best = Infinity;
  for (let i = 1; i < stem.points.length; i++) {
    const a = stem.points[i - 1];
    const b = stem.points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) {
      best = d;
      bestS = arc[i - 1] + t * (arc[i] - arc[i - 1]);
    }
  }
  return Math.min(sTo, Math.max(sFrom, bestS));
}

// ---------------------------------------------------------------------------
// Falling
// ---------------------------------------------------------------------------

export const FALL_DURATION_MS = 1250;
/** Share of the fall during which the piece hangs in place before dropping. */
const FALL_HOLD = 0.08;
const FALL_TILT = 30;
const FALL_DRIFT = 40;
const VIEW_BOTTOM = PLANT_VIEWBOX.y + PLANT_VIEWBOX.height;

export interface FallTransform {
  dx: number;
  dy: number;
  angle: number;
  pivot: Point;
}

function piecePoints(piece: PlantParts): Point[] {
  return [
    ...piece.stems.flatMap((s) => s.points),
    ...piece.leaves.flatMap((l) => leafOutlinePoints(l)),
    ...piece.buds.flatMap((b) => reproOutlinePoints(b)),
  ];
}

/** Head ids whose growing head is on a detached piece. */
export function headsIn(piece: PlantParts): string[] {
  const ids = new Set<string>();
  for (const l of piece.leaves) {
    const m = /^leaf-(.+)-tip-\d+$/.exec(l.id);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function rotateAbout(p: Point, c: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos };
}

/** Final tilt direction and the drop needed to clear the bottom edge. */
function fallPlan(piece: DetachedPiece): { dir: 1 | -1; drop: number } {
  const pts = piecePoints(piece);
  const cx = pts.reduce((sum, p) => sum + p.x, 0) / (pts.length || 1);
  // Tips toward the side carrying more of its weight.
  const dir: 1 | -1 = cx >= piece.pivot.x ? 1 : -1;
  const minY = Math.min(...pts.map((p) => rotateAbout(p, piece.pivot, dir * FALL_TILT).y));
  return { dir, drop: VIEW_BOTTOM - minY + 30 };
}

const planCache = new WeakMap<DetachedPiece, { dir: 1 | -1; drop: number }>();

/** Rigid transform of a falling piece at progress 0…1: holds its shape,
 *  then drops under constant acceleration while tilting, and at 1 is
 *  entirely below the canvas. */
export function fallTransform(piece: DetachedPiece, progress: number): FallTransform {
  let plan = planCache.get(piece);
  if (!plan) {
    plan = fallPlan(piece);
    planCache.set(piece, plan);
  }
  const u = Math.min(1, Math.max(0, (progress - FALL_HOLD) / (1 - FALL_HOLD)));
  if (u === 0) return { dx: 0, dy: 0, angle: 0, pivot: piece.pivot };
  return {
    dx: plan.dir * FALL_DRIFT * u,
    dy: plan.drop * u * u,
    angle: plan.dir * FALL_TILT * Math.pow(u, 1.4),
    pivot: piece.pivot,
  };
}

/** A point of the piece after applying the fall transform. */
export function transformPoint(p: Point, t: FallTransform): Point {
  const r = rotateAbout(p, t.pivot, t.angle);
  return { x: r.x + t.dx, y: r.y + t.dy };
}

export { piecePoints };
