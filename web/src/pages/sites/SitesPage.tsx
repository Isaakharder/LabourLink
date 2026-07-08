import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ArchiveRestore, Archive, Check, X, Building2 } from 'lucide-react';
import { locationApi } from '../../api/locations';
import type { SiteListItem } from '../../api/locations';

// ── Constants ──────────────────────────────────────────────────────────────────

const TIMEZONES = [
  'UTC',
  'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Brussels',
  'Europe/Dublin', 'Europe/Helsinki', 'Europe/Lisbon', 'Europe/London',
  'Europe/Madrid', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Warsaw',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/New_York', 'America/Sao_Paulo', 'America/Toronto',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Nairobi',
  'Asia/Dubai', 'Asia/Jerusalem', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney',
  'Pacific/Auckland',
];

const DEFAULT_TZ = 'Europe/Amsterdam';

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white ' +
  'placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

function generateCode(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 8);
}

// ── Site form (shared by create + edit) ────────────────────────────────────────

interface SiteFormProps {
  initial?: SiteListItem;
  onSave: (data: { name: string; code: string; address: string; timezone: string }) => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
}

function SiteForm({ initial, onSave, onCancel, isPending, error }: SiteFormProps) {
  const isCreate = !initial;
  const [name, setName]         = useState(initial?.name ?? '');
  const [code, setCode]         = useState(initial?.code ?? '');
  const [address, setAddress]   = useState(initial?.address ?? '');
  const [timezone, setTimezone] = useState(initial?.timezone ?? DEFAULT_TZ);
  const [customTz, setCustomTz] = useState(
    !TIMEZONES.includes(initial?.timezone ?? '') ? initial?.timezone ?? '' : ''
  );
  // Track whether user has manually edited the code field
  const codeManualRef = useRef(!!initial?.code);
  const isCustomTz = !TIMEZONES.includes(timezone) && timezone !== '__custom__';

  // Auto-generate code from name when creating (until user edits the code field)
  useEffect(() => {
    if (!codeManualRef.current && isCreate) {
      setCode(generateCode(name));
    }
  }, [name, isCreate]);

  const handleCodeChange = (v: string) => {
    codeManualRef.current = true;
    setCode(v.toUpperCase());
  };

  const handleTzChange = (v: string) => {
    if (v === '__custom__') {
      setTimezone('__custom__');
    } else {
      setTimezone(v);
      setCustomTz('');
    }
  };

  const effectiveTz = timezone === '__custom__' ? customTz : timezone;
  const canSubmit = name.trim() && code.trim() && effectiveTz && !isPending;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Site Name <span className="text-red-500">*</span></label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="First Light Farms"
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>
            Site Code <span className="text-red-500">*</span>
            {isCreate && !codeManualRef.current && (
              <span className="ml-1 font-normal text-gray-400">(auto)</span>
            )}
          </label>
          <input
            type="text"
            value={code}
            onChange={(e) => handleCodeChange(e.target.value)}
            placeholder="FLF"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-gray-400">Short unique identifier · auto-uppercased</p>
        </div>
      </div>

      <div>
        <label className={labelCls}>Address</label>
        <textarea
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="123 Farm Road"
          rows={2}
          className={inputCls + ' resize-none'}
        />
      </div>

      <div>
        <label className={labelCls}>Timezone <span className="text-red-500">*</span></label>
        <select
          value={isCustomTz ? '__custom__' : timezone}
          onChange={(e) => handleTzChange(e.target.value)}
          className={inputCls}
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
          <option value="__custom__">Other (custom IANA timezone)…</option>
        </select>
        {(timezone === '__custom__' || isCustomTz) && (
          <input
            type="text"
            value={customTz}
            onChange={(e) => setCustomTz(e.target.value)}
            placeholder="e.g. America/Bogota"
            className={inputCls + ' mt-2'}
          />
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>
      )}

      <div className="flex gap-3 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), code: code.trim(), address: address.trim(), timezone: effectiveTz })}
          disabled={!canSubmit}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={13} />
          {isPending ? 'Saving…' : (initial ? 'Save Changes' : 'Create Site')}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Create modal ───────────────────────────────────────────────────────────────

interface CreateModalProps {
  onSave: (data: { name: string; code: string; address: string; timezone: string }) => void;
  onClose: () => void;
  isPending: boolean;
  error: string | null;
}

function CreateModal({ onSave, onClose, isPending, error }: CreateModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Create Site</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="px-6 py-5">
          <SiteForm
            onSave={onSave}
            onCancel={onClose}
            isPending={isPending}
            error={error}
          />
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SitesPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate]   = useState(false);
  const [editingId, setEditingId]     = useState<number | null>(null);
  const [formError, setFormError]     = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<Record<number, string>>({});

  const { data: sites = [], isLoading } = useQuery({
    queryKey: ['sites'],
    queryFn: () => locationApi.listSites(),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['sites'] });
    void qc.invalidateQueries({ queryKey: ['locations'] });
  };

  const stripApiError = (msg: string) =>
    msg.replace(/^API \d+: /, '').replace(/^\{"error":"/, '').replace(/"\}$/, '');

  const createMut = useMutation({
    mutationFn: locationApi.createSite,
    onSuccess: () => { invalidate(); setShowCreate(false); setFormError(null); },
    onError: (e: Error) => setFormError(stripApiError(e.message)),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof locationApi.updateSite>[1] }) =>
      locationApi.updateSite(id, data),
    onSuccess: () => { invalidate(); setEditingId(null); setFormError(null); },
    onError: (e: Error) => setFormError(stripApiError(e.message)),
  });

  const deleteMut = useMutation({
    mutationFn: locationApi.deleteSite,
    onSuccess: (_v, id) => {
      invalidate();
      setDeleteError(prev => { const n = { ...prev }; delete n[id]; return n; });
    },
    onError: (e: Error, id) => {
      setDeleteError(prev => ({ ...prev, [id]: stripApiError(e.message) }));
    },
  });

  const archiveMut = useMutation({
    mutationFn: ({ id, archive }: { id: number; archive: boolean }) =>
      locationApi.updateSite(id, { archivedAt: archive ? new Date().toISOString() : null }),
    onSuccess: () => invalidate(),
  });

  const active   = sites.filter(s => !s.archivedAt);
  const inactive = sites.filter(s => !!s.archivedAt);
  const isDeletable = (s: SiteListItem) => s.locationCount === 0 && s.mapCount === 0;

  function SiteRow({ site }: { site: SiteListItem }) {
    const isEditing = editingId === site.id;
    const delErr = deleteError[site.id];
    return (
      <div className={`border-b border-gray-100 last:border-0 ${site.archivedAt ? 'bg-gray-50/60' : ''}`}>
        {isEditing ? (
          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-wider">Edit Site</p>
            <SiteForm
              initial={site}
              onSave={(data) => { setFormError(null); updateMut.mutate({ id: site.id, data }); }}
              onCancel={() => { setEditingId(null); setFormError(null); }}
              isPending={updateMut.isPending}
              error={formError}
            />
          </div>
        ) : (
          <div className="flex items-center gap-4 px-5 py-3.5">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${site.archivedAt ? 'bg-gray-300' : 'bg-emerald-500'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-sm font-medium ${site.archivedAt ? 'text-gray-400' : 'text-gray-900'}`}>
                  {site.name}
                </span>
                <span className="px-1.5 py-0.5 text-xs font-mono bg-gray-100 text-gray-600 rounded">
                  {site.code}
                </span>
                {site.archivedAt && (
                  <span className="px-1.5 py-0.5 text-xs bg-gray-200 text-gray-500 rounded">Inactive</span>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                {site.timezone}
                {(site.locationCount > 0 || site.mapCount > 0) && (
                  <span className="ml-2">
                    · {site.locationCount} location{site.locationCount !== 1 ? 's' : ''}
                    · {site.mapCount} map{site.mapCount !== 1 ? 's' : ''}
                  </span>
                )}
              </p>
              {site.address && (
                <p className="text-xs text-gray-400 truncate">{site.address}</p>
              )}
              {delErr && <p className="text-xs text-red-600 mt-1">{delErr}</p>}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => { setEditingId(site.id); setFormError(null); }}
                title="Edit"
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => archiveMut.mutate({ id: site.id, archive: !site.archivedAt })}
                disabled={archiveMut.isPending}
                title={site.archivedAt ? 'Reactivate' : 'Deactivate'}
                className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors disabled:opacity-40"
              >
                {site.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              </button>
              <button
                onClick={() => {
                  if (!isDeletable(site)) return;
                  if (!confirm(`Delete site "${site.name}"? This cannot be undone.`)) return;
                  deleteMut.mutate(site.id);
                }}
                disabled={!isDeletable(site) || deleteMut.isPending}
                title={
                  !isDeletable(site)
                    ? `Cannot delete: ${site.locationCount} location(s), ${site.mapCount} map(s)`
                    : 'Delete'
                }
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-5 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Sites</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Physical greenhouse locations. Each greenhouse map belongs to a site.
          </p>
        </div>
        {sites.length > 0 && (
          <button
            onClick={() => { setShowCreate(true); setFormError(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors"
          >
            <Plus size={14} />
            Create Site
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto bg-gray-50">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {isLoading && (
            <p className="text-sm text-gray-400 text-center py-8">Loading sites…</p>
          )}

          {/* ── Empty state ──────────────────────────────────────────── */}
          {!isLoading && sites.length === 0 && (
            <div className="text-center py-16">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 mb-4">
                <Building2 size={22} className="text-emerald-600" />
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1">No sites yet</p>
              <p className="text-xs text-gray-500 max-w-xs mx-auto mb-6">
                No sites have been created yet. Create your first site to begin building your greenhouse map.
              </p>
              <button
                onClick={() => { setShowCreate(true); setFormError(null); }}
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors"
              >
                <Plus size={14} />
                Create Site
              </button>
            </div>
          )}

          {/* ── Active sites ─────────────────────────────────────────── */}
          {!isLoading && sites.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/50">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Active · {active.length}
                </p>
              </div>
              {active.length === 0 ? (
                <p className="px-5 py-4 text-sm text-gray-400">No active sites.</p>
              ) : (
                active.map(s => <SiteRow key={s.id} site={s} />)
              )}
            </div>
          )}

          {/* ── Inactive sites ───────────────────────────────────────── */}
          {!isLoading && inactive.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/50">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Inactive · {inactive.length}
                </p>
              </div>
              {inactive.map(s => <SiteRow key={s.id} site={s} />)}
            </div>
          )}
        </div>
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateModal
          onSave={(data) => { setFormError(null); createMut.mutate(data); }}
          onClose={() => { setShowCreate(false); setFormError(null); }}
          isPending={createMut.isPending}
          error={formError}
        />
      )}
    </div>
  );
}
