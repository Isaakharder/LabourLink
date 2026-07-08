import { useState } from 'react';
import { Plus, Layers } from 'lucide-react';
import type { LocationGroupListItem } from '../../api/locations';

interface Props {
  groups: LocationGroupListItem[];
  isLoading: boolean;
  selectedId: number | null;
  isNew: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
}

export function LocationGroupList({ groups, isLoading, selectedId, isNew, onSelect, onNew }: Props) {
  const [search, setSearch] = useState('');

  const q = search.toLowerCase();
  const filtered = groups.filter(
    g => !q || g.name.toLowerCase().includes(q) || g.code.toLowerCase().includes(q),
  );

  const active   = filtered.filter(g => !g.archivedAt);
  const archived = filtered.filter(g =>  g.archivedAt);

  function groupBySite(items: LocationGroupListItem[]) {
    const map = new Map<string, LocationGroupListItem[]>();
    for (const item of items) {
      const arr = map.get(item.siteName) ?? [];
      arr.push(item);
      map.set(item.siteName, arr);
    }
    return Array.from(map.entries()).map(([siteName, items]) => ({ siteName, items }));
  }

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            <Layers size={12} />
            Location Groups
          </div>
          <button
            onClick={onNew}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md font-medium transition-colors ${
              isNew
                ? 'bg-emerald-100 text-emerald-700'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Plus size={12} />
            New
          </button>
        </div>
        <input
          type="text"
          placeholder="Search groups…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full px-3 py-1.5 text-xs border border-gray-200 rounded-md bg-gray-50 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2">
        {isLoading ? (
          <p className="px-4 py-6 text-xs text-gray-400 text-center">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-6 text-xs text-gray-400 text-center">No groups found</p>
        ) : (
          <>
            {groupBySite(active).map(({ siteName, items }) => (
              <div key={siteName}>
                <div className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {siteName}
                </div>
                {items.map(g => (
                  <GroupRow
                    key={g.id}
                    group={g}
                    selected={g.id === selectedId}
                    onClick={() => onSelect(g.id)}
                  />
                ))}
              </div>
            ))}

            {archived.length > 0 && (
              <>
                <div className="px-4 pt-3 pb-1">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Inactive
                  </span>
                </div>
                {groupBySite(archived).map(({ siteName, items }) => (
                  <div key={`archived-${siteName}`}>
                    <div className="px-4 pt-2 pb-1 text-xs text-gray-300 uppercase tracking-wider">
                      {siteName}
                    </div>
                    {items.map(g => (
                      <GroupRow
                        key={g.id}
                        group={g}
                        selected={g.id === selectedId}
                        onClick={() => onSelect(g.id)}
                      />
                    ))}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function GroupRow({
  group,
  selected,
  onClick,
}: {
  group: LocationGroupListItem;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 flex items-center justify-between border-l-2 transition-colors ${
        selected
          ? 'bg-emerald-50 border-emerald-500'
          : 'border-transparent hover:bg-gray-50'
      }`}
    >
      <div className="min-w-0">
        <p className={`text-sm font-medium truncate leading-tight ${
          group.archivedAt ? 'text-gray-400' : 'text-gray-900'
        }`}>
          {group.name}
        </p>
        <p className="text-xs text-gray-400 font-mono mt-0.5">{group.code}</p>
      </div>
      <span className="text-xs text-gray-400 flex-shrink-0 ml-2">
        {group.locationCount}
      </span>
    </button>
  );
}
