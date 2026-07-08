import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Check, ChevronDown, AlertCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { greenhouseApi } from '../../api/greenhouse';
import { cropsApi } from '../../api/crops';
import { GreenhouseCanvas } from '../greenhouse/components/GreenhouseCanvas';

export interface DensitySaveData {
  rowIds: number[];
  plantCount: number;
  name: string;
}

interface Props {
  cropId: number;
  cropName: string;
  onConfirm: (data: DensitySaveData) => void;
  onCancel: () => void;
}

export function CropDensityPickerModal({ cropId, cropName, onConfirm, onCancel }: Props) {
  const [selectedMapId, setSelectedMapId] = useState<number | null>(null);
  const [pickedRowIds,  setPickedRowIds]  = useState<Set<number>>(new Set());
  const [plantCount,    setPlantCount]    = useState('');
  const [name,          setName]          = useState('');
  const [warnMsg,       setWarnMsg]       = useState<string | null>(null);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load crop locations to know which rows are available for density setup
  const { data: locations = [], isLoading: locsLoading } = useQuery({
    queryKey: ['crop-locations', cropId],
    queryFn: () => cropsApi.listLocations(cropId),
  });

  // Stable set of linked row IDs and their areas
  const linkedRowIds = useMemo(
    () => new Set(locations.map(l => l.rowId)),
    [locations],
  );
  const rowAreaMap = useMemo(
    () => new Map(locations.map(l => [l.rowId, Number(l.areaM2)])),
    [locations],
  );

  // Load greenhouse maps list
  const { data: maps = [], isLoading: mapsLoading } = useQuery({
    queryKey: ['greenhouse-maps'],
    queryFn: () => greenhouseApi.listMaps(),
  });

  // Auto-select first map
  useEffect(() => {
    if (selectedMapId == null && maps.length > 0) {
      setSelectedMapId(maps[0].id);
    }
  }, [maps, selectedMapId]);

  // Load selected map detail
  const { data: mapDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['greenhouse-map', selectedMapId],
    queryFn: () => greenhouseApi.getMap(selectedMapId!),
    enabled: selectedMapId != null,
  });

  // Compute selected area from the rowAreaMap (which uses the server-computed values)
  const selectedArea = useMemo(
    () => Array.from(pickedRowIds).reduce((sum, rid) => sum + (rowAreaMap.get(rid) ?? 0), 0),
    [pickedRowIds, rowAreaMap],
  );

  const count   = parseInt(plantCount, 10);
  const density = count > 0 && selectedArea > 0 ? (count / selectedArea).toFixed(1) : null;
  const canSave = pickedRowIds.size > 0 && count > 0 && selectedArea > 0;

  function showWarn(msg: string) {
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    setWarnMsg(msg);
    warnTimerRef.current = setTimeout(() => setWarnMsg(null), 3500);
  }

  function handleRowPick(rowId: number) {
    if (!linkedRowIds.has(rowId)) {
      showWarn('Only rows linked to this crop can be selected. Link rows first in the Locations tab.');
      return;
    }
    setPickedRowIds(prev => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function handleSave() {
    if (!canSave) return;
    onConfirm({ rowIds: Array.from(pickedRowIds), plantCount: count, name: name.trim() });
  }

  const isLoading = locsLoading || mapsLoading;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <button onClick={onCancel} className="p-1.5 text-gray-400 hover:text-gray-600 rounded transition-colors">
          <X size={16} />
        </button>
        <div className="text-sm font-semibold text-gray-900 flex-1">
          Setup Plant Density — <span className="font-normal text-gray-500">{cropName}</span>
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
      </div>

      {/* Hint / warning bar */}
      {warnMsg ? (
        <div className="px-5 py-1.5 bg-amber-50 border-b border-amber-100 text-xs text-amber-700 flex-shrink-0 flex items-center gap-1.5">
          <AlertCircle size={12} className="flex-shrink-0" />
          {warnMsg}
        </div>
      ) : (
        <div className="px-5 py-1.5 bg-blue-50 border-b border-blue-100 text-xs text-blue-700 flex-shrink-0">
          {locsLoading
            ? 'Loading linked rows…'
            : linkedRowIds.size === 0
              ? 'No rows are linked to this crop yet. Go to the Locations tab to link rows first.'
              : `Blue rows are linked to this crop (${linkedRowIds.size} rows). Click to select them for this density record.`
          }
        </div>
      )}

      {/* Main: canvas + side panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas */}
        <div className="flex-1 flex overflow-hidden">
          {isLoading && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading…</div>
          )}
          {!isLoading && maps.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">No greenhouse maps found.</div>
          )}
          {!isLoading && maps.length > 0 && selectedMapId != null && (
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
                highlightedRowIds={linkedRowIds}
                pickedRowIds={pickedRowIds}
                onRowPick={handleRowPick}
              />
            ) : null
          )}
        </div>

        {/* Side panel */}
        <div className="w-64 flex-shrink-0 border-l border-gray-200 bg-gray-50 flex flex-col p-5 gap-5 overflow-y-auto">
          {/* Selection summary */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Selection</p>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Rows selected</span>
                <span className="font-medium text-gray-800 tabular-nums">{pickedRowIds.size}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Total area</span>
                <span className="font-medium text-gray-800 tabular-nums">
                  {selectedArea > 0 ? `${selectedArea.toFixed(1)} m²` : '—'}
                </span>
              </div>
            </div>
            {pickedRowIds.size > 0 && (
              <button
                onClick={() => setPickedRowIds(new Set())}
                className="mt-2 text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Clear selection
              </button>
            )}
          </div>

          {/* Form */}
          <div className="space-y-3">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Record details</p>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Label</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Initial planting"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Plant count <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min={1}
                value={plantCount}
                onChange={e => setPlantCount(e.target.value)}
                placeholder="e.g. 500"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            {density !== null && (
              <div className="bg-emerald-50 border border-emerald-100 rounded-md px-3 py-2.5">
                <div className="text-[10px] text-emerald-600 font-semibold uppercase tracking-wider mb-0.5">Density</div>
                <div className="text-lg font-bold text-emerald-800 tabular-nums">{density}</div>
                <div className="text-xs text-emerald-600">plants / m²</div>
              </div>
            )}
          </div>

          <div className="mt-auto pt-2 space-y-2">
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="w-full flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={13} />
              Save Record
            </button>
            <button
              onClick={onCancel}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
