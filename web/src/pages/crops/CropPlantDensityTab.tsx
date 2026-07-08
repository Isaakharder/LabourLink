import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BarChart2, Settings2, Trash2, AlertCircle } from 'lucide-react';
import { cropsApi, type CropPlantDensity } from '../../api/crops';
import { CropDensityPickerModal } from './CropDensityPickerModal';

interface Props {
  cropId: number;
  cropName: string;
}

function DensityRow({ record, cropId }: { record: CropPlantDensity; cropId: number }) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMut = useMutation({
    mutationFn: () => cropsApi.deletePlantDensity(cropId, record.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['crop-plant-density', cropId] }),
  });

  return (
    <tr className="group border-b border-gray-100 last:border-0 hover:bg-gray-50/50 transition-colors">
      <td className="py-2.5 pl-4 pr-3 text-gray-800 font-medium">
        {record.name || 'Plants'}
      </td>
      <td className="py-2.5 px-3 tabular-nums text-gray-700 text-right">
        {record.plantCount.toLocaleString()}
      </td>
      <td className="py-2.5 px-3 tabular-nums text-gray-500 text-right">
        {Number(record.areaM2).toFixed(1)} m²
      </td>
      <td className="py-2.5 px-3 tabular-nums text-gray-700 text-right font-medium">
        {record.densityPerM2 != null ? `${Number(record.densityPerM2).toFixed(1)}/m²` : '—'}
      </td>
      <td className="py-2.5 px-3 text-center text-gray-400 tabular-nums text-sm">
        {record.rowIds.length > 0 ? record.rowIds.length : '—'}
      </td>
      <td className="py-2.5 pl-3 pr-4">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => deleteMut.mutate()}
              disabled={deleteMut.isPending}
              className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
            >
              {deleteMut.isPending ? 'Deleting…' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            title="Delete record"
            className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
          >
            <Trash2 size={12} />
          </button>
        )}
      </td>
    </tr>
  );
}

export function CropPlantDensityTab({ cropId, cropName }: Props) {
  const qc = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);
  const [saveError,  setSaveError]  = useState<string | null>(null);

  const { data: records = [], isLoading, isError } = useQuery({
    queryKey: ['crop-plant-density', cropId],
    queryFn: () => cropsApi.listPlantDensity(cropId),
  });

  const createMut = useMutation({
    mutationFn: (data: { rowIds: number[]; plantCount: number; name: string }) =>
      cropsApi.createPlantDensity(cropId, {
        name:       data.name || undefined,
        plantCount: data.plantCount,
        rowIds:     data.rowIds,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['crop-plant-density', cropId] });
      setSaveError(null);
      setShowPicker(false);
    },
    onError: (e: Error) => {
      setSaveError(e.message);
      setShowPicker(false);
    },
  });

  return (
    <>
      <div className="px-6 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm text-gray-500">
              Planting density records for this crop
            </p>
            {records.length > 0 && (
              <p className="text-xs text-gray-400 mt-0.5">
                {records.length} record{records.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <button
            onClick={() => { setSaveError(null); setShowPicker(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors"
          >
            <Settings2 size={13} />
            Setup Plant Density
          </button>
        </div>

        {saveError && (
          <div className="mb-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2.5">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{saveError}</span>
          </div>
        )}

        {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
        {isError   && <p className="text-sm text-red-500">Failed to load density records.</p>}

        {!isLoading && !isError && records.length === 0 && (
          <div className="text-center py-12 border border-dashed border-gray-200 rounded-lg">
            <BarChart2 size={24} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-400">No density records yet.</p>
            <p className="text-xs text-gray-300 mt-1">
              Click "Setup Plant Density" to select rows and record plant counts.
            </p>
          </div>
        )}

        {!isLoading && !isError && records.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-200">
                  <th className="py-2 pl-4 pr-3 text-left">Label</th>
                  <th className="py-2 px-3 text-right">Plants</th>
                  <th className="py-2 px-3 text-right">Area</th>
                  <th className="py-2 px-3 text-right">Density</th>
                  <th className="py-2 px-3 text-center">Rows</th>
                  <th className="py-2 pl-3 pr-4" />
                </tr>
              </thead>
              <tbody>
                {records.map(r => (
                  <DensityRow key={r.id} record={r} cropId={cropId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showPicker && (
        <CropDensityPickerModal
          cropId={cropId}
          cropName={cropName}
          onConfirm={data => createMut.mutate(data)}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </>
  );
}
