import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Leaf, Plus, X, Check, ChevronDown, ChevronRight, Sprout,
} from 'lucide-react';
import { cropsApi, getCropStatus, type Crop, type CropStatus } from '../../api/crops';
import { CropDetail } from './CropDetail';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

const STATUS_DOT: Record<CropStatus, string> = {
  active:   'bg-emerald-400',
  upcoming: 'bg-blue-400',
  ended:    'bg-gray-300',
  archived: 'bg-gray-200',
};

// ── New Crop form ──────────────────────────────────────────────────────────────

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 ' +
  'focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

function NewCropPanel({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Crop) => void }) {
  const qc = useQueryClient();
  const [name,         setName]         = useState('');
  const [plantingDate, setPlantingDate] = useState('');
  const [pullingDate,  setPullingDate]  = useState('');
  const [err,          setErr]          = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => {
      if (!name.trim())  throw new Error('Name is required');
      if (!plantingDate) throw new Error('Planting date is required');
      if (pullingDate && pullingDate < plantingDate)
        throw new Error('Pulling date cannot be before planting date');
      return cropsApi.create({ name: name.trim(), plantingDate, pullingDate: pullingDate || null });
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['crops'] });
      onCreated(created);
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="border-b border-gray-200 bg-gray-50 px-4 py-4 space-y-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">New Crop</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
      </div>
      <div>
        <label className={labelCls}>Name <span className="text-red-500">*</span></label>
        <input type="text" value={name}
          onChange={e => { setName(e.target.value); setErr(null); }}
          placeholder="e.g. Bell Peppers 2026"
          className={inputCls} autoFocus />
      </div>
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
      {err && <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1.5">{err}</p>}
      <button
        onClick={() => mut.mutate()}
        disabled={!name.trim() || !plantingDate || mut.isPending}
        className="w-full flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors"
      >
        <Check size={13} />
        {mut.isPending ? 'Creating…' : 'Create Crop'}
      </button>
    </div>
  );
}

// ── Crop list item ─────────────────────────────────────────────────────────────

function CropListItem({ crop, isSelected, onClick }: {
  crop: Crop;
  isSelected: boolean;
  onClick: () => void;
}) {
  const status = getCropStatus(crop);
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-gray-100 last:border-0 transition-colors hover:bg-gray-50 ${
        isSelected ? 'bg-emerald-50 hover:bg-emerald-50' : ''
      } ${status === 'archived' ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[status]}`} />
        <span className={`text-sm font-medium truncate ${isSelected ? 'text-emerald-800' : 'text-gray-800'}`}>
          {crop.name}
        </span>
      </div>
      <div className="mt-0.5 pl-4.5 flex items-center gap-2 text-[11px] text-gray-400">
        <span>{formatDate(crop.plantingDate)}</span>
        {crop.varietyCount > 0 && (
          <>
            <span>·</span>
            <span className="flex items-center gap-0.5">
              <Sprout size={9} className="text-emerald-400" />
              {crop.varietyCount}
            </span>
          </>
        )}
      </div>
    </button>
  );
}

// ── Collapsible section ────────────────────────────────────────────────────────

function CropSection({ title, crops, defaultOpen = true, selectedId, onSelect }: {
  title: string;
  crops: Crop[];
  defaultOpen?: boolean;
  selectedId: number | null;
  onSelect: (c: Crop) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-4 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-wider hover:bg-gray-50 transition-colors"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {title}
        <span className="ml-0.5 font-normal text-gray-300">({crops.length})</span>
      </button>
      {open && crops.map(c => (
        <CropListItem
          key={c.id}
          crop={c}
          isSelected={c.id === selectedId}
          onClick={() => onSelect(c)}
        />
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function CropsPage() {
  const qc = useQueryClient();
  const [showAdd,       setShowAdd]       = useState(false);
  const [selectedCrop,  setSelectedCrop]  = useState<Crop | null>(null);

  const { data: crops = [], isLoading, isError } = useQuery({
    queryKey: ['crops'],
    queryFn: cropsApi.list,
  });

  const activeCrops   = crops.filter(c => ['active', 'upcoming'].includes(getCropStatus(c)));
  const inactiveCrops = crops.filter(c => ['ended', 'archived'].includes(getCropStatus(c)));

  // Auto-select first active crop on initial load
  useEffect(() => {
    if (selectedCrop == null && crops.length > 0) {
      setSelectedCrop(activeCrops[0] ?? crops[0]);
    }
  // only run when the list goes from empty → populated
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crops.length]);

  // Re-sync selectedCrop when list refreshes
  const latestSelected = selectedCrop
    ? (crops.find(c => c.id === selectedCrop.id) ?? selectedCrop)
    : null;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Left panel: crop list ─────────────────────────────────────────────── */}
      <div className="w-64 flex-shrink-0 border-r border-gray-200 flex flex-col bg-white overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Leaf size={15} className="text-emerald-600" />
            <span className="text-sm font-semibold text-gray-800">Crops</span>
          </div>
          <button
            onClick={() => setShowAdd(s => !s)}
            title="Add crop"
            className={`p-1 rounded transition-colors ${
              showAdd
                ? 'text-emerald-600 bg-emerald-50'
                : 'text-gray-400 hover:text-emerald-600 hover:bg-emerald-50'
            }`}
          >
            <Plus size={15} />
          </button>
        </div>

        {/* New crop form */}
        {showAdd && (
          <NewCropPanel
            onClose={() => setShowAdd(false)}
            onCreated={c => setSelectedCrop(c)}
          />
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && <p className="px-4 py-4 text-sm text-gray-400">Loading…</p>}
          {isError   && <p className="px-4 py-4 text-sm text-red-500">Failed to load.</p>}
          {!isLoading && !isError && crops.length === 0 && (
            <p className="px-4 py-6 text-sm text-gray-400 text-center">No crops yet.</p>
          )}
          {!isLoading && !isError && (
            <>
              {activeCrops.length > 0 && (
                <CropSection
                  title="Active"
                  crops={activeCrops}
                  defaultOpen
                  selectedId={latestSelected?.id ?? null}
                  onSelect={setSelectedCrop}
                />
              )}
              {inactiveCrops.length > 0 && (
                <CropSection
                  title="Inactive"
                  crops={inactiveCrops}
                  defaultOpen={activeCrops.length === 0}
                  selectedId={latestSelected?.id ?? null}
                  onSelect={setSelectedCrop}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Right panel: crop detail ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden bg-white">
        {latestSelected ? (
          <CropDetail key={latestSelected.id} crop={latestSelected} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center mb-3">
              <Leaf size={22} className="text-emerald-400" />
            </div>
            <p className="text-sm text-gray-400">Select a crop to view details</p>
            <p className="text-xs text-gray-300 mt-1">or click + to add a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}
