// Pure layout for the TV ranking bar chart (TvRankingSlide). Given the
// chart's measured size and a text-measuring function, decides each row's
// position and thickness, the font size, each bar's width (proportional to
// speed on one shared scale — never stretched to fit text) and where its
// labels go. Kept free of the DOM so it can be tested exactly.

export interface BarInput {
  name: string;
  speed: number;
  speedLabel: string; // e.g. "812 stems/hour"
}

export type MeasureText = (text: string, fontPx: number, bold: boolean) => number;

export interface BarRow {
  top: number;
  barWidth: number;
  color: string;
  meetsTarget: boolean;
  // "inside": name at the bar's left, speed at its right, both inside.
  // "outside": the bar is too short for both; name just right of the bar,
  // speed right-aligned at the chart's right edge.
  labelMode: "inside" | "outside";
  name: string; // possibly shortened with "…" if even the open space is too narrow
  nameLeft: number;
  speedRight: number; // distance of the speed label's right edge from the chart's left
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
// no clipping.
export const MAX_BAR_HEIGHT = 96;
export const MAX_FONT = 40;
export const MIN_FONT = 10;
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
  const fontSize = Math.min(Math.max(MIN_FONT, Math.min(MAX_FONT, barHeight * 0.62, pitch * 0.62)), pitch * 0.75);
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

// Longest prefix of `text` (plus "…") that fits in maxWidth.
function shorten(text: string, maxWidth: number, fontPx: number, measure: MeasureText): string {
  if (measure(text, fontPx, true) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}…`, fontPx, true) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "…";
}

export function layoutBarChart(bars: BarInput[], opts: LayoutOptions): BarChartLayout {
  const { width, height, target, measure } = opts;
  const { barHeight, gap, fontSize } = sizeRows(bars.length, height);
  const padding = Math.max(4, Math.round(fontSize * 0.5));
  const maxSpeed = Math.max(...bars.map((b) => b.speed), target ?? 0, 0);
  // One shared scale for every bar; the target line stays on screen.
  const scale = maxSpeed > 0 ? maxSpeed : 1;
  const targetX = target != null && target > 0 ? (target / scale) * width : null;

  const rows: BarRow[] = bars.map((bar, i) => {
    const barWidth = Math.max(0, (bar.speed / scale) * width);
    const meetsTarget = target == null || bar.speed >= target;
    const color = meetsTarget ? opts.atTargetColor : opts.belowTargetColor;
    const nameWidth = measure(bar.name, fontSize, true);
    const speedWidth = measure(bar.speedLabel, fontSize, true);

    // Room for the name in each placement, keeping clear space before the
    // speed label. Inside: name at the bar's left, speed at its right.
    // Outside: name just after the bar, speed right-aligned at the chart edge.
    const insideRoom = barWidth - padding - padding * 2 - speedWidth - padding;
    const outsideRoom = width - padding - speedWidth - padding * 2 - (barWidth + padding);
    const mode: "inside" | "outside" =
      nameWidth <= insideRoom ? "inside" : nameWidth <= outsideRoom ? "outside" : insideRoom >= outsideRoom ? "inside" : "outside";
    const room = mode === "inside" ? insideRoom : outsideRoom;
    return {
      top: i * (barHeight + gap),
      barWidth,
      color,
      meetsTarget,
      labelMode: mode,
      // Shortened with "…" only when neither placement can hold the full name.
      name: nameWidth <= room ? bar.name : shorten(bar.name, Math.max(0, room), fontSize, measure),
      nameLeft: mode === "inside" ? padding : barWidth + padding,
      speedRight: mode === "inside" ? barWidth - padding : width - padding,
      insideTextColor: textColorOn(color),
    };
  });

  return { barHeight, gap, fontSize, padding, targetX, rows };
}
