import { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Navigation2 } from "lucide-react";
import { LivePhase, LiveRow } from "../../lib/greenhouseLiveTypes";
import { CanvasTransform, RotationDegrees, clampPan, zoomAtPoint } from "../../lib/canvasTransform";
import { rowScreenRect } from "../../lib/rowLayout";
import { formatTimeInAppTimezone } from "../../lib/timezone";
import { EmployeeLocationBubbles } from "./EmployeeLocationBubbles";

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
  // Row-selection mode (used by Employee Blocks' and Plant Density's Link
  // Rows steps) — entirely optional and additive: when onRowClick is
  // omitted, every row renders exactly as before (colored by row.state, no
  // click handler). When provided, rows render by selection state instead
  // and become clickable; row.state itself is ignored in that case
  // (callers in selection mode have no live work-status to show, only
  // which rows are selected/taken).
  //
  // `opts.rangeRows` is populated on a shift+click that has a valid anchor
  // (the previously-clicked row, tracked internally) — the full run of
  // rows from that anchor to the one just clicked, inclusive, in the same
  // order `phases` was given (flattened phase-by-phase, row-by-row —
  // "logical" order, not screen position). Callers that don't care about
  // range-select can just ignore `opts` entirely and keep toggling
  // `row` one at a time; Employee Blocks does exactly this today.
  onRowClick?: (row: LiveRow, opts?: { shiftKey?: boolean; rangeRows?: LiveRow[] }) => void;
  selectedRowIds?: Set<string>;
  // Rows already linked to a *different* block/owner, keyed by row id to
  // that owner's display name — highlighted as "taken" (unless also
  // selected) and named in the tooltip, so a reassignment is visible
  // before the caller's own onRowClick confirm logic runs.
  unavailableRowIds?: Map<string, string>;
  // false = display-only: no wheel/pointer pan-zoom handlers are attached
  // at all (not just visually disabled — the listeners themselves never
  // get wired up). Defaults to true so every existing caller (the office
  // page, Employee Blocks' Link Rows step) keeps its current pan/zoom
  // behavior with no change. Used by the read-only TV display.
  interactive?: boolean;
}

// Same threshold LandCanvas uses — below this many screen px-per-foot, row
// number labels are hidden rather than rendered as illegible/overlapping
// text.
const ROW_LABEL_MIN_SCALE = 3;

const PAN_DRAG_THRESHOLD_PX = 4;

function selectionTooltip(row: LiveRow, phaseName: string, unavailableBy?: string): string {
  const lines = [`Row ${row.rowNumber}`, phaseName];
  if (unavailableBy) lines.push(`Currently in block: ${unavailableBy}`);
  return lines.join("\n");
}

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
// only interactions, and even those are opt-out via `interactive={false}`
// (see the TV display, the one caller that needs a fully display-only map).
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
  onRowClick,
  selectedRowIds,
  unavailableRowIds,
  interactive = true,
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
  // Anchor for shift+click range-select — the id of the last row clicked
  // in selection mode, regardless of whether that click was itself a
  // shift+click (so a *second* shift+click extends/redefines the range
  // from the row just added, not always from the very first click).
  const lastClickedRowIdRef = useRef<string | null>(null);

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
    if (!interactive) return;
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
  }, [interactive, transform, minScale, maxScale, onTransformChange]);

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
  // Employee location bubbles only make sense outside row-selection mode —
  // Employee Blocks' and Plant Density's Link Rows steps pass onRowClick
  // with placeholder land/employees data that has no real live work status
  // to show (see their buildSelectionLand() comments), so bubbles must never
  // render there.
  const showEmployeeBubbles = !onRowClick;
  // Rotation pivots around the land's own center, in world feet — the same
  // center computeFitTransform's rotation-aware scale calculation assumes.
  const rotateCx = land.eastWestFeet / 2;
  const rotateCy = land.northSouthFeet / 2;

  // The single flat "logical" row order shift+click ranges are computed
  // against — every phase's rows, in the same order `phases` was given
  // (already the deterministic order the caller's own data fetch produced,
  // the same order rendered above), not screen/pixel position.
  const flatSelectableRows = onRowClick ? visiblePhases.flatMap((p) => p.rows) : [];

  function handleRowSelectionClick(row: LiveRow, e: ReactMouseEvent) {
    const shiftKey = e.shiftKey;
    let rangeRows: LiveRow[] | undefined;
    if (shiftKey && lastClickedRowIdRef.current) {
      const fromIdx = flatSelectableRows.findIndex((r) => r.id === lastClickedRowIdRef.current);
      const toIdx = flatSelectableRows.findIndex((r) => r.id === row.id);
      if (fromIdx !== -1 && toIdx !== -1) {
        const [start, end] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        rangeRows = flatSelectableRows.slice(start, end + 1);
      }
    }
    lastClickedRowIdRef.current = row.id;
    onRowClick!(row, { shiftKey, rangeRows });
  }

  return (
    <div
      ref={viewportRef}
      className={`greenhouse-canvas-viewport${isPanning ? " greenhouse-canvas-viewport-panning" : ""}`}
      onPointerDown={interactive ? handleViewportPointerDown : undefined}
      onPointerMove={interactive ? handleViewportPointerMove : undefined}
      onPointerUp={interactive ? handleViewportPointerUp : undefined}
      onPointerCancel={interactive ? handleViewportPointerUp : undefined}
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

                {phase.rows.map((row) => {
                  const { width, height } = rowScreenRect(row);
                  const rowX = phase.xFeetFromWest + row.xFt;
                  const rowY = phase.yFeetFromNorth + row.yFt;
                  const showLabel = transform.scale >= ROW_LABEL_MIN_SCALE;
                  const rowFontSize = Math.max(6, Math.min(width, height) * 0.5);

                  const selectable = Boolean(onRowClick);
                  const isSelected = selectedRowIds?.has(row.id);
                  const unavailableBy = unavailableRowIds?.get(row.id);
                  const visualState = selectable
                    ? isSelected
                      ? "selected"
                      : unavailableBy
                        ? "taken"
                        : "available"
                    : row.state;

                  return (
                    <g key={row.id} className="greenhouse-row-group">
                      <rect
                        x={rowX}
                        y={rowY}
                        width={width}
                        height={height}
                        className={`greenhouse-live-row-rect greenhouse-live-row-${visualState}${
                          selectable ? " greenhouse-live-row-selectable" : ""
                        }`}
                        vectorEffect="non-scaling-stroke"
                        onClick={selectable ? (e) => handleRowSelectionClick(row, e) : undefined}
                      >
                        <title>{selectable ? selectionTooltip(row, phase.name, unavailableBy) : rowTooltip(row, phase.name)}</title>
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

      {showEmployeeBubbles && (
        <EmployeeLocationBubbles
          phases={visiblePhases}
          land={land}
          transform={transform}
          rotationDegrees={rotationDegrees}
        />
      )}

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
