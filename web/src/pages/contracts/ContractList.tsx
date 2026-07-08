import { useState } from 'react';
import { Search, Plus, FileText } from 'lucide-react';
import type { ContractListItem } from '../../api/contracts';

interface Props {
  contracts: ContractListItem[];
  isLoading: boolean;
  selectedId: number | null;
  isNew: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
}

export function ContractList({ contracts, isLoading, selectedId, isNew, onSelect, onNew }: Props) {
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const filtered = q ? contracts.filter(c => c.name.toLowerCase().includes(q)) : contracts;

  const active   = filtered.filter(c => !c.archivedAt);
  const archived = filtered.filter(c =>  c.archivedAt);

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white">
      <div className="px-4 pt-5 pb-3 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Contracts</h2>
          <button
            onClick={onNew}
            className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800 transition-colors"
          >
            <Plus size={13} /> New
          </button>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-md bg-gray-50 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto">
        {isLoading ? (
          <li className="px-4 py-8 text-center text-sm text-gray-400">Loading…</li>
        ) : (
          <>
            {isNew && (
              <li className="border-l-2 border-emerald-600 bg-emerald-50 px-4 py-3 flex items-center gap-2.5">
                <FileText size={14} className="text-emerald-600 flex-shrink-0" />
                <span className="text-sm font-medium text-emerald-800">New Contract…</span>
              </li>
            )}

            {active.map(c => (
              <ContractRow
                key={c.id}
                contract={c}
                selected={c.id === selectedId && !isNew}
                onClick={() => onSelect(c.id)}
              />
            ))}

            {archived.length > 0 && (
              <>
                <li className="px-4 pt-4 pb-1">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Archived</span>
                </li>
                {archived.map(c => (
                  <ContractRow
                    key={c.id}
                    contract={c}
                    selected={c.id === selectedId && !isNew}
                    onClick={() => onSelect(c.id)}
                  />
                ))}
              </>
            )}

            {filtered.length === 0 && !isNew && (
              <li className="px-4 py-8 text-center text-sm text-gray-400">No contracts found</li>
            )}
          </>
        )}
      </ul>

      <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400">
        {filtered.length} of {contracts.length}
      </div>
    </aside>
  );
}

function ContractRow({
  contract,
  selected,
  onClick,
}: {
  contract: ContractListItem;
  selected: boolean;
  onClick: () => void;
}) {
  const archived = !!contract.archivedAt;
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-2.5 flex items-center gap-2.5 border-l-2 transition-colors ${
          selected ? 'border-l-emerald-600 bg-emerald-50' : 'border-l-transparent hover:bg-gray-50'
        } ${archived ? 'opacity-50' : ''}`}
      >
        <FileText size={14} className={`flex-shrink-0 ${selected ? 'text-emerald-600' : 'text-gray-400'}`} />
        <span className={`flex-1 text-sm truncate ${selected ? 'font-medium text-emerald-900' : 'text-gray-700'}`}>
          {contract.name}
        </span>
        {contract.profileCount > 0 && (
          <span className="text-xs text-gray-400 flex-shrink-0">{contract.profileCount}p</span>
        )}
      </button>
    </li>
  );
}
