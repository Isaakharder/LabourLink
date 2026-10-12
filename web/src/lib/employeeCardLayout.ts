// Layout for the live map's employee cards. Cards sit in the free space
// around the greenhouse drawing — left, right, above or below it, wherever
// there is room — never on the drawing itself, and each card is joined to
// its row by a connector line. This module only decides where each card
// goes; it knows nothing about React or the DOM, so it can be tested
// directly. All coordinates are px in the map area (0,0 = its top-left).
//
// Regions:
// - left / right: the strips beside the drawing, full height. They always
//   exist: the map area has a reserved column (`gutter`) outside each side,
//   so these strips have room for a card even when the drawing fills the
//   map area's whole width. Where the space above (or below) the drawing is
//   in use, these strips stop level with the drawing's edge instead, so a
//   side card's connector never runs behind a card above or below.
// - top / bottom: the strips above / below the drawing (as wide as the
//   drawing), used only when the map leaves room there for a card.
//
// Rules:
// - A card goes to the region nearest its row (shortest connector), placed
//   as level with its row as possible.
// - Cards that would collide (several people on one row, or on neighbouring
//   rows) are lined up in one group with a fixed gap between cards, centred
//   on the rows it serves. Cards never overlap, never leave their region and
//   never touch the drawing.
// - When a region is full, the cards that lose least by moving go to the
//   next-nearest region with room. Only if every region is full does every
//   card shrink, by the same amount, until they all fit.
// - The same input always gives the same layout (ties are broken by the
//   caller's `order`), so live updates don't shuffle cards around.

export type CardSide = "left" | "right" | "top" | "bottom";

export interface CardAnchor {
  key: string;
  // The row's point in the map area.
  x: number;
  y: number;
  // Stable tie-break: lower first.
  order: number;
}

export interface CardLayoutOptions {
  mapWidth: number;
  height: number;
  // The drawing's bounding box in the map area (clamped to it here).
  drawing: { left: number; top: number; right: number; bottom: number };
  // Reserved column outside each side of the map area that left/right cards
  // may use (x from -gutter to 0, and from mapWidth to mapWidth + gutter).
  gutter: number;
  cardWidth: number; // full size
  cardHeight: number; // full size
  gap: number; // full-size space between cards in a group
  padding: number; // space kept clear at the edges of the area
  clearance: number; // space kept clear between a card and the drawing
}

export interface PlacedCard {
  key: string;
  side: CardSide;
  left: number;
  top: number;
  width: number; // cardWidth * scale
  height: number; // cardHeight * scale
  scale: number; // 1 = full size; the same for every card
  // Where the connector leaves the card: the middle of the edge facing the
  // drawing.
  edgeX: number;
  edgeY: number;
}

const SIDES: CardSide[] = ["left", "right", "top", "bottom"];
const MIN_SCALE = 0.05;

interface Region {
  side: CardSide;
  capacity: number;
  // Distance from an anchor to this region (how far the connector must go).
  cost: (a: CardAnchor) => number;
}

function regionsAt(scale: number, o: CardLayoutOptions) {
  const w = o.cardWidth * scale;
  const h = o.cardHeight * scale;
  const gap = o.gap * scale;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const d = {
    left: clamp(o.drawing.left, 0, o.mapWidth),
    right: clamp(o.drawing.right, 0, o.mapWidth),
    top: clamp(o.drawing.top, 0, o.height),
    bottom: clamp(o.drawing.bottom, 0, o.height),
  };
  const fits = (length: number, size: number) => Math.floor((length + gap) / (size + gap));
  const bandLength = Math.max(0, d.right - d.left - o.padding * 2);
  const bandCap = fits(bandLength, w);
  const topCap = d.top - o.clearance - o.padding >= h ? bandCap : 0;
  const bottomCap = o.height - o.padding - (d.bottom + o.clearance) >= h ? bandCap : 0;
  const column = {
    top: topCap > 0 ? d.top : o.padding,
    bottom: bottomCap > 0 ? d.bottom : o.height - o.padding,
  };
  const columnCap = Math.max(1, fits(column.bottom - column.top, h));
  const regions: Region[] = [
    { side: "left", capacity: columnCap, cost: (a) => Math.max(0, a.x - d.left) },
    { side: "right", capacity: columnCap, cost: (a) => Math.max(0, d.right - a.x) },
    { side: "top", capacity: topCap, cost: (a) => Math.max(0, a.y - d.top) },
    { side: "bottom", capacity: bottomCap, cost: (a) => Math.max(0, d.bottom - a.y) },
  ];
  return { regions, d, column, w, h, gap };
}

// Nearest region for every card, then move cards out of over-full regions
// (cheapest move first) into regions with room. Returns null if they can't
// all fit at this size.
function assign(anchors: CardAnchor[], regions: Region[]): Map<string, CardSide> | null {
  const usable = regions.filter((r) => r.capacity > 0);
  const regionOf = new Map<string, Region>();
  const count = new Map<CardSide, number>(SIDES.map((s) => [s, 0]));
  for (const a of anchors) {
    let best = usable[0];
    for (const r of usable) if (r.cost(a) < best.cost(a)) best = r;
    regionOf.set(a.key, best);
    count.set(best.side, count.get(best.side)! + 1);
  }
  for (;;) {
    const over = usable.find((r) => count.get(r.side)! > r.capacity);
    if (!over) break;
    let move: { a: CardAnchor; to: Region; delta: number } | null = null;
    for (const a of anchors) {
      if (regionOf.get(a.key) !== over) continue;
      for (const to of usable) {
        if (to === over || count.get(to.side)! >= to.capacity) continue;
        const delta = to.cost(a) - over.cost(a);
        if (!move || delta < move.delta || (delta === move.delta && a.order < move.a.order)) move = { a, to, delta };
      }
    }
    if (!move) return null;
    regionOf.set(move.a.key, move.to);
    count.set(over.side, count.get(over.side)! - 1);
    count.set(move.to.side, count.get(move.to.side)! + 1);
  }
  return new Map([...regionOf].map(([k, r]) => [k, r.side]));
}

export function layoutEmployeeCards(anchors: CardAnchor[], opts: CardLayoutOptions): PlacedCard[] {
  if (anchors.length === 0) return [];
  // Largest size at which everyone fits (full size whenever possible).
  let scale = 1;
  let sides = assign(anchors, regionsAt(scale, opts).regions);
  while (!sides && scale > MIN_SCALE) {
    scale *= 0.92;
    sides = assign(anchors, regionsAt(scale, opts).regions);
  }
  if (!sides && (opts.height <= 0 || opts.mapWidth <= 0)) scale = 1; // not measured yet
  const { regions, d, column, w, h, gap } = regionsAt(scale, opts);
  if (!sides) {
    // No room even at the smallest size (or not measured yet): nearest side
    // column, still stacked so nothing overlaps.
    const [left, right] = regions;
    sides = new Map(anchors.map((a) => [a.key, right.cost(a) < left.cost(a) ? "right" : "left"]));
  }

  const placed: PlacedCard[] = [];
  for (const side of SIDES) {
    const group = anchors.filter((a) => sides!.get(a.key) === side);
    if (group.length === 0) continue;
    const vertical = side === "left" || side === "right";
    const starts = vertical
      ? place1D(group, (a) => a.y, h, gap, column.top, column.bottom)
      : place1D(group, (a) => a.x, w, gap, d.left + opts.padding, d.right - opts.padding);
    // Hug the drawing (short connectors), but stay inside the reserved column.
    const leftX = Math.max(-opts.gutter + opts.padding, d.left - opts.clearance - w);
    const rightX = Math.min(opts.mapWidth + opts.gutter - opts.padding - w, d.right + opts.clearance);
    for (const a of group) {
      const start = starts.get(a.key)!;
      const left = side === "left" ? leftX : side === "right" ? rightX : start;
      const top = vertical ? start : side === "top" ? d.top - opts.clearance - h : d.bottom + opts.clearance;
      placed.push({
        key: a.key,
        side,
        left,
        top,
        width: w,
        height: h,
        scale,
        edgeX: side === "left" ? left + w : side === "right" ? left : left + w / 2,
        edgeY: side === "top" ? top + h : side === "bottom" ? top : top + h / 2,
      });
    }
  }
  return placed;
}

// Lines cards up along one axis: each as near its row as possible, groups of
// colliding cards centred on their rows, all within [min, max] (the start
// edge wins if a group can't fit at all). Returns each card's start.
function place1D(
  anchors: CardAnchor[],
  pos: (a: CardAnchor) => number,
  size: number,
  gap: number,
  min: number,
  max: number
): Map<string, number> {
  const length = (n: number) => n * size + (n - 1) * gap;
  const clampStart = (start: number, n: number) => Math.max(min, Math.min(start, max - length(n)));
  const sorted = [...anchors].sort((a, b) => pos(a) - pos(b) || a.order - b.order);
  const groups: { items: CardAnchor[]; start: number }[] = [];
  for (const a of sorted) {
    groups.push({ items: [a], start: clampStart(pos(a) - size / 2, 1) });
    // Merge with the previous group while they collide; a merged group is
    // centred on the average position of the rows it serves.
    while (groups.length > 1) {
      const last = groups[groups.length - 1];
      const prev = groups[groups.length - 2];
      if (prev.start + length(prev.items.length) + gap <= last.start + 1e-6) break;
      const items = [...prev.items, ...last.items];
      const centre = items.reduce((sum, i) => sum + pos(i), 0) / items.length;
      groups.splice(groups.length - 2, 2, { items, start: clampStart(centre - length(items.length) / 2, items.length) });
    }
  }
  const starts = new Map<string, number>();
  for (const g of groups) g.items.forEach((a, i) => starts.set(a.key, g.start + i * (size + gap)));
  return starts;
}
