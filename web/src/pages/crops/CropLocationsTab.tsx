import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin, Plus, Unlink, AlertCircle } from 'lucide-react';
import { cropsApi, type CropLocation } from '../../api/crops';
import { CropMapPickerModal } from './CropMapPickerModal';

interface Props {
  cropId: number;
  cropName: string;
}

function formatArea(m2: number): string {
  return `${Number(m2).toFixed(1)} m²`;
}

const SIDE_LABEL: Record<string, string> = {
  north: 'N', south: 'S', east: 'E', west: 'W',
};

export function CropLocationsTab({ cropId, cropName }: Props) {
  const qc = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);

  const { data: locations = [], isLoading, isError } = useQuery({
    queryKey: ['crop-locations', cropId],
    queryFn: () => cropsApi.listLocations(cropId),
  });

  const setLocationsMut = useMutation({
    mutationFn: (rowIds: number[]) => cropsApi.setLocations(cropId, rowIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['crop-locations', cropId] }),
  });

  function handlePickerConfirm(rowIds: Set<number>) {
    setShowPicker(false);
    setLocationsMut.mutate(Array.from(rowIds));
  }

  function handleUnlink(loc: CropLocation) {
    const remaining = locations.filter(l => l.rowId !== loc.rowId).map(l => l.rowId);
    setLocationsMut.mutate(remaining);
  }

  const currentRowIds = new Set(locations.map(l => l.rowId));
  const totalArea = locations.reduce((sum, l) => sum + Number(l.areaM2), 0);

  return (
    <>
      <div className="px-6 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm text-gray-500">
              Greenhouse rows linked to this crop
            </p>
            {locations.length > 0 && (
              <p className="text-xs text-gray-400 mt-0.5">
                {locations.length} row{locations.length !== 1 ? 's' : ''} · {formatArea(totalArea)} total
              </p>
            )}
          </div>
          <button
            onClick={() => setShowPicker(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors"
          >
            <Plus size={13} />
            Link Rows
          </button>
        </div>

        {setLocationsMut.isError && (
          <p className="mb-3 text-sm text-red-600 flex items-center gap-1.5">
            <AlertCircle size={14} />
            {setLocationsMut.error instanceof Error ? setLocationsMut.error.message : 'Failed to save'}
          </p>
        )}

        {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
        {isError   && <p className="text-sm text-red-500">Failed to load linked rows.</p>}

        {!isLoading && !isError && locations.length === 0 && (
          <div className="text-center py-12 border border-dashed border-gray-200 rounded-lg">
            <MapPin size={24} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-400">No rows linked yet.</p>
            <p className="text-xs text-gray-300 mt-1">Click "Link Rows" to link greenhouse rows to this crop.</p>
          </div>
        )}

        {!isLoading && !isError && locations.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-200">
                  <th className="py-2 pl-4 pr-3 text-left">Row</th>
                  <th className="py-2 px-3 text-left">Side</th>
                  <th className="py-2 px-3 text-left">Compartment</th>
                  <th className="py-2 px-3 text-left">Map</th>
                  <th className="py-2 px-3 text-right">Area</th>
                  <th className="py-2 pl-3 pr-4 text-left">Location</th>
                  <th className="py-2 pl-3 pr-4" />
                </tr>
              </thead>
              <tbody>
                {locations.map(loc => (
                  <tr key={loc.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50 transition-colors">
                    <td className="py-2.5 pl-4 pr-3 font-mono text-gray-700 text-xs">#{loc.rowNumber}</td>
                    <td className="py-2.5 px-3 text-xs text-gray-500">{SIDE_LABEL[loc.side] ?? loc.side}</td>
                    <td className="py-2.5 px-3 text-gray-700">{loc.compartmentName}</td>
                    <td className="py-2.5 px-3 text-gray-500">{loc.mapName}</td>
                    <td className="py-2.5 px-3 text-right text-gray-500 tabular-nums">{formatArea(loc.areaM2)}</td>
                    <td className="py-2.5 pl-3 pr-4 text-gray-400 text-xs">
                      {loc.locationCode ? `${loc.locationCode}${loc.locationName ? ` — ${loc.locationName}` : ''}` : '—'}
                    </td>
                    <td className="py-2.5 pl-3 pr-4">
                      <button
                        onClick={() => handleUnlink(loc)}
                        disabled={setLocationsMut.isPending}
                        title="Unlink row"
                        className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                      >
                        <Unlink size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showPicker && (
        <CropMapPickerModal
          cropName={cropName}
          initialRowIds={currentRowIds}
          onConfirm={handlePickerConfirm}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </>
  );
}
