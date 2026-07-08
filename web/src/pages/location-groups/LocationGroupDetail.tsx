import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, Minus, Plus } from 'lucide-react';
import { locationApi } from '../../api/locations';
import type { LocationGroupMember } from '../../api/locations';

type Tab = 'general' | 'locations';

interface Props {
  groupId: number;
  onRefresh: () => void;
}

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-500 mb-1';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function LocationGroupDetail({ groupId, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>('general');

  useEffect(() => { setTab('general'); }, [groupId]);

  const { data: group, isLoading, isError } = useQuery({
    queryKey: ['location-group', groupId],
    queryFn: () => locationApi.groupDetail(groupId),
  });

  if (isLoading) {
    return <div className="h-full flex items-center justify-center text-sm text-gray-400">Loading…</div>;
  }
  if (isError || !group) {
    return <div className="h-full flex items-center justify-center text-sm text-red-500">Failed to load group</div>;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general',   label: 'General'   },
    { id: 'locations', label: 'Locations' },
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-8 py-5">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-gray-900">{group.name}</h2>
          {group.archivedAt && (
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">
              Inactive
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-0.5">
          <span className="font-mono">{group.code}</span>{' · '}{group.siteName}
        </p>

        <div className="flex gap-1 mt-4">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                tab === t.id
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-white">
        {tab === 'general'   && <GeneralPanel groupId={groupId} onRefresh={onRefresh} />}
        {tab === 'locations' && <LocationsPanel groupId={groupId} siteId={group.siteId} />}
      </div>
    </div>
  );
}

// ── General panel ─────────────────────────────────────────────────────────────

function GeneralPanel({ groupId, onRefresh }: { groupId: number; onRefresh: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const { data: group } = useQuery({
    queryKey: ['location-group', groupId],
    queryFn: () => locationApi.groupDetail(groupId),
  });

  useEffect(() => {
    if (group) {
      setName(group.name);
      setCode(group.code);
      setSortOrder(String(group.sortOrder));
      setEditing(false);
      setSaveErr(null);
    }
  }, [group?.id]);

  const saveMut = useMutation({
    mutationFn: () =>
      locationApi.updateGroup(groupId, {
        name: name.trim(),
        code: code.trim(),
        sortOrder: parseInt(sortOrder, 10) || 0,
      }),
    onSuccess: () => {
      setEditing(false);
      setSaveErr(null);
      void qc.invalidateQueries({ queryKey: ['location-groups-all'] });
      void qc.invalidateQueries({ queryKey: ['location-group', groupId] });
      onRefresh();
    },
    onError: (err: Error) => setSaveErr(err.message),
  });

  const activeMut = useMutation({
    mutationFn: (active: boolean) =>
      locationApi.updateGroup(groupId, { archivedAt: active ? null : new Date().toISOString() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['location-groups-all'] });
      void qc.invalidateQueries({ queryKey: ['location-group', groupId] });
      onRefresh();
    },
  });

  if (!group) return null;

  return (
    <div className="px-8 py-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!group.archivedAt}
            onChange={e => activeMut.mutate(e.target.checked)}
            disabled={activeMut.isPending}
            className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
          />
          <span className="text-sm font-medium text-gray-700">Active</span>
        </label>
        {group.archivedAt && (
          <span className="text-xs text-gray-400">Inactive since {fmtDate(group.archivedAt)}</span>
        )}
      </div>

      {editing ? (
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Code</label>
            <input type="text" value={code} onChange={e => setCode(e.target.value)} className={inputCls} />
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
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check size={13} />
              {saveMut.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setSaveErr(null); }}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-md hover:bg-gray-50"
            >
              <X size={13} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <ReadField label="Site"       value={group.siteName} />
          <ReadField label="Code"       value={group.code} mono />
          <ReadField label="Name"       value={group.name} />
          <ReadField label="Sort Order" value={String(group.sortOrder)} />
          <ReadField label="Created"    value={fmtDate(group.createdAt)} />
          <ReadField label="Updated"    value={fmtDate(group.updatedAt)} />
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

// ── Locations panel ───────────────────────────────────────────────────────────

function LocationsPanel({ groupId, siteId }: { groupId: number; siteId: number }) {
  const qc = useQueryClient();

  const { data: members = [] } = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => locationApi.groupLocations(groupId),
  });

  const { data: allLocations = [] } = useQuery({
    queryKey: ['locations', siteId],
    queryFn: () => locationApi.list(siteId, false),
  });

  const removeMut = useMutation({
    mutationFn: (locationId: number) => locationApi.removeFromGroup(groupId, locationId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['group-members', groupId] }),
  });

  const addMut = useMutation({
    mutationFn: (locationId: number) => locationApi.addToGroup(groupId, locationId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['group-members', groupId] }),
  });

  const memberIds = new Set(members.map((m: LocationGroupMember) => m.id));
  const available = allLocations.filter(l => !memberIds.has(l.id));

  return (
    <div className="px-8 py-6 max-w-xl">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Locations in this Group
      </p>

      {members.length === 0 ? (
        <p className="text-sm text-gray-400 mb-4">No locations assigned yet.</p>
      ) : (
        <ul className="space-y-2 mb-6">
          {members.map((m: LocationGroupMember) => (
            <li
              key={m.id}
              className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-md px-4 py-2.5"
            >
              <div>
                <p className="text-sm font-medium text-gray-900">{m.name}</p>
                <p className="text-xs font-mono text-gray-400">{m.code}</p>
              </div>
              <button
                onClick={() => removeMut.mutate(m.id)}
                disabled={removeMut.isPending}
                className="text-gray-400 hover:text-red-500 transition-colors"
                title="Remove from group"
              >
                <Minus size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Add Location
          </p>
          <div className="flex flex-wrap gap-2">
            {available.map(l => (
              <button
                key={l.id}
                onClick={() => addMut.mutate(l.id)}
                disabled={addMut.isPending}
                className="flex items-center gap-1 text-xs px-3 py-1.5 border border-gray-200 rounded-full text-gray-600 hover:border-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-50"
              >
                <Plus size={10} />
                {l.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
