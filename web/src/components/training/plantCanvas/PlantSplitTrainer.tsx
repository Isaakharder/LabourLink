import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PLANT_VIEWBOX, STEM_BASE_X } from "./plantGeometry";
import { PlantCanvas } from "./PlantCanvas";
import { usePlantGrowth } from "./usePlantGrowth";
import "./plantTraining.css";

// Grow-and-prune simulator: the plant on the left, a small control panel on
// the right. Start → "2 split" / "3 split" grows the first crown → "Grow
// 30 cm" adds a cycle to every live growing tip, as often as you like →
// double-click any stem to cut it → "Undo" plays everything back to the
// identical starting plant. Entirely local: no API calls, nothing saved.
//
// A plant that outgrows the frame keeps its scale: the stage scrolls, and
// follows the growing tips while a cycle animates. The controls sit outside
// the scrolling stage so they stay in reach.

const STATUS: Record<string, string> = {
  start: "Plant ready to split",
  growing: "Growing",
  falling: "Cut",
  undoing: "Returning to start",
};

/** Pixels per SVG unit that fit the original frame into the stage. */
function useFitScale(ref: React.RefObject<HTMLDivElement>): number | undefined {
  const [scale, setScale] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (w > 0 && h > 0) setScale(Math.min(w / PLANT_VIEWBOX.width, h / PLANT_VIEWBOX.height));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return scale;
}

export function PlantSplitTrainer() {
  const { phase, growth, splitMode, cycles, cuts, fallProgress, activeHeads, split, grow, cut, undo } = usePlantGrowth();
  const stageRef = useRef<HTMLDivElement>(null);
  const fitScale = useFitScale(stageRef);
  const busy = phase === "growing" || phase === "undoing" || phase === "falling" || phase === "cycling";
  const showSplitButtons = phase === "start" || phase === "growing";
  const noTips = !showSplitButtons && activeHeads.length === 0;

  // While a cycle grows, keep the growing tips in view (top of the stage)
  // and the stem base centred horizontally.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || (phase !== "cycling" && phase !== "growing")) return;
    if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
    if (el.scrollWidth > el.clientWidth) {
      const svg = el.querySelector("svg");
      const vb = svg?.viewBox?.baseVal;
      if (svg && vb && vb.width) {
        const px = ((STEM_BASE_X - vb.x) / vb.width) * svg.clientWidth;
        el.scrollLeft = px - el.clientWidth / 2;
      }
    }
  }, [growth, phase]);

  let status: string;
  if (phase === "grown" || phase === "cycling") {
    status = cycles > 0 || phase === "cycling" ? `Growth cycle ${phase === "cycling" ? cycles + 1 : cycles} · +${30 * (phase === "cycling" ? cycles + 1 : cycles)} cm` : `Split complete · ${splitMode}-way`;
  } else {
    status = phase === "growing" ? `${STATUS.growing} · ${splitMode}-way` : STATUS[phase];
  }

  return (
    <div className="plant-trainer">
      <div className="plant-trainer-stage" ref={stageRef}>
        <PlantCanvas
          growth={growth}
          splitMode={splitMode}
          cuts={cuts}
          fallProgress={fallProgress}
          onCut={phase === "grown" ? cut : undefined}
          fitScale={fitScale}
        />
      </div>
      <div className="plant-trainer-controls" role="group" aria-label="Plant controls">
        {showSplitButtons ? (
          <>
            <button type="button" className="plant-trainer-button" disabled={busy} onClick={() => split(2)}>
              2 split
            </button>
            <button type="button" className="plant-trainer-button" disabled={busy} onClick={() => split(3)}>
              3 split
            </button>
          </>
        ) : (
          <>
            <button type="button" className="plant-trainer-button" disabled={busy || noTips} onClick={() => grow()}>
              Grow 30 cm
            </button>
            <button
              type="button"
              className="plant-trainer-button plant-trainer-button-secondary"
              disabled={busy}
              onClick={undo}
            >
              Undo
            </button>
          </>
        )}
        <p className="plant-trainer-status" role="status" aria-live="polite">
          {noTips && !busy ? "No active growing tips." : status}
        </p>
        {phase === "grown" && <p className="plant-trainer-hint">Double-click a stem to cut it</p>}
      </div>
    </div>
  );
}
