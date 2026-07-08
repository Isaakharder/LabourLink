import { useState } from 'react';
import { Plus, MapPin } from 'lucide-react';
import type { LocationListItem } from '../../api/locations';

interface Props {
  locations: LocationListItem[];
  isLoading: boolean;
  selectedId: number | null;
  isNew: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
}

export function LocationList({ locations, isLoading, selectedId, isNew, onSelect, onNew }: Props) {
  const [search, setSearch] = useState('');

  const q = search.toLowerCase();
  const filtered = locations.filter(
    l => !q || l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q),
  );

  const active   = filtered.filter(l => !l.archivedAt);
  const archived = filtered.filter(l =>  l.archivedAt);

  // Group by site
  const activeBySite   = groupBySite(active);
  const archivedBySite = groupBySite(archived);

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            <MapPin size={12} />
            Locations
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
          placeholder="Search locations…"
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
          <p className="px-4 py-6 text-xs text-gray-400 text-center">No locations found</p>
        ) : (
          <>
            {activeBySite.map(({ siteName, items }) => (
              <SiteSection key={siteName} siteName={siteName}>
                {items.map(loc => (
                  <LocationRow
                    key={loc.id}
                    location={loc}
                    selected={loc.id === selectedId}
                    onClick={() => onSelect(loc.id)}
                  />
                ))}
              </SiteSection>
            ))}

            {archivedBySite.length > 0 && (
              <>
                <div className="px-4 pt-3 pb-1">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Inactive
                  </span>
                </div>
                {archivedBySite.map(({ siteName, items }) => (
                  <SiteSection key={`archived-${siteName}`} siteName={siteName} muted>
                    {items.map(loc => (
                      <LocationRow
                        key={loc.id}
                        location={loc}
                        selected={loc.id === selectedId}
                        onClick={() => onSelect(loc.id)}
                      />
                    ))}
                  </SiteSection>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function groupBySite(items: LocationListItem[]): { siteName: string; items: LocationListItem[] }[] {
  const map = new Map<string, LocationListItem[]>();
  for (const item of items) {
    const arr = map.get(item.siteName) ?? [];
    arr.push(item);
    map.set(item.siteName, arr);
  }
  return Array.from(map.entries()).map(([siteName, items]) => ({ siteName, items }));
}

function SiteSection({
  siteName,
  muted = false,
  children,
}: {
  siteName: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className={`px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider ${muted ? 'text-gray-300' : 'text-gray-400'}`}>
        {siteName}
      </div>
      {children}
    </div>
  );
}

function LocationRow({
  location,
  selected,
  onClick,
}: {
  location: LocationListItem;
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
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium truncate leading-tight ${
          location.archivedAt ? 'text-gray-400' : 'text-gray-900'
        }`}>
          {location.name}
        </p>
        <p className="text-xs text-gray-400 font-mono mt-0.5">{location.code}</p>
      </div>
      {location.netAreaM2 != null && (
        <span className="ml-2 text-xs text-gray-400 shrink-0">
          {parseFloat(String(location.netAreaM2)).toFixed(2)} m²
        </span>
      )}
    </button>
  );
}
