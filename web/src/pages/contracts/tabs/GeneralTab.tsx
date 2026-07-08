import { useState, useEffect } from 'react';
import { Pencil, X, Check, Archive, RotateCcw } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type { ContractDetail } from '../../../api/contracts';
import { contractApi } from '../../../api/contracts';

interface Props {
  contract: ContractDetail;
  onUpdated: () => void;
}

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function GeneralTab({ contract, onUpdated }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName]       = useState(contract.name);

  useEffect(() => { setName(contract.name); setEditing(false); }, [contract.id]);

  const saveMutation = useMutation({
    mutationFn: () => contractApi.update(contract.id, { name }),
    onSuccess: () => { setEditing(false); onUpdated(); },
  });

  const archiveMutation = useMutation({
    mutationFn: (archive: boolean) =>
      contractApi.update(contract.id, { archivedAt: archive ? new Date().toISOString() : null }),
    onSuccess: onUpdated,
  });

  const isArchived = !!contract.archivedAt;

  return (
    <div className="px-8 py-6 max-w-2xl">
      {/* Name */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Identity</h4>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          {!editing ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Name</div>
                <div className="text-sm text-gray-800 font-medium">{contract.name}</div>
              </div>
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
              >
                <Pencil size={12} /> Edit
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className={inputCls}
                  autoFocus
                />
              </div>
              {saveMutation.isError && (
                <p className="text-sm text-red-600">
                  {saveMutation.error instanceof Error ? saveMutation.error.message : 'Save failed'}
                </p>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => saveMutation.mutate()}
                  disabled={!name.trim() || saveMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  <Check size={13} /> {saveMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => { setEditing(false); setName(contract.name); }}
                  className="p-1.5 text-gray-400 hover:text-gray-600"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Timestamps */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Timestamps</h4>
        <div className="bg-white rounded-lg border border-gray-200 p-5 grid grid-cols-2 gap-5">
          <div>
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Created</div>
            <div className="text-sm text-gray-700">{fmtDate(contract.createdAt)}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Last Updated</div>
            <div className="text-sm text-gray-700">{fmtDate(contract.updatedAt)}</div>
          </div>
          {isArchived && contract.archivedAt && (
            <div>
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Archived</div>
              <div className="text-sm text-gray-700">{fmtDate(contract.archivedAt)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Archive action */}
      {!isArchived ? (
        <button
          onClick={() => archiveMutation.mutate(true)}
          disabled={archiveMutation.isPending}
          className="flex items-center gap-1.5 text-sm text-amber-600 hover:text-amber-700 transition-colors disabled:opacity-50"
        >
          <Archive size={14} /> {archiveMutation.isPending ? 'Archiving…' : 'Archive Contract'}
        </button>
      ) : (
        <button
          onClick={() => archiveMutation.mutate(false)}
          disabled={archiveMutation.isPending}
          className="flex items-center gap-1.5 text-sm text-emerald-600 hover:text-emerald-700 transition-colors disabled:opacity-50"
        >
          <RotateCcw size={14} /> {archiveMutation.isPending ? 'Restoring…' : 'Restore Contract'}
        </button>
      )}
    </div>
  );
}
