// Plain HTML chrome, not SVG content — north is already guaranteed to be
// "up" simply because LandCanvas never rotates or flips the SVG, so this
// just needs to sit visually at the top of the canvas panel at any zoom.
export function NorthIndicator() {
  return (
    <div className="greenhouse-north-indicator" aria-label="North">
      <span className="greenhouse-north-arrow">↑</span>
      <span>N</span>
    </div>
  );
}
