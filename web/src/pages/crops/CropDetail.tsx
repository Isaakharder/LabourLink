import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Archive, RotateCcw, X, Check } from 'lucide-react';
import { cropsApi, getCropStatus, type Crop, type CropStatus } from '../../api/crops';
import { CropLocationsTab } from './CropLocationsTab';
import { CropPlantDensityTab } from './CropPlantDensityTab';

// ── Status badge ───────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<CropStatus, { label: string; cls: string }> = {
  active:   { label: 'Active',   cls: 'bg-emerald-100 text-emerald-700' },
  upcoming: { label: 'Upcoming', cls: 'bg-blue-100 text-blue-700' },
  ended:    { label: 'Ended',    cls: 'bg-gray-100 text-gray-500' },
  archived: { label: 'Archived', cls: 'bg-gray-100 text-gray-400' },
};

function StatusBadge({ status }: { status: CropStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}>
      {s.label}
    </span>
  );
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

// ── Inline edit form ───────────────────────────────────────────────────────────

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 ' +
  'focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

function EditCropForm({ crop, onClose }: { crop: Crop; onClose: () => void }) {
  const qc = useQueryClient();
  const [name,         setName]         = useState(crop.name);
  const [plantingDate, setPlantingDate] = useState(crop.plantingDate);
  const [pullingDate,  setPullingDate]  = useState(crop.pullingDate ?? '');
  const [err,          setErr]          = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => {
      if (!name.trim())  throw new Error('Name is required');
      if (!plantingDate) throw new Error('Planting date is required');
      if (pullingDate && pullingDate < plantingDate)
        throw new Error('Pulling date cannot be before planting date');
      return cropsApi.update(crop.id, { name: name.trim(), plantingDate, pullingDate: pullingDate || null });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['crops'] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="border border-gray-200 rounded-lg bg-gray-50 px-5 py-4 space-y-4">
      <div>
        <label className={labelCls}>Name <span className="text-red-500">*</span></label>
        <input type="text" value={name}
          onChange={e => { setName(e.target.value); setErr(null); }}
          className={inputCls} autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Planting Date <span className="text-red-500">*</span></label>
          <input type="date" value={plantingDate}
            onChange={e => { setPlantingDate(e.target.value); setErr(null); }}
            className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Pulling Date</label>
          <input type="date" value={pullingDate}
            onChange={e => { setPullingDate(e.target.value); setErr(null); }}
            min={plantingDate || undefined}
            className={inputCls} />
        </div>
      </div>
      {err && <p className="text-xs text-red-600 bg-red-50 rounded px-3 py-2">{err}</p>}
      <div className="flex items-center gap-3">
        <button
          onClick={() => mut.mutate()}
          disabled={!name.trim() || !plantingDate || mut.isPending}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          <Check size={13} />
          {mut.isPending ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Tab type ───────────────────────────────────────────────────────────────────

type Tab = 'locations' | 'plant-density';

const TABS: { id: Tab; label: string }[] = [
  { id: 'locations',     label: 'Locations'     },
  { id: 'plant-density', label: 'Plant Density' },
];

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  crop: Crop;
}

export function CropDetail({ crop }: Props) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('locations');
  const [isEditing, setIsEditing] = useState(false);

  const status = getCropStatus(crop);

  const archiveMut = useMutation({
    mutationFn: () => cropsApi.archive(crop.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['crops'] }),
  });
  const restoreMut = useMutation({
    mutationFn: () => cropsApi.restore(crop.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['crops'] }),
  });
  const isMutating = archiveMut.isPending || restoreMut.isPending;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 border-b border-gray-200 bg-white flex-shrink-0 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-semibold text-gray-900 truncate">{crop.name}</h2>
              <StatusBadge status={status} />
            </div>
            <div className="flex items-center gap-4 mt-1.5 text-xs text-gray-400">
              <span>Planted {formatDate(crop.plantingDate)}</span>
              {crop.pullingDate && <span>· Pulling {formatDate(crop.pullingDate)}</span>}
              <span>· {crop.varietyCount} {crop.varietyCount === 1 ? 'variety' : 'varieties'}</span>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setIsEditing(e => !e)}
              title="Edit crop"
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
            >
              {isEditing ? <X size={14} /> : <Pencil size={14} />}
            </button>
            {status === 'archived' ? (
              <button onClick={() => restoreMut.mutate()} disabled={isMutating} title="Restore crop"
                className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors disabled:opacity-50">
                <RotateCcw size={14} />
              </button>
            ) : (
              <button onClick={() => archiveMut.mutate()} disabled={isMutating} title="Archive crop"
                className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors disabled:opacity-50">
                <Archive size={14} />
              </button>
            )}
          </div>
        </div>

        {isEditing && <EditCropForm crop={crop} onClose={() => setIsEditing(false)} />}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 bg-white flex-shrink-0 px-6">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-1 py-3 mr-6 text-sm border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-emerald-500 text-emerald-700 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'locations'     && <CropLocationsTab    cropId={crop.id} cropName={crop.name} />}
        {activeTab === 'plant-density' && <CropPlantDensityTab cropId={crop.id} cropName={crop.name} />}
      </div>
    </div>
  );
}
