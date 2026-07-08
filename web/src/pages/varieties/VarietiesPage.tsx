import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sprout, Plus, Pencil, Archive, RotateCcw, X, Check, ChevronDown,
} from 'lucide-react';
import { cropsApi, varietiesApi, getCropStatus, getVarietyStatus, type Crop, type Variety, type VarietyStatus } from '../../api/crops';

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<VarietyStatus, { label: string; cls: string }> = {
  active:   { label: 'Active',   cls: 'bg-emerald-100 text-emerald-700' },
  upcoming: { label: 'Upcoming', cls: 'bg-blue-100 text-blue-700' },
  ended:    { label: 'Ended',    cls: 'bg-gray-100 text-gray-500' },
  archived: { label: 'Archived', cls: 'bg-gray-100 text-gray-400' },
};

function StatusBadge({ status }: { status: VarietyStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}>
      {s.label}
    </span>
  );
}

function ColorDot({ color }: { color: string | null }) {
  if (!color) return <span className="w-4 h-4 rounded-full border border-gray-200 bg-gray-100 flex-shrink-0" />;
  return <span className="w-4 h-4 rounded-full flex-shrink-0 border border-white shadow-sm" style={{ background: color }} />;
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 ' +
  'focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

// ── Form modal ─────────────────────────────────────────────────────────────────

function VarietyFormModal({ variety, crops, defaultCropId, onClose, onSaved }: {
  variety?: Variety;
  crops: Crop[];
  defaultCropId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cropId, setCropId] = useState<string>(
    variety ? String(variety.cropId) : defaultCropId ? String(defaultCropId) : ''
  );
  const [name,  setName]  = useState(variety?.name ?? '');
  const [color, setColor] = useState(variety?.color ?? '');
  const [err,   setErr]   = useState<string | null>(null);
  const isEdit = variety != null;

  const activeCrops   = crops.filter(c => ['active', 'upcoming'].includes(getCropStatus(c)));
  const inactiveCrops = crops.filter(c => ['ended', 'archived'].includes(getCropStatus(c)));

  const mut = useMutation({
    mutationFn: () => {
      if (!cropId) throw new Error('Crop is required');
      if (!name.trim()) throw new Error('Name is required');
      if (isEdit) {
        return varietiesApi.update(variety.id, {
          cropId: parseInt(cropId, 10),
          name: name.trim(),
          color: color || null,
        });
      }
      return varietiesApi.create({ cropId: parseInt(cropId, 10), name: name.trim(), color: color || null });
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError:   (e: Error) => setErr(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">{isEdit ? 'Edit Variety' : 'New Variety'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={15} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className={labelCls}>Crop <span className="text-red-500">*</span></label>
            <select value={cropId} onChange={e => { setCropId(e.target.value); setErr(null); }} className={inputCls}>
              <option value="">Select crop…</option>
              {activeCrops.length > 0 && (
                <optgroup label="Active">
                  {activeCrops.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </optgroup>
              )}
              {inactiveCrops.length > 0 && (
                <optgroup label="Inactive">
                  {inactiveCrops.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div>
            <label className={labelCls}>Variety Name <span className="text-red-500">*</span></label>
            <input type="text" value={name}
              onChange={e => { setName(e.target.value); setErr(null); }}
              placeholder="e.g. Mathieu"
              className={inputCls} autoFocus />
          </div>
          <div>
            <label className={labelCls}>Color <span className="text-gray-400 font-normal">(optional)</span></label>
            <div className="flex items-center gap-3">
              <input type="color" value={color || '#6b7280'}
                onChange={e => setColor(e.target.value)}
                className="w-10 h-10 rounded border border-gray-200 cursor-pointer p-0.5 bg-white" />
              <div className="flex-1">
                <input type="text" value={color}
                  onChange={e => setColor(e.target.value)}
                  placeholder="#6b7280 or leave blank"
                  className={inputCls} />
              </div>
              {color && (
                <button onClick={() => setColor('')} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                  <X size={14} />
                </button>
              )}
            </div>
            <p className="mt-1 text-[10px] text-gray-400">Used to color-code varieties in work records.</p>
          </div>
          {err && <p className="text-xs text-red-600 bg-red-50 rounded px-3 py-2">{err}</p>}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => mut.mutate()}
              disabled={!cropId || !name.trim() || mut.isPending}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              <Check size={13} />
              {mut.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Variety'}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Variety row ────────────────────────────────────────────────────────────────

function VarietyRow({ variety, onEdit, onArchive, onRestore, isMutating }: {
  variety: Variety;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  isMutating: boolean;
}) {
  const status = getVarietyStatus(variety);
  const isArchived = !!variety.archivedAt;

  return (
    <tr className={`group border-b border-gray-100 last:border-0 hover:bg-gray-50/50 transition-colors ${isArchived ? 'opacity-60' : ''}`}>
      <td className="py-3 pl-5 pr-3">
        <div className="flex items-center gap-2.5">
          <ColorDot color={variety.color} />
          <span className="text-sm font-medium text-gray-900">{variety.name}</span>
        </div>
      </td>
      <td className="py-3 px-3">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
          {variety.cropName}
        </span>
      </td>
      <td className="py-3 px-3"><StatusBadge status={status} /></td>
      <td className="py-3 pl-3 pr-5">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onEdit} title="Edit"
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors">
            <Pencil size={12} />
          </button>
          {isArchived ? (
            <button onClick={onRestore} disabled={isMutating} title="Restore"
              className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors disabled:opacity-50">
              <RotateCcw size={12} />
            </button>
          ) : (
            <button onClick={onArchive} disabled={isMutating} title="Archive"
              className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors disabled:opacity-50">
              <Archive size={12} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function VarietiesPage() {
  const qc = useQueryClient();
  const [cropFilter,   setCropFilter]   = useState<number | null>(null);
  const [showAdd,      setShowAdd]      = useState(false);
  const [editVariety,  setEditVariety]  = useState<Variety | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const { data: crops = [] } = useQuery({
    queryKey: ['crops'],
    queryFn: cropsApi.list,
  });

  const { data: varieties = [], isLoading, isError } = useQuery({
    queryKey: ['varieties', cropFilter],
    queryFn: () => varietiesApi.list(cropFilter ?? undefined),
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['varieties'] });
    void qc.invalidateQueries({ queryKey: ['crops'] });
  }

  const archiveMut = useMutation({ mutationFn: varietiesApi.archive, onSuccess: invalidate });
  const restoreMut = useMutation({ mutationFn: varietiesApi.restore, onSuccess: invalidate });
  const isMutating = archiveMut.isPending || restoreMut.isPending;

  const active   = varieties.filter(v => !v.archivedAt);
  const archived = varieties.filter(v =>  v.archivedAt);

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 flex items-center justify-center rounded-lg bg-emerald-50">
            <Sprout size={18} className="text-emerald-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Varieties</h1>
            <p className="text-xs text-gray-400 mt-0.5">Varieties grown under each crop</p>
          </div>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors shadow-sm"
        >
          <Plus size={14} />
          Add Variety
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative">
          <select
            value={cropFilter ?? ''}
            onChange={e => setCropFilter(e.target.value ? parseInt(e.target.value, 10) : null)}
            className="pl-3 pr-8 py-1.5 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none cursor-pointer"
          >
            <option value="">All Crops</option>
            {crops.filter(c => ['active', 'upcoming'].includes(getCropStatus(c))).map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
            {crops.filter(c => ['ended', 'archived'].includes(getCropStatus(c))).length > 0 && (
              <>
                <option disabled>──── Inactive ────</option>
                {crops.filter(c => ['ended', 'archived'].includes(getCropStatus(c))).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </>
            )}
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
        <span className="text-xs text-gray-400">
          {active.length} {active.length === 1 ? 'variety' : 'varieties'}
          {archived.length > 0 && ` · ${archived.length} archived`}
        </span>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {isError   && <p className="text-sm text-red-500">Failed to load varieties.</p>}

      {!isLoading && !isError && (
        <div className="space-y-4">
          {/* Active varieties */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {active.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <Sprout size={24} className="text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-400">No varieties yet.</p>
                <button onClick={() => setShowAdd(true)}
                  className="mt-3 text-xs text-emerald-600 hover:text-emerald-700 font-medium">
                  Add a variety →
                </button>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50/60 border-b border-gray-100">
                    <th className="py-2 pl-5 pr-3 text-left">Variety</th>
                    <th className="py-2 px-3 text-left">Crop</th>
                    <th className="py-2 px-3 text-left">Status</th>
                    <th className="py-2 pl-3 pr-5" />
                  </tr>
                </thead>
                <tbody>
                  {active.map(v => (
                    <VarietyRow key={v.id} variety={v}
                      onEdit={() => setEditVariety(v)}
                      onArchive={() => archiveMut.mutate(v.id)}
                      onRestore={() => restoreMut.mutate(v.id)}
                      isMutating={isMutating}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Archived section (collapsible) */}
          {archived.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <button
                onClick={() => setShowArchived(o => !o)}
                className="w-full flex items-center gap-2 px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider hover:bg-gray-50 transition-colors"
              >
                <ChevronDown size={13} className={`transition-transform ${showArchived ? '' : '-rotate-90'}`} />
                Archived ({archived.length})
              </button>
              {showArchived && (
                <table className="w-full border-t border-gray-100">
                  <thead>
                    <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50/60 border-b border-gray-100">
                      <th className="py-2 pl-5 pr-3 text-left">Variety</th>
                      <th className="py-2 px-3 text-left">Crop</th>
                      <th className="py-2 px-3 text-left">Status</th>
                      <th className="py-2 pl-3 pr-5" />
                    </tr>
                  </thead>
                  <tbody>
                    {archived.map(v => (
                      <VarietyRow key={v.id} variety={v}
                        onEdit={() => setEditVariety(v)}
                        onArchive={() => archiveMut.mutate(v.id)}
                        onRestore={() => restoreMut.mutate(v.id)}
                        isMutating={isMutating}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <VarietyFormModal
          crops={crops}
          defaultCropId={cropFilter ?? undefined}
          onClose={() => setShowAdd(false)}
          onSaved={invalidate}
        />
      )}
      {editVariety && (
        <VarietyFormModal
          variety={editVariety}
          crops={crops}
          onClose={() => setEditVariety(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}
