import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, Check } from 'lucide-react';
import { contractApi } from '../../api/contracts';

interface Props {
  onCreated: (id: number) => void;
  onCancel: () => void;
}

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

export function NewContractForm({ onCreated, onCancel }: Props) {
  const [name, setName] = useState('');

  const createMutation = useMutation({
    mutationFn: () => contractApi.create(name.trim()),
    onSuccess: (data) => onCreated(data.id),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate();
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <h1 className="text-xl font-semibold text-gray-900">New Contract</h1>
        <p className="text-sm text-gray-400 mt-0.5">Create a new contract template</p>
      </div>

      <div className="px-8 py-6 max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Seasonal Harvester"
              className={inputCls}
              autoFocus
            />
          </div>

          {createMutation.isError && (
            <p className="text-sm text-red-600 flex items-center gap-1.5">
              <AlertCircle size={14} />
              {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create'}
            </p>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={!name.trim() || createMutation.isPending}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={14} />
              {createMutation.isPending ? 'Creating…' : 'Create Contract'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
