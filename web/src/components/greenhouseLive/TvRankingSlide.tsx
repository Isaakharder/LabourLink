import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { BarInput, layoutBarChart, lighten, MeasureText } from "../../lib/barChartLayout";
import { SlideItem } from "../../lib/displaySlideshow";

interface TvRankingSlideProps {
  item: Extract<SlideItem, { kind: "activity" }>;
}

// Text measured with the page's real font through a canvas; a character-
// width estimate stands in where canvas isn't available (tests).
function createMeasure(fontFamily: string): MeasureText {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  return (text, fontPx, bold) => {
    if (ctx) {
      ctx.font = `${bold ? 700 : 400} ${fontPx}px ${fontFamily}`;
      return ctx.measureText(text).width;
    }
    return text.length * fontPx * (bold ? 0.62 : 0.56);
  };
}

// One activity's employee speed ranking on the break-room TV, as a bar
// chart: every eligible employee on one screen, fastest first, bars on one
// shared scale from the same left edge, sized to fit however many qualify.
// Speeds come straight from the server's canonical calculation — this only
// lays them out; it never fills in a missing speed or stretches a bar.
export function TvRankingSlide({ item }: TvRankingSlideProps) {
  const { slide } = item;
  const chartRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fontFamily, setFontFamily] = useState("sans-serif");

  useLayoutEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    setFontFamily(getComputedStyle(el).fontFamily || "sans-serif");
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [slide.status]);

  const measure = useMemo(() => createMeasure(fontFamily), [fontFamily]);
  const unit = slide.speedUnit ?? "";

  const bars: BarInput[] = useMemo(
    () =>
      slide.employees.map((e) => ({
        name: e.displayName || `${e.firstName} ${e.lastInitial}`.trim(),
        speed: e.speed,
        speedLabel: unit ? `${Math.round(e.speed)} ${unit}` : String(Math.round(e.speed)),
      })),
    [slide.employees, unit]
  );

  const layout = useMemo(
    () =>
      layoutBarChart(bars, {
        width: size.width,
        height: size.height,
        target: slide.target,
        atTargetColor: slide.atTargetColor,
        belowTargetColor: slide.belowTargetColor,
        measure,
      }),
    [bars, size, slide.target, slide.atTargetColor, slide.belowTargetColor, measure]
  );

  if (slide.status !== "ok") {
    return (
      <div className={`tv-ranking tv-ranking-notice-only ${slide.status === "unavailable" ? "tv-ranking-unavailable" : ""}`}>
        <p className="tv-ranking-notice-title">
          {slide.status === "unavailable"
            ? "Unavailable"
            : slide.reason === "no_density"
              ? "No speed ranking"
              : slide.reason === "below_minimum"
                ? "No one listed yet"
                : "No speeds yet"}
        </p>
        <p className="tv-ranking-notice-text">{slide.notice}</p>
      </div>
    );
  }

  return (
    <div className="tv-ranking">
      {unit && <p className="tv-chart-caption">{chartCaption(unit)}</p>}
      <div className="tv-chart" ref={chartRef} role="list" aria-label={`${slide.activityName} speeds, fastest first`}>
        {size.width > 0 &&
          layout.rows.map((row, i) => (
            <div
              key={`${i}:${bars[i].name}`}
              className={`tv-chart-row tv-chart-label-${row.labelMode}`}
              role="listitem"
              data-meets-target={row.meetsTarget}
              style={{ top: row.top, height: layout.barHeight, fontSize: layout.fontSize }}
            >
              <div
                className="tv-chart-bar"
                data-color={row.color}
                style={{ width: row.barWidth, background: `linear-gradient(90deg, ${row.color}, ${lighten(row.color)})` }}
              />
              <span
                className="tv-chart-name"
                style={{
                  left: row.nameLeft,
                  color: row.labelMode === "inside" ? row.insideTextColor : undefined,
                }}
              >
                {row.name}
              </span>
              <span
                className="tv-chart-speed"
                style={{
                  right: size.width - row.speedRight,
                  color: row.labelMode === "inside" ? row.insideTextColor : undefined,
                }}
              >
                {bars[i].speedLabel}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

// "stems/hour" -> "Stems per hour" for the small caption above the bars.
function chartCaption(unit: string): string {
  const text = unit.replace("/", " per ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
