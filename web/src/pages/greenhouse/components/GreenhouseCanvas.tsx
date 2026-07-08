import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Scan, RotateCcw, RotateCw, X, Trash2, Grid3X3 } from 'lucide-react';
import type {
  GreenhouseCompartmentDetail,
  GreenhouseRowBlock,
  CompassSide,
} from '../../../api/greenhouse';
import {
  rowToRect,
  blockBBoxFromRows,
  walkwayRect,
} from '../../../lib/greenhouse-geometry';

export interface GreenhouseCanvasHandle {
  fitCompartments: () => void;
}

interface Props {
  compartments: GreenhouseCompartmentDetail[];
  northExtentFt?: number;
  southExtentFt?: number;
  eastExtentFt?: number;
  westExtentFt?: number;
  selectedCompartmentId?: number | null;
  selectedBlockId?: number | null;
  snapGridFt?: number;
  onSelectCompartment?: (id: number) => void;
  onSelectBlock?: (blockId: number, compartmentId: number) => void;
  onSelectionChange?: (ids: Set<number>) => void;
  onDeleteSelected?: (ids: Set<number>) => void;
  isDeleting?: boolean;
  readOnly?: boolean;
  /** Rows shown in light blue — indicates "available" rows (e.g., crop-linked rows in density picker). */
  highlightedRowIds?: Set<number>;
  /** Externally controlled picked rows shown in emerald. When provided, row clicks call onRowPick instead of the internal selection logic. */
  pickedRowIds?: Set<number>;
  /** Called when a row is clicked in pick mode (when onRowPick is provided). */
  onRowPick?: (rowId: number) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

interface SideStyle { fill: string; hoverFill: string; blockFill: string; stroke: string; hoverStroke: string; label: string; }
const SIDE_STYLES: Record<CompassSide, SideStyle> = {
  east:  { fill: '#bfdbfe', hoverFill: '#93c5fd', blockFill: '#60a5fa', stroke: '#60a5fa', hoverStroke: '#3b82f6', label: 'East'  },
  west:  { fill: '#bbf7d0', hoverFill: '#86efac', blockFill: '#4ade80', stroke: '#4ade80', hoverStroke: '#22c55e', label: 'West'  },
  north: { fill: '#ddd6fe', hoverFill: '#c4b5fd', blockFill: '#a78bfa', stroke: '#a78bfa', hoverStroke: '#8b5cf6', label: 'North' },
  south: { fill: '#fed7aa', hoverFill: '#fdba74', blockFill: '#fb923c', stroke: '#fb923c', hoverStroke: '#f97316', label: 'South' },
};
const COMPASS_SIDES: CompassSide[] = ['north', 'south', 'east', 'west'];

const TARGET_WIDTH_PX  = 720;
const MIN_SVG_SCALE    = 0.5;
const MAX_SVG_SCALE    = 8;
const TIP_W            = 160;
const TIP_H            = 30;
const TIP_OFFSET       = 14;
const MIN_ZOOM         = 0.05;
const MAX_ZOOM         = 10;
const ZOOM_BTN_FACTOR  = 1.3;
const DRAG_PX_THRESH   = 4;

const GRID_CANDIDATES = [5, 10, 25, 50, 100, 200, 500, 1000, 2000];

function screenToFoot(
  clientX: number, clientY: number,
  containerRect: DOMRect,
  pan: { x: number; y: number },
  zoom: number, rotation: number,
  svgW: number, svgH: number,
  vb: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const px = clientX - containerRect.left - pan.x;
  const py = clientY - containerRect.top  - pan.y;
  const cx = (svgW * zoom) / 2;
  const cy = (svgH * zoom) / 2;
  const rad = (-rotation * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  const ux = dx * Math.cos(rad) - dy * Math.sin(rad) + cx;
  const uy = dx * Math.sin(rad) + dy * Math.cos(rad) + cy;
  return {
    x: vb.x + (ux / (svgW * zoom)) * vb.w,
    y: vb.y + (uy / (svgH * zoom)) * vb.h,
  };
}

function fmtEW(ft: number): string {
  if (ft === 0) return '0';
  return ft > 0 ? `${ft}E` : `${-ft}W`;
}
function fmtNS(ft: number): string {
  if (ft === 0) return '0';
  return ft > 0 ? `${ft}S` : `${-ft}N`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const GreenhouseCanvas = forwardRef<GreenhouseCanvasHandle, Props>(
  function GreenhouseCanvas({
    compartments,
    northExtentFt = 200,
    southExtentFt = 1500,
    eastExtentFt  = 800,
    westExtentFt  = 200,
    selectedCompartmentId,
    selectedBlockId,
    snapGridFt = 0,
    onSelectCompartment,
    onSelectBlock,
    onSelectionChange,
    onDeleteSelected,
    isDeleting = false,
    readOnly = false,
    highlightedRowIds,
    pickedRowIds,
    onRowPick,
  }: Props, ref) {

  // ── State ──────────────────────────────────────────────────────────────────
  const [hoveredBlockId, setHoveredBlockId] = useState<number | null>(null);
  const [hoveredRowId,   setHoveredRowId]   = useState<number | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<number>>(new Set());
  const [lassoBox,       setLassoBox]       = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [zoom,           setZoom]           = useState(1);
  const [pan,            setPan]            = useState({ x: 0, y: 0 });
  const [isPanning,      setIsPanning]      = useState(false);
  const [isLassing,      setIsLassing]      = useState(false);
  const [shiftHeld,      setShiftHeld]      = useState(false);
  const [rotation,       setRotation]       = useState(0);
  const [shiftSelectMsg, setShiftSelectMsg] = useState<string | null>(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const tooltipRef      = useRef<HTMLDivElement>(null);
  const containerRef    = useRef<HTMLDivElement>(null);
  const zoomRef         = useRef(1);
  const panRef          = useRef({ x: 0, y: 0 });
  const rotationRef     = useRef(0);
  const panStartRef     = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const hasDraggedRef   = useRef(false);
  const hasFittedRef    = useRef(false);
  const svgDimsRef      = useRef({ w: 0, h: 0 });
  const lassoStartRef   = useRef<{ x: number; y: number } | null>(null);
  const vbRef           = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const compartmentsRef = useRef(compartments);
  const onSelChangeRef  = useRef(onSelectionChange);
  const onDelSelRef     = useRef(onDeleteSelected);
  const onSelectCompRef = useRef(onSelectCompartment);
  const onRowPickRef        = useRef(onRowPick);
  const pickedRowIdsRef     = useRef(pickedRowIds);
  const highlightedRowIdsRef = useRef(highlightedRowIds);
  const anchorRowIdRef  = useRef<number | null>(null);
  const shiftMsgTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync refs
  zoomRef.current         = zoom;
  panRef.current          = pan;
  rotationRef.current     = rotation;
  compartmentsRef.current = compartments;
  onSelChangeRef.current  = onSelectionChange;
  onDelSelRef.current     = onDeleteSelected;
  onSelectCompRef.current = onSelectCompartment;
  onRowPickRef.current         = onRowPick;
  pickedRowIdsRef.current      = pickedRowIds;
  highlightedRowIdsRef.current = highlightedRowIds;

  // ── Fit to full canvas ─────────────────────────────────────────────────────
  const resetView = useCallback((overrideRotation?: number) => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const { w, h } = svgDimsRef.current;
    if (!w || !h) return;
    const rot = overrideRotation !== undefined ? overrideRotation : rotationRef.current;
    const effectiveW = rot % 180 === 0 ? w : h;
    const effectiveH = rot % 180 === 0 ? h : w;
    const fitZoom = Math.min((width - 40) / effectiveW, (height - 40) / effectiveH);
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitZoom));
    setZoom(clamped);
    setPan({ x: (width - w * clamped) / 2, y: (height - h * clamped) / 2 });
  }, []);

  // ── Fit to compartments ────────────────────────────────────────────────────
  const fitToCompartments = useCallback(() => {
    const el = containerRef.current;
    const comps = compartmentsRef.current;
    if (!el) { resetView(); return; }
    const { width, height } = el.getBoundingClientRect();
    const { w: svgW } = svgDimsRef.current;
    if (!svgW || !vbRef.current.w) { resetView(); return; }

    let minX: number, minY: number, maxX: number, maxY: number;
    if (comps.length) {
      minX = Math.min(...comps.map(c => c.xFt));
      minY = Math.min(...comps.map(c => c.yFt));
      maxX = Math.max(...comps.map(c => c.xFt + c.eastWestFt));
      maxY = Math.max(...comps.map(c => c.yFt + c.northSouthFt));
    } else {
      minX = -50; minY = -50; maxX = 50; maxY = 50;
    }
    const padFt = 30;
    const cxFt = minX - padFt, cyFt = minY - padFt;
    const cwFt = (maxX - minX) + 2 * padFt;
    const chFt = (maxY - minY) + 2 * padFt;
    const ss = svgDimsRef.current.w / vbRef.current.w;
    const fitZoom = Math.min((width - 40) / (cwFt * ss), (height - 40) / (chFt * ss));
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitZoom));
    const svgPxX = (cxFt - vbRef.current.x) * ss;
    const svgPxY = (cyFt - vbRef.current.y) * ss;
    setZoom(clamped);
    setPan({
      x: (width  - cwFt * ss * clamped) / 2 - svgPxX * clamped,
      y: (height - chFt * ss * clamped) / 2 - svgPxY * clamped,
    });
  }, [resetView]);

  useImperativeHandle(ref, () => ({ fitCompartments: fitToCompartments }), [fitToCompartments]);

  // ── Initial fit ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasFittedRef.current) {
      hasFittedRef.current = true;
      setTimeout(fitToCompartments, 50);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when extents change
  const prevExtentsKey = `${northExtentFt}|${southExtentFt}|${eastExtentFt}|${westExtentFt}`;
  const prevExtentsRef = useRef(prevExtentsKey);
  useEffect(() => {
    if (prevExtentsRef.current !== prevExtentsKey) {
      prevExtentsRef.current = prevExtentsKey;
      setTimeout(resetView, 0);
    }
  }, [prevExtentsKey, resetView]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const curZoom = zoomRef.current;
      const curPan  = panRef.current;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.ctrlKey ? 0.015 : 0.001;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, curZoom * Math.exp(-e.deltaY * factor)));
      const ratio = newZoom / curZoom;
      setZoom(newZoom);
      setPan({ x: mx - (mx - curPan.x) * ratio, y: my - (my - curPan.y) * ratio });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // ── Pan drag ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      if (!panStartRef.current) return;
      const { mx, my, px, py } = panStartRef.current;
      const dx = e.clientX - mx, dy = e.clientY - my;
      if (!hasDraggedRef.current && Math.hypot(dx, dy) > DRAG_PX_THRESH) hasDraggedRef.current = true;
      setPan({ x: px + dx, y: py + dy });
    };
    const onUp = () => { setIsPanning(false); panStartRef.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',  onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isPanning]);

  // ── Lasso drag ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLassing) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el || !lassoStartRef.current) return;
      const foot = screenToFoot(
        e.clientX, e.clientY, el.getBoundingClientRect(),
        panRef.current, zoomRef.current, rotationRef.current,
        svgDimsRef.current.w, svgDimsRef.current.h, vbRef.current,
      );
      const s = lassoStartRef.current;
      setLassoBox({ x1: s.x, y1: s.y, x2: foot.x, y2: foot.y });
      const minX = Math.min(s.x, foot.x), maxX = Math.max(s.x, foot.x);
      const minY = Math.min(s.y, foot.y), maxY = Math.max(s.y, foot.y);
      const ids = new Set<number>();
      for (const comp of compartmentsRef.current) {
        for (const block of comp.blocks) {
          block.rows.forEach(row => {
            const r = rowToRect(row);
            if (r.x < maxX && r.x + r.w > minX && r.y < maxY && r.y + r.h > minY) ids.add(row.id);
          });
        }
      }
      setSelectedRowIds(ids);
      onSelChangeRef.current?.(ids);
    };
    const onUp = () => { setIsLassing(false); setLassoBox(null); lassoStartRef.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',  onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isLassing]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') { setShiftHeld(true); return; }
      if (e.key === 'Escape') {
        anchorRowIdRef.current = null;
        setSelectedRowIds(new Set());
        onSelChangeRef.current?.(new Set());
      }
    };
    const onUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup',   onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
  }, []);

  // ── Auto-prune orphaned row selection ─────────────────────────────────────
  useEffect(() => {
    setSelectedRowIds(prev => {
      if (prev.size === 0) return prev;
      const allIds = new Set(compartments.flatMap(c => c.blocks.flatMap(b => b.rows.map(r => r.id))));
      const next = new Set([...prev].filter(id => allIds.has(id)));
      if (next.size !== prev.size) {
        if (next.size === 0) anchorRowIdRef.current = null;
        onSelChangeRef.current?.(next);
        return next;
      }
      return prev;
    });
  }, [compartments]);

  // ── Canvas / viewBox ───────────────────────────────────────────────────────
  const vbX = -westExtentFt;
  const vbY = -northExtentFt;
  const vbW = westExtentFt + eastExtentFt;
  const vbH = northExtentFt + southExtentFt;
  const svgScale = Math.min(MAX_SVG_SCALE, Math.max(MIN_SVG_SCALE, TARGET_WIDTH_PX / vbW));
  const svgW = Math.ceil(vbW * svgScale);
  const svgH = Math.ceil(vbH * svgScale);

  svgDimsRef.current = { w: svgW, h: svgH };
  vbRef.current      = { x: vbX, y: vbY, w: vbW, h: vbH };

  // ── Zoom-reactive grid interval ────────────────────────────────────────────
  const pxPerFt    = svgScale * zoom;
  const gridFt     = GRID_CANDIDATES.find(c => c * pxPerFt >= 40) ?? 2000;
  const labelEvery = gridFt * 2;

  // Non-scaling sizes (appear at fixed pixel size regardless of zoom)
  const uiFs     = 9  / pxPerFt;
  const anchorFs = 10 / pxPerFt;
  const arm      = 14 / pxPerFt;

  const hoveredRow = hoveredRowId != null
    ? compartments.flatMap(c => c.blocks.flatMap(b => b.rows)).find(r => r.id === hoveredRowId) ?? null
    : null;

  function handleSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!tooltipRef.current) return;
    const tipX = e.clientX + TIP_OFFSET + TIP_W > window.innerWidth
      ? e.clientX - TIP_OFFSET - TIP_W : e.clientX + TIP_OFFSET;
    const tipY = e.clientY + TIP_OFFSET + TIP_H > window.innerHeight
      ? e.clientY - TIP_OFFSET - TIP_H : e.clientY + TIP_OFFSET;
    tooltipRef.current.style.left = `${tipX}px`;
    tooltipRef.current.style.top  = `${tipY}px`;
  }

  const rotateLeft  = () => { const r = (rotation - 90 + 360) % 360; setRotation(r); resetView(r); };
  const rotateRight = () => { const r = (rotation + 90) % 360;        setRotation(r); resetView(r); };
  const resetRot    = () => { setRotation(0); resetView(0); };

  function zoomBy(factor: number) {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current * factor));
    const el = containerRef.current;
    if (!el) { setZoom(nz); return; }
    const { width, height } = el.getBoundingClientRect();
    const ratio = nz / zoomRef.current;
    setZoom(nz);
    setPan({ x: width/2 - (width/2 - panRef.current.x)*ratio, y: height/2 - (height/2 - panRef.current.y)*ratio });
  }

  function handleRowClick(rowId: number, e: React.MouseEvent) {
    if (hasDraggedRef.current) return;
    e.stopPropagation();
    if (onRowPickRef.current) { onRowPickRef.current(rowId); return; }
    if (e.shiftKey) { handleShiftClick(rowId); return; }
    const ctrlCmd = e.ctrlKey || e.metaKey;
    const next = new Set(selectedRowIds);
    if (ctrlCmd) { if (next.has(rowId)) next.delete(rowId); else next.add(rowId); }
    else { next.clear(); next.add(rowId); }
    anchorRowIdRef.current = rowId;
    setSelectedRowIds(next);
    onSelChangeRef.current?.(next);
  }

  function handleShiftClick(clickedId: number) {
    const anchor = anchorRowIdRef.current;
    if (!anchor) {
      const next = new Set([clickedId]);
      anchorRowIdRef.current = clickedId;
      setSelectedRowIds(next);
      onSelChangeRef.current?.(next);
      return;
    }
    let anchorBlock: GreenhouseRowBlock | null = null;
    let clickedBlock: GreenhouseRowBlock | null = null;
    for (const comp of compartments) {
      for (const block of comp.blocks) {
        for (const row of block.rows) {
          if (row.id === anchor)    anchorBlock  = block;
          if (row.id === clickedId) clickedBlock = block;
        }
      }
    }
    if (!anchorBlock || !clickedBlock) return;
    if (anchorBlock.id !== clickedBlock.id) {
      if (shiftMsgTimer.current) clearTimeout(shiftMsgTimer.current);
      setShiftSelectMsg('Shift-select works within the same row block');
      shiftMsgTimer.current = setTimeout(() => setShiftSelectMsg(null), 3000);
      return;
    }
    const rows = anchorBlock.rows;
    const ai = rows.findIndex(r => r.id === anchor);
    const ci = rows.findIndex(r => r.id === clickedId);
    if (ai === -1 || ci === -1) return;
    const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
    const next = new Set(rows.slice(lo, hi + 1).map(r => r.id));
    setSelectedRowIds(next);
    onSelChangeRef.current?.(next);
  }

  function clearSelection() {
    anchorRowIdRef.current = null;
    setSelectedRowIds(new Set());
    onSelChangeRef.current?.(new Set());
  }

  const cursor = isLassing ? 'crosshair' : isPanning ? 'grabbing' : shiftHeld ? 'crosshair' : 'grab';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden bg-gray-200 select-none"
      style={{ cursor }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (e.shiftKey && !readOnly && !onRowPickRef.current) {
          const el = containerRef.current!;
          const foot = screenToFoot(e.clientX, e.clientY, el.getBoundingClientRect(),
            pan, zoom, rotation, svgW, svgH, vbRef.current);
          lassoStartRef.current = foot;
          setIsLassing(true);
          return;
        }
        hasDraggedRef.current = false;
        panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
        setIsPanning(true);
      }}
    >
      {/* Pan wrapper */}
      <div style={{ position: 'absolute', transform: `translate(${pan.x}px, ${pan.y}px)`, willChange: 'transform' }}>
        {/* Rotation wrapper */}
        <div style={{
          transformOrigin: `${(svgW*zoom)/2}px ${(svgH*zoom)/2}px`,
          transform: `rotate(${rotation}deg)`,
          transition: 'transform 0.25s ease',
        }}>
          <svg
            width={svgW * zoom} height={svgH * zoom}
            viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
            className="block"
            onMouseMove={handleSvgMouseMove}
            onMouseLeave={() => { setHoveredBlockId(null); setHoveredRowId(null); }}
          >
            {/* Grey outer */}
            <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="#e5e7eb" />

            {/* White canvas workspace */}
            <rect x={-westExtentFt} y={-northExtentFt} width={vbW} height={vbH} fill="white" />
            <rect x={-westExtentFt} y={-northExtentFt} width={vbW} height={vbH}
              fill="none" stroke="#d1d5db" strokeWidth={0.5 / pxPerFt} rx={1 / pxPerFt} />

            {/* Grid lines */}
            {(() => {
              const lines: React.ReactNode[] = [];
              const x0 = Math.ceil(-westExtentFt / gridFt) * gridFt;
              for (let x = x0; x <= eastExtentFt; x += gridFt) {
                const isAxis = x === 0;
                lines.push(
                  <line key={`vl${x}`} x1={x} y1={-northExtentFt} x2={x} y2={southExtentFt}
                    stroke={isAxis ? '#818cf8' : '#e5e7eb'}
                    strokeWidth={(isAxis ? 0.8 : 0.3) / pxPerFt}
                    strokeDasharray={isAxis ? undefined : `${2/pxPerFt} ${2/pxPerFt}`}
                  />
                );
                if (x % labelEvery === 0) {
                  lines.push(
                    <text key={`vlb${x}`} x={x} y={southExtentFt - uiFs * 0.5}
                      textAnchor="middle" fontSize={uiFs}
                      fill={isAxis ? '#6366f1' : '#9ca3af'} fontFamily="sans-serif">
                      {fmtEW(x)}
                    </text>
                  );
                }
              }
              const y0 = Math.ceil(-northExtentFt / gridFt) * gridFt;
              for (let y = y0; y <= southExtentFt; y += gridFt) {
                const isAxis = y === 0;
                lines.push(
                  <line key={`hl${y}`} x1={-westExtentFt} y1={y} x2={eastExtentFt} y2={y}
                    stroke={isAxis ? '#818cf8' : '#e5e7eb'}
                    strokeWidth={(isAxis ? 0.8 : 0.3) / pxPerFt}
                    strokeDasharray={isAxis ? undefined : `${2/pxPerFt} ${2/pxPerFt}`}
                  />
                );
                if (y % labelEvery === 0) {
                  lines.push(
                    <text key={`hlb${y}`} x={-westExtentFt + uiFs * 0.5} y={y}
                      textAnchor="start" dominantBaseline="middle" fontSize={uiFs}
                      fill={isAxis ? '#6366f1' : '#9ca3af'} fontFamily="sans-serif">
                      {fmtNS(y)}
                    </text>
                  );
                }
              }
              return lines;
            })()}

            {/* Snap grid overlay */}
            {snapGridFt > 0 && (() => {
              const lines: React.ReactNode[] = [];
              const sx = Math.ceil(-westExtentFt / snapGridFt) * snapGridFt;
              const sy = Math.ceil(-northExtentFt / snapGridFt) * snapGridFt;
              for (let x = sx; x <= eastExtentFt; x += snapGridFt)
                lines.push(<line key={`sg${x}`} x1={x} y1={-northExtentFt} x2={x} y2={southExtentFt} stroke="#bfdbfe" strokeWidth={0.2/pxPerFt} />);
              for (let y = sy; y <= southExtentFt; y += snapGridFt)
                lines.push(<line key={`sh${y}`} x1={-westExtentFt} y1={y} x2={eastExtentFt} y2={y} stroke="#bfdbfe" strokeWidth={0.2/pxPerFt} />);
              return lines;
            })()}

            {/* Anchor marker at (0,0) */}
            <g pointerEvents="none">
              <line x1={-arm} y1={0} x2={arm} y2={0} stroke="#6366f1" strokeWidth={0.8/pxPerFt} />
              <line x1={0} y1={-arm} x2={0} y2={arm} stroke="#6366f1" strokeWidth={0.8/pxPerFt} />
              <circle cx={0} cy={0} r={arm * 0.35} fill="white" stroke="#6366f1" strokeWidth={0.6/pxPerFt} />
              <text x={arm * 1.4} y={0} textAnchor="start" dominantBaseline="middle" fontSize={anchorFs} fill="#6366f1" fontFamily="sans-serif" fontWeight="600">E</text>
              <text x={-arm * 1.4} y={0} textAnchor="end" dominantBaseline="middle" fontSize={anchorFs} fill="#6366f1" fontFamily="sans-serif" fontWeight="600">W</text>
              <text x={0} y={-arm * 1.6} textAnchor="middle" dominantBaseline="auto" fontSize={anchorFs} fill="#6366f1" fontFamily="sans-serif" fontWeight="600">N</text>
              <text x={0} y={arm * 1.6} textAnchor="middle" dominantBaseline="hanging" fontSize={anchorFs} fill="#6366f1" fontFamily="sans-serif" fontWeight="600">S</text>
              <text x={arm * 1.4} y={arm * 1.4} textAnchor="start" dominantBaseline="hanging" fontSize={anchorFs * 0.8} fill="#a5b4fc" fontFamily="sans-serif">Anchor (0, 0)</text>
            </g>

            {/* Compartments */}
            {compartments.map(comp => {
              const isCompSelected = comp.id === selectedCompartmentId;
              const cw = comp.eastWestFt;
              const cl = comp.northSouthFt;
              const lfs  = Math.max(3.5, Math.min(cw, cl) * 0.09);
              const lGap = lfs * 0.85;

              return (
                <g key={comp.id}>
                  {/* Labels (outside compartment bounds — rendered before background so they stay visible) */}
                  <text x={comp.xFt+cw/2} y={comp.yFt-lGap-lfs*1.5} textAnchor="middle" dominantBaseline="auto"    fontSize={lfs*0.78} fill="#374151" fontFamily="sans-serif" fontWeight="600" pointerEvents="none">{comp.name}</text>
                  <text x={comp.xFt+cw/2} y={comp.yFt-lGap}            textAnchor="middle" dominantBaseline="auto"    fontSize={lfs} fill="#1e3a5f" fontFamily="sans-serif" fontWeight="700" pointerEvents="none">↑ N</text>
                  <text x={comp.xFt+cw/2} y={comp.yFt+cl+lGap}         textAnchor="middle" dominantBaseline="hanging" fontSize={lfs} fill="#1e3a5f" fontFamily="sans-serif" fontWeight="700" pointerEvents="none">S ↓</text>
                  <text x={comp.xFt+cw+lGap} y={comp.yFt+cl/2}         textAnchor="start"  dominantBaseline="middle"  fontSize={lfs} fill="#1e3a5f" fontFamily="sans-serif" fontWeight="700" pointerEvents="none">E →</text>
                  <text x={comp.xFt-lGap} y={comp.yFt+cl/2}            textAnchor="end"    dominantBaseline="middle"  fontSize={lfs} fill="#1e3a5f" fontFamily="sans-serif" fontWeight="700" pointerEvents="none">← W</text>
                  <text x={comp.xFt+cw/2} y={comp.yFt+cl+lGap+lfs*1.4} textAnchor="middle" dominantBaseline="hanging" fontSize={lfs*0.55} fill="#9ca3af" fontFamily="sans-serif" pointerEvents="none">{comp.eastWestFt} ft (E–W) × {comp.northSouthFt} ft (N–S)</text>

                  {/* Background — clickable to select compartment */}
                  <rect x={comp.xFt} y={comp.yFt} width={cw} height={cl}
                    fill={isCompSelected ? '#f0fdf4' : '#f9fafb'}
                    stroke={isCompSelected ? '#16a34a' : '#d1d5db'}
                    strokeWidth={isCompSelected ? 0.6 : 0.4}
                    rx={0.5}
                    style={{ cursor: readOnly ? 'default' : 'pointer' }}
                    onClick={(e) => {
                      if (hasDraggedRef.current || readOnly) return;
                      e.stopPropagation();
                      onSelectCompRef.current?.(comp.id);
                    }}
                  />

                  {/* Walkways */}
                  {comp.walkways.map(wk => {
                    const r = walkwayRect(comp, wk);
                    return <rect key={`wk-${wk.id}`} x={r.x} y={r.y} width={r.w} height={r.h}
                      fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.2}
                      shapeRendering="crispEdges" pointerEvents="none" />;
                  })}

                  {/* Row blocks */}
                  {comp.blocks.map(block => {
                    const isBlockSelected = block.id === selectedBlockId;
                    const isBlockHovered  = block.id === hoveredBlockId;
                    const s = SIDE_STYLES[block.anchorSide as CompassSide] ?? SIDE_STYLES.east;
                    const bbox = blockBBoxFromRows(block.rows);
                    return (
                      <g key={`block-${block.id}`}
                        onMouseEnter={() => { if (!isPanning) setHoveredBlockId(block.id); }}
                        onMouseLeave={() => setHoveredBlockId(null)}>
                        {bbox && !readOnly && (
                          <rect x={bbox.x} y={bbox.y} width={bbox.w} height={bbox.h}
                            fill="transparent" style={{ cursor: 'pointer' }}
                            onClick={(e) => { e.stopPropagation(); if (!hasDraggedRef.current) onSelectBlock?.(block.id, comp.id); }} />
                        )}
                        {block.rows.map(row => {
                          const r = rowToRect(row);
                          const isSel         = selectedRowIds.has(row.id);
                          const isPicked      = pickedRowIdsRef.current?.has(row.id) ?? false;
                          const isHighlighted = highlightedRowIdsRef.current?.has(row.id) ?? false;
                          const isHov         = row.id === hoveredRowId;
                          let fill: string, stroke: string, sw: number;
                          if (isPicked && isHov)         { fill = '#34d399'; stroke = '#065f46'; sw = 0.7; }
                          else if (isPicked)             { fill = '#a7f3d0'; stroke = '#059669'; sw = 0.6; }
                          else if (isHighlighted && isHov) { fill = '#93c5fd'; stroke = '#2563eb'; sw = 0.6; }
                          else if (isHighlighted)          { fill = '#dbeafe'; stroke = '#93c5fd'; sw = 0.5; }
                          else if (isSel && isHov) { fill = '#fde047'; stroke = '#b45309'; sw = 0.7; }
                          else if (isSel)          { fill = '#fef08a'; stroke = '#ca8a04'; sw = 0.6; }
                          else if (isBlockHovered || isBlockSelected) {
                            fill = s.hoverFill; stroke = isBlockSelected ? s.blockFill : s.hoverStroke; sw = isBlockSelected ? 0.6 : 0.5;
                          } else { fill = s.fill; stroke = s.stroke; sw = 0.25; }
                          const isPickMode = !!onRowPickRef.current;
                          return (
                            <rect key={row.id} x={r.x} y={r.y} width={r.w} height={r.h}
                              fill={fill} stroke={stroke} strokeWidth={sw}
                              shapeRendering="crispEdges"
                              style={{ cursor: isPickMode ? 'pointer' : readOnly ? 'default' : 'pointer' }}
                              onMouseDown={(e) => { if (e.shiftKey && !isPickMode) { e.stopPropagation(); hasDraggedRef.current = false; } }}
                              onClick={(e) => handleRowClick(row.id, e)}
                              onMouseEnter={() => { if (!isPanning) setHoveredRowId(row.id); }}
                              onMouseLeave={() => setHoveredRowId(null)} />
                          );
                        })}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Lasso */}
            {lassoBox && (() => {
              const x = Math.min(lassoBox.x1, lassoBox.x2);
              const y = Math.min(lassoBox.y1, lassoBox.y2);
              const w = Math.abs(lassoBox.x2 - lassoBox.x1);
              const h = Math.abs(lassoBox.y2 - lassoBox.y1);
              return <rect x={x} y={y} width={w} height={h}
                fill="rgba(59,130,246,0.10)" stroke="#3b82f6"
                strokeWidth={0.4} strokeDasharray="1.5 1"
                shapeRendering="crispEdges" pointerEvents="none" />;
            })()}
          </svg>
        </div>
      </div>

      {/* Controls — top right */}
      <div className="absolute top-3 right-3 flex flex-col items-center gap-1 z-10" onMouseDown={e => e.stopPropagation()}>
        <button onClick={rotateLeft}  title="Rotate left 90°"  className="w-8 h-8 flex items-center justify-center bg-white border border-gray-200 rounded-md shadow-sm text-gray-600 hover:bg-gray-50"><RotateCcw size={14} /></button>
        <button onClick={rotateRight} title="Rotate right 90°" className="w-8 h-8 flex items-center justify-center bg-white border border-gray-200 rounded-md shadow-sm text-gray-600 hover:bg-gray-50"><RotateCw  size={14} /></button>
        {rotation !== 0 && (
          <button onClick={resetRot} title="Reset rotation" className="w-8 h-5 flex items-center justify-center bg-white border border-gray-200 rounded-md shadow-sm text-gray-500 hover:bg-gray-50 text-[9px] font-semibold tabular-nums">{rotation}°</button>
        )}
        <div className="w-6 border-t border-gray-200 my-0.5" />
        <button onClick={() => zoomBy(ZOOM_BTN_FACTOR)}   disabled={zoom >= MAX_ZOOM} title="Zoom in"  className="w-8 h-8 flex items-center justify-center bg-white border border-gray-200 rounded-md shadow-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"><ZoomIn   size={14} /></button>
        <button onClick={() => zoomBy(1/ZOOM_BTN_FACTOR)} disabled={zoom <= MIN_ZOOM} title="Zoom out" className="w-8 h-8 flex items-center justify-center bg-white border border-gray-200 rounded-md shadow-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"><ZoomOut  size={14} /></button>
        <button onClick={fitToCompartments} title="Fit all compartments" className="w-8 h-8 flex items-center justify-center bg-white border border-gray-200 rounded-md shadow-sm text-gray-600 hover:bg-gray-50"><Scan      size={14} /></button>
        <button onClick={() => resetView()} title="Fit full canvas"      className="w-8 h-8 flex items-center justify-center bg-white border border-gray-200 rounded-md shadow-sm text-gray-600 hover:bg-gray-50"><Maximize2 size={14} /></button>
        <div className="text-center text-[10px] text-gray-400 font-medium tabular-nums leading-none mt-0.5">{Math.round(zoom * 100)}%</div>
      </div>

      {/* Snap indicator */}
      {snapGridFt > 0 && !readOnly && (
        <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 bg-blue-50/90 border border-blue-200 rounded-md px-2 py-1 pointer-events-none">
          <Grid3X3 size={11} className="text-blue-500" />
          <span className="text-[10px] text-blue-600 font-semibold">Snap {snapGridFt} ft</span>
        </div>
      )}

      {/* Legend — bottom left */}
      <div className="absolute bottom-3 left-3 flex flex-wrap gap-3 z-10 bg-white/85 backdrop-blur-sm border border-gray-200 rounded-lg px-3 py-2" onMouseDown={e => e.stopPropagation()}>
        {COMPASS_SIDES.map(side => {
          const s = SIDE_STYLES[side];
          return (
            <div key={side} className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm border" style={{ background: s.fill, borderColor: s.stroke }} />
              <span className="text-xs text-gray-500">{s.label}</span>
            </div>
          );
        })}
        {!readOnly && (
          <div className="flex items-center gap-1.5 border-l border-gray-200 pl-3 ml-1">
            <span className="inline-block w-3 h-3 rounded-sm border" style={{ background: '#fef08a', borderColor: '#ca8a04' }} />
            <span className="text-xs text-gray-500">Selected rows</span>
          </div>
        )}
      </div>

      {/* Compass — bottom right */}
      <div className="absolute bottom-3 right-3 z-10" onMouseDown={e => e.stopPropagation()}>
        <svg width={52} height={52} viewBox="-26 -26 52 52"
          style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 0.25s ease', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.18))' }}>
          <circle r={23} fill="white" fillOpacity={0.93} stroke="#e2e8f0" strokeWidth={1} />
          <polygon points="0,-19 -4.5,-7 4.5,-7" fill="#ef4444" />
          <polygon points="0,19 -4.5,7 4.5,7"   fill="#cbd5e1" />
          <circle r={2.8} fill="#334155" />
          <text x={0} y={-10} textAnchor="middle" dominantBaseline="middle" fontSize={7.5} fill="white" fontWeight="800" fontFamily="sans-serif" style={{ userSelect: 'none' }}>N</text>
          <line x1={0}   y1={-21} x2={0}   y2={-23} stroke="#94a3b8" strokeWidth={1.2} />
          <line x1={21}  y1={0}   x2={23}  y2={0}   stroke="#94a3b8" strokeWidth={1.2} />
          <line x1={0}   y1={21}  x2={0}   y2={23}  stroke="#94a3b8" strokeWidth={1.2} />
          <line x1={-21} y1={0}   x2={-23} y2={0}   stroke="#94a3b8" strokeWidth={1.2} />
        </svg>
      </div>

      {/* Row selection toolbar */}
      {selectedRowIds.size > 0 && !readOnly && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-gray-900/95 text-white text-xs rounded-lg px-3 py-2 shadow-xl backdrop-blur-sm whitespace-nowrap" onMouseDown={e => e.stopPropagation()}>
          <span className="font-semibold tabular-nums">{selectedRowIds.size} row{selectedRowIds.size === 1 ? '' : 's'} selected</span>
          <span className="text-gray-600">·</span>
          <button onClick={clearSelection} className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/10"><X size={11} /> Clear</button>
          <button onClick={() => onDelSelRef.current?.(selectedRowIds)} disabled={isDeleting}
            className="flex items-center gap-1.5 px-2.5 py-0.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded font-semibold">
            <Trash2 size={11} />
            {isDeleting ? 'Deleting…' : 'Delete Selected'}
          </button>
        </div>
      )}

      {/* Shift lasso hint */}
      {shiftHeld && !isLassing && !readOnly && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-gray-900/80 text-white text-xs rounded px-2.5 py-1.5 pointer-events-none">
          {selectedRowIds.size > 0 ? 'Click a row to extend the range, or drag to lasso' : 'Click a row to start a range, or drag to lasso'}
        </div>
      )}

      {/* Cross-block warning */}
      {shiftSelectMsg && !readOnly && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-20 bg-amber-900/90 text-white text-xs rounded-lg px-3 py-1.5 pointer-events-none whitespace-nowrap">{shiftSelectMsg}</div>
      )}

      {/* Row tooltip */}
      <div ref={tooltipRef}
        style={{ position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 9999, visibility: hoveredRow && !isPanning && !isLassing ? 'visible' : 'hidden' }}
        className="bg-gray-900 text-white text-xs font-medium rounded-md px-2.5 py-1.5 shadow-lg whitespace-nowrap select-none">
        {hoveredRow ? `R${String(hoveredRow.rowNumber).padStart(3, '0')}${selectedRowIds.has(hoveredRow.id) ? ' ✓' : ''}` : ''}
      </div>
    </div>
  );
});
