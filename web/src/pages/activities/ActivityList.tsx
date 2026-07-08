import { useState } from 'react';
import { Search, Plus } from 'lucide-react';
import type { ActivityListItem } from '../../api/activities';

interface Props {
  activities: ActivityListItem[];
  isLoading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
}

export function ActivityList({ activities, isLoading, selectedId, onSelect, onNew }: Props) {
  const [search, setSearch] = useState('');

  const q = search.toLowerCase();
  const filtered = q
    ? activities.filter(
        a =>
          a.code.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q) ||
          (a.displayName ?? '').toLowerCase().includes(q) ||
          a.groupName.toLowerCase().includes(q),
      )
    : activities;

  // Group into ordered sections
  const groups = buildGroups(filtered);

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 pt-5 pb-3 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Activities
          </h2>
          <button
            onClick={onNew}
            className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800 transition-colors"
          >
            <Plus size={13} />
            New
          </button>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-md bg-gray-50 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
          />
        </div>
      </div>

      {/* Grouped list */}
      <ul className="flex-1 overflow-y-auto">
        {isLoading ? (
          <li className="px-4 py-8 text-center text-sm text-gray-400">Loading…</li>
        ) : groups.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-gray-400">No activities found</li>
        ) : (
          groups.map(group => (
            <li key={group.groupName}>
              {/* Group header */}
              <div className="px-4 pt-4 pb-1 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {group.groupName}
                </span>
                <span className="text-xs text-gray-300">{group.items.length}</span>
              </div>

              {/* Items */}
              <ul>
                {group.items.map(a => {
                  const isSelected = a.id === selectedId;
                  const label = a.displayName ?? a.name;
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => onSelect(a.id)}
                        className={`w-full text-left px-4 py-2.5 flex items-center gap-2.5 border-l-2 transition-colors ${
                          isSelected
                            ? 'border-l-emerald-600 bg-emerald-50'
                            : 'border-l-transparent hover:bg-gray-50'
                        } ${a.archivedAt ? 'opacity-50' : ''}`}
                      >
                        {/* Color dot */}
                        <span
                          className="flex-shrink-0 w-2.5 h-2.5 rounded-full border border-black/10"
                          style={{ backgroundColor: a.color ?? '#9CA3AF' }}
                        />
                        {/* Code */}
                        <span
                          className={`flex-shrink-0 text-xs font-mono font-semibold w-12 truncate ${
                            isSelected ? 'text-emerald-700' : 'text-gray-500'
                          }`}
                        >
                          {a.code}
                        </span>
                        {/* Name */}
                        <span
                          className={`text-sm truncate flex-1 ${
                            isSelected ? 'text-emerald-900 font-medium' : 'text-gray-700'
                          }`}
                        >
                          {label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))
        )}
      </ul>

      {/* Footer count */}
      <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400">
        {filtered.length} of {activities.length}
      </div>
    </aside>
  );
}

interface GroupSection {
  groupName: string;
  items: ActivityListItem[];
}

function buildGroups(items: ActivityListItem[]): GroupSection[] {
  const map = new Map<string, { sortOrder: number; items: ActivityListItem[] }>();
  for (const item of items) {
    if (!map.has(item.groupName)) {
      map.set(item.groupName, { sortOrder: item.groupSortOrder, items: [] });
    }
    map.get(item.groupName)!.items.push(item);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
    .map(([groupName, { items }]) => ({ groupName, items }));
}
