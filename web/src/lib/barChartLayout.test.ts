import { describe, expect, it } from "vitest";
import { BarInput, layoutBarChart, MAX_BAR_HEIGHT, MIN_FONT, MeasureText, sizeRows, textColorOn } from "./barChartLayout";

// Deterministic text width: 0.6 em per character (bold), like a sans font.
const measure: MeasureText = (text, fontPx) => text.length * fontPx * 0.6;

// The chart area on a 1920×1080 TV: full width minus side padding, height
// minus the compact header (~100 px) and chart padding.
const W = 1872;
const H = 950;

const GREEN = "#15803d";
const RED = "#dc2626";

function bars(speeds: number[], name = (i: number) => `Person ${i + 1} L.`): BarInput[] {
  return speeds.map((s, i) => ({ name: name(i), speed: s, speedLabel: `${s} stems/hour` }));
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

describe("labels", () => {
  it("go inside a long bar: name at the left, speed at the right", () => {
    const r = layout(bars([800])).rows[0];
    expect(r.labelMode).toBe("inside");
    expect(r.nameLeft).toBeLessThan(r.speedRight);
    expect(r.speedRight).toBeLessThanOrEqual(r.barWidth);
  });

  it("move outside a very short bar: name after the bar, speed right-aligned at the edge, no overlap", () => {
    const l = layout(bars([800, 20]));
    const short = l.rows[1];
    expect(short.labelMode).toBe("outside");
    expect(short.nameLeft).toBeGreaterThanOrEqual(short.barWidth);
    expect(short.speedRight).toBeCloseTo(W - l.padding);
    const nameEnd = short.nameLeft + measure(short.name, l.fontSize, true);
    const speedStart = short.speedRight - measure("20 stems/hour", l.fontSize, true);
    expect(nameEnd).toBeLessThan(speedStart);
  });

  it("move a long name outside rather than overlap the speed, and never shorten the bar", () => {
    const longName = "Maximiliano Alejandro de la Cruz Hernández-Villanueva Z.";
    const l = layout([{ name: longName, speed: 360, speedLabel: "360 stems/hour" }, ...bars([800])]);
    const r = l.rows[0];
    expect(r.barWidth).toBeCloseTo((360 / 800) * W);
    // whichever mode was chosen, the two labels never overlap
    const nameEnd = r.nameLeft + measure(r.name, l.fontSize, true);
    const speedStart = r.speedRight - measure("360 stems/hour", l.fontSize, true);
    expect(nameEnd).toBeLessThanOrEqual(speedStart);
  });

  it("only shortens a name with … when even the open space can't hold it", () => {
    const huge = "N".repeat(200);
    const l = layout([{ name: huge, speed: 790, speedLabel: "790 stems/hour" }, ...bars([800])], 500, 1000, 400);
    const r = l.rows[0];
    expect(r.name.endsWith("…")).toBe(true);
    const nameEnd = r.nameLeft + measure(r.name, l.fontSize, true);
    expect(nameEnd).toBeLessThanOrEqual(r.speedRight - measure("790 stems/hour", l.fontSize, true));
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
