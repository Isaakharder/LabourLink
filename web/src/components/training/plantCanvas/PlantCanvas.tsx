import { memo, useId, useMemo } from "react";
import {
  GROUND_Y,
  PLANT_VIEWBOX,
  RULER_X,
  START_TOP_Y,
  STEM_BASE_X,
  UNITS_PER_CM,
  buildPlantModel,
  type BudPart,
  type LeafPart,
  type PlantParts,
  type Point,
  type SplitMode,
  type StemPart,
} from "./plantGeometry";
import { cutFaces, leafOutlinePoints, leafPaths, stemPaths } from "./plantPaths";
import { applyCuts, cuttableSegments, fallTransform, projectOntoStem, type CutRecord } from "./plantCuts";
import { FRUIT_HEIGHT, reproOutlinePoints, reproShape } from "./plantRepro";

const FRUIT_REACH = 30 + FRUIT_HEIGHT;

// Renders the plant model as SVG. Every drawn part carries `data-part`
// (its stable id) and `data-kind`, the hook for selection and pruning.
// The drawing keeps one scale throughout: as repeated growth takes the
// plant past the original frame, the viewBox (and, with `fitScale`, the
// SVG itself) extends up and sideways instead of shrinking the plant.

// Leaf greens sampled to match greenhouse pepper foliage: bright,
// slightly yellow-green tops, deeper shaded halves; young leaves paler.
const MATURE_UPPER = [92, 150, 56];
const MATURE_LOWER = [70, 126, 46];
const YOUNG_UPPER = [150, 192, 92];
const YOUNG_LOWER = [124, 172, 78];

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Rendering stays fast on a heavily branched plant: every part is drawn
// from its geometry rounded to 1/100 unit, and re-renders only when that
// rounded geometry changes — so settled older growth is skipped while new
// growth animates. Because the drawing depends only on the rounded values,
// skipping is exact: the same plant always produces the same markup,
// however it got there (Undo lands on the byte-identical start).
const q2 = (n: number) => Math.round(n * 100) / 100;
const q4 = (n: number) => Math.round(n * 10000) / 10000;
const qp = (p: Point): Point => ({ x: q2(p.x), y: q2(p.y) });

function quantLeaf(l: LeafPart): LeafPart {
  return {
    ...l,
    base: qp(l.base),
    angle: q2(l.angle),
    bend: q2(l.bend),
    tipCurl: q2(l.tipCurl),
    petioleLength: q2(l.petioleLength),
    bladeLength: q2(l.bladeLength),
    bladeWidth: q2(l.bladeWidth),
    asymmetry: q4(l.asymmetry),
    marginPhase: q4(l.marginPhase),
    fold: q4(l.fold),
  };
}
const leafKey = (l: LeafPart) =>
  [l.id, l.parentId, l.side, l.layer, l.base.x, l.base.y, l.angle, l.bend, l.tipCurl, l.petioleLength, l.bladeLength, l.bladeWidth, l.asymmetry, l.marginPhase, l.fold].join(",");

function quantBud(b: BudPart): BudPart {
  return { ...b, base: qp(b.base), angle: q2(b.angle), pedicelLength: q2(b.pedicelLength), radius: q2(b.radius), stage: q4(b.stage) };
}
const budKey = (b: BudPart) => [b.id, b.side, b.base.x, b.base.y, b.angle, b.pedicelLength, b.radius, b.stage].join(",");

function quantStem(s: StemPart): StemPart {
  return { ...s, points: s.points.map(qp), baseWidth: q2(s.baseWidth), tipWidth: q2(s.tipWidth) };
}
const stemKey = (s: StemPart) =>
  [s.id, s.kind, s.baseWidth, s.tipWidth, s.cutTip ? 1 : 0, s.cutBase ? 1 : 0, s.points.map((p) => `${p.x} ${p.y}`).join(" ")].join(",");

const Leaf = memo(function Leaf({ leaf }: { leaf: LeafPart; k: string }) {
  const paths = leafPaths(leaf);
  if (!paths.upperHalf) return null;
  // Young folded leaves are paler and show more of their darker half.
  const youth = Math.min(1, leaf.fold * 1.1);
  return (
    <g data-part={leaf.id} data-kind="leaf">
      <path d={paths.petiole} className="plant-petiole" strokeWidth={Math.max(0.9, leaf.bladeLength * 0.026)} />
      <path d={paths.lowerHalf} fill={mix(MATURE_LOWER, YOUNG_LOWER, youth)} className="plant-leaf-half" />
      <path d={paths.upperHalf} fill={mix(MATURE_UPPER, YOUNG_UPPER, youth)} className="plant-leaf-half" />
      {paths.veins && <path d={paths.veins} className="plant-leaf-veins" />}
      <path d={paths.midrib} className="plant-leaf-midrib" />
    </g>
  );
}, (a, b) => a.k === b.k);

const STAGE_NAMES = ["bud", "flower", "small-fruit", "large-fruit"];

/** Bud, flower or fruit at a split, drawn for its continuous stage. */
const Repro = memo(function Repro({ bud }: { bud: BudPart; k: string }) {
  const shape = reproShape(bud);
  if (!shape) return null;
  return (
    <g data-part={bud.id} data-kind="bud" data-stage={STAGE_NAMES[Math.round(Math.min(3, bud.stage))]}>
      <path d={shape.pedicel} className="plant-pedicel" strokeWidth={shape.pedicelWidth} />
      {shape.fruit && (
        <g className="plant-fruit">
          <path d={shape.fruit.body} className="plant-fruit-body" />
          <path d={shape.fruit.grooves} className="plant-fruit-groove" opacity={0.25 + 0.35 * shape.fruit.ridge} />
          <path d={shape.fruit.highlight} className="plant-fruit-highlight" opacity={0.18 + 0.22 * shape.fruit.ridge} />
        </g>
      )}
      {shape.bud && (
        <ellipse
          cx={shape.bud.cx}
          cy={shape.bud.cy}
          rx={shape.bud.rx}
          ry={shape.bud.ry}
          transform={`rotate(${shape.bud.rotate.toFixed(2)} ${shape.bud.cx.toFixed(2)} ${shape.bud.cy.toFixed(2)})`}
          className="plant-bud"
          opacity={shape.bud.opacity}
        />
      )}
      {shape.petals && <path d={shape.petals.d} className="plant-petals" opacity={shape.petals.opacity} />}
      {shape.centre && (
        <g opacity={shape.centre.opacity}>
          <circle cx={shape.centre.cx} cy={shape.centre.cy} r={shape.centre.r} className="plant-flower-centre" />
          <path d={shape.anthers} className="plant-anthers" />
        </g>
      )}
      <path d={shape.calyx} className="plant-calyx" />
    </g>
  );
}, (a, b) => a.k === b.k);

const Stem = memo(function Stem({ stem }: { stem: StemPart; k: string }) {
  const p = stemPaths(stem);
  return (
    <g data-part={stem.id} data-kind={stem.kind}>
      <path d={p.body} className="plant-stem" />
      <path d={p.highlight} className="plant-stem-highlight" strokeWidth={Math.max(0.6, stem.baseWidth * 0.16)} />
      {cutFaces(stem).map((face, i) => (
        <ellipse
          key={i}
          data-testid="plant-cut-face"
          cx={face.center.x}
          cy={face.center.y}
          rx={face.halfWidth}
          ry={face.halfWidth * 0.42}
          transform={`rotate(${face.angle + 90} ${face.center.x} ${face.center.y})`}
          className="plant-cut-face"
        />
      ))}
    </g>
  );
}, (a, b) => a.k === b.k);

interface View {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BASE_VIEW: View = { ...PLANT_VIEWBOX };
const VIEW_STEP = 50;

/** The frame needed to show everything at the original scale: never smaller
 *  than the original viewBox, extended up and sideways in steps. The bottom
 *  (soil) never moves, so falling pieces still leave through it. */
function viewFor(parts: PlantParts): View {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  const take = (p: Point) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
  };
  for (const s of parts.stems) s.points.forEach(take);
  // A leaf reaches at most petiole + blade from its base, and fruit hangs
  // within FRUIT_REACH: only parts whose reach could set a new extreme get
  // their exact (costlier) outline measured.
  const couldExtend = (p: Point, r: number) => p.x - r < minX || p.x + r > maxX || p.y - r < minY;
  for (const l of parts.leaves) {
    if (couldExtend(l.base, l.petioleLength + l.bladeLength)) leafOutlinePoints(l).forEach(take);
  }
  for (const b of parts.buds) {
    if (b.radius > 0.05 && couldExtend(b.base, FRUIT_REACH)) reproOutlinePoints(b).forEach(take);
  }
  const bottom = BASE_VIEW.y + BASE_VIEW.height;
  // Leave room on the left for the ruler and its labels.
  const left = Math.min(BASE_VIEW.x, Math.floor((minX - 120) / VIEW_STEP) * VIEW_STEP);
  const right = Math.max(BASE_VIEW.x + BASE_VIEW.width, Math.ceil((maxX + 30) / VIEW_STEP) * VIEW_STEP);
  const top = Math.min(BASE_VIEW.y, Math.floor((minY - 30) / VIEW_STEP) * VIEW_STEP);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function Ruler({ x, view }: { x: number; view: View }) {
  // Always 0–30 cm (the first split); extends in 30 cm steps as the plant
  // grows taller, labelled every 10 cm with "cm" on each 30 cm mark.
  const roomCm = (START_TOP_Y - (view.y + 20)) / UNITS_PER_CM;
  const maxCm = Math.max(30, Math.floor(roomCm / 30) * 30);
  const ticks = [];
  for (let cm = 0; cm <= maxCm; cm++) {
    const y = START_TOP_Y - cm * UNITS_PER_CM;
    const major = cm % 10 === 0;
    const mid = cm % 5 === 0;
    ticks.push(
      <line
        key={cm}
        x1={x}
        x2={x + (major ? 14 : mid ? 9 : 5)}
        y1={y}
        y2={y}
        className={major ? "plant-ruler-tick plant-ruler-tick-major" : "plant-ruler-tick"}
      />
    );
    if (major) {
      ticks.push(
        <text key={`l${cm}`} x={x - 8} y={y + 4} className="plant-ruler-label" textAnchor="end">
          {cm > 0 && cm % 30 === 0 ? `${cm} cm` : cm}
        </text>
      );
    }
  }
  return (
    <g className="plant-ruler" data-testid="plant-ruler" aria-hidden="true">
      <line x1={x} x2={x} y1={START_TOP_Y} y2={START_TOP_Y - maxCm * UNITS_PER_CM} className="plant-ruler-spine" />
      {ticks}
    </g>
  );
}

function Substrate() {
  return (
    <g className="plant-substrate" aria-hidden="true">
      <rect x={PLANT_VIEWBOX.x + 40} y={GROUND_Y + 66} width={PLANT_VIEWBOX.width - 80} height={34} rx={6} className="plant-slab" />
      <rect x={STEM_BASE_X - 62} y={GROUND_Y} width={124} height={70} rx={5} className="plant-block" />
      <rect x={STEM_BASE_X + 30} y={GROUND_Y} width={32} height={70} rx={5} className="plant-block-shade" />
      <ellipse cx={STEM_BASE_X} cy={GROUND_Y + 2} rx={14} ry={3} className="plant-block-hole" />
    </g>
  );
}

/** Draws a set of plant parts in side-view paint order: back leaves,
 *  stems (with any cut faces), front leaves, then buds/flowers/fruit. */
function PartsView({ parts }: { parts: PlantParts }) {
  const leaves = parts.leaves.map(quantLeaf);
  const leafEl = (leaf: LeafPart) => <Leaf key={leaf.id} leaf={leaf} k={leafKey(leaf)} />;
  return (
    <>
      {leaves.filter((l) => l.layer === "back").map(leafEl)}
      {parts.stems.map((raw) => {
        const stem = quantStem(raw);
        return <Stem key={stem.id} stem={stem} k={stemKey(stem)} />;
      })}
      {leaves.filter((l) => l.layer === "front").map(leafEl)}
      {parts.buds.map((raw) => {
        const bud = quantBud(raw);
        return <Repro key={bud.id} bud={bud} k={budKey(bud)} />;
      })}
    </>
  );
}

function polylinePath(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join("");
}

/** Viewport coordinates → SVG user units; null where the DOM can't tell
 *  (e.g. jsdom), in which case the caller falls back to the segment middle. */
function toSvgPoint(svg: SVGSVGElement | null, clientX: number, clientY: number): Point | null {
  const ctm = svg?.getScreenCTM?.();
  if (!ctm || typeof DOMPoint === "undefined") return null;
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

export interface PlantCanvasProps {
  /** 0…1 initial split, then +1 per "Grow 30 cm" cycle. */
  growth: number;
  splitMode: SplitMode;
  /** Cuts made so far, in order, each with its fallen-piece snapshot. Keep
   *  the array identity stable between cuts. */
  cuts?: CutRecord[];
  /** Fall progress per cut (0…1); a piece at 1 has left the canvas and is
   *  no longer drawn. */
  fallProgress?: number[];
  /** When set, stem segments between leaf nodes can be double-clicked. */
  onCut?: (stemId: string, s: number) => void;
  /** Pixels per SVG unit. When given, the SVG is sized explicitly so a plant
   *  taller or wider than the original frame scrolls at the same scale. */
  fitScale?: number;
  showRuler?: boolean;
  className?: string;
}

const NO_CUTS: CutRecord[] = [];
const NO_PROGRESS: number[] = [];

export const PlantCanvas = memo(function PlantCanvas({
  growth,
  splitMode,
  cuts = NO_CUTS,
  fallProgress = NO_PROGRESS,
  onCut,
  fitScale,
  showRuler = true,
  className,
}: PlantCanvasProps) {
  const model = useMemo(() => buildPlantModel(growth, splitMode, cuts), [growth, splitMode, cuts]);
  const kept = useMemo(() => applyCuts(model, cuts).kept, [model, cuts]);
  const segments = useMemo(() => (onCut ? cuttableSegments(kept) : []), [kept, onCut]);
  const view = useMemo(() => viewFor(kept), [kept]);
  const rulerX = Math.min(RULER_X, view.x + 82);
  const clipId = `plant-frame-${useId().replace(/:/g, "")}`;

  const handleDoubleClick = (event: React.MouseEvent<SVGPathElement>, index: number) => {
    if (!onCut) return;
    event.preventDefault();
    const seg = segments[index];
    const stem = kept.stems.find((st) => st.id === seg.stemId);
    if (!stem) return;
    const p = toSvgPoint(event.currentTarget.ownerSVGElement, event.clientX, event.clientY);
    const s = p ? projectOntoStem(stem, p, seg.sFrom, seg.sTo) : (seg.sFrom + seg.sTo) / 2;
    onCut(seg.stemId, Math.round(s * 10) / 10);
  };

  const size = fitScale ? { width: view.width * fitScale, height: view.height * fitScale } : null;

  return (
    <svg
      className={className ? `plant-canvas ${className}` : "plant-canvas"}
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      preserveAspectRatio="xMidYMid meet"
      style={size ? { width: size.width, height: size.height, flex: "none" } : undefined}
      role="img"
      aria-label={
        growth <= 0
          ? "Pepper plant just before its crown split"
          : `Pepper plant growing a ${splitMode}-way crown split`
      }
      data-growth={growth.toFixed(3)}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={view.x} y={view.y} width={view.width} height={view.height} />
        </clipPath>
        <linearGradient id={`${clipId}-fruit`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#5fa63f" />
          <stop offset="0.55" stopColor="#3f8a2c" />
          <stop offset="1" stopColor="#2b671e" />
        </linearGradient>
      </defs>
      <style>{`#${clipId}-root .plant-fruit-body{fill:url(#${clipId}-fruit)}`}</style>
      <g id={`${clipId}-root`}>
        {showRuler && <Ruler x={rulerX} view={view} />}
        <Substrate />
        <PartsView parts={kept} />
        <g clipPath={`url(#${clipId})`}>
          {cuts.map((cut, i) => {
            const progress = fallProgress[i] ?? 1;
            if (progress >= 1) return null;
            const t = fallTransform(cut.piece, progress);
            return (
              <g
                key={i}
                data-piece={i}
                transform={`translate(${t.dx.toFixed(2)} ${t.dy.toFixed(2)}) rotate(${t.angle.toFixed(3)} ${t.pivot.x.toFixed(2)} ${t.pivot.y.toFixed(2)})`}
              >
                <PartsView parts={cut.piece} />
              </g>
            );
          })}
        </g>
        {onCut &&
          segments.map((seg, i) => (
            <path
              key={`${seg.stemId}:${seg.sFrom.toFixed(1)}`}
              d={polylinePath(seg.points)}
              className="plant-stem-hit"
              data-stem={seg.stemId}
              data-testid="plant-stem-hit"
              onDoubleClick={(e) => handleDoubleClick(e, i)}
            >
              <title>Double-click to cut</title>
            </path>
          ))}
      </g>
    </svg>
  );
});
