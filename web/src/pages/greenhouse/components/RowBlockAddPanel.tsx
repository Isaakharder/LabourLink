import { useState, useEffect, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { greenhouseApi } from '../../../api/greenhouse';
import type {
  GreenhouseCompartmentDetail,
  RowOrientation,
  CompassSide,
  PlacementMode,
  FilterMode,
  AlongWallStart,
} from '../../../api/greenhouse';
import { blockActualDepth } from '../../../lib/greenhouse-geometry';
import {
  blockRowRect,
  blockAlongWallSpan,
  rangesOverlap,
  type BlockGeom,
  type CompGeom,
} from '@shared/greenhouse-geometry';

interface Props {
  mapId: number;
  compartment: GreenhouseCompartmentDetail;
  onDone: () => void;
  onClose: () => void;
}

// Which anchor sides are valid for each orientation
const ANCHOR_OPTIONS: Record<RowOrientation, CompassSide[]> = {
  north_south: ['east', 'west'],
  east_west:   ['north', 'south'],
};

const SIDE_ACTIVE: Record<CompassSide, string> = {
  north: 'border-violet-400 bg-violet-50 text-violet-700 font-semibold',
  south: 'border-orange-400 bg-orange-50 text-orange-700 font-semibold',
  east:  'border-blue-400 bg-blue-50 text-blue-700 font-semibold',
  west:  'border-green-400 bg-green-50 text-green-700 font-semibold',
};

const SIDE_HELP: Record<CompassSide, string> = {
  north: 'First row abuts the North (top) wall, additional rows extend inward.',
  south: 'First row abuts the South (bottom) wall, additional rows extend inward.',
  east:  'First row abuts the East (right) wall, additional rows extend inward.',
  west:  'First row abuts the West (left) wall, additional rows extend inward.',
};

const ALONG_WALL_OPTIONS: Record<RowOrientation, { value: AlongWallStart; label: string }[]> = {
  north_south: [
    { value: 'near',     label: 'North end' },
    { value: 'far',      label: 'South end' },
    { value: 'centered', label: 'Centered'  },
    { value: 'custom',   label: 'Custom'    },
  ],
  east_west: [
    { value: 'near',     label: 'West end'  },
    { value: 'far',      label: 'East end'  },
    { value: 'centered', label: 'Centered'  },
    { value: 'custom',   label: 'Custom'    },
  ],
};

const ALONG_WALL_OFFSET_LABEL: Record<RowOrientation, Record<AlongWallStart, string>> = {
  north_south: {
    near:     'Gap from North wall (ft)',
    far:      'Gap from South wall (ft)',
    centered: '',
    custom:   'Offset from North wall (ft)',
  },
  east_west: {
    near:     'Gap from West wall (ft)',
    far:      'Gap from East wall (ft)',
    centered: '',
    custom:   'Offset from West wall (ft)',
  },
};

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white ' +
  'placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1.5';

function previewCount(start: string, end: string, filter: FilterMode): number {
  const s = parseInt(start, 10);
  const e = parseInt(end, 10);
  if (isNaN(s) || isNaN(e) || e < s || s < 1) return 0;
  if (filter === 'all') return e - s + 1;
  const odd = Math.floor((e + 1) / 2) - Math.floor(s / 2);
  return filter === 'odd' ? odd : (e - s + 1) - odd;
}

const SVG_W = 248, SVG_H = 120, PAD = 12;

export function RowBlockAddPanel({ mapId, compartment, onDone, onClose }: Props) {
  const [orientation, setOrientation]         = useState<RowOrientation>('north_south');
  const [anchorSide, setAnchorSide]           = useState<CompassSide>('east');
  const [alongWallStart, setAlongWallStart]   = useState<AlongWallStart>('near');
  const [alongWallOffsetFt, setAlongWallOffsetFt] = useState('0');
  const [placement, setPlacement]             = useState<PlacementMode>('edge');
  const [offsetFt, setOffsetFt]               = useState('0');
  const [startRow, setStartRow]               = useState('1');
  const [endRow, setEndRow]                   = useState('');
  const [filter, setFilter]                   = useState<FilterMode>('all');
  const [rowWidthFt, setRowWidthFt]           = useState('4');
  const [rowLengthFt, setRowLengthFt]         = useState('');
  const [rowSpacingFt, setRowSpacingFt]       = useState('0');
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Auto-fill row length from compartment when orientation changes
  useEffect(() => {
    const len = orientation === 'north_south' ? compartment.northSouthFt : compartment.eastWestFt;
    setRowLengthFt(String(len));
    const valid = ANCHOR_OPTIONS[orientation];
    if (!valid.includes(anchorSide)) setAnchorSide(valid[0]);
    setResult(null);
    setErr(null);
  }, [orientation]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setResult(null); setErr(null); }, [anchorSide, alongWallStart]);

  // ── Continuation offset (2D-overlap-aware) ─────────────────────────────────
  //
  // For 'continue' placement: find all same-anchor same-orientation blocks whose
  // along-wall span intersects ours, then place immediately after the deepest one.
  const effectiveOffsetFt = useMemo((): number => {
    if (placement === 'custom_offset') return parseFloat(offsetFt) || 0;
    if (placement !== 'continue')      return 0;

    const rL = parseFloat(rowLengthFt) || 0;
    const rW = parseFloat(rowWidthFt)  || 0;
    if (!rL || !rW) return 0;

    // Use compartment origin (0,0) for preview geometry
    const compGeom: CompGeom = {
      x_ft: 0, y_ft: 0,
      east_west_ft:   compartment.eastWestFt,
      north_south_ft: compartment.northSouthFt,
    };

    const newBlockGeom: BlockGeom = {
      orientation,
      anchor_side:          anchorSide,
      offset_ft:            0, // irrelevant for span calculation
      row_width_ft:         rW,
      row_length_ft:        rL,
      row_spacing_ft:       parseFloat(rowSpacingFt) || 0,
      along_wall_start:     alongWallStart,
      along_wall_offset_ft: parseFloat(alongWallOffsetFt) || 0,
    };

    const newBlockSpan = blockAlongWallSpan(compGeom, newBlockGeom);

    let maxDepth = 0;
    for (const b of compartment.blocks) {
      if (b.anchorSide !== anchorSide || b.orientation !== orientation) continue;
      if (!b.rows.length) continue;

      // Filter by along-wall span overlap (block-level property, unchanged by deletions)
      const existingGeom: BlockGeom = {
        orientation:          b.orientation,
        anchor_side:          b.anchorSide,
        offset_ft:            0,  // irrelevant for span calculation
        row_width_ft:         0,
        row_length_ft:        b.rowLengthFt,
        row_spacing_ft:       0,
        along_wall_start:     b.alongWallStart,
        along_wall_offset_ft: b.alongWallOffsetFt,
      };

      const existingSpan = blockAlongWallSpan(compGeom, existingGeom);
      if (!rangesOverlap(newBlockSpan, existingSpan)) continue;

      // Use actual stored row coords — correct even when rows have been deleted
      const depth = blockActualDepth(b.anchorSide, b.rows, compartment);
      if (depth > maxDepth) maxDepth = depth;
    }

    return maxDepth;
  }, [
    placement, orientation, anchorSide, alongWallStart, alongWallOffsetFt,
    rowLengthFt, rowWidthFt, rowSpacingFt, offsetFt, compartment,
  ]);

  const mutation = useMutation({
    mutationFn: () =>
      greenhouseApi.addBlock(mapId, compartment.id, {
        orientation,
        anchorSide,
        placementMode:     placement,
        offsetFt:          placement === 'custom_offset' ? parseFloat(offsetFt) : 0,
        startRow:          parseInt(startRow, 10),
        endRow:            parseInt(endRow, 10),
        filter,
        rowWidthFt:        parseFloat(rowWidthFt),
        rowLengthFt:       parseFloat(rowLengthFt),
        rowSpacingFt:      parseFloat(rowSpacingFt) || 0,
        alongWallStart,
        alongWallOffsetFt: alongWallStart !== 'centered' ? parseFloat(alongWallOffsetFt) || 0 : 0,
      }),
    onSuccess: (data) => {
      setResult({ created: data.created, skipped: data.skipped });
      setErr(null);
      onDone();
    },
    onError: (e: Error) => {
      const msg = e.message.replace(/^API \d+: /, '').replace(/^\{"error":"/, '').replace(/"\}$/, '');
      setErr(msg);
    },
  });

  const preview  = previewCount(startRow, endRow, filter);
  const step     = parseFloat(rowWidthFt || '0') + parseFloat(rowSpacingFt || '0');
  const totalFt  = preview > 0 && step > 0 ? parseFloat(rowWidthFt || '0') + (preview - 1) * step : 0;

  // Perpendicular dimension (across the anchor wall) and along-wall dimension
  const perpDim  = orientation === 'north_south' ? compartment.eastWestFt   : compartment.northSouthFt;
  const wallDim  = orientation === 'north_south' ? compartment.northSouthFt : compartment.eastWestFt;
  const awOffFt  = parseFloat(alongWallOffsetFt) || 0;
  const rLenFt   = parseFloat(rowLengthFt) || 0;

  // For 'continue', existingDepth = effectiveOffsetFt; new block stacks after it.
  const existingDepth    = placement === 'continue' ? effectiveOffsetFt : 0;
  const finalExtent      = effectiveOffsetFt + totalFt;

  const wouldOverflowPerp  = finalExtent > perpDim;
  const wouldOverflowAlong = alongWallStart !== 'centered' && (rLenFt + awOffFt) > wallDim;
  const wouldOverflow      = wouldOverflowPerp || wouldOverflowAlong;

  const canSubmit =
    Boolean(startRow) && Boolean(endRow) && Boolean(rowWidthFt) && Boolean(rowLengthFt) &&
    !mutation.isPending && preview > 0 && !wouldOverflow;

  // ── Mini SVG preview ────────────────────────────────────────────────────────
  const previewRect = useMemo(() => {
    const rW = parseFloat(rowWidthFt) || 0;
    const rL = parseFloat(rowLengthFt) || 0;
    if (!rW || !rL || preview < 1) return null;

    const compGeom: CompGeom = {
      x_ft: 0, y_ft: 0,
      east_west_ft:   compartment.eastWestFt,
      north_south_ft: compartment.northSouthFt,
    };

    const blockGeom: BlockGeom = {
      orientation,
      anchor_side:          anchorSide,
      offset_ft:            effectiveOffsetFt,
      row_width_ft:         rW,
      row_length_ft:        rL,
      row_spacing_ft:       parseFloat(rowSpacingFt) || 0,
      along_wall_start:     alongWallStart,
      along_wall_offset_ft: alongWallStart !== 'centered' ? (parseFloat(alongWallOffsetFt) || 0) : 0,
    };

    const first = blockRowRect(compGeom, blockGeom, 0);
    const last  = blockRowRect(compGeom, blockGeom, preview - 1);
    const bx = Math.min(first.x, last.x);
    const by = Math.min(first.y, last.y);
    return {
      blockX: bx,
      blockY: by,
      blockW: Math.max(first.x + first.w, last.x + last.w) - bx,
      blockH: Math.max(first.y + first.h, last.y + last.h) - by,
    };
  }, [
    orientation, anchorSide, effectiveOffsetFt,
    rowWidthFt, rowLengthFt, rowSpacingFt,
    alongWallStart, alongWallOffsetFt,
    preview, compartment,
  ]);

  const scale = Math.min((SVG_W - 2 * PAD) / compartment.eastWestFt, (SVG_H - 2 * PAD) / compartment.northSouthFt);
  const cw = compartment.eastWestFt * scale;
  const cl = compartment.northSouthFt * scale;
  const ox = PAD + (SVG_W - 2 * PAD - cw) / 2;
  const oy = PAD + (SVG_H - 2 * PAD - cl) / 2;

  return (
    <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-20">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Add Row Block</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {compartment.name} — {compartment.eastWestFt} ft E↔W × {compartment.northSouthFt} ft N↕S
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* ① Row Orientation */}
          <div>
            <label className={labelCls}>① Row Orientation</label>
            <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
              <button
                type="button"
                onClick={() => setOrientation('north_south')}
                className={`flex-1 px-3 py-2 transition-colors ${orientation === 'north_south' ? 'bg-gray-800 text-white font-medium' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                N ↕ S — rows run vertically
              </button>
              <button
                type="button"
                onClick={() => setOrientation('east_west')}
                className={`flex-1 px-3 py-2 border-l border-gray-200 transition-colors ${orientation === 'east_west' ? 'bg-gray-800 text-white font-medium' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                E ↔ W — rows run horizontally
              </button>
            </div>
            <p className="mt-1.5 text-xs text-gray-400 px-0.5">
              {orientation === 'north_south'
                ? 'Rows run north-to-south (tall strips). Stack east↔west across the compartment.'
                : 'Rows run east-to-west (wide strips). Stack north↔south across the compartment.'}
            </p>
          </div>

          {/* ② Anchor Wall */}
          <div>
            <label className={labelCls}>② Anchor Wall</label>
            <div className="grid grid-cols-2 gap-1.5">
              {ANCHOR_OPTIONS[orientation].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setAnchorSide(s)}
                  className={`px-2 py-2 text-xs rounded-md border transition-colors ${
                    anchorSide === s ? SIDE_ACTIVE[s] : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-600 px-0.5">{SIDE_HELP[anchorSide]}</p>
            <p className="mt-0.5 text-xs text-gray-400 px-0.5">True greenhouse side — unaffected by map rotation.</p>
          </div>

          {/* ③ Along-Wall Start */}
          <div>
            <label className={labelCls}>
              ③ Along-Wall Start
              <span className="ml-1 font-normal text-gray-400">
                — where along the {orientation === 'north_south' ? 'E/W' : 'N/S'} wall the block begins
              </span>
            </label>
            <div className="grid grid-cols-4 gap-1">
              {ALONG_WALL_OPTIONS[orientation].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAlongWallStart(opt.value)}
                  className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                    alongWallStart === opt.value
                      ? 'bg-gray-800 text-white border-gray-800 font-medium'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {alongWallStart !== 'centered' && (
              <div className="mt-2">
                <p className="text-xs text-gray-400 mb-1">
                  {ALONG_WALL_OFFSET_LABEL[orientation][alongWallStart]}
                </p>
                <input
                  type="number" min={0} step={0.5} value={alongWallOffsetFt}
                  onChange={(e) => setAlongWallOffsetFt(e.target.value)}
                  className={inputCls}
                />
              </div>
            )}

            <p className="mt-1.5 text-xs text-gray-400 px-0.5">
              {orientation === 'north_south' ? (
                alongWallStart === 'near'     ? 'Block starts at the North (top) end of the compartment.'
                : alongWallStart === 'far'    ? 'Block starts at the South (bottom) end — leaves a gap at the top.'
                : alongWallStart === 'centered' ? 'Block is centered between North and South walls.'
                                              : 'Block starts at an exact distance from the North wall.'
              ) : (
                alongWallStart === 'near'     ? 'Block starts at the West (left) end of the compartment.'
                : alongWallStart === 'far'    ? 'Block starts at the East (right) end — leaves a gap at the left.'
                : alongWallStart === 'centered' ? 'Block is centered between West and East walls.'
                                              : 'Block starts at an exact distance from the West wall.'
              )}
            </p>
          </div>

          {/* ④ Placement from anchor wall */}
          <div>
            <label className={labelCls}>④ Placement from Anchor Wall</label>
            <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
              {(['edge', 'continue', 'custom_offset'] as PlacementMode[]).map((m, idx) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPlacement(m)}
                  className={`flex-1 px-2 py-2 transition-colors ${
                    placement === m ? 'bg-gray-800 text-white font-medium' : 'text-gray-500 hover:bg-gray-50'
                  } ${idx > 0 ? 'border-l border-gray-200' : ''}`}
                >
                  {m === 'edge' ? 'At wall' : m === 'continue' ? 'After existing' : 'Custom offset'}
                </button>
              ))}
            </div>
            {placement === 'custom_offset' && (
              <div className="mt-2">
                <p className="text-xs text-gray-400 mb-1">Offset from anchor wall (ft)</p>
                <input
                  type="number" min={0} step={0.5} value={offsetFt}
                  onChange={(e) => setOffsetFt(e.target.value)}
                  className={inputCls}
                />
              </div>
            )}
            {placement === 'continue' && (
              <p className="mt-1.5 text-xs text-blue-600 px-0.5">
                Only counts existing {anchorSide}-anchored blocks whose along-wall span overlaps this block's position.
              </p>
            )}
          </div>

          {/* ⑤ Row Numbers */}
          <div>
            <label className={labelCls}>⑤ Row Numbers</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-400 mb-1">Start</p>
                <input type="number" min={1} value={startRow} onChange={(e) => setStartRow(e.target.value)} className={inputCls} />
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">End</p>
                <input type="number" min={1} value={endRow} onChange={(e) => setEndRow(e.target.value)} className={inputCls} />
              </div>
            </div>
          </div>

          {/* Pattern */}
          <div>
            <label className={labelCls}>Pattern</label>
            <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
              {(['all', 'odd', 'even'] as FilterMode[]).map((f, idx) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`flex-1 px-3 py-2 transition-colors ${
                    filter === f ? 'bg-gray-800 text-white font-medium' : 'text-gray-500 hover:bg-gray-50'
                  } ${idx > 0 ? 'border-l border-gray-200' : ''}`}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* ⑥ Row Dimensions */}
          <div>
            <label className={labelCls}>⑥ Row Dimensions</label>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-gray-400 mb-1">Width (ft)</p>
                <input type="number" min={0.5} step={0.5} value={rowWidthFt} onChange={(e) => setRowWidthFt(e.target.value)} className={inputCls} />
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Length (ft)</p>
                <input type="number" min={1} value={rowLengthFt} onChange={(e) => setRowLengthFt(e.target.value)} className={inputCls} />
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Spacing (ft)</p>
                <input type="number" min={0} step={0.5} value={rowSpacingFt} onChange={(e) => setRowSpacingFt(e.target.value)} className={inputCls} />
              </div>
            </div>
            <p className="mt-1.5 text-xs text-gray-400 px-0.5">
              Width = depth into compartment · Length = along the row direction · Spacing = gap between rows
            </p>
          </div>

          {/* Mini SVG Preview — shows ACTUAL computed position (including continuation offset) */}
          <div>
            <label className={labelCls}>Preview</label>
            <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
              <svg width={SVG_W} height={SVG_H} className="w-full" style={{ display: 'block' }}>
                {/* Compartment outline */}
                <rect x={ox} y={oy} width={cw} height={cl}
                  fill="white" stroke="#d1d5db" strokeWidth={1} />

                {/* Row block bounding box */}
                {previewRect && (() => {
                  const bx = ox + previewRect.blockX * scale;
                  const by = oy + previewRect.blockY * scale;
                  const bw = Math.max(1, previewRect.blockW * scale);
                  const bh = Math.max(1, previewRect.blockH * scale);
                  return (
                    <rect x={bx} y={by} width={bw} height={bh}
                      fill="rgba(16,185,129,0.25)" stroke="#059669" strokeWidth={1} rx={1} />
                  );
                })()}

                {/* Compass labels */}
                <text x={ox + cw / 2} y={oy - 3} textAnchor="middle" fontSize={8} fill="#6b7280">N</text>
                <text x={ox + cw / 2} y={oy + cl + 9} textAnchor="middle" fontSize={8} fill="#6b7280">S</text>
                <text x={ox - 4}      y={oy + cl / 2} textAnchor="end"    fontSize={8} fill="#6b7280" dominantBaseline="middle">W</text>
                <text x={ox + cw + 4} y={oy + cl / 2} textAnchor="start"  fontSize={8} fill="#6b7280" dominantBaseline="middle">E</text>
              </svg>
            </div>
          </div>

          {/* Preview summary / status card */}
          {preview > 0 && !result && (
            <div className={`rounded-md px-3 py-2.5 text-xs space-y-0.5 ${wouldOverflow ? 'bg-orange-50' : 'bg-emerald-50'}`}>
              <p className={wouldOverflow ? 'text-orange-800' : 'text-emerald-800'}>
                <strong>{preview} rows</strong> · anchored to <strong>{anchorSide}</strong> wall
                {' · '}<strong>{rowWidthFt}</strong> × <strong>{rowLengthFt}</strong> ft each
                {parseFloat(rowSpacingFt) > 0 ? ` · ${rowSpacingFt} ft spacing` : ''}
              </p>

              {placement === 'continue' ? (
                <>
                  <p className="text-gray-500">
                    Existing occupied depth: <strong>{existingDepth.toFixed(1)} ft</strong>
                  </p>
                  <p className="text-gray-500">
                    New block depth: <strong>{totalFt.toFixed(1)} ft</strong>
                  </p>
                  <p className={wouldOverflowPerp ? 'text-orange-600 font-medium' : 'text-emerald-700'}>
                    Final extent from {anchorSide} wall: <strong>{finalExtent.toFixed(1)} ft</strong> / {perpDim} ft available
                  </p>
                </>
              ) : (
                <>
                  <p className={`mt-0.5 ${wouldOverflowPerp ? 'text-orange-600 font-medium' : 'text-emerald-700'}`}>
                    Depth across wall: {finalExtent.toFixed(1)} ft / {perpDim} ft available
                  </p>
                  {rLenFt > 0 && (
                    <p className={`mt-0.5 ${wouldOverflowAlong ? 'text-orange-600 font-medium' : 'text-emerald-700'}`}>
                      Length along wall: {rLenFt} ft
                      {alongWallStart !== 'centered' && awOffFt > 0 ? ` + ${awOffFt} ft gap` : ''}
                      {' / '}{wallDim} ft available
                    </p>
                  )}
                </>
              )}

              {wouldOverflow && (
                <p className="text-orange-700 font-medium pt-0.5">
                  Block exceeds compartment bounds — adjust dimensions before adding.
                </p>
              )}
            </div>
          )}

          {result && (
            <p className="text-xs text-emerald-700 bg-emerald-50 rounded-md px-3 py-2">
              Added {result.created} rows{result.skipped > 0 ? `, ${result.skipped} already existed` : ''}.
            </p>
          )}

          {err && (
            <p className="text-xs text-red-600 bg-red-50 rounded-md px-3 py-2">{err}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex items-center gap-3 flex-shrink-0">
          <button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Check size={13} />
            {mutation.isPending ? 'Adding…' : `Add${preview > 0 ? ` ${preview}` : ''} Rows`}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
