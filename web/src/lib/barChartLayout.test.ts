import { describe, expect, it } from "vitest";
import { BarChartLayout, BarInput, BarRow, labelText, layoutBarChart, MAX_BAR_HEIGHT, MAX_FONT, MIN_FONT, MeasureText, sizeRows, textColorOn } from "./barChartLayout";

// Deterministic text width: 0.6 em per character (bold), like a sans font.
const measure: MeasureText = (text, fontPx) => text.length * fontPx * 0.6;

// The chart area on a 1920×1080 TV: full width minus side padding, height
// minus the compact header (~100 px) and chart padding.
const W = 1872;
const H = 950;

const GREEN = "#15803d";
const RED = "#dc2626";

function bars(speeds: number[], name = (i: number) => `Person ${i + 1} L.`): BarInput[] {
  return speeds.map((s, i) => ({ name: name(i), speed: s, speedLabel: `${s} stm/hr` }));
}

function layout(input: BarInput[], target: number | null = 500, width = W, height = H) {
  return layoutBarChart(input, { width, height, target, atTargetColor: GREEN, belowTargetColor: RED, measure });
}

describe("colours against the target", () => {
  it("below = below colour, equal and above = at/above colour", () => {
    const l = layout(bars([800, 500, 499.99]));
    expect(l.rows.map((r) => r.color)).toEqual([GREEN, GREEN, RED]);
    expect(l.rows.map((r) => r.meetsTarget)).toEqual([true, true, false]);
  });

  it("with no target every bar uses the at/above colour", () => {
    expect(layout(bars([800, 100]), null).rows.every((r) => r.color === GREEN)).toBe(true);
  });

  it("inside-bar text contrasts with the bar colour", () => {
    expect(textColorOn("#15803d")).toBe("#ffffff");
    expect(textColorOn("#dc2626")).toBe("#ffffff");
    expect(textColorOn("#fde047")).toBe("#111827"); // light yellow -> dark text
  });
});

describe("bars", () => {
  it("share one scale from the same left edge, proportional to speed (never stretched)", () => {
    const l = layout(bars([800, 400, 50]));
    expect(l.rows[0].barWidth).toBeCloseTo(W);
    expect(l.rows[1].barWidth).toBeCloseTo(W / 2);
    expect(l.rows[2].barWidth).toBeCloseTo(W / 16);
    expect(l.rows[1].barWidth / l.rows[2].barWidth).toBeCloseTo(8);
  });

  it("keep the target on screen when it is above everyone", () => {
    const l = layout(bars([300, 200]), 1200);
    expect(l.targetX).toBeCloseTo(W);
    expect(l.rows[0].barWidth).toBeCloseTo(W / 4);
  });
});

// Every placement: text never overlaps itself or the wrong side of the bar,
// never clips, and an outside label starts right after its bar.
function expectClean(r: BarRow, l: BarChartLayout, width: number) {
  const p = l.padding;
  const end = (b: { left: number; width: number }) => b.left + b.width;
  const eps = 0.001;
  if (r.labelMode === "split") {
    expect(r.nameBox.left).toBe(p);
    expect(end(r.nameBox) + 2 * p).toBeLessThanOrEqual(r.speedBox.left + eps); // two paddings between them
    expect(end(r.speedBox)).toBeCloseTo(r.barWidth - p); // speed at the bar's right end
  } else if (r.labelMode === "name-inside") {
    expect(r.nameBox.left).toBe(p);
    expect(end(r.nameBox)).toBeLessThanOrEqual(r.barWidth - p + eps);
    expect(r.speedBox.left).toBeCloseTo(r.barWidth + p); // immediately after the bar
    expect(end(r.speedBox)).toBeLessThanOrEqual(width - p + eps);
  } else {
    expect(r.nameBox.left).toBeCloseTo(r.barWidth + p); // immediately after the bar
    expect(end(r.nameBox)).toBeLessThanOrEqual(width - p + eps);
    expect(end(r.speedBox)).toBeCloseTo(end(r.nameBox)); // speed ends the one label
  }
}

describe("labels: placement", () => {
  it("both fit: name at the bar's left, speed at its right end, with padding", () => {
    const l = layout(bars([800]));
    const r = l.rows[0];
    expect(r.labelMode).toBe("split");
    expectClean(r, l, W);
    expect(r.speedLabel).toBe("800 stm/hr");
  });

  it("name fits but not both: name inside, speed immediately past the bar's end", () => {
    // 2 rows -> 32px text, 16px padding. "Person 2 L." = 211px, "150 stm/hr" = 192px;
    // a 351px bar holds the name (319px inside) but not name + gap + speed (435px).
    const l = layout(bars([800, 150]));
    const r = l.rows[1];
    expect(r.labelMode).toBe("name-inside");
    expect(r.name).toBe("Person 2 L.");
    expectClean(r, l, W);
    expect(r.speedBox.left + r.speedBox.width).toBeLessThan(W / 3); // not at the chart's right edge
  });

  it("name doesn't fit: 'Name · speed' immediately past the bar", () => {
    const l = layout(bars([800, 20]));
    const r = l.rows[1];
    expect(r.labelMode).toBe("outside");
    expectClean(r, l, W);
    expect(r.nameBox.width).toBeCloseTo(measure(labelText("Person 2 L.", "20 stm/hr"), l.fontSize, true));
    expect(r.nameBox.left + r.nameBox.width).toBeLessThan(W / 2); // never pushed to the right edge
  });

  it("a long name on a medium bar goes outside in full", () => {
    const name = "Maximiliano Alejandro de la Cruz H.";
    const l = layout([...bars([800]), { name, speed: 260, speedLabel: "260 stm/hr" }]);
    const r = l.rows[1];
    expect(r.labelMode).toBe("outside");
    expect(r.name).toBe(name);
    expectClean(r, l, W);
  });

  it("the full-width top bar never loses its speed: with no room past it, only the name is shortened", () => {
    const longName = "Maximiliano Alejandro de la Cruz Hernández-Villanueva Zapata Q.";
    const l = layout([{ name: longName, speed: 800, speedLabel: "800 stm/hr" }, ...bars([400])], 500, 1000, 400);
    const r = l.rows[0];
    expect(r.labelMode).toBe("split");
    expect(r.name.endsWith("…")).toBe(true);
    expect(r.speedLabel).toBe("800 stm/hr");
    expectClean(r, l, 1000);
  });

  it.each([
    [1920 - 48, 950],
    [1280 - 48, 590],
  ])("long names and short bars at %ix%i: proportional bars, every label clean, speed always whole", (width, height) => {
    const longName = "Maximiliano Alejandro de la Cruz Hernández-Villanueva Z.";
    for (const n of [3, 12, 40]) {
      for (const speed of [5, 15, 60, 120, 260, 360, 640, 790]) {
        const input = [...bars([800]), { name: longName, speed, speedLabel: `${speed} stm/hr` }, ...bars(Array.from({ length: n - 2 }, (_, i) => 700 - i * 15))];
        const l = layout(input, 500, width, height);
        const r = l.rows[1];
        expect(r.barWidth).toBeCloseTo((speed / 800) * width);
        expect(r.speedLabel).toBe(`${speed} stm/hr`);
        for (const row of l.rows) expectClean(row, l, width);
      }
    }
  });

  it.each([
    [1920 - 48, 950],
    [1280 - 48, 590],
  ])("60 employees with long names at %ix%i: everyone on one page, labels clean", (width, height) => {
    const speeds = Array.from({ length: 60 }, (_, i) => 1400 - i * 23);
    const input = bars(speeds, (i) => (i % 3 === 0 ? `Employee With A Very Long Name ${i} Hernández-Villanueva` : `P${i}`));
    const l = layout(input, 500, width, height);
    for (const r of l.rows) expectClean(r, l, width);
    const last = l.rows[l.rows.length - 1];
    expect(last.top + l.barHeight).toBeLessThanOrEqual(height + 0.5);
    expect(l.fontSize).toBeLessThanOrEqual(l.barHeight + l.gap);
    // All three placements occur in a real spread of speeds.
    expect(new Set(l.rows.map((r) => r.labelMode))).toEqual(new Set(["split", "name-inside", "outside"]));
  });
});

describe("text size", () => {
  it("is 20% smaller than before (was 40px max, 10px floor)", () => {
    expect(MAX_FONT).toBe(32);
    expect(MIN_FONT).toBe(8);
    expect(sizeRows(1, H).fontSize).toBeCloseTo(32);
    expect(sizeRows(5, H).fontSize).toBeCloseTo(0.8 * Math.min(40, 96 * 0.62));
    expect(sizeRows(60, H).fontSize).toBeCloseTo(8);
  });
});

describe("responsive sizing at 1920×1080", () => {
  for (const n of [1, 5, 20, 40, 60]) {
    it(`fits all ${n} employee(s) in the chart height with no clipping`, () => {
      const speeds = Array.from({ length: n }, (_, i) => 900 - i * 10);
      const l = layout(bars(speeds));
      expect(l.rows).toHaveLength(n);
      const last = l.rows[n - 1];
      expect(last.top + l.barHeight).toBeLessThanOrEqual(H + 0.001);
      expect(l.fontSize).toBeGreaterThanOrEqual(MIN_FONT);
      expect(l.fontSize).toBeLessThanOrEqual(l.barHeight + l.gap); // text never taller than its row
    });
  }

  it("thick bars and large labels for few employees, thinner as more qualify", () => {
    const sizes = [1, 5, 20, 40, 60].map((n) => sizeRows(n, H));
    expect(sizes[0].barHeight).toBe(MAX_BAR_HEIGHT);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i].barHeight).toBeLessThanOrEqual(sizes[i - 1].barHeight);
      expect(sizes[i].fontSize).toBeLessThanOrEqual(sizes[i - 1].fontSize);
    }
    expect(sizes[4].barHeight).toBeLessThan(sizes[1].barHeight / 3);
  });

  it("on a small window, shrinks text rather than let it overlap the next row", () => {
    const { barHeight, gap, fontSize } = sizeRows(60, 530); // 60 people in a 1280×720 window's chart
    expect(fontSize).toBeLessThanOrEqual((barHeight + gap) * 0.75 + 1e-9);
  });

  it("re-fits on resize (1280×720 window)", () => {
    const speeds = Array.from({ length: 40 }, (_, i) => 900 - i * 10);
    const small = layout(bars(speeds), 500, 1232, 600);
    expect(small.rows[39].top + small.barHeight).toBeLessThanOrEqual(600 + 0.001);
    expect(small.rows[0].barWidth).toBeCloseTo(1232);
  });
});
