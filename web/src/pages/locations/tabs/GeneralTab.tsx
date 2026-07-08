import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { locationApi } from '../../../api/locations';
import type { LocationDetail } from '../../../api/locations';

interface Props {
  location: LocationDetail;
  onRefresh: () => void;
}

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-500 mb-1';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function GeneralTab({ location, onRefresh }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(location.name);
  const [code, setCode] = useState(location.code);
  const [abbr, setAbbr] = useState(location.abbreviatedName ?? '');
  const [sortOrder, setSortOrder] = useState(String(location.sortOrder));
  const [netArea, setNetArea] = useState(location.netAreaM2 ?? '');
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    setName(location.name);
    setCode(location.code);
    setAbbr(location.abbreviatedName ?? '');
    setSortOrder(String(location.sortOrder));
    setNetArea(location.netAreaM2 ?? '');
    setEditing(false);
    setSaveErr(null);
  }, [location.id]);

  const saveMut = useMutation({
    mutationFn: () =>
      locationApi.update(location.id, {
        name: name.trim(),
        code: code.trim(),
        abbreviatedName: abbr.trim() || null,
        sortOrder: parseInt(sortOrder, 10) || 0,
        netAreaM2: netArea ? parseFloat(String(netArea)) : null,
      }),
    onSuccess: () => {
      setEditing(false);
      setSaveErr(null);
      void qc.invalidateQueries({ queryKey: ['locations'] });
      onRefresh();
    },
    onError: (err: Error) => setSaveErr(err.message),
  });

  const activeMut = useMutation({
    mutationFn: (active: boolean) =>
      locationApi.update(location.id, {
        archivedAt: active ? null : new Date().toISOString(),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['locations'] });
      onRefresh();
    },
  });

  return (
    <div className="px-8 py-6 max-w-2xl">
      {/* Active toggle */}
      <div className="flex items-center gap-3 mb-6">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!location.archivedAt}
            onChange={e => activeMut.mutate(e.target.checked)}
            disabled={activeMut.isPending}
            className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
          />
          <span className="text-sm font-medium text-gray-700">Active</span>
        </label>
        {location.archivedAt && (
          <span className="text-xs text-gray-400">
            Inactive since {fmtDate(location.archivedAt)}
          </span>
        )}
      </div>

      {/* Fields */}
      {editing ? (
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Code</label>
            <input type="text" value={code} onChange={e => setCode(e.target.value)} className={inputCls} />
            <p className="text-xs text-gray-400 mt-1">Unique within the site.</p>
          </div>
          <div>
            <label className={labelCls}>Abbreviated Name</label>
            <input type="text" value={abbr} onChange={e => setAbbr(e.target.value)} placeholder="Optional short name" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Net Area (m²)</label>
            <input type="number" step="0.01" value={netArea} onChange={e => setNetArea(e.target.value)} placeholder="Optional" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Sort Order</label>
            <input type="number" value={sortOrder} onChange={e => setSortOrder(e.target.value)} className={inputCls} />
          </div>

          {saveErr && <p className="text-sm text-red-600">{saveErr}</p>}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50"
            >
              <Check size={13} />
              {saveMut.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setSaveErr(null); }}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-md hover:bg-gray-50"
            >
              <X size={13} />
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <ReadField label="Site"             value={location.siteName} />
          <ReadField label="Code"             value={location.code} mono />
          <ReadField label="Name"             value={location.name} />
          <ReadField label="Abbreviated Name" value={location.abbreviatedName ?? '—'} />
          <ReadField label="Net Area (m²)"    value={location.netAreaM2 != null ? `${parseFloat(String(location.netAreaM2)).toFixed(2)} m²` : '—'} />
          <ReadField label="Sort Order"       value={String(location.sortOrder)} />
          <ReadField label="Created"          value={fmtDate(location.createdAt)} />
          <ReadField label="Updated"          value={fmtDate(location.updatedAt)} />

          <div className="pt-2">
            <button
              onClick={() => setEditing(true)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"
            >
              Edit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className={`text-sm text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}
