import { useState, useEffect } from 'react';
import { X, Check, ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { greenhouseApi } from '../../api/greenhouse';
import { GreenhouseCanvas } from '../greenhouse/components/GreenhouseCanvas';

interface Props {
  cropName: string;
  initialRowIds?: Set<number>;
  onConfirm: (rowIds: Set<number>) => void;
  onCancel: () => void;
}

export function CropMapPickerModal({ cropName, initialRowIds, onConfirm, onCancel }: Props) {
  const [selectedMapId, setSelectedMapId] = useState<number | null>(null);
  const [pickedRowIds, setPickedRowIds]   = useState<Set<number>>(new Set(initialRowIds ?? []));

  const { data: maps = [], isLoading: mapsLoading } = useQuery({
    queryKey: ['greenhouse-maps'],
    queryFn: () => greenhouseApi.listMaps(),
  });

  const { data: mapDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['greenhouse-map', selectedMapId],
    queryFn: () => greenhouseApi.getMap(selectedMapId!),
    enabled: selectedMapId != null,
  });

  // Auto-select first map once data arrives
  useEffect(() => {
    if (selectedMapId == null && maps.length > 0) {
      setSelectedMapId(maps[0].id);
    }
  }, [maps, selectedMapId]);

  function handleRowPick(rowId: number) {
    setPickedRowIds(prev => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* Top bar */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <button
          onClick={onCancel}
          className="p-1.5 text-gray-400 hover:text-gray-600 rounded transition-colors"
          title="Cancel"
        >
          <X size={16} />
        </button>
        <div className="text-sm font-semibold text-gray-900 flex-1">
          Link rows — <span className="font-normal text-gray-500">{cropName}</span>
        </div>

        {maps.length > 1 && (
          <div className="relative">
            <select
              value={selectedMapId ?? ''}
              onChange={e => setSelectedMapId(parseInt(e.target.value, 10))}
              className="appearance-none pl-3 pr-7 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              {maps.map(m => (
                <option key={m.id} value={m.id}>{m.siteName} — {m.name}</option>
              ))}
            </select>
            <ChevronDown size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          </div>
        )}

        {pickedRowIds.size > 0 && (
          <button
            onClick={() => setPickedRowIds(new Set())}
            className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors"
          >
            Clear all
          </button>
        )}

        <span className="text-sm text-gray-500 tabular-nums">
          {pickedRowIds.size === 0
            ? 'No rows selected'
            : `${pickedRowIds.size} row${pickedRowIds.size !== 1 ? 's' : ''} selected`}
        </span>

        <button
          onClick={() => onConfirm(pickedRowIds)}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors"
        >
          <Check size={13} />
          Save
        </button>
      </div>

      {/* Hint bar */}
      <div className="px-5 py-1.5 bg-emerald-50 border-b border-emerald-100 text-xs text-emerald-700 flex-shrink-0">
        Click rows to select or deselect them. Selected rows are shown in green.
      </div>

      {/* Map canvas */}
      <div className="flex-1 flex overflow-hidden">
        {mapsLoading && (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading maps…</div>
        )}
        {!mapsLoading && maps.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">No greenhouse maps found.</div>
        )}
        {!mapsLoading && maps.length > 0 && selectedMapId != null && (
          detailLoading ? (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading map…</div>
          ) : mapDetail ? (
            <GreenhouseCanvas
              compartments={mapDetail.compartments}
              northExtentFt={mapDetail.northExtentFt}
              southExtentFt={mapDetail.southExtentFt}
              eastExtentFt={mapDetail.eastExtentFt}
              westExtentFt={mapDetail.westExtentFt}
              readOnly
              pickedRowIds={pickedRowIds}
              onRowPick={handleRowPick}
            />
          ) : null
        )}
      </div>
    </div>
  );
}
