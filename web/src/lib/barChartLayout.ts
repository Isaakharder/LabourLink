// Pure layout for the TV ranking bar chart (TvRankingSlide). Given the
// chart's measured size and a text-measuring function, decides each row's
// position and thickness, the font size, each bar's width (proportional to
// speed on one shared scale — never stretched to fit text) and where its
// labels go. Kept free of the DOM so it can be tested exactly.

export interface BarInput {
  name: string;
  speed: number;
  speedLabel: string; // e.g. "1389 stm/hr"
}

export type MeasureText = (text: string, fontPx: number, bold: boolean) => number;

// Separator when name and speed share one label outside a short bar:
// "Name · 350 stm/hr".
export const LABEL_SEPARATOR = " · ";

// Where a bar's name and speed go, best first:
//   "split":       both inside — name at the bar's left, speed at its right end.
//   "name-inside": the name fits inside but not both; the speed sits just
//                  past the bar's right end.
//   "outside":     the name doesn't fit inside; "Name · speed" starts just
//                  past the bar's end.
// An outside speed always follows its bar — never the chart's right edge.
export type LabelMode = "split" | "name-inside" | "outside";

export interface LabelBox {
  left: number; // from the chart's left
  width: number; // measured text width
}

export interface BarRow {
  top: number;
  barWidth: number;
  color: string;
  meetsTarget: boolean;
  labelMode: LabelMode;
  name: string; // shortened with "…" only if no placement can hold the full name
  speedLabel: string; // always shown in full
  // Where the text sits. In "outside" mode the name box is the whole
  // "Name · speed" label and speedBox is its speed part.
  nameBox: LabelBox;
  speedBox: LabelBox;
  insideTextColor: string;
}

export interface BarChartLayout {
  barHeight: number;
  gap: number;
  fontSize: number;
  padding: number;
  targetX: number | null;
  rows: BarRow[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  target: number | null;
  atTargetColor: string;
  belowTargetColor: string;
  measure: MeasureText;
}

// Bars are at most this thick (few employees) and the font tracks the bar,
// within readable limits. Dense charts (60 people at 1080p) still fit with
// no clipping. Labels are TEXT_SCALE of the original sizing (20% smaller),
// leaving more of each bar for name and speed side by side.
export const MAX_BAR_HEIGHT = 96;
export const TEXT_SCALE = 0.8;
const BASE_MAX_FONT = 40;
const BASE_MIN_FONT = 10;
export const MAX_FONT = BASE_MAX_FONT * TEXT_SCALE;
export const MIN_FONT = BASE_MIN_FONT * TEXT_SCALE;
// Productive TV-style: bars nearly touching, separated by a thin gap.
const MAX_GAP = 8;

export function sizeRows(count: number, height: number): { barHeight: number; gap: number; fontSize: number } {
  if (count <= 0 || height <= 0) return { barHeight: 0, gap: 0, fontSize: MIN_FONT };
  const pitch = height / count; // vertical space per employee
  const barHeight = Math.min(MAX_BAR_HEIGHT, pitch * 0.88);
  const gap = Math.min(MAX_GAP, pitch - barHeight);
  // MIN_FONT keeps dense 1080p charts legible, but text may never be taller
  // than its own row: on a small window (60 people at 1280×720) the font
  // shrinks below MIN_FONT rather than overlap the next row.
  const fontSize =
    TEXT_SCALE * Math.min(Math.max(BASE_MIN_FONT, Math.min(BASE_MAX_FONT, barHeight * 0.62, pitch * 0.62)), pitch * 0.75);
  return { barHeight, gap, fontSize };
}

// Relative luminance (WCAG) of #rrggbb.
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

// The bar's gradient: the chosen colour at the left, fading to a lighter
// tint of it at the right (Productive TV style).
export function lighten(hex: string, amount = 0.28): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// White or near-black, whichever contrasts more with the bar colour.
export function textColorOn(hex: string): string {
  const L = luminance(/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#000000");
  const contrastWhite = 1.05 / (L + 0.05);
  const contrastDark = (L + 0.05) / 0.06; // vs #111827-ish
  return contrastWhite >= contrastDark ? "#ffffff" : "#111827";
}

export function labelText(name: string, speedLabel: string): string {
  return `${name}${LABEL_SEPARATOR}${speedLabel}`;
}

// Longest prefix of `name` (plus "…") for which fits(candidate) holds.
function shortenName(name: string, fits: (candidate: string) => boolean): string {
  let lo = 0;
  let hi = name.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(`${name.slice(0, mid)}…`)) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${name.slice(0, lo)}…` : "…";
}

interface Placement {
  mode: LabelMode;
  name: string;
}

export function layoutBarChart(bars: BarInput[], opts: LayoutOptions): BarChartLayout {
  const { width, height, target, measure } = opts;
  const { barHeight, gap, fontSize } = sizeRows(bars.length, height);
  const padding = Math.max(4, Math.round(fontSize * 0.5));
  const maxSpeed = Math.max(...bars.map((b) => b.speed), target ?? 0, 0);
  // One shared scale for every bar; the target line stays on screen.
  const scale = maxSpeed > 0 ? maxSpeed : 1;
  const targetX = target != null && target > 0 ? (target / scale) * width : null;
  const w = (text: string) => measure(text, fontSize, true);

  const rows: BarRow[] = bars.map((bar, i) => {
    const barWidth = Math.max(0, (bar.speed / scale) * width);
    const meetsTarget = target == null || bar.speed >= target;
    const color = meetsTarget ? opts.atTargetColor : opts.belowTargetColor;
    const speedW = w(bar.speedLabel);
    // Inside: padding at both bar ends, and at least two paddings between
    // name and speed so they never read as one run of text. Outside: starts one padding past the bar's end and
    // keeps one padding clear of the chart's right edge.
    const insideRoom = barWidth - padding * 2;
    const outsideLeft = barWidth + padding;
    const outsideRoom = width - padding - outsideLeft;

    const fitsSplit = (n: string) => w(n) + padding * 2 + speedW <= insideRoom;
    const fitsNameInside = (n: string) => w(n) <= insideRoom && speedW <= outsideRoom;
    const fitsOutside = (n: string) => w(labelText(n, bar.speedLabel)) <= outsideRoom;

    let placement: Placement;
    if (fitsSplit(bar.name)) placement = { mode: "split", name: bar.name };
    else if (fitsNameInside(bar.name)) placement = { mode: "name-inside", name: bar.name };
    else if (fitsOutside(bar.name)) placement = { mode: "outside", name: bar.name };
    else {
      // Nothing holds the full name (a very long name, or a bar so close to
      // full width that there's no room past it): shorten only the name, in
      // whichever placement keeps the most of it. The speed is never cut.
      const candidates: Placement[] = [];
      if (fitsSplit("…")) candidates.push({ mode: "split", name: shortenName(bar.name, fitsSplit) });
      if (fitsNameInside("…")) candidates.push({ mode: "name-inside", name: shortenName(bar.name, fitsNameInside) });
      if (fitsOutside("…")) candidates.push({ mode: "outside", name: shortenName(bar.name, fitsOutside) });
      placement = candidates.reduce<Placement | null>((best, c) => (!best || c.name.length > best.name.length ? c : best), null) ?? {
        mode: insideRoom >= outsideRoom ? "split" : "outside",
        name: "…",
      };
    }

    const { mode, name } = placement;
    const nameW = mode === "outside" ? w(labelText(name, bar.speedLabel)) : w(name);
    const nameBox = { left: mode === "outside" ? outsideLeft : padding, width: nameW };
    const speedBox =
      mode === "split"
        ? { left: barWidth - padding - speedW, width: speedW }
        : mode === "name-inside"
          ? { left: outsideLeft, width: speedW }
          : { left: outsideLeft + nameW - speedW, width: speedW };

    return {
      top: i * (barHeight + gap),
      barWidth,
      color,
      meetsTarget,
      labelMode: mode,
      name,
      speedLabel: bar.speedLabel,
      nameBox,
      speedBox,
      insideTextColor: textColorOn(color),
    };
  });

  return { barHeight, gap, fontSize, padding, targetX, rows };
}
