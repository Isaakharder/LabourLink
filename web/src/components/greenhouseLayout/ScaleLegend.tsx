interface ScaleLegendProps {
  pxPerFoot: number | null;
  gridFeet: number;
}

// Display-only — never used for any positioning math (that's all done in
// real feet via the SVG viewBox/getScreenCTM, see LandCanvas.tsx).
export function ScaleLegend({ pxPerFoot, gridFeet }: ScaleLegendProps) {
  return (
    <div className="greenhouse-scale-legend">
      <span>1 grid square = {gridFeet} ft</span>
      {pxPerFoot !== null && pxPerFoot > 0 && <span>Scale: 1 px ≈ {(1 / pxPerFoot).toFixed(2)} ft</span>}
    </div>
  );
}
