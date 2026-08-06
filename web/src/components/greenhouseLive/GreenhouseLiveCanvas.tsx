import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Navigation2 } from "lucide-react";
import { LivePhase, LiveRow } from "../../lib/greenhouseLiveTypes";
import { CanvasTransform, RotationDegrees, clampPan, zoomAtPoint } from "../../lib/canvasTransform";
import { rowScreenRect } from "../../lib/rowLayout";
import { formatTimeInAppTimezone } from "../../lib/timezone";

interface GreenhouseLiveCanvasProps {
  land: { northSouthFeet: number; eastWestFeet: number };
  phases: LivePhase[];
  phaseFilterId: string | null; // null = show all
  transform: CanvasTransform;
  onTransformChange: (next: CanvasTransform) => void;
  onViewportSize: (size: { width: number; height: number }) => void;
  minScale: number;
  maxScale: number;
  // 0 = normal. Rotates only the phases/rows group below, around the
  // land's own center — pan/zoom, hit-testing, and tooltips all keep
  // working unmodified since this is just one more nested SVG transform,
  // handled natively by the browser. Defaults to 0 so callers that don't
  // (yet) care about rotation need no change.
  rotationDegrees?: RotationDegrees;
}

// Same threshold LandCanvas uses — below this many screen px-per-foot, row
// number labels are hidden rather than rendered as illegible/overlapping
// text.
const ROW_LABEL_MIN_SCALE = 3;

const PAN_DRAG_THRESHOLD_PX = 4;

function rowTooltip(row: LiveRow, phaseName: string): string {
  const lines = [`Row ${row.rowNumber}`, phaseName];
  if (row.state === "blue") {
    for (const e of row.employees) {
      const started = e.startedAt ? ` — started ${formatTimeInAppTimezone(e.startedAt)}` : "";
      const carrier = e.carrierName ? ` [${e.carrierName}]` : "";
      lines.push(`${e.firstName} ${e.lastName} · ${e.activityName ?? "Working"}${carrier}${started}`);
    }
  } else if (row.state === "green") {
    for (const e of row.employees) {
      const ended = e.endedAt ? ` (completed ${formatTimeInAppTimezone(e.endedAt)})` : "";
      const carrier = e.carrierName ? ` [${e.carrierName}]` : "";
      lines.push(`${e.firstName} ${e.lastName} · ${e.activityName ?? "Completed"}${carrier}${ended}`);
    }
  }
  return lines.join("\n");
}

// Read-only counterpart to LandCanvas.tsx: same world-feet SVG + pan/zoom
// math (canvasTransform.ts, unmodified), same phase/row rect+label
// conventions and CSS class names, but no land background/border/grid, and
// no drag/select/edit state or handlers of any kind — pan and zoom are the
// only interactions.
export function GreenhouseLiveCanvas({
  land,
  phases,
  phaseFilterId,
  transform,
  onTransformChange,
  onViewportSize,
  minScale,
  maxScale,
  rotationDegrees = 0,
}: GreenhouseLiveCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const panRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPan: { x: number; y: number };
    captured: boolean;
  } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function report() {
      onViewportSize({ width: el!.clientWidth, height: el!.clientHeight });
    }
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.min(maxScale, Math.max(minScale, transform.scale * factor));
      onTransformChange(zoomAtPoint(transform, newScale, focalX, focalY));
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [transform, minScale, maxScale, onTransformChange]);

  function handleViewportPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const isMiddle = e.button === 1;
    const isPlainLeft = e.button === 0;
    if (!isMiddle && !isPlainLeft) return;

    panRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPan: transform.pan,
      captured: false,
    };

    if (isMiddle) {
      e.currentTarget.setPointerCapture(e.pointerId);
      panRef.current.captured = true;
      setIsPanning(true);
      e.preventDefault();
    }
  }

  function handleViewportPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;

    if (!pan.captured) {
      const dist = Math.hypot(e.clientX - pan.startClientX, e.clientY - pan.startClientY);
      if (dist < PAN_DRAG_THRESHOLD_PX) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      pan.captured = true;
      setIsPanning(true);
    }

    const dx = e.clientX - pan.startClientX;
    const dy = e.clientY - pan.startClientY;
    const viewport = viewportRef.current;
    const nextPan = viewport
      ? clampPan(
          { x: pan.startPan.x + dx, y: pan.startPan.y + dy },
          transform.scale,
          land,
          viewport.clientWidth,
          viewport.clientHeight,
          rotationDegrees
        )
      : { x: pan.startPan.x + dx, y: pan.startPan.y + dy };
    onTransformChange({ pan: nextPan, scale: transform.scale });
  }

  function handleViewportPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null;
    setIsPanning(false);
  }

  const visiblePhases = phaseFilterId ? phases.filter((p) => p.id === phaseFilterId) : phases;
  // Rotation pivots around the land's own center, in world feet — the same
  // center computeFitTransform's rotation-aware scale calculation assumes.
  const rotateCx = land.eastWestFeet / 2;
  const rotateCy = land.northSouthFeet / 2;

  return (
    <div
      ref={viewportRef}
      className={`greenhouse-canvas-viewport${isPanning ? " greenhouse-canvas-viewport-panning" : ""}`}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={handleViewportPointerMove}
      onPointerUp={handleViewportPointerUp}
      onPointerCancel={handleViewportPointerUp}
    >
      <svg ref={svgRef} className="greenhouse-canvas-svg">
        <g ref={gRef} transform={`translate(${transform.pan.x} ${transform.pan.y}) scale(${transform.scale})`}>
          {/* Rotation lives on its own nested group, inside the pan/zoom
              group above — the browser handles hit-testing, tooltips, and
              row highlighting correctly for the combined transform with no
              extra math needed here. Phase/row x/y/width/height below are
              always the original, un-rotated world-feet coordinates. */}
          <g transform={rotationDegrees ? `rotate(${rotationDegrees} ${rotateCx} ${rotateCy})` : undefined}>
          {visiblePhases.map((phase) => {
            const fontSize = Math.max(8, Math.min(phase.eastWestFeet, phase.northSouthFeet) * 0.12);
            return (
              <g key={phase.id} className="greenhouse-phase-group">
                <rect
                  x={phase.xFeetFromWest}
                  y={phase.yFeetFromNorth}
                  width={phase.eastWestFeet}
                  height={phase.northSouthFeet}
                  className="greenhouse-phase-rect"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
                <text
                  x={phase.xFeetFromWest + phase.eastWestFeet / 2}
                  y={phase.yFeetFromNorth + phase.northSouthFeet / 2 - fontSize * 0.4}
                  textAnchor="middle"
                  fontSize={fontSize}
                  className="greenhouse-phase-label"
                  pointerEvents="none"
                >
                  {phase.name}
                </text>

                {phase.rows.map((row) => {
                  const { width, height } = rowScreenRect(row);
                  const rowX = phase.xFeetFromWest + row.xFt;
                  const rowY = phase.yFeetFromNorth + row.yFt;
                  const showLabel = transform.scale >= ROW_LABEL_MIN_SCALE;
                  const rowFontSize = Math.max(6, Math.min(width, height) * 0.5);
                  return (
                    <g key={row.id} className="greenhouse-row-group">
                      <rect
                        x={rowX}
                        y={rowY}
                        width={width}
                        height={height}
                        className={`greenhouse-live-row-rect greenhouse-live-row-${row.state}`}
                        vectorEffect="non-scaling-stroke"
                      >
                        <title>{rowTooltip(row, phase.name)}</title>
                      </rect>
                      {showLabel && (
                        <text
                          x={rowX + width / 2}
                          y={rowY + height / 2}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize={Math.min(rowFontSize, 10)}
                          className="greenhouse-row-label"
                          pointerEvents="none"
                        >
                          {row.rowNumber}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
          </g>
        </g>
      </svg>

      {/* Compass/North indicator — the needle rotates with the map (same
          degrees, same clockwise direction) so it keeps pointing at true
          north exactly as it now renders on screen, making the current
          orientation clear even on the TV, which has no Rotate control of
          its own. Positioned outside the SVG's transform stack entirely
          (a plain HTML overlay), so it's unaffected by pan/zoom. */}
      <div className="greenhouse-compass" aria-hidden="true">
        <Navigation2
          className="greenhouse-compass-arrow"
          size={18}
          style={{ transform: `rotate(${rotationDegrees}deg)` }}
        />
        <span className="greenhouse-compass-label">N</span>
      </div>
    </div>
  );
}
