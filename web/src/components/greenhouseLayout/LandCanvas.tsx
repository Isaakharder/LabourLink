import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { GreenhouseLand, GreenhousePhase } from "../../lib/greenhouseLayoutTypes";
import { CanvasTransform, clampPan, zoomAtPoint } from "../../lib/canvasTransform";
import { isTypingIntoFormField } from "../../lib/isTypingTarget";

interface LandCanvasProps {
  land: GreenhouseLand;
  phases: GreenhousePhase[];
  editMode: boolean;
  // A phase currently open in the single-phase D-pad position editor is
  // draggable too (both methods edit the same draft coordinates), even
  // when the batch "Edit Phases" mode is off.
  positionEditId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDragMove: (id: string, xFeetFromWest: number, yFeetFromNorth: number) => void;
  snapEnabled: boolean;
  gridFeet: number;
  overlappingPhaseIds: Set<string>;
  // View transform (pan in screen px, scale in px/ft) is owned by the
  // parent editor shell — the toolbar's zoom buttons and keyboard
  // shortcuts drive the exact same state this canvas's own wheel/drag
  // gestures do. This component only ever reports intended changes; it
  // never treats pan/scale as local state.
  transform: CanvasTransform;
  onTransformChange: (next: CanvasTransform) => void;
  onViewportSize: (size: { width: number; height: number }) => void;
  minScale: number;
  maxScale: number;
}

// A plain left press doesn't capture the pointer (and so isn't yet treated
// as panning) until it's moved this many screen pixels — see
// handleViewportPointerMove for why.
const PAN_DRAG_THRESHOLD_PX = 4;

// Generates evenly-spaced grid line positions from 0 up to `lengthFeet`
// (inclusive of the boundary), marking every `majorEvery`-th line as major.
function gridLines(lengthFeet: number, stepFeet: number, majorEvery: number) {
  const lines: { pos: number; major: boolean }[] = [];
  let i = 0;
  for (let pos = 0; pos <= lengthFeet + 0.001; pos += stepFeet, i++) {
    lines.push({ pos: Math.min(pos, lengthFeet), major: i % majorEvery === 0 });
  }
  return lines;
}

export function LandCanvas({
  land,
  phases,
  editMode,
  positionEditId,
  selectedId,
  onSelect,
  onDragMove,
  snapEnabled,
  gridFeet,
  overlappingPhaseIds,
  transform,
  onTransformChange,
  onViewportSize,
  minScale,
  maxScale,
}: LandCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const dragRef = useRef<{ id: string; grabDxFeet: number; grabDyFeet: number } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPan: { x: number; y: number };
    // Pointer capture is deferred until the gesture proves itself a real
    // drag (see handleViewportPointerMove) for plain-left presses — see
    // that handler for why.
    captured: boolean;
  } | null>(null);

  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  // Reports the viewport's own rendered pixel size up to the editor shell
  // — used there for Fit to screen and for clamping pan. A CSS transform
  // on an ancestor (zoom) doesn't change this element's own layout box, so
  // a ResizeObserver on the viewport itself (not on anything transformed)
  // is the right thing to watch.
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

  // Tracks the spacebar for space+drag panning, and lets Escape cancel an
  // in-progress pan (distinct from — and independent of — the D-pad
  // position editor's own Escape-to-cancel, which only exists while that
  // editor is open).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingIntoFormField()) return;
      if (e.code === "Space") {
        setSpacePressed(true);
        e.preventDefault();
      } else if (e.key === "Escape" && panRef.current) {
        onTransformChange({ pan: panRef.current.startPan, scale: transform.scale });
        panRef.current = null;
        setIsPanning(false);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpacePressed(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform.scale]);

  // Wheel = zoom, centered on the cursor. Attached as a native non-passive
  // listener (React's onWheel is passive by default) so preventDefault
  // reliably stops the page/browser from scrolling or pinch-zooming.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;
      // Smooth exponential increment — a single "notch" (~100 deltaY) is
      // roughly an 8% step, small pinch/trackpad deltas are proportionally
      // gentler, never a huge jump.
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.min(maxScale, Math.max(minScale, transform.scale * factor));
      onTransformChange(zoomAtPoint(transform, newScale, focalX, focalY));
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [transform, minScale, maxScale, onTransformChange]);

  function screenToFeet(clientX: number, clientY: number): { x: number; y: number } | null {
    const g = gRef.current;
    if (!g) return null;
    const ctm = g.getScreenCTM();
    if (!ctm) return null;
    const pt = svgRef.current!.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function handlePhasePointerDown(e: ReactPointerEvent<SVGRectElement>, phase: GreenhousePhase) {
    // Middle-click and Space+left are unambiguous pan gestures regardless
    // of what's underneath the pointer — a phase happening to sit at the
    // gesture's start point must never swallow it (that previously made
    // panning silently fail to start whenever it began over a phase).
    // Don't stopPropagation or select in that case; let it bubble up to
    // the viewport's own pan handler exactly as if it started on empty
    // canvas. A plain left press is the only case that's phase
    // select/drag, same as before.
    const isPanGesture = e.button === 1 || (e.button === 0 && spacePressed);
    if (isPanGesture) return;

    e.stopPropagation();
    onSelect(phase.id);
    const draggable = editMode || phase.id === positionEditId;
    if (!draggable) return;
    const pt = screenToFeet(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: phase.id, grabDxFeet: pt.x - phase.xFeetFromWest, grabDyFeet: pt.y - phase.yFeetFromNorth };
    e.preventDefault();
  }

  function handlePhasePointerMove(e: ReactPointerEvent<SVGRectElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const phase = phases.find((p) => p.id === drag.id);
    if (!phase) return;
    const pt = screenToFeet(e.clientX, e.clientY);
    if (!pt) return;

    let x = pt.x - drag.grabDxFeet;
    let y = pt.y - drag.grabDyFeet;
    if (snapEnabled) {
      x = Math.round(x / gridFeet) * gridFeet;
      y = Math.round(y / gridFeet) * gridFeet;
    }
    const maxX = Math.max(0, land.eastWestFeet - phase.eastWestFeet);
    const maxY = Math.max(0, land.northSouthFeet - phase.northSouthFeet);
    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(0, Math.min(y, maxY));

    onDragMove(drag.id, x, y);
    e.preventDefault();
  }

  function handlePhasePointerUp() {
    dragRef.current = null;
  }

  // Middle-mouse drag, Space+left-drag, or a plain left-drag starting on
  // empty canvas (never reached for a phase — see stopPropagation above)
  // all pan. Panning only ever adjusts pan in screen pixels; scale is
  // untouched, so no feet-space math is needed here at all.
  function handleViewportPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const isMiddle = e.button === 1;
    const isSpaceLeft = e.button === 0 && spacePressed;
    const isPlainLeft = e.button === 0;
    if (!isMiddle && !isSpaceLeft && !isPlainLeft) return;

    panRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPan: transform.pan,
      captured: false,
    };

    // Middle/space are unambiguously a pan gesture, so those capture (and
    // preventDefault) immediately. A plain left press might just be a
    // click-to-deselect — capturing the pointer on pointerdown changes
    // what element the browser's synthesized click event fires on, which
    // silently broke that deselect. So a plain left press waits until the
    // pointer actually moves past a small threshold (see
    // handleViewportPointerMove) before capturing/panning.
    if (isMiddle || isSpaceLeft) {
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
      if (dist < PAN_DRAG_THRESHOLD_PX) return; // still might just be a click
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
          viewport.clientHeight
        )
      : { x: pan.startPan.x + dx, y: pan.startPan.y + dy };
    onTransformChange({ pan: nextPan, scale: transform.scale });
  }

  function handleViewportPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null;
    setIsPanning(false);
  }

  const verticalLines = gridLines(land.eastWestFeet, gridFeet, 5);
  const horizontalLines = gridLines(land.northSouthFeet, gridFeet, 5);

  const viewportClassName = `greenhouse-canvas-viewport${
    isPanning ? " greenhouse-canvas-viewport-panning" : spacePressed ? " greenhouse-canvas-viewport-pannable" : ""
  }`;

  return (
    <div
      ref={viewportRef}
      className={viewportClassName}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={handleViewportPointerMove}
      onPointerUp={handleViewportPointerUp}
      onPointerCancel={handleViewportPointerUp}
    >
      <svg ref={svgRef} className="greenhouse-canvas-svg" onClick={(e) => e.target === svgRef.current && onSelect(null)}>
        <g ref={gRef} transform={`translate(${transform.pan.x} ${transform.pan.y}) scale(${transform.scale})`}>
          <rect
            x={0}
            y={0}
            width={land.eastWestFeet}
            height={land.northSouthFeet}
            className="greenhouse-land-rect"
            onClick={() => onSelect(null)}
          />

          <g className="greenhouse-grid" aria-hidden="true">
            {verticalLines.map((l) => (
              <line
                key={`v-${l.pos}`}
                x1={l.pos}
                y1={0}
                x2={l.pos}
                y2={land.northSouthFeet}
                vectorEffect="non-scaling-stroke"
                className={l.major ? "greenhouse-grid-major" : "greenhouse-grid-minor"}
              />
            ))}
            {horizontalLines.map((l) => (
              <line
                key={`h-${l.pos}`}
                x1={0}
                y1={l.pos}
                x2={land.eastWestFeet}
                y2={l.pos}
                vectorEffect="non-scaling-stroke"
                className={l.major ? "greenhouse-grid-major" : "greenhouse-grid-minor"}
              />
            ))}
          </g>

          <rect
            x={0}
            y={0}
            width={land.eastWestFeet}
            height={land.northSouthFeet}
            className="greenhouse-land-border"
            vectorEffect="non-scaling-stroke"
            fill="none"
            pointerEvents="none"
          />

          {phases.map((phase) => {
            const fontSize = Math.max(8, Math.min(phase.eastWestFeet, phase.northSouthFeet) * 0.12);
            const selected = phase.id === selectedId;
            const overlapping = overlappingPhaseIds.has(phase.id);
            return (
              <g
                key={phase.id}
                className={`greenhouse-phase-group${phase.isActive ? "" : " greenhouse-phase-inactive"}`}
              >
                <rect
                  x={phase.xFeetFromWest}
                  y={phase.yFeetFromNorth}
                  width={phase.eastWestFeet}
                  height={phase.northSouthFeet}
                  className={`greenhouse-phase-rect${selected ? " greenhouse-phase-rect-selected" : ""}${
                    overlapping ? " greenhouse-phase-rect-overlapping" : ""
                  }`}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: editMode || phase.id === positionEditId ? "grab" : "pointer" }}
                  onPointerDown={(e) => handlePhasePointerDown(e, phase)}
                  onPointerMove={handlePhasePointerMove}
                  onPointerUp={handlePhasePointerUp}
                  onPointerCancel={handlePhasePointerUp}
                >
                  <title>
                    {phase.name} — {phase.eastWestFeet} ft × {phase.northSouthFeet} ft
                  </title>
                </rect>
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
                <text
                  x={phase.xFeetFromWest + phase.eastWestFeet / 2}
                  y={phase.yFeetFromNorth + phase.northSouthFeet / 2 + fontSize * 0.9}
                  textAnchor="middle"
                  fontSize={fontSize * 0.8}
                  className="greenhouse-phase-dims"
                  pointerEvents="none"
                >
                  {phase.eastWestFeet} ft × {phase.northSouthFeet} ft
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
