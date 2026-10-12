import { describe, expect, it } from "vitest";
import { CardAnchor, CardLayoutOptions, PlacedCard, layoutEmployeeCards } from "./employeeCardLayout";

// A map area whose drawing fills it, less the fit's 40px margin.
const opts: CardLayoutOptions = {
  mapWidth: 1000,
  height: 600,
  drawing: { left: 40, top: 40, right: 960, bottom: 560 },
  gutter: 168,
  cardWidth: 150,
  cardHeight: 54,
  gap: 8,
  padding: 8,
  clearance: 10,
};

const anchor = (key: string, x: number, y: number, order = 0): CardAnchor => ({ key, x, y, order });

// Never overlapping (at least a scaled gap apart), never on the drawing, and
// inside the map area plus its reserved columns.
function expectClean(cards: PlacedCard[], o: CardLayoutOptions = opts) {
  const eps = 1e-6;
  const d = {
    left: Math.max(0, Math.min(o.drawing.left, o.mapWidth)),
    right: Math.max(0, Math.min(o.drawing.right, o.mapWidth)),
    top: Math.max(0, Math.min(o.drawing.top, o.height)),
    bottom: Math.max(0, Math.min(o.drawing.bottom, o.height)),
  };
  for (const c of cards) {
    expect(c.left).toBeGreaterThanOrEqual(-o.gutter - eps);
    expect(c.left + c.width).toBeLessThanOrEqual(o.mapWidth + o.gutter + eps);
    expect(c.top).toBeGreaterThanOrEqual(-eps);
    expect(c.top + c.height).toBeLessThanOrEqual(o.height + eps);
    const onDrawing = c.left < d.right - eps && c.left + c.width > d.left + eps && c.top < d.bottom - eps && c.top + c.height > d.top + eps;
    expect(onDrawing, `${c.key} on the drawing`).toBe(false);
  }
  for (let i = 0; i < cards.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = cards[i];
      const b = cards[j];
      const g = o.gap * a.scale - eps;
      const apart = a.left >= b.left + b.width + g || b.left >= a.left + a.width + g || a.top >= b.top + b.height + g || b.top >= a.top + a.height + g;
      expect(apart, `${a.key} overlaps ${b.key}`).toBe(true);
    }
  }
}

const midY = (c: PlacedCard) => c.top + c.height / 2;
const midX = (c: PlacedCard) => c.left + c.width / 2;

describe("layoutEmployeeCards", () => {
  it("puts a card beside the drawing on its row's side, level with the row", () => {
    const cards = layoutEmployeeCards([anchor("a", 200, 300), anchor("b", 800, 150)], opts);
    const a = cards.find((c) => c.key === "a")!;
    const b = cards.find((c) => c.key === "b")!;
    expect(a).toMatchObject({ side: "left", top: 300 - 27, scale: 1 });
    expect(a.left + a.width).toBe(40 - 10); // hugs the drawing, clear of it
    expect(b).toMatchObject({ side: "right", left: 960 + 10, top: 150 - 27, scale: 1 });
    // Connector leaves from the edge facing the drawing.
    expect([a.edgeX, a.edgeY]).toEqual([30, 300]);
    expect([b.edgeX, b.edgeY]).toEqual([970, 150]);
  });

  it("stacks several people on the same row with clear spacing, centred on the row", () => {
    const anchors = [0, 1, 2, 3].map((i) => anchor(`r5:e${i}`, 300, 300, i));
    const cards = layoutEmployeeCards(anchors, opts);
    expectClean(cards);
    expect(cards.map((c) => c.key)).toEqual(anchors.map((a) => a.key));
    expect(cards.map((c) => c.top)).toEqual([180, 242, 304, 366]);
    expect((midY(cards[0]) + midY(cards[3])) / 2).toBeCloseTo(300);
  });

  it("keeps cards for neighbouring rows apart and in row order", () => {
    const anchors = [anchor("r1", 400, 200, 0), anchor("r2a", 400, 206, 1), anchor("r2b", 400, 206, 2), anchor("r3", 400, 212, 3)];
    const cards = layoutEmployeeCards(anchors, opts);
    expectClean(cards);
    expect(cards.map((c) => c.key)).toEqual(["r1", "r2a", "r2b", "r3"]);
    expect((midY(cards[0]) + midY(cards[3])) / 2).toBeCloseTo(206);
  });

  it("uses the space above and below a short, wide drawing", () => {
    const wide = { ...opts, drawing: { left: 40, top: 200, right: 960, bottom: 400 } };
    const cards = layoutEmployeeCards(
      [anchor("nearTop", 500, 210, 0), anchor("nearTop2", 520, 212, 1), anchor("nearBottom", 300, 395, 2), anchor("nearLeft", 45, 300, 3)],
      wide
    );
    expectClean(cards, wide);
    const by = Object.fromEntries(cards.map((c) => [c.key, c]));
    expect(by.nearTop.side).toBe("top");
    expect(by.nearTop.top + by.nearTop.height).toBe(200 - 10);
    expect([by.nearTop.edgeX, by.nearTop.edgeY]).toEqual([midX(by.nearTop), 190]);
    // Side by side, centred on their rows.
    expect(by.nearTop2.side).toBe("top");
    expect((midX(by.nearTop) + midX(by.nearTop2)) / 2).toBeCloseTo(510);
    expect(by.nearBottom).toMatchObject({ side: "bottom", top: 400 + 10 });
    expect(by.nearLeft.side).toBe("left");
  });

  it("keeps side cards level with the drawing while the space above/below is in use", () => {
    const wide = { ...opts, drawing: { left: 40, top: 200, right: 960, bottom: 400 } };
    const anchors = Array.from({ length: 24 }, (_, i) => anchor(`e${i}`, 60, 300, i));
    const cards = layoutEmployeeCards(anchors, wide);
    for (const c of cards.filter((c) => c.side === "left" || c.side === "right")) {
      expect(c.top).toBeGreaterThanOrEqual(200);
      expect(c.top + c.height).toBeLessThanOrEqual(400);
    }
  });

  it("hugs a narrow drawing from inside the map area, not out in the reserved column", () => {
    const narrow = { ...opts, drawing: { left: 300, top: 40, right: 700, bottom: 560 } };
    const cards = layoutEmployeeCards([anchor("a", 320, 100), anchor("b", 690, 500)], narrow);
    expectClean(cards, narrow);
    expect(cards[0]).toMatchObject({ side: "left", left: 300 - 10 - 150 });
    expect(cards[1]).toMatchObject({ side: "right", left: 700 + 10 });
  });

  it("keeps a group inside the area when its rows are at the very edge", () => {
    const cards = layoutEmployeeCards([0, 1, 2].map((i) => anchor(`e${i}`, 100, 595, i)), opts);
    expectClean(cards);
    expect(cards[2].top + cards[2].height).toBeCloseTo(600 - 8);
  });

  it("moves overflow to the next-nearest region before shrinking anything", () => {
    // 12 people at the left edge; a column holds 9 at 600px.
    const anchors = Array.from({ length: 12 }, (_, i) => anchor(`e${i}`, 50 + i, 300, i));
    const cards = layoutEmployeeCards(anchors, opts);
    expectClean(cards);
    expect(cards.every((c) => c.scale === 1)).toBe(true);
    expect(cards.filter((c) => c.side === "left")).toHaveLength(9);
    // The ones losing least (nearest the other side) went across.
    expect(cards.filter((c) => c.side !== "left").map((c) => c.key).sort()).toEqual(["e10", "e11", "e9"]);
  });

  it("fills the bands above and below before shrinking", () => {
    const wide = { ...opts, drawing: { left: 40, top: 200, right: 960, bottom: 400 } };
    // Full size holds 3 per side (level with the 200px drawing) + 5 above + 5 below.
    const anchors = Array.from({ length: 16 }, (_, i) => anchor(`e${i}`, 60, 300, i));
    const cards = layoutEmployeeCards(anchors, wide);
    expectClean(cards, wide);
    expect(cards.every((c) => c.scale === 1)).toBe(true);
    const count = (side: string) => cards.filter((c) => c.side === side).length;
    expect([count("left"), count("right"), count("top"), count("bottom")]).toEqual([3, 3, 5, 5]);
    // One more and everyone shrinks a little.
    const more = layoutEmployeeCards([...anchors, anchor("e16", 60, 300, 16)], wide);
    expectClean(more, wide);
    expect(more[0].scale).toBeLessThan(1);
  });

  it("shrinks every card equally only when every region is full — still no overlap", () => {
    const anchors = Array.from({ length: 60 }, (_, i) => anchor(`e${i}`, (i % 2) * 900 + 50, 290 + (i % 7), i));
    const cards = layoutEmployeeCards(anchors, opts);
    expect(cards).toHaveLength(60);
    expectClean(cards);
    const scale = cards[0].scale;
    expect(scale).toBeLessThan(1);
    expect(cards.every((c) => c.scale === scale)).toBe(true);
  });

  it("gives the same layout whatever order the anchors arrive in", () => {
    const anchors = [anchor("a", 100, 300, 0), anchor("b", 100, 300, 1), anchor("c", 120, 310, 2), anchor("d", 900, 40, 3)];
    const a = layoutEmployeeCards(anchors, opts);
    const b = layoutEmployeeCards([...anchors].reverse(), opts);
    const byKey = (cards: PlacedCard[]) => Object.fromEntries(cards.map((c) => [c.key, [c.side, c.left, c.top]]));
    expect(byKey(b)).toEqual(byKey(a));
  });

  it("never overlaps or covers the drawing across many random updates, drawings and screen sizes", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 400; run++) {
      const mapWidth = 200 + rand() * 1600;
      const height = 120 + rand() * 1000;
      const l = rand() * mapWidth * 0.4;
      const t = rand() * height * 0.4;
      const o = { ...opts, mapWidth, height, drawing: { left: l, top: t, right: l + (mapWidth - l) * (0.3 + rand() * 0.7), bottom: t + (height - t) * (0.3 + rand() * 0.7) } };
      const rows = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => ({
        x: o.drawing.left + rand() * (o.drawing.right - o.drawing.left),
        y: o.drawing.top + rand() * (o.drawing.bottom - o.drawing.top),
      }));
      const anchors = Array.from({ length: Math.floor(rand() * 40) }, (_, i) => {
        const r = rows[Math.floor(rand() * rows.length)];
        return anchor(`e${i}`, r.x, r.y, i);
      });
      const cards = layoutEmployeeCards(anchors, o);
      expect(cards).toHaveLength(anchors.length);
      expectClean(cards, o);
    }
  });

  it("stacks at full size without overlap before the area has been measured", () => {
    const cards = layoutEmployeeCards([0, 1, 2, 3].map((i) => anchor(`e${i}`, 0, 0, i)), { ...opts, mapWidth: 0, height: 0, drawing: { left: 0, top: 0, right: 0, bottom: 0 } });
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.scale === 1)).toBe(true);
    for (const side of ["left", "right"] as const) {
      const tops = cards.filter((c) => c.side === side).map((c) => c.top).sort((a, b) => a - b);
      for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeGreaterThanOrEqual(62);
    }
  });
});
