import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X, Trash2, ChevronDown, ChevronUp, Search, RotateCcw } from 'lucide-react';
import { greenhouseApi } from '../../../api/greenhouse';
import type {
  GreenhouseCompartmentDetail,
  GreenhouseRowBlock,
  MissingRowSlot,
} from '../../../api/greenhouse';

interface Props {
  mapId: number;
  compartment: GreenhouseCompartmentDetail;
  blockId: number;
  onDeleted: () => void;
  onDone: () => void;
  onClose: () => void;
}

const ORIENTATION_LABEL: Record<string, string> = {
  north_south: 'N ↕ S (rows run vertically)',
  east_west:   'E ↔ W (rows run horizontally)',
};

const ALONG_WALL_LABEL: Record<string, Record<string, string>> = {
  north_south: { near: 'North end', far: 'South end', centered: 'Centered', custom: 'Custom' },
  east_west:   { near: 'West end',  far: 'East end',  centered: 'Centered', custom: 'Custom' },
};

const SIDE_COLOR: Record<string, string> = {
  east:  'text-blue-700 bg-blue-50',
  west:  'text-green-700 bg-green-50',
  north: 'text-violet-700 bg-violet-50',
  south: 'text-orange-700 bg-orange-50',
};

// ── Restore sub-panel ─────────────────────────────────────────────────────────

interface RestoreFormProps {
  mapId: number;
  compartmentId: number;
  blockId: number;
  slot: MissingRowSlot;
  onRestored: () => void;
  onCancel: () => void;
}

function RestoreForm({ mapId, compartmentId, blockId, slot, onRestored, onCancel }: RestoreFormProps) {
  const [rowNum, setRowNum] = useState(
    slot.inferredRowNumber != null ? String(slot.inferredRowNumber) : '',
  );
  const [err, setErr] = useState<string | null>(null);

  const restoreMut = useMutation({
    mutationFn: () => {
      const n = parseInt(rowNum, 10);
      if (!n || n < 1) throw new Error('Enter a valid row number');
      return greenhouseApi.insertRow(mapId, compartmentId, blockId, {
        rowNumber:   n,
        xFt:         slot.xFt,
        yFt:         slot.yFt,
        widthFt:     slot.widthFt,
        lengthFt:    slot.lengthFt,
        orientation: slot.orientation,
      });
    },
    onSuccess: onRestored,
    onError: (e: Error) => {
      const msg = e.message.replace(/^API \d+: /, '').replace(/^\{"error":"/, '').replace(/"\}$/, '');
      setErr(msg);
    },
  });

  return (
    <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2.5">
      <p className="text-xs font-semibold text-amber-800">Restore row at this position</p>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
        <div>
          <span className="text-gray-400">x&nbsp;</span>
          <span className="font-mono">{slot.xFt.toFixed(2)} ft</span>
        </div>
        <div>
          <span className="text-gray-400">y&nbsp;</span>
          <span className="font-mono">{slot.yFt.toFixed(2)} ft</span>
        </div>
        <div>
          <span className="text-gray-400">width&nbsp;</span>
          <span className="font-mono">{slot.widthFt} ft</span>
        </div>
        <div>
          <span className="text-gray-400">length&nbsp;</span>
          <span className="font-mono">{slot.lengthFt} ft</span>
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Row number</label>
        <input
          type="number"
          min={1}
          value={rowNum}
          onChange={e => { setRowNum(e.target.value); setErr(null); }}
          className="w-full border border-gray-300 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
          placeholder="e.g. 79"
        />
        {slot.inferredRowNumber != null && (
          <p className="text-xs text-amber-700 mt-1">
            Detected as Row {slot.inferredRowNumber} based on neighbouring rows
          </p>
        )}
      </div>

      {err && <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">{err}</p>}

      <div className="flex gap-2 pt-0.5">
        <button
          onClick={() => restoreMut.mutate()}
          disabled={restoreMut.isPending || !rowNum}
          className="flex-1 px-3 py-1.5 text-xs font-semibold bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-md transition-colors"
        >
          {restoreMut.isPending ? 'Restoring…' : 'Restore Row'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 rounded-md border border-gray-200 hover:border-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Missing rows panel ────────────────────────────────────────────────────────

interface MissingRowsPanelProps {
  mapId: number;
  compartmentId: number;
  blockId: number;
  onRestored: () => void;
  onClose: () => void;
}

function MissingRowsPanel({ mapId, compartmentId, blockId, onRestored, onClose }: MissingRowsPanelProps) {
  const [selectedSlot, setSelectedSlot] = useState<MissingRowSlot | null>(null);
  const [restoredCount, setRestoredCount] = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['missing-rows', mapId, compartmentId, blockId, restoredCount],
    queryFn: () => greenhouseApi.getMissingRows(mapId, compartmentId, blockId),
  });

  const missing = data?.missing ?? [];

  const handleRestored = () => {
    setSelectedSlot(null);
    setRestoredCount(c => c + 1);
    onRestored();
  };

  if (isLoading) {
    return (
      <div className="py-4 text-center text-xs text-gray-400">Scanning for missing rows…</div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">
          {(error as Error).message}
        </p>
        <button onClick={() => refetch()} className="text-xs text-gray-500 underline">
          Retry
        </button>
      </div>
    );
  }

  if (missing.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-700">Missing Row Slots</p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={13} /></button>
        </div>
        <p className="text-xs text-green-700 bg-green-50 rounded-md px-3 py-2">
          No missing slots detected — all expected positions are occupied.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-700">
          {missing.length} missing slot{missing.length === 1 ? '' : 's'} detected
        </p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={13} /></button>
      </div>

      <div className="space-y-2 max-h-60 overflow-y-auto">
        {missing.map((slot, idx) => {
          const isSelected = selectedSlot === slot;
          const label = slot.inferredRowNumber != null
            ? `Missing Row ${slot.inferredRowNumber}`
            : `Empty slot between R${slot.neighborRowNumbers[0]} and R${slot.neighborRowNumbers[1]}`;

          return (
            <div key={idx} className="space-y-2">
              <button
                type="button"
                onClick={() => setSelectedSlot(isSelected ? null : slot)}
                className={`w-full text-left rounded-lg px-3 py-2.5 border text-xs transition-colors ${
                  isSelected
                    ? 'border-amber-400 bg-amber-50'
                    : 'border-gray-200 bg-gray-50 hover:border-amber-300 hover:bg-amber-50/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-800">{label}</span>
                  <span className="text-gray-400">{isSelected ? '▴' : '▾'}</span>
                </div>
                <div className="text-gray-400 mt-0.5">
                  y = {slot.yFt.toFixed(2)} ft · between R{slot.neighborRowNumbers[0]} &amp; R{slot.neighborRowNumbers[1]}
                </div>
              </button>

              {isSelected && (
                <RestoreForm
                  mapId={mapId}
                  compartmentId={compartmentId}
                  blockId={blockId}
                  slot={slot}
                  onRestored={handleRestored}
                  onCancel={() => setSelectedSlot(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function BlockDetailPanel({ mapId, compartment, blockId, onDeleted, onDone, onClose }: Props) {
  const [showRows,       setShowRows]       = useState(false);
  const [showMissing,    setShowMissing]    = useState(false);
  const [deleteErr,      setDeleteErr]      = useState<string | null>(null);

  const block = compartment.blocks.find((b: GreenhouseRowBlock) => b.id === blockId) ?? null;

  const deleteMut = useMutation({
    mutationFn: () => greenhouseApi.deleteBlock(mapId, compartment.id, blockId),
    onSuccess: onDeleted,
    onError: (e: Error) => {
      const msg = e.message.replace(/^API \d+: /, '').replace(/^\{"error":"/, '').replace(/"\}$/, '');
      setDeleteErr(msg);
    },
  });

  if (!block) {
    return (
      <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-20">
        <div className="bg-white rounded-xl shadow-xl p-6 w-80">
          <p className="text-sm text-gray-500">Block not found.</p>
          <button onClick={onClose} className="mt-3 text-xs text-gray-400 hover:text-gray-600">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-20">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 overflow-hidden max-h-[88vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Row Block</h3>
            <p className="text-xs text-gray-400 mt-0.5">{compartment.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Anchor side badge */}
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${SIDE_COLOR[block.anchorSide] ?? ''}`}>
              {block.anchorSide.charAt(0).toUpperCase() + block.anchorSide.slice(1)} anchor
            </span>
            <span className="text-xs text-gray-400">{ORIENTATION_LABEL[block.orientation]}</span>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-lg px-3 py-2.5">
              <p className="text-xs text-gray-400">Rows</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{block.rows.length}</p>
            </div>
            <div className="bg-gray-50 rounded-lg px-3 py-2.5">
              <p className="text-xs text-gray-400">Offset from wall</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{block.offsetFt} ft</p>
            </div>
            <div className="bg-gray-50 rounded-lg px-3 py-2.5">
              <p className="text-xs text-gray-400">Row width × length</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{block.rowWidthFt} × {block.rowLengthFt} ft</p>
            </div>
            <div className="bg-gray-50 rounded-lg px-3 py-2.5">
              <p className="text-xs text-gray-400">Spacing between rows</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{block.rowSpacingFt} ft</p>
            </div>
            <div className="bg-gray-50 rounded-lg px-3 py-2.5 col-span-2">
              <p className="text-xs text-gray-400">Along-wall start</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">
                {ALONG_WALL_LABEL[block.orientation]?.[block.alongWallStart] ?? 'Near end'}
                {block.alongWallStart !== 'centered' && block.alongWallOffsetFt > 0
                  ? <span className="font-normal text-gray-500"> · {block.alongWallOffsetFt} ft gap</span>
                  : null}
              </p>
            </div>
          </div>

          {/* Row list toggle */}
          {block.rows.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowRows(v => !v)}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
              >
                {showRows ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {showRows ? 'Hide' : 'Show'} row numbers
              </button>
              {showRows && (
                <div className="mt-2 flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                  {block.rows.map(r => (
                    <span key={r.id} className="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600 font-mono">
                      R{String(r.rowNumber).padStart(3, '0')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Find Missing Rows */}
          {showMissing ? (
            <div className="border border-amber-200 rounded-lg p-3">
              <MissingRowsPanel
                mapId={mapId}
                compartmentId={compartment.id}
                blockId={blockId}
                onRestored={() => { onDone(); }}
                onClose={() => setShowMissing(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowMissing(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-amber-700 border border-amber-200 rounded-md hover:bg-amber-50 transition-colors"
            >
              <Search size={12} />
              Find Missing Rows
            </button>
          )}

          {deleteErr && (
            <p className="text-xs text-red-600 bg-red-50 rounded-md px-3 py-2">{deleteErr}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100">
          <button
            onClick={() => {
              if (confirm(`Delete this block and all ${block.rows.length} row${block.rows.length === 1 ? '' : 's'}?`)) {
                deleteMut.mutate();
              }
            }}
            disabled={deleteMut.isPending}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={13} />
            {deleteMut.isPending ? 'Deleting…' : 'Delete Block'}
          </button>
        </div>
      </div>
    </div>
  );
}
