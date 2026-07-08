import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { locationApi } from '../../api/locations';

interface Props {
  onCreated: (id: number) => void;
  onCancel: () => void;
}

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

export function NewLocationGroupForm({ onCreated, onCancel }: Props) {
  const [siteId, setSiteId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const { data: allLocations = [] } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationApi.list(undefined, true),
  });

  const sites = Array.from(
    new Map(allLocations.map(l => [l.siteId, { id: l.siteId, name: l.siteName }])).values(),
  );

  const mutation = useMutation({
    mutationFn: () =>
      locationApi.createGroup({
        siteId: parseInt(siteId, 10),
        code: code.trim(),
        name: name.trim(),
        sortOrder: parseInt(sortOrder, 10) || 0,
      }),
    onSuccess: ({ id }) => onCreated(id),
    onError: (err: Error) => setError(err.message),
  });

  const canSubmit = siteId && code.trim() && name.trim() && !mutation.isPending;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-md mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold text-gray-900">New Location Group</h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Site <span className="text-red-500">*</span>
            </label>
            <select value={siteId} onChange={e => setSiteId(e.target.value)} className={inputCls}>
              <option value="">Select site…</option>
              {sites.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Code <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder="e.g. SECT-A"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Section A"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Sort Order</label>
            <input
              type="number"
              value={sortOrder}
              onChange={e => setSortOrder(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={13} />
            {mutation.isPending ? 'Creating…' : 'Create Group'}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
